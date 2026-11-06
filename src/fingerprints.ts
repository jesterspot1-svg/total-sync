import { sha256, SyncError, type LocalEntry } from './model';

type Stat = { mtime: number; ctime: number; size: number };
type Fingerprint = Extract<LocalEntry, { kind: 'file' }>;
const ttl = 15 * 60_000;

function same(a: Stat, b: Stat): boolean {
  return a.mtime === b.mtime && a.ctime === b.ctime && a.size === b.size;
}

export class Fingerprints<T extends object> {
  private readonly cached = new WeakMap<T, { stat: Stat; result: Fingerprint; at: number }>();
  private readonly generation = new WeakMap<T, number>();

  invalidate(file: T): void {
    this.cached.delete(file);
    this.generation.set(file, (this.generation.get(file) ?? 0) + 1);
  }

  async scan(file: T, stat: () => Stat, read: () => Promise<ArrayBuffer>, now = Date.now()): Promise<Fingerprint> {
    const before = { ...stat() };
    const saved = this.cached.get(file);
    if (saved && now >= saved.at && now - saved.at < ttl && same(saved.stat, before)) return saved.result;
    const generation = this.generation.get(file);
    const bytes = await read();
    const result: Fingerprint = { kind: 'file', hash: await sha256(bytes), size: bytes.byteLength };
    if (result.size !== before.size || !same(stat(), before) || generation !== this.generation.get(file)) {
      throw new SyncError('changed');
    }
    this.cached.set(file, { stat: before, result, at: now });
    return result;
  }
}
