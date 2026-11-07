import { encode, object, parse, sha256, SyncError } from './model';
import { safePluginId, safeVersion } from './policy';
import { canonical, fieldName, isRemoved, packageNames, settingValue, type FieldValue, type PluginPackage } from './plugin-profile';
import { allowedPreference, needsLocalValue, preferences } from './plugin-preferences';

export interface PluginDisk {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: 'file' | 'folder'; size: number; mtime: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
export interface InstalledPlugin { id: string; pkg: PluginPackage; enabled: boolean; settings: Record<string, FieldValue>; localFields: string[]; requiredLocal: string[] }
export interface PluginRuntime {
  loaded(id: string): boolean;
  unload(id: string): Promise<void>;
  reloadManifests(): Promise<void>;
  enable(id: string, enabled: boolean): Promise<void>;
  compatible(minVersion: string): boolean;
  canReloadSettings?(id: string): boolean;
  reloadSettings?(id: string): Promise<void>;
}
type BackupFile = { name: string; before: string | null; after: string | null };
interface Transaction { schema: 1; id: string; token: string; enabled: boolean; hot: boolean; phase: 'prepared' | 'writing'; files: BackupFile[] }

export class PluginFiles {
  readonly base: string;
  private readonly cache = new Map<string, { sourceSize: number; size: number; mtime: number; hash: string }>();
  constructor(readonly disk: PluginDisk, readonly configDir: string, private readonly runtime: PluginRuntime,
    readonly extra: Record<string, string[]> = {}) {
    this.extra = Object.assign(Object.create(null) as Record<string, string[]>, extra);
    this.base = configDir + '/plugins/total-sync/local/plugin-profiles-v1';
  }
  async mkdir(path: string): Promise<void> {
    let current = '';
    for (const segment of path.split('/')) {
      current = current ? current + '/' + segment : segment;
      if (!await this.disk.exists(current)) await this.disk.mkdir(current);
    }
  }
  async read(path: string): Promise<unknown> { return parse(await this.disk.readBinary(path)); }
  async write(path: string, value: unknown): Promise<void> {
    await this.mkdir(path.slice(0, path.lastIndexOf('/')));
    const bytes = encode(JSON.stringify(value));
    await this.disk.writeBinary(path, bytes);
    if (await sha256(await this.disk.readBinary(path)) !== await sha256(bytes)) throw new SyncError('local');
  }
  private dir(id: string): string {
    if (!safePluginId(id) || id === 'total-sync') throw new SyncError('path');
    return this.configDir + '/plugins/' + id;
  }
  async enabled(): Promise<string[]> {
    const path = this.configDir + '/community-plugins.json';
    if (!await this.disk.exists(path)) return [];
    const data = await this.read(path);
    if (!Array.isArray(data) || !data.every((x): x is string => typeof x === 'string' && safePluginId(x))) throw new SyncError('configuration');
    return data;
  }
  async watchStamp(): Promise<string> {
    const root = this.configDir + '/plugins';
    const folders = await this.disk.exists(root) ? (await this.disk.list(root)).folders : [];
    const paths = [this.configDir + '/community-plugins.json'];
    for (const folder of folders) {
      if (folder === root + '/total-sync') continue;
      for (const name of [...packageNames, 'data.json']) paths.push(folder + '/' + name);
    }
    const stats = [];
    for (const path of paths.sort()) {
      const stat = await this.disk.stat(path);
      stats.push([path, stat?.size ?? null, stat?.mtime ?? null]);
    }
    return canonical(stats);
  }
  async rawSettings(id: string): Promise<Record<string, unknown>> {
    const path = this.dir(id) + '/data.json';
    if (!await this.disk.exists(path)) return {};
    const stat = await this.disk.stat(path);
    if (!stat || stat.size > 2 * 1024 * 1024) throw new SyncError('size');
    const data = await this.read(path);
    if (!object(data)) throw new SyncError('configuration');
    return data;
  }
  async packageBytes(id: string, name: string): Promise<ArrayBuffer> {
    if (!packageNames.includes(name as typeof packageNames[number])) throw new SyncError('path');
    const path = this.dir(id) + '/' + name;
    const stat = await this.disk.stat(path);
    if (!stat || stat.type !== 'file' || stat.size > 128 * 1024 * 1024) throw new SyncError('size');
    const bytes = await this.disk.readBinary(path);
    return name === 'manifest.json' ? encode(canonical(parse(bytes))) : bytes;
  }
  async scan(force = false, onlyId?: string): Promise<InstalledPlugin[]> {
    const root = this.configDir + '/plugins';
    if (!await this.disk.exists(root)) return [];
    const enabled = new Set(await this.enabled());
    const result: InstalledPlugin[] = [];
    const directories = onlyId === undefined ? (await this.disk.list(root)).folders : [this.dir(onlyId)];
    for (const dir of directories) {
      const id = dir.slice(root.length + 1);
      if (!safePluginId(id) || id === 'total-sync' || !await this.disk.exists(dir + '/manifest.json')) continue;
      const manifestBytes = await this.packageBytes(id, 'manifest.json');
      const manifest = parse(manifestBytes);
      if (!object(manifest) || manifest.id !== id || typeof manifest.version !== 'string' || !safeVersion(manifest.version)) throw new SyncError('configuration');
      const pkg: PluginPackage = { version: manifest.version, files: {} };
      for (const name of packageNames) {
        const path = dir + '/' + name;
        const stat = await this.disk.stat(path);
        if (!stat) continue;
        if (stat.type !== 'file' || stat.size > 128 * 1024 * 1024 || stat.size === 0) throw new SyncError('size');
        let cached = this.cache.get(path);
        if (force || !cached || cached.sourceSize !== stat.size || cached.mtime !== stat.mtime) {
          const bytes = name === 'manifest.json' ? manifestBytes : await this.packageBytes(id, name);
          cached = { sourceSize: stat.size, size: bytes.byteLength, mtime: stat.mtime, hash: await sha256(bytes) };
          this.cache.set(path, cached);
        }
        pkg.files[name] = { hash: cached.hash, size: cached.size };
      }
      if (!pkg.files['main.js'] || !pkg.files['manifest.json']) throw new SyncError('configuration');
      const raw = await this.rawSettings(id);
      const settings = preferences(id, raw, this.extra[id]);
      result.push({ id, pkg, enabled: enabled.has(id), settings,
        localFields: Object.keys(raw).filter(k => !Object.prototype.hasOwnProperty.call(settings, k)).sort(),
        requiredLocal: Object.keys(raw).filter(k => !Object.prototype.hasOwnProperty.call(settings, k) && needsLocalValue(k, raw[k])).sort() });
    }
    return result;
  }
  private invalidate(id: string): void {
    const prefix = this.dir(id) + '/';
    for (const path of this.cache.keys()) if (path.startsWith(prefix)) this.cache.delete(path);
  }
  fields(plugins: InstalledPlugin[]): Record<string, FieldValue> {
    const result: Record<string, FieldValue> = {};
    for (const plugin of plugins) {
      result[fieldName(plugin.id, 'package')] = plugin.pkg;
      result[fieldName(plugin.id, 'enabled')] = plugin.enabled;
      for (const [key, value] of Object.entries(plugin.settings)) result[fieldName(plugin.id, 'setting', key)] = value;
    }
    return result;
  }
  loaded(id: string): boolean { return this.runtime.loaded(id); }
  canReloadSettings(id: string): boolean { return this.runtime.canReloadSettings?.(id) === true; }
  async interrupted(): Promise<boolean> {
    return await this.disk.exists(this.base + '/transaction.json') || await this.disk.exists(this.base + '/transaction-backup.json');
  }
  private async journal(tx: Transaction): Promise<void> {
    const current = this.base + '/transaction.json', backup = this.base + '/transaction-backup.json';
    if (tx.phase === 'prepared') { await this.write(backup, tx); await this.write(current, tx); }
    else { await this.write(current, tx); await this.write(backup, tx); }
  }
  private async clearJournal(): Promise<void> {
    for (const name of ['transaction.json', 'transaction-backup.json']) {
      if (await this.disk.exists(this.base + '/' + name)) await this.disk.remove(this.base + '/' + name);
    }
  }

