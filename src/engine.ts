import {
  channels, encode, newState, RETENTION, sha256, stamp, SyncError,
  type Channel, type Checkpoint, type HistoryItem, type LocalEntry, type LocalFiles,
  type Manifest, type PendingConflict, type RemoteEntry, type RemoteFile, type Scan, type SyncState, type Profile,
} from './model';
import { markdownPreviews, markdownText, maxMergeBytes, mergeMarkdown, type MarkdownMerge } from './markdown-merge';
import { checkPayload, EXCALIDRAW_PROFILE, pathKey } from './policy';
import { planSync, type Action, type Operation, type Plan, type Selection } from './planner';
import { RemoteVault, type Head } from './repository';

export interface EngineOptions {
  device: string;
  profile: Profile;
  selection: Selection;
  maxBytes: number;
  active: () => boolean;
  now?: () => number;
  controls?: SyncControls;
}
export interface SyncControls {
  signal: AbortSignal;
  progress?: (completed: number, total: number) => void;
}
export interface Preview {
  plan: Plan;
  approval: string;
}
export interface Result {
  state: SyncState;
  counts: Record<Action, number>;
  errors: SyncError['code'][];
  devices: Manifest['devices'];
  desktopChanged: boolean;
  merged: number;
  newConflicts: number;
  uploadRetryStatus?: number;
  recoveredPublication?: boolean;
}

export type ConflictReview = { path: string; pending: PendingConflict } & (
  | { kind: 'fragments'; merge: MarkdownMerge }
  | { kind: 'whole'; previews: ReturnType<typeof markdownPreviews> }
);

export type ConflictChoice = { kind: 'text'; text: string } | { kind: 'local' | 'remote' };

type ConflictBytes = { local: ArrayBuffer; remote: ArrayBuffer };

type Inspection = Preview & { scans: Map<Channel, Scan> };
type CloudWork = {
  head: Head;
  failed: Set<Operation>;
  conflicts: Map<Operation, { path: string; file: RemoteFile }>;
  merges: Map<Operation, RemoteFile>;
  pending: Map<Operation, PendingConflict>;
  unsafeDelete: Set<Channel>;
  transferred: () => void;
  uploadRetryStatus?: number;
};

const transferBatch = 3;
const smallFile = 2 * 1024 * 1024;
const bulkBatch = 24;
const bulkTimeoutLimit = 3;

function* batches<T>(items: T[], size = transferBatch): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function ordered(ops: Operation[]): Operation[] {
  const order = (op: Operation) => op.action.startsWith('delete') ? 2
    : (op.local?.kind === 'folder' || op.remote?.kind === 'folder') ? 0 : 1;
  const depth = (path: string) => path.split('/').length;
  return [...ops].sort((a, b) => order(a) - order(b)
    || (depth(a.path) - depth(b.path)) * (order(a) === 2 ? -1 : 1)
    || a.path.localeCompare(b.path));
}

function copyState(state: SyncState, checkpoint: Checkpoint) {
  const copy = newState();
  copy.checkpoint = { revision: checkpoint.revision, hash: checkpoint.hash };
  for (const channel of channels) Object.assign(copy.base[channel], state.base[channel]);
  Object.assign(copy.pending, state.pending);
  return copy;
}

function conflictPath(path: string, remote: RemoteFile, local: Extract<LocalEntry, { kind: 'file' }>, device: string): string {
  const boundary = path.lastIndexOf('/') + 1;
  const lastDot = path.lastIndexOf('.');
  const split = lastDot > boundary ? lastDot : path.length;
  const extension = Array.from(path.slice(split)).slice(0, 20).join('');
  const suffix = ' (conflict ' + new Date(Math.min(remote.at, 8.64e15)).toISOString().slice(0, 19).replace(/:/g, '-')
    + ' ' + device.slice(0, 8) + '-' + local.hash.slice(0, 12) + ')';
  const budget = Math.min(240, 1024 - boundary) - suffix.length - extension.length;
  if (budget < 1) throw new SyncError('path');
  let base = '';
  for (const char of path.slice(boundary, split)) {
    if (base.length + char.length > budget) break;
    base += char;
  }
  return path.slice(0, boundary) + base + suffix + extension;
}

