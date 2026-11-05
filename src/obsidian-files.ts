import { type Vault, TFile, TFolder } from 'obsidian';
import {
  channels, decode, object, parse, sha256, stamp, SyncError,
  type Channel, type HistoryItem, type LocalEntry, type LocalFiles, type Scan, type Stamp,
} from './model';
import { calendarPreferences, checkPayload, inChannel, isNote, jsonBytes, pathKey, portablePath, safePluginId, safeVersion } from './policy';

const calendar = 'plugins/calendar/preferences.json';
const recovery = 'TotalSync-Recovery';
const maxConfig = 2 * 1024 * 1024;
const inventoryPattern = /^inventory\//;
type InventoryRow = { id: string; version: string; enabled: boolean };

export class ObsidianFiles implements LocalFiles {
  private readonly actual = new Map<Channel, Map<string, string>>(channels.map(channel => [channel, new Map()]));
  private readonly base: string;
  private readonly adapter: Vault['adapter'];

  constructor(
    private readonly vault: Vault, private readonly device: string, private readonly maxBytes: number,
    private readonly attachments: boolean, private readonly exclude: readonly string[],
    private readonly preferences: boolean,
  ) {
    this.adapter = vault.adapter;
    this.base = vault.configDir + '/plugins/total-sync/local';
  }

  private contentAllowed(path: string, folder = false): boolean {
    const key = pathKey(path);
    const config = pathKey(this.vault.configDir);
    return inChannel('content', path) && key !== config && !key.startsWith(config + '/')
      && !this.exclude.some(prefix => key === prefix || key.startsWith(prefix + '/'))
      && (folder || this.attachments || isNote(path));
  }

  private path(channel: Channel, path: string): string {
    if (!inChannel(channel, path)) throw new SyncError('path');
    if (channel === 'content' && !this.contentAllowed(path, true)) throw new SyncError('path');
    const actual = this.actual.get(channel)?.get(path);
    if (actual) return actual;
    if (channel === 'content') {
      const segments = path.split('/');
      for (let end = segments.length - 1; end > 0; end--) {
        const prefix = this.actual.get('content')?.get(segments.slice(0, end).join('/'));
        if (prefix) return prefix + '/' + segments.slice(end).join('/');
      }
      return path;
    }
    if (channel === 'shared-state' || inventoryPattern.test(path)) return this.base + '/' + path;
    if (path === calendar) return this.vault.configDir + '/plugins/calendar/data.json';
    return this.vault.configDir + '/' + path;
  }

  private add(scan: Scan, channel: Channel, raw: string, actual: string, folder: boolean): void {
    if (raw.split('/').some(part => part.startsWith('.'))) return;
    const canonical = raw.normalize('NFC');
    try {
      portablePath(canonical);
      if (channel === 'content' && !this.contentAllowed(canonical, folder)) return;
      if (!inChannel(channel, canonical)) return;
      const mapped = this.actual.get(channel);
      if (mapped?.has(canonical)) {
        scan.blocked.add(canonical);
        scan.entries.delete(canonical);
      } else {
        mapped?.set(canonical, actual);
        if (folder) scan.entries.set(canonical, { kind: 'folder' });
      }
    } catch {
      scan.blocked.add(canonical);
    }
  }

  private async listFiles(dir: string): Promise<string[]> {
    const stat = await this.adapter.stat(dir);
    if (!stat) return [];
    if (stat.type !== 'folder') throw new SyncError('local');
    return (await this.adapter.list(dir)).files;
  }

