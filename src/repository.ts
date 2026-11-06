import {
  channels, encode, hashPattern, idPattern, sha256, SyncError,
  type Channel, type Checkpoint, type Manifest, type RemoteFile,
} from './model';
import { emptyManifest, validateManifest } from './manifest';
import { ROOT, WebDav } from './webdav';

export interface Head extends Checkpoint {
  manifest: Manifest;
  pending?: boolean;
}

export class RemoteVault {
  private readonly root: string;
  private readonly meta: string;

  constructor(private readonly dav: WebDav, private readonly id: string, private readonly exclusiveMove = false) {
    if (!idPattern.test(id)) throw new SyncError('identity');
    this.root = ROOT + '/vaults/' + id;
    this.meta = this.root + '/metadata';
  }

  get serverTime(): number | null {
    return this.dav.serverTime;
  }

  static async probe(dav: WebDav): Promise<{ move: boolean; exclusiveMove: boolean }> {
    if (!await dav.collection('')) throw new SyncError('missing');
    await dav.mkdir(ROOT);
    const path = ROOT + '/probe-' + crypto.randomUUID();
    if (!await dav.mkdir(path)) throw new SyncError('integrity');
    try {
      const lock = path + '/exclusive';
      const outcomes = await Promise.allSettled([dav.mkdir(lock), dav.mkdir(lock)]);
      if (outcomes.some(result => result.status === 'rejected')
        || outcomes.filter(result => result.status === 'fulfilled' && result.value).length !== 1
        || !await dav.collection(lock)) throw new SyncError('protocol');
      const sample = encode('TotalSync probe · Проверка');
      await dav.put(path + '/sample.bin', sample);
      if (await sha256(await dav.get(path + '/sample.bin')) !== await sha256(sample)) throw new SyncError('integrity');
      const move = await dav.move(path + '/sample.bin', path + '/moved.bin');
      if (move && await sha256(await dav.get(path + '/moved.bin')) !== await sha256(sample)) throw new SyncError('integrity');
      await dav.remove(lock);
      if (await dav.collection(lock)) throw new SyncError('protocol');
      let exclusiveMove = false;
      if (move) {
        try {
          exclusiveMove = await this.probeExclusiveMove(dav, path);
        } catch (error) {
          // A partial collection MOVE response is inconclusive in the disposable probe.
          if (!(error instanceof SyncError) || error.status !== 207) throw error;
        }
      }
      return { move, exclusiveMove };
    } finally {
      await dav.remove(path);
    }
  }

