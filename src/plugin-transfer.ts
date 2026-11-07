import { encode, hashPattern, idPattern, object, parse, sha256, SyncError } from './model';
import { ROOT, type WebDav } from './webdav';
import { canonical, encodeHead, verifyHead, type BlobRef, type SignedHead, type VerifiedHead } from './plugin-profile';

export class PluginTransfer {
  private readonly root: string;
  constructor(private readonly dav: Pick<WebDav, 'get' | 'put' | 'mkdir'>, private readonly vault: string,
    private readonly check: () => void = () => {}) {
    if (!idPattern.test(vault)) throw new SyncError('identity');
    this.root = ROOT + '/vaults/' + vault + '/plugin-profiles-v1';
  }
  async head(device: string): Promise<VerifiedHead | null> {
    if (!idPattern.test(device)) throw new SyncError('identity');
    this.check();
    try { return await verifyHead(await this.dav.get(this.root + '/' + device + '.json'), this.vault, device); }
    catch (error) { if (error instanceof SyncError && error.code === 'missing') return null; throw error; }
  }
  async archived(device: string, seq: number): Promise<VerifiedHead> {
    if (!idPattern.test(device) || !Number.isSafeInteger(seq) || seq < 1) throw new SyncError('identity');
    this.check();
    return verifyHead(await this.dav.get(this.root + '/history/' + device + '/' + seq + '.json'), this.vault, device);
  }
  async publish(device: string, envelope: SignedHead): Promise<void> {
    const bytes = encodeHead(envelope);
    const verified = await verifyHead(bytes, this.vault, device);
    const expectedHash = await sha256(bytes);
    this.check();
    await this.dav.mkdir(this.root);
    await this.dav.mkdir(this.root + '/history');
    await this.dav.mkdir(this.root + '/history/' + device);
    const historyPath = this.root + '/history/' + device + '/' + verified.data.seq + '.json';
    let old: VerifiedHead | undefined;
    try {
      old = await verifyHead(await this.dav.get(historyPath), this.vault, device);
    } catch (error) {
      // A truncated upload is not a published signed revision. Retry it from the durable outbox.
      if (!(error instanceof SyncError) || !['missing', 'integrity', 'configuration', 'protocol'].includes(error.code)) throw error;
    }
    // A different valid signed revision must never be overwritten, even at our own sequence number.
    if (old && (old.fingerprint !== verified.fingerprint || old.envelope.body !== envelope.body)) throw new SyncError('integrity');
    if (!old) {
      try { await this.dav.put(historyPath, bytes); }
      catch (error) { if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error; }
      if (await sha256(await this.dav.get(historyPath)) !== expectedHash) throw new SyncError('integrity');
    }
    // Each device owns a different head. No shared collection lock or numbered revision is needed.
    const path = this.root + '/' + device + '.json';
    try { await this.dav.put(path, bytes); }
    catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error;
      if (await sha256(await this.dav.get(path)) !== expectedHash) throw error;
      return;
    }
    if (await sha256(await this.dav.get(path)) !== expectedHash) throw new SyncError('integrity');
  }
  async blob(ref: BlobRef): Promise<ArrayBuffer> {
    if (!hashPattern.test(ref.hash)) throw new SyncError('integrity');
    this.check();
    const bytes = await this.dav.get(this.root + '/blobs/' + ref.hash);
    if (bytes.byteLength !== ref.size || await sha256(bytes) !== ref.hash) throw new SyncError('integrity');
    this.check();
    return bytes;
  }
  async upload(bytes: ArrayBuffer): Promise<BlobRef> {
    const ref = { hash: await sha256(bytes), size: bytes.byteLength };
    this.check();
    try { await this.blob(ref); return ref; }
    catch (error) { if (!(error instanceof SyncError) || !['missing', 'integrity'].includes(error.code)) throw error; }
    await this.dav.mkdir(this.root);
    await this.dav.mkdir(this.root + '/blobs');
    try { await this.dav.put(this.root + '/blobs/' + ref.hash, bytes); }
    catch (error) {
      if (!(error instanceof SyncError) || error.code !== 'uncertain') throw error;
      await this.blob(ref);
      return ref;
    }
    await this.blob(ref);
    return ref;
  }
}

export type PublicFetch = (url: string) => Promise<ArrayBuffer>;
export class PluginCatalog {
  private registry?: Map<string, string>;
  constructor(private readonly fetch: PublicFetch) {}
  async repository(id: string): Promise<string | undefined> {
    if (!this.registry) {
      const bytes = await this.fetch('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json');
      if (bytes.byteLength > 16 * 1024 * 1024) throw new SyncError('size');
      const rows: unknown = parse(bytes);
      if (!Array.isArray(rows)) throw new SyncError('protocol');
      this.registry = new Map();
      for (const row of rows) if (object(row) && typeof row.id === 'string' && typeof row.repo === 'string'
        && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(row.repo)) this.registry.set(row.id, row.repo);
    }
    return this.registry.get(id);
  }
  async package(id: string, version: string, refs: Record<string, BlobRef>): Promise<Map<string, ArrayBuffer> | null> {
    const repository = await this.repository(id);
    if (!repository) return null;
    if (Object.keys(refs).some(name => !['main.js', 'manifest.json', 'styles.css'].includes(name))) return null;
    for (const tag of [version, 'v' + version]) {
      const result = new Map<string, ArrayBuffer>();
      try {
        for (const [name, ref] of Object.entries(refs)) {
          const downloaded = await this.fetch('https://github.com/' + repository + '/releases/download/' + encodeURIComponent(tag) + '/' + name);
          const bytes = name === 'manifest.json' ? encode(canonical(parse(downloaded))) : downloaded;
          if (bytes.byteLength !== ref.size || await sha256(bytes) !== ref.hash) { result.clear(); break; }
          result.set(name, bytes);
        }
        if (result.size === Object.keys(refs).length) return result;
      } catch (error) {
        if (!(error instanceof SyncError) || !['missing', 'integrity'].includes(error.code)) throw error;
      }
    }
    return null;
  }
}