  async apply(id: string, expected: InstalledPlugin | undefined, pkg: PluginPackage | null,
    files: Map<string, ArrayBuffer>, settings: Record<string, FieldValue>, enabled: boolean): Promise<void> {
    if (await this.interrupted()) throw new SyncError('plugin-recovery');
    const dir = this.dir(id);
    const current = (await this.scan(true, id))[0];
    if (canonical(current ?? null) !== canonical(expected ?? null)) throw new SyncError('changed');
    const writes = new Map(files);
    if (Object.keys(settings).some(key => !allowedPreference(id, key, this.extra[id]))) throw new SyncError('configuration');
    const removals = new Set<string>();
    if (pkg) {
      const manifestBytes = writes.get('manifest.json') ?? await this.packageBytes(id, 'manifest.json');
      const manifest = parse(manifestBytes);
      if (!object(manifest) || manifest.id !== id || manifest.version !== pkg.version
        || typeof manifest.minAppVersion !== 'string' || !this.runtime.compatible(manifest.minAppVersion)) throw new SyncError('plugin-version');
      for (const name of packageNames) {
        if (expected?.pkg.files[name] && !pkg.files[name]) removals.add(name);
        const bytes = writes.get(name);
        const ref = pkg.files[name];
        if (bytes && (!ref || bytes.byteLength !== ref.size || await sha256(bytes) !== ref.hash)) throw new SyncError('integrity');
      }
      const raw = await this.rawSettings(id);
      for (const [key, value] of Object.entries(settings)) {
        if (isRemoved(value)) delete raw[key]; else raw[key] = value;
      }
      if (Object.keys(settings).length) writes.set('data.json', encode(JSON.stringify(raw)));
    } else for (const name of packageNames) if (expected?.pkg.files[name]) removals.add(name);
    const hot = !!expected && canonical(expected.pkg) === canonical(pkg) && expected.enabled === enabled
      && this.runtime.loaded(id) && this.canReloadSettings(id);
    const tx: Transaction = { schema: 1, id, token: crypto.randomUUID(), enabled: expected?.enabled ?? false, hot, phase: 'prepared', files: [] };
    const backup = this.base + '/backups/' + tx.token;
    await this.mkdir(backup);
    for (const name of new Set([...writes.keys(), ...removals])) {
      if (![...packageNames, 'data.json'].includes(name)) throw new SyncError('path');
      const before = await this.disk.exists(dir + '/' + name) ? await this.disk.readBinary(dir + '/' + name) : null;
      if (before) await this.disk.writeBinary(backup + '/' + name, before);
      const after = writes.get(name);
      tx.files.push({ name, before: before ? await sha256(before) : null, after: after ? await sha256(after) : null });
    }
    // Backups and the journal are verified before unloading or touching the installed files.
    for (const file of tx.files) if (file.before && await sha256(await this.disk.readBinary(backup + '/' + file.name)) !== file.before) throw new SyncError('local');
    await this.journal(tx);
    try {
      if (!hot && this.runtime.loaded(id)) await this.runtime.unload(id);
      // unload hooks may flush data.json; preserve new local secrets, but never hide portable edits.
      const afterUnload = (await this.scan(true, id))[0];
      if (canonical(afterUnload ?? null) !== canonical(expected ?? null)) throw new SyncError('changed');
      if (writes.has('data.json')) {
        const raw = await this.rawSettings(id);
        for (const [key, value] of Object.entries(settings)) { if (isRemoved(value)) delete raw[key]; else raw[key] = value; }
        writes.set('data.json', encode(JSON.stringify(raw)));
      }
      for (const file of tx.files) {
        const before = await this.disk.exists(dir + '/' + file.name) ? await this.disk.readBinary(dir + '/' + file.name) : null;
        if (before) {
          await this.disk.writeBinary(backup + '/' + file.name, before);
          if (await sha256(await this.disk.readBinary(backup + '/' + file.name)) !== await sha256(before)) throw new SyncError('local');
        }
        file.before = before ? await sha256(before) : null;
        file.after = writes.has(file.name) ? await sha256(writes.get(file.name)!) : null;
      }
      tx.phase = 'writing';
      await this.write(backup + '/record.json', { ...tx, at: Date.now(), version: expected?.pkg.version ?? null, nextVersion: pkg?.version ?? null });
      await this.journal(tx);
      await this.mkdir(dir);
      for (const [name, bytes] of writes) {
        await this.disk.writeBinary(dir + '/' + name, bytes);
        if (await sha256(await this.disk.readBinary(dir + '/' + name)) !== await sha256(bytes)) throw new SyncError('local');
      }
      for (const name of removals) if (await this.disk.exists(dir + '/' + name)) await this.disk.remove(dir + '/' + name);
      if (hot) await this.runtime.reloadSettings!(id);
      else { await this.runtime.reloadManifests(); await this.runtime.enable(id, pkg !== null && enabled); }
      const applied = (await this.scan(true, id))[0];
      if (canonical(applied?.pkg ?? null) !== canonical(pkg) || (applied?.enabled ?? false) !== (pkg !== null && enabled)
        || (pkg && Object.entries(settings).some(([key, value]) => canonical(settingValue(applied?.settings ?? {}, key)) !== canonical(value)))) throw new SyncError('changed');
      await this.clearJournal();
      this.invalidate(id);
    } catch (error) {
      await this.recover();
      throw error;
    }
  }
  async recover(force = false): Promise<void> {
    const journal = this.base + '/transaction.json';
    if (!await this.interrupted()) return;
    let value: unknown;
    try { value = await this.read(journal); }
    catch { value = await this.read(this.base + '/transaction-backup.json'); }
    if (!object(value) || value.schema !== 1 || typeof value.id !== 'string' || typeof value.token !== 'string'
      || !/^[a-f0-9-]{36}$/.test(value.token) || typeof value.enabled !== 'boolean' || !Array.isArray(value.files)
      || !['prepared', 'writing'].includes(String(value.phase))) throw new SyncError('integrity');
    const tx = value as unknown as Transaction;
    const dir = this.dir(tx.id);
    if (tx.phase === 'prepared') {
      if (!tx.hot) await this.runtime.enable(tx.id, tx.enabled);
      await this.clearJournal();
      return;
    }
    const backup = this.base + '/backups/' + tx.token;
    const originals = new Map<string, ArrayBuffer | null>();
    for (const file of tx.files) {
      if (!file || ![...packageNames, 'data.json'].includes(file.name)) throw new SyncError('integrity');
      const bytes = file.before ? await this.disk.readBinary(backup + '/' + file.name) : null;
      if (bytes && await sha256(bytes) !== file.before) throw new SyncError('integrity');
      originals.set(file.name, bytes);
    }
    const hot = tx.hot && !force && this.runtime.loaded(tx.id) && this.canReloadSettings(tx.id);
    if (!hot && this.runtime.loaded(tx.id)) await this.runtime.unload(tx.id);
    for (const [name, bytes] of originals) {
      const path = dir + '/' + name;
      if (await this.disk.exists(path)) {
        const current = await this.disk.readBinary(path);
        const hash = await sha256(current);
        const expected = tx.files.find(file => file.name === name)!;
        if (hash !== expected.before && hash !== expected.after) await this.disk.writeBinary(backup + '/recovery-current-' + name, current);
      }
      if (bytes) {
        await this.disk.writeBinary(dir + '/' + name, bytes);
        if (await sha256(await this.disk.readBinary(dir + '/' + name)) !== await sha256(bytes)) throw new SyncError('local');
      } else if (await this.disk.exists(dir + '/' + name)) await this.disk.remove(dir + '/' + name);
    }
    if (hot) await this.runtime.reloadSettings!(tx.id);
    else { await this.runtime.reloadManifests(); await this.runtime.enable(tx.id, tx.enabled); }
    await this.clearJournal();
    this.invalidate(tx.id);
  }
}