  async inventory(): Promise<InventoryRow[]> {
    const config = this.vault.configDir;
    const enabledPath = config + '/community-plugins.json';
    const enabledRaw = await this.adapter.exists(enabledPath) ? parse(await this.adapter.readBinary(enabledPath)) : [];
    if (!Array.isArray(enabledRaw)) throw new SyncError('configuration');
    const enabled = new Set(enabledRaw.filter((entry): entry is string => typeof entry === 'string'));
    const directory = config + '/plugins';
    if (!await this.adapter.exists(directory)) return [];
    const folders = (await this.adapter.list(directory)).folders;
    const result: InventoryRow[] = [];
    for (const folder of folders) {
      const id = folder.slice(directory.length + 1);
      if (!safePluginId(id) || id === 'total-sync') continue;
      const manifest = folder + '/manifest.json';
      const stat = await this.adapter.stat(manifest);
      if (!stat || stat.type !== 'file' || stat.size > maxConfig) continue;
      try {
        const data = parse(await this.adapter.readBinary(manifest));
        if (object(data) && data.id === id && typeof data.version === 'string' && safeVersion(data.version)) {
          result.push({ id, version: data.version, enabled: enabled.has(id) });
        }
      } catch {
        continue;
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  async storedInventories(): Promise<{ device: string; items: InventoryRow[] }[]> {
    const result: { device: string; items: InventoryRow[] }[] = [];
    for (const actual of await this.listFiles(this.base + '/inventory')) {
      const relative = actual.slice(this.base.length + 1);
      if (!inChannel('desktop-config', relative)) continue;
      const bytes = await this.adapter.readBinary(actual);
      checkPayload('desktop-config', relative, bytes);
      result.push({ device: relative.slice('inventory/'.length, -5), items: parse(bytes) as InventoryRow[] });
    }
    return result;
  }

  private async configPaths(scan: Scan): Promise<void> {
    const config = this.vault.configDir;
    const top = await this.listFiles(config);
    const snippets = await this.listFiles(config + '/snippets');
    const themeDir = config + '/themes';
    const themes = await this.adapter.exists(themeDir) ? (await this.adapter.list(themeDir)).folders : [];
    for (const path of [...top, ...snippets]) this.add(scan, 'desktop-config', path.slice(config.length + 1), path, false);
    for (const theme of themes) {
      for (const path of await this.listFiles(theme)) this.add(scan, 'desktop-config', path.slice(config.length + 1), path, false);
    }
    if (this.preferences && await this.adapter.exists(this.path('desktop-config', calendar))) {
      this.add(scan, 'desktop-config', calendar, this.path('desktop-config', calendar), false);
    }
    for (const path of await this.listFiles(this.base + '/inventory')) {
      this.add(scan, 'desktop-config', path.slice(this.base.length + 1), path, false);
    }
    const own = 'inventory/' + this.device + '.json';
    this.actual.get('desktop-config')?.set(own, this.path('desktop-config', own));
  }

  async scan(channel: Channel): Promise<Scan> {
    const scan: Scan = { entries: new Map(), blocked: new Set(), issues: new Set() };
    this.actual.get(channel)?.clear();
    if (channel === 'content') {
      for (const file of this.vault.getAllLoadedFiles()) {
        if (file !== this.vault.getRoot() && file.path) this.add(scan, channel, file.path, file.path, file instanceof TFolder);
      }
    } else if (channel === 'shared-state') {
      const path = 'bookmarks.json';
      if (await this.adapter.exists(this.path(channel, path))) this.add(scan, channel, path, this.path(channel, path), false);
    } else {
      await this.configPaths(scan);
    }
    for (const [path] of this.actual.get(channel) ?? []) {
      if (scan.entries.has(path) || scan.blocked.has(path)) continue;
      try {
        const bytes = await this.read(channel, path);
        checkPayload(channel, path, bytes);
        scan.entries.set(path, { kind: 'file', hash: await sha256(bytes), size: bytes.byteLength });
      } catch (error) {
        scan.blocked.add(path);
        scan.issues?.add(error instanceof SyncError ? error.code : 'local');
      }
    }
    return scan;
  }

  async read(channel: Channel, path: string): Promise<ArrayBuffer> {
    const full = this.path(channel, path);
    if (channel === 'desktop-config' && path === 'inventory/' + this.device + '.json') return jsonBytes(await this.inventory());
    const stat = await this.adapter.stat(full);
    if (!stat || stat.type !== 'file') throw new SyncError('changed');
    if (stat.size > (channel === 'content' ? this.maxBytes : maxConfig)) throw new SyncError('size');
    if (channel === 'content') {
      const file = this.vault.getAbstractFileByPath(full);
      if (!(file instanceof TFile)) throw new SyncError('changed');
      return this.vault.readBinary(file);
    }
    const bytes = await this.adapter.readBinary(full);
    if (channel === 'desktop-config' && path === calendar) return jsonBytes(calendarPreferences(parse(bytes)));
    return bytes;
  }

  private async createParents(full: string, content: boolean): Promise<void> {
    const segments = full.split('/');
    segments.pop();
    let path = '';
    for (const segment of segments) {
      path = path ? path + '/' + segment : segment;
      const stat = await this.adapter.stat(path);
      if (stat?.type === 'file') throw new SyncError('path');
      if (!stat) {
        if (content) await this.vault.createFolder(path);
        else await this.adapter.mkdir(path);
      }
    }
  }

  private async current(channel: Channel, path: string): Promise<Stamp> {
    const stat = await this.adapter.stat(this.path(channel, path));
    if (!stat) return null;
    if (stat.type === 'folder') return 'folder';
    return 'file:' + await sha256(await this.read(channel, path));
  }

  async verify(channel: Channel, path: string, expected: Stamp): Promise<void> {
    if (await this.current(channel, path) !== expected) throw new SyncError('changed');
  }

  private async backup(full: string): Promise<void> {
    const bytes = await this.adapter.readBinary(full);
    const hash = await sha256(bytes);
    const path = this.base + '/backups/' + hash + '.bin';
    await this.createParents(path, false);
    if (!await this.adapter.exists(path)) await this.adapter.writeBinary(path, bytes);
    if (await sha256(await this.adapter.readBinary(path)) !== hash) throw new SyncError('local');
  }

  private async writeConfig(channel: Channel, path: string, full: string, bytes: ArrayBuffer, expected: Stamp): Promise<void> {
    const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let output = bytes;
    const calendarFile = channel === 'desktop-config' && path === calendar;
    if (expected?.startsWith('file:')) {
      const original = await this.adapter.readBinary(full);
      const existing = calendarFile ? parse(original) : null;
      const projection = calendarFile ? jsonBytes(calendarPreferences(existing)) : original;
      if ('file:' + await sha256(projection) !== expected) throw new SyncError('changed');
      if (calendarFile) {
        if (!object(existing)) throw new SyncError('configuration');
        const merged = { ...existing };
        for (const key of Object.keys(calendarPreferences(existing))) delete merged[key];
        output = jsonBytes({ ...merged, ...calendarPreferences(parse(bytes)) });
      }
      const before = utf8.decode(original);
      const after = utf8.decode(output);
      await this.adapter.process(full, text => {
        if (text !== before) throw new SyncError('changed');
        return after;
      });
      return;
    }
    const stage = this.base + '/staging/' + crypto.randomUUID() + '.bin';
    await this.createParents(stage, false);
    await this.adapter.writeBinary(stage, output);
    if (await sha256(await this.adapter.readBinary(stage)) !== await sha256(output)) throw new SyncError('local');
    if (await this.adapter.exists(full)) throw new SyncError('changed');
    await this.adapter.rename(stage, full);
  }

  async apply(channel: Channel, path: string, expected: Stamp, next: LocalEntry | null, bytes?: ArrayBuffer): Promise<void> {
    const full = this.path(channel, path);
    if (channel === 'desktop-config' && path === calendar && !this.preferences) throw new SyncError('configuration');
    if (bytes) checkPayload(channel, path, bytes);
    const actual = await this.current(channel, path);
    if (actual === stamp(next)) return;
    if (actual !== expected) throw new SyncError('changed');
    if (actual?.startsWith('file:')) await this.backup(full);
    await this.createParents(full, channel === 'content');
    if (actual !== await this.current(channel, path)) throw new SyncError('changed');
    if (channel === 'content') {
      const target = this.vault.getAbstractFileByPath(full);
      if (!next && target instanceof TFolder) {
        const list = await this.adapter.list(full);
        if (list.files.length || list.folders.length) throw new SyncError('changed');
        await this.vault.delete(target, false);
      } else if (!next && target instanceof TFile) await this.vault.trash(target, false);
      else if (next?.kind === 'folder' && !target && !actual) await this.vault.createFolder(full);
      else if (bytes && target instanceof TFile && actual?.startsWith('file:')) {
        if (target.extension.toLowerCase() === 'md') {
          let markdown: { before: string; after: string } | undefined;
          try {
            const before = decode(await this.vault.readBinary(target));
            const after = decode(bytes);
            if (await sha256(new TextEncoder().encode(before).buffer) === expected?.slice(5)
              && await sha256(new TextEncoder().encode(after).buffer) === stamp(next)?.slice(5)) markdown = { before, after };
          } catch {
            // Preserve non-UTF-8 and BOM-containing Markdown as binary.
          }
          if (!markdown) {
            await this.verify(channel, path, expected);
            await this.vault.modifyBinary(target, bytes);
          }
          else await this.vault.process(target, text => {
            if (text !== markdown.before) throw new SyncError('changed');
            return markdown.after;
          });
        } else await this.vault.modifyBinary(target, bytes);
      } else if (bytes && !target && !actual) await this.vault.createBinary(full, bytes);
      else throw new SyncError('changed');
    } else if (bytes) {
      await this.writeConfig(channel, path, full, bytes, actual);
    } else if (actual?.startsWith('file:')) {
      if (channel === 'desktop-config' && path === calendar) throw new SyncError('configuration');
      await this.adapter.remove(full);
    }
    if (await this.current(channel, path) !== stamp(next)) throw new SyncError('local');
  }

  async stageBookmarks(): Promise<void> {
    const src = this.vault.configDir + '/bookmarks.json';
    const stat = await this.adapter.stat(src);
    if (!stat || stat.type !== 'file' || stat.size > maxConfig) throw new SyncError('configuration');
    const bytes = await this.adapter.readBinary(src);
    const path = 'bookmarks.json';
    checkPayload('shared-state', path, bytes);
    const next = { kind: 'file' as const, size: bytes.byteLength, hash: await sha256(bytes) };
    await this.apply('shared-state', path, await this.current('shared-state', path), next, bytes);
  }

  async exportBookmarks(): Promise<void> {
    const bytes = await this.read('shared-state', 'bookmarks.json');
    checkPayload('shared-state', 'bookmarks.json', bytes);
    await this.saveCopy('bookmarks.json', bytes);
  }

  async saveCopy(path: string, bytes: ArrayBuffer): Promise<void> {
    const leaf = path.slice(path.lastIndexOf('/') + 1);
    const target = recovery + '/' + crypto.randomUUID().slice(0, 12) + '/' + leaf;
    await this.createParents(target, true);
    await this.vault.createBinary(target, bytes);
  }

  async restore(item: HistoryItem, bytes: ArrayBuffer, original: boolean): Promise<void> {
    if (!original || item.channel !== 'content') return this.saveCopy(item.path, bytes);
    const target = this.path(item.channel, item.path);
    if (await this.adapter.exists(target)) throw new SyncError('changed');
    await this.createParents(target, true);
    await this.vault.createBinary(target, bytes);
  }
}