export class SyncEngine {
  private inFlight = false;

  constructor(private readonly remote: RemoteVault, private readonly local: LocalFiles, private readonly options: EngineOptions) {}

  private active(): void {
    if (this.options.controls?.signal.aborted) throw new SyncError('cancelled');
    if (!this.options.active()) throw new SyncError('inactive');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.inFlight) throw new SyncError('busy');
    this.inFlight = true;
    try {
      this.active();
      return await action();
    } finally {
      this.inFlight = false;
    }
  }

  private async inspect(state: SyncState, head: Head): Promise<Inspection> {
    const scans = new Map<Channel, Scan>();
    for (const channel of this.options.selection.channels) {
      this.active();
      scans.set(channel, await this.local.scan(channel, () => this.active()));
    }
    this.active();
    const plan = planSync(head.manifest, state, scans, this.options.selection);
    const destructive = plan.destructive.map(op =>
      JSON.stringify([op.channel, op.path, op.action, stamp(op.local), stamp(op.remote)])).sort();
    return { plan, scans, approval: await sha256(encode(JSON.stringify([head.hash, destructive]))) };
  }

  preview(state: SyncState): Promise<Preview> {
    return this.exclusive(async () => this.inspect(state, await this.remote.head(state.checkpoint, true)));
  }

  run(state: SyncState, approval?: string): Promise<Result> {
    return this.exclusive(async () => {
      const check = () => this.active();
      const recoveredPublication = await this.remote.recoverLegacy(state.checkpoint, check);
      const head = await this.remote.head(state.checkpoint, true, check);
      const preview = await this.inspect(state, head);
      if (preview.plan.requiresApproval && preview.approval !== approval) throw new SyncError('mass-delete');
      const ops = ordered(preview.plan.operations);
      const errors: Result['errors'] = [...new Set([...preview.scans.values()].flatMap(scan => [...scan.issues ?? []]))];
      const now = this.now();
      const expiration = this.expiration(now);
      const report = this.options.controls?.progress;
      const total = ops.filter(op => (op.action === 'push' && op.local?.kind === 'file')
        || (op.action === 'pull' && op.remote?.kind === 'file')).length;
      const bulk = !head.pending && total >= bulkBatch
        && ops.every(op => op.action === 'equal' || op.action === 'blocked' || (op.action === 'push' && !op.remote));
      let completed = 0;
      report?.(completed, total);
      const needsLock = head.pending || head.manifest.devices[this.options.device] !== this.options.profile
        || ops.some(op => op.action === 'push' || op.action.startsWith('delete') || (op.action === 'conflict' && !!op.local))
        || head.manifest.garbage.length > 0
        || (expiration !== null && head.manifest.history.some(item => item.at <= expiration));
      const cloud: CloudWork = {
        head, failed: new Set(), conflicts: new Map(), merges: new Map(), pending: new Map(), unsafeDelete: new Set(),
        transferred: () => report?.(++completed, total),
      };
      let readOnly = false;
      if (needsLock) {
        try {
          if (bulk) await this.pushBulk(preview, ops, cloud, errors, now);
          else await this.writeBatch(preview, ops, cloud, errors, now);
        } catch (error) {
          if (!(error instanceof SyncError) || !['cloud-lock', 'cloud-preparing'].includes(error.code)) throw error;
          readOnly = !bulk;
          errors.unshift(error.code);
        }
      }
      if (bulk) {
        for (const op of ops) {
          if (op.action === 'push' && stamp(op.local) !== stamp(cloud.head.manifest.files[op.channel][op.path])) cloud.failed.add(op);
        }
      }
      this.active();
      const result = await this.apply(state, preview, ops, cloud, errors, readOnly);
      if (recoveredPublication) result.recoveredPublication = true;
      return result;
    });
  }

  private async writeBatch(
    preview: Inspection, ops: Operation[], work: CloudWork, errors: Result['errors'], now: number,
    staged?: ReadonlyMap<Operation, RemoteFile>,
  ): Promise<void> {
    this.active();
    const expected = work.head;
    // Verify ordinary file uploads before taking the shared metadata lock. Slow uploads
    // and failed connections must not block other devices from publishing their changes.
    if (!staged && await this.remote.writesLocked()) throw new SyncError('cloud-lock');
    const prepared = staged ?? await this.stageUploads(ops, now, work, errors);
    this.active();
    await this.remote.write(async () => {
      const current = await this.remote.headForWrite(expected, () => this.active());
      if (current.hash !== expected.hash) throw new SyncError('cloud-advanced');
      work.head = await this.commit(current, preview, ops, work, errors, now, prepared);
    });
  }

  private async pushBulk(preview: Inspection, ops: Operation[], work: CloudWork, errors: Result['errors'], now: number): Promise<void> {
    this.active();
    if (await this.remote.writesLocked()) throw new SyncError('cloud-lock');
    const uploads = ops.filter(op => op.action === 'push');
    let timeouts = 0;
    for (const batch of batches(uploads, bulkBatch)) {
      const staged = new Map<Operation, RemoteFile>();
      for (const op of batch) {
        this.active();
        if (op.local?.kind !== 'file') continue;
        try {
          staged.set(op, await this.upload(op, now, work.transferred));
          timeouts = 0;
        } catch (error) {
          if (!(error instanceof SyncError) || (error.code !== 'upload-retry' && error.code !== 'timeout' && error.status !== 504)) {
            this.fileFailure(error, op, work.failed, errors);
            continue;
          }
          work.failed.add(op);
          work.uploadRetryStatus ??= error.status;
          if (!errors.includes('upload-retry')) errors.unshift('upload-retry');
          if (++timeouts >= bulkTimeoutLimit) break;
        }
      }
      // The blobs are verified before taking the legacy write lock. Publish only this batch.
      const ready = batch.filter(op => op.local?.kind === 'folder' || staged.has(op));
      if (ready.length) await this.writeBatch(preview, ready, work, errors, now, staged);
      if (timeouts >= bulkTimeoutLimit) break;
    }
  }

  private archive(manifest: Manifest, op: Operation, file: RemoteFile, reason: HistoryItem['reason'], now: number): void {
    if (manifest.history.some(item => item.channel === op.channel && item.path === op.path
      && item.file.blob === file.blob && item.reason === reason && now - item.at < RETENTION)) return;
    manifest.history.push({ id: crypto.randomUUID(), channel: op.channel, path: op.path, reason, at: now, file });
  }

  private async verifiedLocal(op: Operation): Promise<{ bytes: ArrayBuffer; hash: string }> {
    if (op.local?.kind !== 'file') throw new SyncError('local');
    if (op.local.size > this.options.maxBytes) throw new SyncError('size');
    const bytes = await this.local.read(op.channel, op.path);
    if (bytes.byteLength !== op.local.size || await sha256(bytes) !== op.local.hash) throw new SyncError('changed');
    checkPayload(op.channel, op.path, bytes);
    return { bytes, hash: op.local.hash };
  }

  private async upload(op: Operation, now: number, transferred?: () => void): Promise<RemoteFile> {
    const { bytes, hash } = await this.verifiedLocal(op);
    this.active();
    const file = await this.remote.upload(op.channel, bytes, hash, this.options.device, now);
    transferred?.();
    return file;
  }

  private async bytes(channel: Channel, path: string, entry: RemoteFile): Promise<ArrayBuffer> {
    if (entry.size > this.options.maxBytes) throw new SyncError('size');
    const bytes = await this.remote.download(channel, entry);
    checkPayload(channel, path, bytes);
    return bytes;
  }

  private async pull(op: Operation, entry: RemoteEntry | undefined, prefetched?: ArrayBuffer): Promise<void> {
    const bytes = entry?.kind === 'file' ? prefetched ?? await this.bytes(op.channel, op.path, entry) : undefined;
    this.active();
    await this.local.apply(op.channel, op.path, stamp(op.local), entry?.kind === 'deleted' ? null : entry ?? null, bytes);
  }

  private async markdownBytes(op: Operation, remote: RemoteFile): Promise<ConflictBytes> {
    const [{ bytes: localBytes }, remoteBytes] = await Promise.all([
      this.verifiedLocal(op), this.bytes('content', op.path, remote),
    ]);
    return { local: localBytes, remote: remoteBytes };
  }

  private async compareMarkdown(op: Operation, manifest: Manifest, versions: ConflictBytes): Promise<MarkdownMerge | undefined> {
    const local = markdownText(versions.local);
    const remote = markdownText(versions.remote);
    if (local === undefined || remote === undefined) return undefined;
    const ancestor = manifest.history.find(item => item.channel === 'content' && item.path === op.path
      && item.file.hash === op.baseHash && item.file.size <= maxMergeBytes);
    let base: string | undefined;
    if (ancestor) {
      try {
        base = markdownText(await this.bytes('content', op.path, ancestor.file));
      } catch (error) {
        if (!(error instanceof SyncError) || !['missing', 'integrity'].includes(error.code)) throw error;
      }
    }
    return mergeMarkdown(base, local, remote);
  }

  private async archiveMarkdown(manifest: Manifest, op: Operation, localBytes: ArrayBuffer, now: number): Promise<RemoteFile> {
    if (op.local?.kind !== 'file' || op.remote?.kind !== 'file') throw new SyncError('changed');
    const hash = op.local.hash;
    let local = manifest.history.find(item => item.channel === 'content' && item.path === op.path
      && item.file.hash === hash && item.reason === 'conflict' && now - item.at < RETENTION)?.file;
    if (local) {
      try {
        await this.remote.download('content', local);
      } catch (error) {
        if (!(error instanceof SyncError) || !['missing', 'integrity'].includes(error.code)) throw error;
        local = undefined;
      }
    }
    this.active();
    local ??= await this.remote.upload('content', localBytes, hash, this.options.device, now);
    this.archive(manifest, op, local, 'conflict', now);
    this.archive(manifest, op, op.remote, 'conflict', now);
    return local;
  }

  private async mergedFile(bytes: ArrayBuffer, local: RemoteFile, remote: RemoteFile, now: number): Promise<RemoteFile> {
    if (bytes.byteLength > this.options.maxBytes) throw new SyncError('size');
    const hash = await sha256(bytes);
    if (hash === remote.hash) return remote;
    if (hash === local.hash) return local;
    this.active();
    return this.remote.upload('content', bytes, hash, this.options.device, now);
  }

  private async stageUploads(deferred: Operation[], now: number, work: CloudWork, errors: Result['errors']) {
    const { failed, transferred } = work;
    const files = deferred.filter(op => op.action === 'push' && op.local?.kind === 'file' && op.local.size <= smallFile);
    const staged = new Map<Operation, RemoteFile>();
    for (const batch of batches(files)) {
      this.active();
      const results = await Promise.allSettled(batch.map(op => this.upload(op, now, transferred)));
      for (const [index, result] of results.entries()) {
        const op = batch[index]!;
        if (result.status === 'fulfilled') staged.set(op, result.value);
        else this.fileFailure(result.reason, op, failed, errors);
      }
    }
    // Keep large files sequential so preparation does not multiply peak memory use.
    for (const op of deferred) {
      if (op.action !== 'push' || op.local?.kind !== 'file' || op.local.size <= smallFile) continue;
      this.active();
      try {
        staged.set(op, await this.upload(op, now, transferred));
      } catch (error) {
        this.fileFailure(error, op, failed, errors);
      }
    }
    return staged;
  }

  private async *prefetchSmallPulls(ops: Operation[], manifest: Manifest) {
    for (const batch of batches(ops)) {
      this.active();
      const prefetched = await Promise.all(batch.map(async op => {
        const file = manifest.files[op.channel][op.path];
        if (op.action !== 'pull' || file?.kind !== 'file' || file.size > smallFile) return { op };
        try {
          return { op, bytes: await this.bytes(op.channel, op.path, file) };
        } catch (error) {
          return { op, failedRead: { error } };
        }
      }));
      yield* prefetched;
    }
  }

  private addParents(manifest: Manifest, path: string, scan: Scan | undefined, now: number): void {
    const parts = path.split('/');
    parts.pop();
    let parent = '';
    for (const segment of parts) {
      parent = parent ? parent + '/' + segment : segment;
      const current = manifest.files.content[parent];
      if (current?.kind === 'folder') continue;
      if (current?.kind === 'file' || scan?.entries.get(parent)?.kind !== 'folder') throw new SyncError('path');
      manifest.files.content[parent] = { kind: 'folder', at: now, device: this.options.device };
    }
  }

  private expiration(now: number): number | null {
    const serverTime = this.remote.serverTime;
    return serverTime === null || Math.abs(serverTime - now) > 5 * 60_000 ? null : Math.min(now, serverTime) - RETENTION;
  }

  private prune(manifest: Manifest, now: number): boolean {
    const expiresBefore = this.expiration(now);
    if (expiresBefore === null) return false;
    const expired = manifest.history.filter(item => item.at <= expiresBefore).slice(0, 64);
    if (!expired.length) return false;
    const expiredIds = new Set(expired.map(item => item.id));
    manifest.history = manifest.history.filter(item => !expiredIds.has(item.id));
    const refs = new Set(manifest.history.map(item => item.channel + '/' + item.file.blob));
    for (const channel of channels) {
      for (const entry of Object.values(manifest.files[channel])) {
        if (entry.kind === 'file') refs.add(channel + '/' + entry.blob);
      }
    }
    for (const item of expired) {
      const key = item.channel + '/' + item.file.blob;
      if (!refs.has(key)) {
        manifest.garbage.push({ channel: item.channel, blob: item.file.blob });
        refs.add(key);
      }
    }
    return true;
  }

  private async commit(
    head: Head, preview: Inspection, deferred: Operation[], work: CloudWork, errors: Result['errors'], now: number,
    prepared: ReadonlyMap<Operation, RemoteFile>,
  ): Promise<Head> {
    const manifest = head.manifest;
    const { failed, conflicts, unsafeDelete } = work;
    const aliases = new Map<string, string>();
    for (const path of Object.keys(manifest.files.content)) aliases.set(pathKey(path), path);
    for (const path of preview.scans.get('content')?.entries.keys() ?? []) aliases.set(pathKey(path), path);
    let dirty = manifest.devices[this.options.device] !== this.options.profile;
    manifest.devices[this.options.device] = this.options.profile;

    for (const op of deferred) {
      this.active();
      if (failed.has(op) || (op.action !== 'push' && op.action !== 'conflict')) continue;
      const group = manifest.files[op.channel];
      try {
        if (op.action === 'conflict' && op.local?.kind === 'file' && op.remote?.kind === 'file') {
          if (op.channel === 'content') {
            if (/\.md$/i.test(op.path)) {
              const versions = await this.markdownBytes(op, op.remote);
              const merge = await this.compareMarkdown(op, manifest, versions);
              const historySize = manifest.history.length;
              const local = await this.archiveMarkdown(manifest, op, versions.local, now);
              if (!merge || merge.parts.some(part => part.kind === 'conflict')) {
                work.pending.set(op, { local: op.local.hash, remote: op.remote.hash, base: op.baseHash ?? null });
              } else {
                const bytes = encode(merge.parts.flatMap(part => part.kind === 'text' ? part.lines : []).join(merge.eol));
                const file = await this.mergedFile(bytes, local, op.remote, now);
                group[op.path] = file;
                work.merges.set(op, file);
                dirty ||= file.hash !== op.remote.hash;
              }
              dirty ||= historySize !== manifest.history.length;
              continue;
            }
            const path = conflictPath(op.path, op.remote, op.local, this.options.device);
            const existing = group[path];
            const localCopy = preview.scans.get('content')?.entries.get(path);
            if ((existing && stamp(existing) !== stamp(op.local))
              || (localCopy && stamp(localCopy) !== stamp(op.local))
              || (aliases.has(pathKey(path)) && aliases.get(pathKey(path)) !== path)) throw new SyncError('path');
            const file = existing?.kind === 'file' ? existing : await this.upload(op, now);
            group[path] = file;
            aliases.set(pathKey(path), path);
            conflicts.set(op, { path, file });
          } else {
            const previous = manifest.history.find(item => item.channel === op.channel && item.path === op.path
              && item.reason === 'conflict' && item.file.hash === (op.local?.kind === 'file' ? op.local.hash : '')
              && now - item.at < RETENTION);
            this.archive(manifest, op, previous?.file ?? await this.upload(op, now), 'conflict', now);
            this.archive(manifest, op, op.remote, 'conflict', now);
          }
          dirty = true;
          continue;
        }
        if (!op.local) continue;
        if (op.local.kind === 'folder') await this.local.verify(op.channel, op.path, 'folder');
        const next: RemoteEntry | undefined = op.local.kind === 'folder'
          ? { kind: 'folder', at: now, device: this.options.device } : prepared.get(op);
        if (!next) throw new SyncError('integrity');
        if (op.channel === 'content') this.addParents(manifest, op.path, preview.scans.get('content'), now);
        if (op.remote?.kind === 'file') this.archive(manifest, op, op.remote, 'updated', now);
        group[op.path] = next;
        dirty = true;
      } catch (error) {
        this.fileFailure(error, op, failed, errors);
      }
    }

    for (const op of deferred) if (failed.has(op) || op.action === 'blocked') unsafeDelete.add(op.channel);
    for (const op of deferred) {
      if (op.action !== 'delete-remote') continue;
      if (unsafeDelete.has(op.channel)) continue;
      this.active();
      try {
        await this.local.verify(op.channel, op.path, null);
        if (op.remote?.kind === 'file') await this.remote.download(op.channel, op.remote);
      } catch (error) {
        this.fileFailure(error, op, failed, errors);
        unsafeDelete.add(op.channel);
      }
    }
    for (const op of deferred) {
      if (op.action !== 'delete-remote') continue;
      const group = manifest.files[op.channel];
      if (unsafeDelete.has(op.channel) || (op.remote?.kind === 'folder' && Object.entries(group)
        .some(([path, item]) => path.startsWith(op.path + '/') && item.kind !== 'deleted'))) {
        failed.add(op);
        continue;
      }
      if (op.remote?.kind === 'file') this.archive(manifest, op, op.remote, 'deleted', now);
      group[op.path] = { kind: 'deleted', at: now, device: this.options.device };
      dirty = true;
    }

    const garbage = manifest.garbage.slice(0, 32);
    for (const item of garbage) {
      this.active();
      await this.remote.drop(item.channel, item.blob);
    }
    manifest.garbage = manifest.garbage.slice(garbage.length);
    dirty = this.prune(manifest, now) || dirty || garbage.length > 0;
    this.active();
    if (dirty) manifest.at = now;
    return dirty ? this.remote.publish(manifest, head) : head;
  }

  private async apply(
    state: SyncState, preview: Inspection, deferred: Operation[], work: CloudWork,
    errors: Result['errors'], readOnly: boolean,
  ): Promise<Result> {
    const { head, failed, conflicts, unsafeDelete } = work;
    const manifest = head.manifest;
    const counts: Result['counts'] = {
      push: 0, pull: 0, 'delete-remote': 0, 'delete-local': 0, conflict: 0, review: 0, equal: 0, blocked: 0,
    };
    const next = copyState(state, head);
    let desktopChanged = false;
    let merged = 0;
    let newConflicts = 0;

    for await (const { op, bytes, failedRead } of this.prefetchSmallPulls(deferred, manifest)) {
      this.active();
      if (op.action === 'blocked' || failed.has(op)
        || (readOnly && op.action !== 'equal' && op.action !== 'pull' && op.action !== 'review')) {
        counts.blocked++;
        continue;
      }
      const current = manifest.files[op.channel][op.path];
      let localStamp = stamp(op.local);
      try {
        if (failedRead) throw failedRead.error;
        const pending = work.pending.get(op);
        if (pending) {
          next.pending[op.path] = pending;
          newConflicts++;
        }
        if (pending || op.action === 'review') {
          counts.review++;
          continue;
        }
        const conflict = conflicts.get(op);
        if (conflict) {
          const localCopy = preview.scans.get(op.channel)?.entries.get(conflict.path);
          if (!localCopy) await this.pull({ ...op, path: conflict.path, local: undefined }, conflict.file);
          next.base[op.channel][conflict.path] = { local: stamp(conflict.file), remote: stamp(conflict.file) };
        }
        if (op.action === 'delete-local' && (unsafeDelete.has(op.channel) || errors.length)) {
          counts.blocked++;
          continue;
        }
        const mergedFile = work.merges.get(op);
        if (op.action === 'pull' || op.action === 'delete-local' || conflict || mergedFile || (op.action === 'conflict' && !op.local)) {
          if (stamp(current) !== 'deleted' || op.local) await this.pull(op, current, bytes);
          localStamp = current?.kind === 'deleted' ? null : stamp(current);
          if (op.channel === 'desktop-config' && !op.path.startsWith('inventory/')) desktopChanged = true;
        }
        if (mergedFile) merged++;
        next.base[op.channel][op.path] = { local: localStamp, remote: stamp(current) };
        if (op.channel === 'content') delete next.pending[op.path];
        counts[op.action]++;
        if (op.action === 'pull' && current?.kind === 'file') work.transferred();
      } catch (error) {
        this.fileFailure(error, op, failed, errors, true);
        counts.blocked++;
      }
    }
    return { state: next, counts, errors, desktopChanged, devices: manifest.devices, merged, newConflicts,
      uploadRetryStatus: work.uploadRetryStatus };
  }

  private async pendingOperation(path: string, pending: PendingConflict, head: Head): Promise<Operation & { remote: RemoteFile }> {
    if (!this.options.selection.channels.includes('content')) throw new SyncError('configuration');
    const scan = await this.local.scan('content');
    const local = scan.entries.get(path);
    const remote = head.manifest.files.content[path];
    if (local?.kind !== 'file' || local.hash !== pending.local || scan.blocked.has(path)
      || remote?.kind !== 'file' || remote.hash !== pending.remote) throw new SyncError('changed');
    return { action: 'conflict', channel: 'content', path, local, remote, baseHash: pending.base ?? undefined };
  }

  reviewConflict(state: SyncState, path: string): Promise<ConflictReview> {
    return this.exclusive(async () => {
      const pending = state.pending?.[path];
      if (!pending) throw new SyncError('changed');
      const head = await this.remote.head(state.checkpoint, true);
      const op = await this.pendingOperation(path, pending, head);
      const versions = await this.markdownBytes(op, op.remote);
      const merge = await this.compareMarkdown(op, head.manifest, versions);
      if (merge) return { path, pending, kind: 'fragments', merge };
      return { path, pending, kind: 'whole', previews: markdownPreviews(versions.local, versions.remote) };
    });
  }

  resolveConflict(state: SyncState, review: ConflictReview, choice: ConflictChoice): Promise<SyncState> {
    return this.exclusive(async () => {
      const { path, pending: expected } = review;
      const pending = state.pending?.[path];
      if (!pending || pending.local !== expected.local || pending.remote !== expected.remote || pending.base !== expected.base) {
        throw new SyncError('changed');
      }
      const edited = choice.kind === 'text' ? encode(choice.text) : undefined;
      if (edited && (review.kind !== 'fragments' || edited.byteLength > Math.min(2 * maxMergeBytes, this.options.maxBytes))) {
        throw new SyncError('size');
      }
      const head = await this.remote.head(state.checkpoint, true);
      const op = await this.pendingOperation(path, pending, head);
      const versions = await this.markdownBytes(op, op.remote);
      const bytes = edited ?? (choice.kind === 'local' ? versions.local : versions.remote);
      const now = this.now();
      const { latest, file } = await this.remote.write(async () => {
        const current = await this.remote.headForWrite(head);
        if (current.hash !== head.hash) throw new SyncError('cloud-advanced');
        await this.local.verify('content', path, 'file:' + pending.local);
        const local = await this.archiveMarkdown(current.manifest, op, versions.local, now);
        const file = choice.kind === 'local' ? local : choice.kind === 'remote' ? op.remote
          : await this.mergedFile(bytes, local, op.remote, now);
        current.manifest.files.content[path] = file;
        current.manifest.at = now;
        this.active();
        const latest = await this.remote.publish(current.manifest, current);
        return { latest, file };
      });
      this.active();
      await this.local.apply('content', path, 'file:' + pending.local, file, bytes);
      const next = copyState(state, latest);
      next.base.content[path] = { local: stamp(file), remote: stamp(file) };
      delete next.pending[path];
      return next;
    });
  }

  private fileFailure(error: unknown, op: Operation, failed: Set<Operation>, errors: Result['errors'], localPhase = false): void {
    const code = error instanceof SyncError ? error.code : 'local';
    if (!['size', 'changed', 'configuration', 'path', 'local'].includes(code)
      && (!localPhase || !['integrity', 'missing'].includes(code))) throw error;
    failed.add(op);
    if (!errors.includes(code)) errors.push(code);
  }

  history(state: SyncState): Promise<HistoryItem[]> {
    return this.exclusive(async () => {
      const head = await this.remote.head(state.checkpoint);
      return head.manifest.history.filter(item => this.options.selection.channels.includes(item.channel))
        .sort((a, b) => b.at - a.at);
    });
  }

  acceptExcalidraw(state: SyncState): Promise<SyncState> {
    return this.exclusive(async () => {
      const channel = 'desktop-config';
      const path = EXCALIDRAW_PROFILE;
      if (!this.options.selection.excalidraw || !this.options.selection.channels.includes(channel)) {
        throw new SyncError('configuration');
      }
      const head = await this.remote.head(state.checkpoint, true);
      const remote = head.manifest.files[channel][path];
      if (remote?.kind !== 'file') throw new SyncError('missing');
      const scan = await this.local.scan(channel);
      if (scan.ignored?.has(path) || scan.blocked.has(path)) throw new SyncError('configuration');
      await this.pull({ action: 'pull', channel, path, local: scan.entries.get(path), remote }, remote);
      const next = copyState(state, head);
      next.base[channel][path] = { local: stamp(remote), remote: stamp(remote) };
      return next;
    });
  }

  restore(state: SyncState, id: string, save: (item: HistoryItem, bytes: ArrayBuffer) => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      const head = await this.remote.head(state.checkpoint, true);
      const item = head.manifest.history.find(entry => entry.id === id && this.options.selection.channels.includes(entry.channel));
      if (!item) throw new SyncError('missing');
      const bytes = await this.bytes(item.channel, item.path, item.file);
      this.active();
      await save(item, bytes);
    });
  }
}
