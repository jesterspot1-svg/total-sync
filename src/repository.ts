import {
  channels, encode, idPattern, sha256, SyncError,
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

  constructor(private readonly dav: WebDav, private readonly id: string) {
    if (!idPattern.test(id)) throw new SyncError('identity');
    this.root = ROOT + '/vaults/' + id;
    this.meta = this.root + '/metadata';
  }

  get serverTime(): number | null {
    return this.dav.serverTime;
  }

  static async probe(dav: WebDav): Promise<{ move: boolean }> {
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
      return { move };
    } finally {
      await dav.remove(path);
    }
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

  async head(known: Checkpoint | null, publishedOnly = false): Promise<Head> {
    const start = known?.revision ?? 0;
    if (!await this.committed(start)) throw new SyncError(known ? 'integrity' : 'missing');
    let current = await this.read(start);
    if (known && known.hash !== current.hash) throw new SyncError('integrity');
    while (await this.committed(current.revision + 1)) {
      const next = await this.read(current.revision + 1);
      if (next.manifest.parent !== current.hash) throw new SyncError('integrity');
      current = next;
    }
    if (await this.dav.collection(this.reservation(current.revision + 1))) {
      if (!publishedOnly) throw new SyncError('integrity');
      current.pending = true;
    }
    return current;
  }

  async publish(manifest: Manifest, previous: Head | null): Promise<Head> {
    const revision = previous ? previous.revision + 1 : 0;
    manifest.revision = revision;
    manifest.parent = previous?.hash ?? null;
    const bytes = encode(JSON.stringify(manifest));
    validateManifest(bytes, this.id);
    const hash = await sha256(bytes);
    const path = this.revisionPath(revision);
    if (await this.committed(revision) || !await this.dav.mkdir(this.reservation(revision))) throw new SyncError('integrity');
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
