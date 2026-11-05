import {
  channels, encode, newState, RETENTION, sha256, stamp, SyncError,
  type Channel, type Checkpoint, type HistoryItem, type LocalEntry, type LocalFiles,
  type Manifest, type RemoteEntry, type RemoteFile, type Scan, type SyncState, type Profile,
} from './model';
import { checkPayload, pathKey } from './policy';
import { planSync, type Action, type Operation, type Plan, type Selection } from './planner';
import { RemoteVault, type Head } from './repository';

export interface EngineOptions {
  device: string;
  profile: Profile;
  selection: Selection;
  maxBytes: number;
  active: () => boolean;
  now?: () => number;
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
}

function ordered(ops: Operation[]): Operation[] {
  const order = (op: Operation) => op.action.startsWith('delete') ? 2
    : (op.local?.kind === 'folder' || op.remote?.kind === 'folder') ? 0 : 1;
  const depth = (path: string) => path.split('/').length;
  return [...ops].sort((a, b) => order(a) - order(b)
    || (depth(a.path) - depth(b.path)) * (order(a) === 2 ? -1 : 1)
    || a.path.localeCompare(b.path));
}

function copyState(state: SyncState, checkpoint: Checkpoint): SyncState {
  const copy = newState();
  copy.checkpoint = { revision: checkpoint.revision, hash: checkpoint.hash };
  for (const channel of channels) Object.assign(copy.base[channel], state.base[channel]);
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

  private async inspect(state: SyncState, head: Head): Promise<Preview & { scans: Map<Channel, Scan> }> {
    const scans = new Map<Channel, Scan>();
    for (const channel of this.options.selection.channels) {
      this.active();
      scans.set(channel, await this.local.scan(channel));
    }
    const plan = planSync(head.manifest, state, scans, this.options.selection);
    const destructive = plan.destructive.map(op =>
      JSON.stringify([op.channel, op.path, op.action, stamp(op.local), stamp(op.remote)])).sort();
    return { plan, scans, approval: await sha256(encode(JSON.stringify([head.hash, destructive]))) };
  }

  preview(state: SyncState): Promise<Preview> {
    return this.exclusive(async () => this.inspect(state, await this.remote.head(state.checkpoint)));
  }

  run(state: SyncState, approval?: string): Promise<Result> {
    return this.exclusive(() => this.remote.lock(async () => {
      const head = await this.remote.head(state.checkpoint);
      const preview = await this.inspect(state, head);
      if (preview.plan.requiresApproval && preview.approval !== approval) throw new SyncError('mass-delete');
      return this.execute(state, head, preview);
    }));
  }

  private archive(manifest: Manifest, op: Operation, file: RemoteFile, reason: HistoryItem['reason'], now: number): void {
    if (manifest.history.some(item => item.channel === op.channel && item.path === op.path
      && item.file.blob === file.blob && item.reason === reason && now - item.at < RETENTION)) return;
    manifest.history.push({ id: crypto.randomUUID(), channel: op.channel, path: op.path, reason, at: now, file });
  }

  private async upload(op: Operation, now: number): Promise<RemoteFile> {
    if (op.local?.kind !== 'file') throw new SyncError('local');
    if (op.local.size > this.options.maxBytes) throw new SyncError('size');
    const bytes = await this.local.read(op.channel, op.path);
    if (bytes.byteLength !== op.local.size || await sha256(bytes) !== op.local.hash) throw new SyncError('changed');
    checkPayload(op.channel, op.path, bytes);
    this.active();
    return this.remote.upload(op.channel, bytes, op.local.hash, this.options.device, now);
  }

  private async bytes(channel: Channel, path: string, entry: RemoteFile): Promise<ArrayBuffer> {
    if (entry.size > this.options.maxBytes) throw new SyncError('size');
    const bytes = await this.remote.download(channel, entry);
    checkPayload(channel, path, bytes);
    return bytes;
  }

  private async pull(op: Operation, entry: RemoteEntry | undefined): Promise<void> {
    const bytes = entry?.kind === 'file' ? await this.bytes(op.channel, op.path, entry) : undefined;
    this.active();
    await this.local.apply(op.channel, op.path, stamp(op.local), entry?.kind === 'deleted' ? null : entry ?? null, bytes);
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

  private prune(manifest: Manifest, now: number): boolean {
    const serverTime = this.remote.serverTime;
    if (serverTime === null || Math.abs(serverTime - now) > 5 * 60_000) return false;
    const expiresBefore = Math.min(now, serverTime) - RETENTION;
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

  private async execute(
    state: SyncState, head: Head, preview: Preview & { scans: Map<Channel, Scan> },
  ): Promise<Result> {
    const manifest = head.manifest;
    const now = this.now();
    const counts: Result['counts'] = { push: 0, pull: 0, 'delete-remote': 0, 'delete-local': 0, conflict: 0, equal: 0, blocked: 0 };
    const errors: Result['errors'] = [...new Set([...preview.scans.values()].flatMap(scan => [...scan.issues ?? []]))];
    const failed = new Set<Operation>();
    const conflicts = new Map<Operation, { path: string; file: RemoteFile }>();
    const deferred = ordered(preview.plan.operations);
    const aliases = new Map<string, string>();
    for (const path of Object.keys(manifest.files.content)) aliases.set(pathKey(path), path);
    for (const path of preview.scans.get('content')?.entries.keys() ?? []) aliases.set(pathKey(path), path);
    let dirty = manifest.devices[this.options.device] !== this.options.profile;
    manifest.devices[this.options.device] = this.options.profile;

    for (const op of deferred) {
      this.active();
      if (op.action !== 'push' && op.action !== 'conflict') continue;
      const group = manifest.files[op.channel];
      try {
        if (op.action === 'conflict' && op.local?.kind === 'file' && op.remote?.kind === 'file') {
          if (op.channel === 'content') {
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
        const next: RemoteEntry = op.local.kind === 'folder'
          ? { kind: 'folder', at: now, device: this.options.device } : await this.upload(op, now);
        if (op.channel === 'content') this.addParents(manifest, op.path, preview.scans.get('content'), now);
        if (op.remote?.kind === 'file') this.archive(manifest, op, op.remote, 'updated', now);
        group[op.path] = next;
        dirty = true;
      } catch (error) {
        this.fileFailure(error, op, failed, errors);
      }
    }

    const unsafeDelete = new Set([...failed, ...deferred.filter(op => op.action === 'blocked')].map(op => op.channel));
    for (const op of deferred) {
      if (op.action !== 'delete-remote') continue;
      if (unsafeDelete.has(op.channel)) continue;
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
    const latest = dirty ? await this.remote.publish(manifest, head) : head;
    const next = copyState(state, latest);
    let desktopChanged = false;

    for (const op of deferred) {
      this.active();
      if (op.action === 'blocked' || failed.has(op)) {
        counts.blocked++;
        continue;
      }
      const current = manifest.files[op.channel][op.path];
      let localStamp = stamp(op.local);
      try {
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
        if (op.action === 'pull' || op.action === 'delete-local' || conflict || (op.action === 'conflict' && !op.local)) {
          if (stamp(current) !== 'deleted' || op.local) await this.pull(op, current);
          localStamp = current?.kind === 'deleted' ? null : stamp(current);
          if (op.channel === 'desktop-config' && !op.path.startsWith('inventory/')) desktopChanged = true;
        }
        next.base[op.channel][op.path] = { local: localStamp, remote: stamp(current) };
        counts[op.action]++;
      } catch (error) {
        this.fileFailure(error, op, failed, errors, true);
        counts.blocked++;
      }
    }
    return { state: next, counts, errors, desktopChanged, devices: manifest.devices };
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

  restore(state: SyncState, id: string, save: (item: HistoryItem, bytes: ArrayBuffer) => Promise<void>): Promise<void> {
    return this.exclusive(() => this.remote.lock(async () => {
      const head = await this.remote.head(state.checkpoint);
      const item = head.manifest.history.find(entry => entry.id === id && this.options.selection.channels.includes(entry.channel));
      if (!item) throw new SyncError('missing');
      const bytes = await this.bytes(item.channel, item.path, item.file);
      this.active();
      await save(item, bytes);
    }));
  }
}