  private static async probeExclusiveMove(dav: WebDav, path: string): Promise<boolean> {
    const occupied = path + '/occupied';
    const candidates = ['a', 'b'].map(name => ({ path: path + '/candidate-' + name, bytes: encode(name) }));
    await dav.mkdir(occupied);
    for (const candidate of candidates) {
      await dav.mkdir(candidate.path);
      await dav.put(candidate.path + '/index.json', candidate.bytes);
      await dav.put(candidate.path + '/ready', candidate.bytes);
    }
    // A legacy writer reserves an empty collection before filling it.
    if (await dav.moveNewCollection(candidates[0]!.path, occupied) !== 'occupied') return false;
    try {
      await dav.get(occupied + '/index.json');
      return false;
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'missing') throw error;
    }
    const target = path + '/winner';
    const results = await Promise.all(candidates.map(candidate => dav.moveNewCollection(candidate.path, target)));
    if (!results.includes('occupied') || !results.includes('moved') || await dav.mkdir(target)) return false;
    const winner = candidates[results.indexOf('moved')]!;
    return await sha256(await dav.get(target + '/index.json')) === await sha256(winner.bytes)
      && await sha256(await dav.get(target + '/ready')) === await sha256(winner.bytes);
  }

  async create(now: number): Promise<Head> {
    await this.dav.mkdir(ROOT);
    await this.dav.mkdir(ROOT + '/vaults');
    await this.dav.mkdir(this.root);
    await this.dav.mkdir(this.meta);
    return this.lock(async () => {
      await this.dav.mkdir(this.meta + '/commits');
      await this.dav.mkdir(this.meta + '/revisions');
      if (await this.committed(0)) throw new SyncError('identity');
      for (const channel of channels) await this.dav.mkdir(this.root + '/' + channel);
      return this.publish(emptyManifest(this.id, now), null);
    });
  }

  async lock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = this.meta + '/lock';
    if (!await this.dav.collection(this.meta)) throw new SyncError('missing');
    if (!await this.dav.mkdir(lockPath)) throw new SyncError('cloud-lock');
    let uncertain = false;
    try {
      return await action();
    } catch (error) {
      uncertain = error instanceof SyncError && error.code === 'uncertain';
      throw error;
    } finally {
      if (!uncertain) await this.releaseLock(lockPath);
    }
  }

  write<T>(action: () => Promise<T>): Promise<T> {
    return this.exclusiveMove ? action() : this.lock(action);
  }

  private async releaseLock(path: string): Promise<void> {
    try {
      await this.dav.remove(path);
    } catch (error) {
      const status = error instanceof SyncError ? error.status : undefined;
      // The reply can be lost after DELETE. Read the result without issuing another DELETE.
      try {
        if (!await this.dav.collection(path)) return;
      } catch {
        // The lock's disappearance could not be confirmed.
      }
      throw new SyncError('cloud-unlock', status);
    }
  }

  private committed(revision: number): Promise<boolean> {
    return this.dav.collection(this.meta + '/commits/' + revision);
  }

  private revisionPath(revision: number): string {
    return this.meta + '/revisions/' + revision + '/index.json';
  }

  private reservation(revision: number): string {
    return this.meta + '/revisions/' + revision;
  }

  private async read(revision: number): Promise<Head> {
    const bytes = await this.dav.get(this.revisionPath(revision));
    const manifest = validateManifest(bytes, this.id);
    if (manifest.revision !== revision) throw new SyncError('integrity');
    return { manifest, revision, hash: await sha256(bytes) };
  }

  async head(known: Checkpoint | null, publishedOnly = false, check?: () => void): Promise<Head> {
    check?.();
    const start = known?.revision ?? 0;
    const [marker, first, next] = await Promise.allSettled([
      this.committed(start), this.read(start), this.revisionStatus(start + 1),
    ]);
    if (marker.status === 'rejected') throw marker.reason;
    if (!marker.value) throw new SyncError(known ? 'integrity' : 'missing');
    if (first.status === 'rejected') throw first.reason;
    if (next.status === 'rejected') throw next.reason;
    let current = first.value;
    if (known && known.hash !== current.hash) throw new SyncError('integrity');
    let status = next.value;
    while (status === 'committed') {
      check?.();
      const [entry, following] = await Promise.all([
        this.read(current.revision + 1), this.revisionStatus(current.revision + 2),
      ]);
      if (entry.manifest.parent !== current.hash) throw new SyncError('integrity');
      current = entry;
      status = following;
    }
    if (status === 'reserved') {
      if (!publishedOnly) throw new SyncError('integrity');
      current.pending = true;
    }
    return current;
  }

  private async revisionStatus(revision: number): Promise<'committed' | 'reserved' | 'absent'> {
    const [marker, reservation] = await Promise.allSettled([
      this.committed(revision), this.dav.collection(this.reservation(revision)),
    ]);
    if (marker.status === 'rejected') throw marker.reason;
    if (marker.value) return 'committed';
    if (reservation.status === 'rejected') throw reservation.reason;
    if (!reservation.value) return 'absent';
    // A writer may have published the marker between the two reads.
    return await this.committed(revision) ? 'committed' : 'reserved';
  }

  async headForWrite(known: Checkpoint, check?: () => void): Promise<Head> {
    if (!this.exclusiveMove) return this.head(known, false, check);
    const head = await this.head(known, true, check);
    check?.();
    return head.pending ? this.finishPrepared(head) : head;
  }

  async publish(manifest: Manifest, previous: Head | null): Promise<Head> {
    const revision = previous ? previous.revision + 1 : 0;
    manifest.revision = revision;
    manifest.parent = previous?.hash ?? null;
    const bytes = encode(JSON.stringify(manifest));
    validateManifest(bytes, this.id);
    const hash = await sha256(bytes);
    if (previous && this.exclusiveMove) return this.publishPrepared(previous, bytes, hash);
    const path = this.revisionPath(revision);
    if (await this.committed(revision) || !await this.dav.mkdir(this.reservation(revision))) {
      throw new SyncError(previous ? 'cloud-advanced' : 'integrity');
    }
    await this.dav.put(path, bytes);
    if (await sha256(await this.dav.get(path)) !== hash) throw new SyncError('integrity');
    try {
      if (!await this.dav.mkdir(this.meta + '/commits/' + revision)) throw new SyncError('integrity');
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error;
      try {
        if (await this.committed(revision) && (await this.read(revision)).hash === hash) {
          return { manifest, revision, hash };
        }
      } catch {
        // Preserve the lock until the commit can be verified.
      }
      throw error;
    }
    return { manifest, revision, hash };
  }

  private async publishPrepared(previous: Head, bytes: ArrayBuffer, hash: string): Promise<Head> {
    const revision = previous.revision + 1;
    const target = this.reservation(revision);
    if (await this.committed(revision) || await this.dav.collection(target)) throw new SyncError('cloud-advanced');
    const staging = this.meta + '/staging';
    const source = staging + '/' + crypto.randomUUID();
    try {
      await this.dav.mkdir(staging);
      if (!await this.dav.mkdir(source)) throw new SyncError('integrity');
      await this.dav.put(source + '/index.json', bytes);
      if (await sha256(await this.dav.get(source + '/index.json')) !== hash) throw new SyncError('integrity');
      await this.dav.put(source + '/ready', encode(hash));
    } catch (error) {
      // A late write to this UUID cannot change an active revision.
      if (error instanceof SyncError && error.code === 'uncertain') throw new SyncError('upload-retry', error.status);
      throw error;
    }

    let moved;
    try {
      moved = await this.dav.moveNewCollection(source, target);
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error;
      // The move can succeed even if the connection drops before its reply.
      return this.finishPrepared(previous, hash);
    }
    if (moved === 'occupied') {
      // The losing candidate is still at its unique staging path.
      await this.dav.remove(source).catch(() => undefined);
      throw new SyncError('cloud-advanced');
    }
    if (moved !== 'moved') throw new SyncError('protocol');
    return this.finishPrepared(previous, hash);
  }

  private async finishPrepared(previous: Head, expectedHash?: string): Promise<Head> {
    const revision = previous.revision + 1;
    let ready: string;
    let prepared: Head;
    try {
      const digest = new Uint8Array(await this.dav.get(this.reservation(revision) + '/ready'));
      if (digest.byteLength !== 64) throw new SyncError('integrity');
      ready = String.fromCharCode(...digest);
      prepared = await this.read(revision);
    } catch (error) {
      if (error instanceof SyncError && error.code === 'missing') throw new SyncError('cloud-preparing');
      throw error;
    }
    if (!hashPattern.test(ready) || ready !== prepared.hash || prepared.manifest.parent !== previous.hash) {
      throw new SyncError('integrity');
    }
    if (expectedHash !== undefined && expectedHash !== prepared.hash) throw new SyncError('cloud-advanced');
    try {
      if (!await this.committed(revision)) await this.dav.mkdir(this.meta + '/commits/' + revision);
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error;
      if (!await this.committed(revision)) throw new SyncError('cloud-preparing', error.status);
    }
    return prepared;
  }

  async upload(channel: Channel, bytes: ArrayBuffer, hash: string, device: string, at: number): Promise<RemoteFile> {
    const file: RemoteFile = { kind: 'file', hash, size: bytes.byteLength, blob: crypto.randomUUID(), device, at };
    try {
      await this.dav.put(this.blobPath(channel, file.blob), bytes);
    } catch (error) {
      // A late upload to a fresh UUID cannot change a published revision.
      if (error instanceof SyncError && error.code === 'uncertain') throw new SyncError('upload-retry', error.status);
      throw error;
    }
    await this.download(channel, file);
    return file;
  }

  private blobPath(channel: Channel, blob: string): string {
    if (!idPattern.test(blob)) throw new SyncError('integrity');
    return this.root + '/' + channel + '/' + blob;
  }

  async download(channel: Channel, file: RemoteFile): Promise<ArrayBuffer> {
    const bytes = await this.dav.get(this.blobPath(channel, file.blob));
    if (bytes.byteLength !== file.size || await sha256(bytes) !== file.hash) throw new SyncError('integrity');
    return bytes;
  }

  drop(channel: Channel, blob: string): Promise<void> {
    return this.dav.remove(this.blobPath(channel, blob));
  }
}
