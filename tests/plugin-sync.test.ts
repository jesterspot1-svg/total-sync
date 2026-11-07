import assert from 'node:assert/strict';
import test from 'node:test';
import { decode, encode, parse, SyncError } from '../src/model';
import { PluginFiles, type PluginDisk, type PluginRuntime } from '../src/plugin-disk';
import { candidates, encodeHead, loadSigningKey, newSigningKey, signHead, verifyHead, type PluginHead } from '../src/plugin-profile';
import { preferences, safePreferenceKey } from '../src/plugin-preferences';
import { PluginSync, type PluginSyncState } from '../src/plugin-sync';
import { PluginCatalog, PluginTransfer } from '../src/plugin-transfer';
import { DavServer } from './fixture';
import { RemoteVault } from '../src/repository';

const vault = '10000000-0000-4000-8000-000000000000';
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000003';
const config = '.custom-config';
const missing = () => new SyncError('missing', 404);

class Disk implements PluginDisk {
  reads: string[] = [];
  data = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  mtimes = new Map<string, number>();
  tick = 0;
  failWrite?: (path: string) => boolean;
  async exists(path: string) { return this.data.has(path) || this.folders.has(path); }
  async stat(path: string) {
    const bytes = this.data.get(path);
    return bytes ? { type: 'file' as const, size: bytes.byteLength, mtime: this.mtimes.get(path) ?? 0 }
      : this.folders.has(path) ? { type: 'folder' as const, size: 0, mtime: 0 } : null;
  }
  async list(path: string) {
    const direct = (p: string) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/');
    return { files: [...this.data.keys()].filter(direct), folders: [...this.folders].filter(direct) };
  }
  async readBinary(path: string) { this.reads.push(path); const value = this.data.get(path); if (!value) throw missing(); return value.slice(0); }
  async writeBinary(path: string, bytes: ArrayBuffer) {
    if (this.failWrite?.(path)) throw new SyncError('local');
    if (!this.folders.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('Missing parent: ' + path);
    this.data.set(path, bytes.slice(0)); this.mtimes.set(path, ++this.tick);
  }
  async mkdir(path: string) { this.folders.add(path); }
  async remove(path: string) { this.data.delete(path); }
  async rename(from: string, to: string) { await this.writeBinary(to, await this.readBinary(from)); await this.remove(from); }
}
class Cloud {
  data = new Map<string, ArrayBuffer>();
  writes: string[] = [];
  uncertain = false;
  fail?: (path: string) => boolean;
  async get(path: string) { const bytes = this.data.get(path); if (!bytes) throw missing(); return bytes.slice(0); }
  async mkdir() { return true; }
  async put(path: string, bytes: ArrayBuffer) {
    if (this.fail?.(path)) throw new SyncError('network');
    this.writes.push(path); this.data.set(path, bytes.slice(0));
    if (this.uncertain) throw new SyncError('uncertain', 504);
  }
}
class Runtime implements PluginRuntime {
  live = new Set<string>();
  failEnable?: string;
  onUnload?: (id: string) => Promise<void>;
  onEnable?: (id: string) => Promise<void>;
  onReloadSettings?: (id: string) => Promise<void>;
  constructor(private disk: Disk) {}
  loaded(id: string) { return this.live.has(id); }
  async unload(id: string) { this.live.delete(id); await this.onUnload?.(id); }
  async reloadManifests() {}
  async enable(id: string, enabled: boolean) {
    if (this.failEnable === id && enabled) { this.failEnable = undefined; throw new SyncError('local'); }
    const path = config + '/community-plugins.json';
    const list = await this.disk.exists(path) ? parse(await this.disk.readBinary(path)) as string[] : [];
    const next = list.filter(x => x !== id);
    if (enabled) { next.push(id); this.live.add(id); } else this.live.delete(id);
    await this.disk.writeBinary(path, encode(JSON.stringify(next)));
    if (enabled) await this.onEnable?.(id);
  }
  compatible(min: string) { return min !== '999.0.0'; }
  canReloadSettings() { return !!this.onReloadSettings; }
  async reloadSettings(id: string) { await this.onReloadSettings?.(id); }
}
interface Client {
  sync: PluginSync; files: PluginFiles; disk: Disk; runtime: Runtime;
  state: () => PluginSyncState | null; restart: () => void;
}
async function client(device: string, cloud: Cloud, publicFiles = new Map<string, ArrayBuffer>()): Promise<Client> {
  const disk = new Disk();
  const runtime = new Runtime(disk);
  const files = new PluginFiles(disk, config, runtime);
  await files.mkdir(config + '/plugins');
  await files.write(config + '/community-plugins.json', ['total-sync']);
  let saved: PluginSyncState | null = null;
  const signingKey = await newSigningKey();
  const transfer = new PluginTransfer(cloud, vault);
  const catalog = new PluginCatalog(async url => {
    const bytes = publicFiles.get(url);
    if (!bytes) {
      if (url.endsWith('community-plugins.json')) return encode('[]');
      throw missing();
    }
    return bytes;
  });
  const make = () => new PluginSync(files, transfer, catalog, vault, device, {
    read: () => saved ? structuredClone(saved) : null,
    write: value => { saved = structuredClone(value); }, signingKey: async () => signingKey,
  });
  const result: Client = { sync: make(), files, disk, runtime, state: () => saved, restart: () => { result.sync = make(); } };
  return result;
}
async function install(client: Client, id = 'calendar', version = '1.5.10', data: Record<string, unknown> = { wordsPerDot: 250 }, enabled = true) {
  const dir = config + '/plugins/' + id;
  await client.files.mkdir(dir);
  await client.files.write(dir + '/manifest.json', { id, version, minAppVersion: '1.0.0', name: id, isDesktopOnly: false });
  await client.disk.writeBinary(dir + '/main.js', encode('/* synthetic plugin ' + version + ' */'));
  await client.files.write(dir + '/data.json', data);
  await client.runtime.enable(id, enabled);
}
async function setting(client: Client, id: string, changes: Record<string, unknown>) {
  await client.files.write(config + '/plugins/' + id + '/data.json', { ...await client.files.rawSettings(id), ...changes });
}
async function paired() {
  const cloud = new Cloud();
  const left = await client(a, cloud);
  const right = await client(b, cloud);
  await install(left);
  await left.sync.initialize(a);
  await left.sync.run([a, b]);
  await right.sync.initialize(a);
  await right.sync.run([a, b]);
  right.sync.trust(a, left.sync.fingerprint);
  await right.sync.run([a, b]);
  await right.sync.run([a, b]);
  await left.sync.run([a, b]);
  return { cloud, left, right };
}

test('portable fields cover working Excalidraw versions and preserve secret, path, and execution boundaries', () => {
  assert.deepEqual(preferences('obsidian-excalidraw-plugin', {
    width: '720', folder: 'Drawings', customPens: [{ width: 2 }], aiProviderProfiles: [{ key: 'synthetic' }],
    taskboneAPIkey: 'synthetic', scriptFolderPath: 'Scripts', fontAssetsPath: 'C:\\Fonts',
  }), { width: '720', folder: 'Drawings', customPens: [{ width: 2 }] });
  assert.deepEqual(preferences('calendar', { weeklyNoteTemplate: 'Templates/Weekly', weekStart: 'monday' }), { weeklyNoteTemplate: 'Templates/Weekly', weekStart: 'monday' });
  assert.deepEqual(preferences('vk-inbox', { targetNotePath: 'Inbox.md', vkToken: 'synthetic', lastProcessedMessageId: 7 }), { targetNotePath: 'Inbox.md' });
  assert.equal(safePreferenceKey('enable_system_commands'), false);
  assert.deepEqual(preferences('custom-plugin', { color: 'blue', payload: { accessToken: 'synthetic' } }, ['color', 'payload']), { color: 'blue' });
});

test('Outliner 4.10.2 settings use persisted keys and keep release bookkeeping local', () => {
  const values = {
    styleLists: true, debug: false, stickCursor: 'bullet-and-checkbox', betterEnter: true,
    betterVimO: true, betterTab: true, selectAll: true, listLines: false,
    listLineAction: 'toggle-folding', dnd: true,
  };
  assert.deepEqual(preferences('obsidian-outliner', { ...values, previousRelease: '4.10.2', token: 'synthetic' }), values);
  assert.deepEqual(preferences('obsidian-outliner', { drawVerticalLines: true, improveStyleOfLists: false }),
    { drawVerticalLines: true, improveStyleOfLists: false });
});

test('applying one plugin verifies its transaction without rereading unrelated packages', async () => {
  const local = await client(a, new Cloud());
  await install(local);
  await install(local, 'obsidian-outliner', '4.10.2', { listLines: false });
  const expected = (await local.files.scan()).find(p => p.id === 'calendar')!;
  local.disk.reads.length = 0;
  await local.files.apply('calendar', expected, expected.pkg, new Map(), { wordsPerDot: 300 }, true);
  assert.equal((await local.files.rawSettings('calendar')).wordsPerDot, 300);
  assert.equal(local.disk.reads.filter(path => path.startsWith(config + '/plugins/obsidian-outliner/')).length, 0);
  assert.ok(local.disk.reads.includes(config + '/plugins/calendar/main.js'));
  assert.equal(await local.files.interrupted(), false);
});

test('a formatted manifest is read once per scan and force scans still observe changed package bytes', async () => {
  const local = await client(a, new Cloud());
  await install(local);
  const manifest = config + '/plugins/calendar/manifest.json';
  await local.disk.writeBinary(manifest, encode(JSON.stringify(await local.files.read(manifest), null, 2)));
  const first = (await local.files.scan())[0]!;
  local.disk.reads.length = 0;
  const second = (await local.files.scan())[0]!;
  assert.deepEqual(second.pkg, first.pkg);
  assert.equal(local.disk.reads.filter(path => path === manifest).length, 1);
  assert.equal(local.disk.reads.filter(path => path.endsWith('/main.js')).length, 0);
  const main = config + '/plugins/calendar/main.js';
  const bytes = new Uint8Array(await local.disk.readBinary(main));
  bytes[0] = bytes[0]! ^ 1;
  local.disk.data.set(main, bytes.buffer);
  assert.notEqual((await local.files.scan(true))[0]!.pkg.files['main.js']!.hash, first.pkg.files['main.js']!.hash);
});

test('identical existing Outliner installations exchange a new toggle in both directions', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud), right = await client(b, cloud);
  const id = 'obsidian-outliner';
  await install(left, id, '4.10.2', { listLines: false, listLineAction: 'toggle-folding', previousRelease: 'source' });
  await install(right, id, '4.10.2', { listLines: false, listLineAction: 'toggle-folding', previousRelease: 'recipient' });
  await left.sync.initialize(a); await left.sync.run([a, b]);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'same');
  await setting(left, id, { listLines: true });
  await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'pending');
  assert.equal((await right.files.rawSettings(id)).listLines, false);
  await right.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings(id)).listLines, true);
  await setting(right, id, { listLines: false });
  await right.sync.run([a, b]); await left.sync.run([a, b]);
  assert.equal(left.sync.rows[0]?.status, 'pending');
  await left.sync.run([a, b], true);
  assert.equal((await left.files.rawSettings(id)).listLines, false);
  assert.equal((await left.files.rawSettings(id)).previousRelease, 'source');
  assert.equal((await right.files.rawSettings(id)).previousRelease, 'recipient');
  const writes = cloud.writes.length;
  await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(cloud.writes.length, writes);
  assert.equal(left.sync.rows[0]?.status, 'same');
  assert.equal(right.sync.rows[0]?.status, 'same');
});

test('profile signing keys respect native secret ID limits, retain identity and isolate vault/device scopes', async () => {
  const secrets = new Map<string, string>();
  const storage = {
    getSecret: (id: string) => secrets.get(id),
    setSecret: (id: string, value: string) => {
      assert.match(id, /^[a-z0-9-]+$/);
      assert.ok(id.length <= 64);
      secrets.set(id, value);
    },
  };
  const key = await loadSigningKey(storage, vault, a);
  const signed = await signHead({ schema: 1, vault, device: a, seq: 1, edits: {} }, key);
  assert.equal((await verifyHead(encodeHead(signed), vault, a)).fingerprint.length, 64);
  assert.equal(await loadSigningKey(storage, vault, a), key);
  assert.notEqual(await loadSigningKey(storage, vault, b), key);
  assert.notEqual(await loadSigningKey(storage, c, a), key);
  assert.equal(secrets.size, 3);
});

test('an existing legacy signing key is migrated without changing its fingerprint or other secrets', async () => {
  const key = await newSigningKey();
  const legacyId = 'total-sync-plugin-signing-' + vault + '-' + a;
  const secrets = new Map([[legacyId, key], ['total-sync-mail-webdav', 'synthetic-credential']]);
  const storage = {
    getSecret: (id: string) => secrets.get(id),
    setSecret: (id: string, value: string) => { assert.ok(id.length <= 64); secrets.set(id, value); },
  };
  assert.equal(await loadSigningKey(storage, vault, a), key);
  assert.equal(await loadSigningKey(storage, vault, a), key);
  assert.equal(secrets.get(legacyId), key);
  assert.equal(secrets.get('total-sync-mail-webdav'), 'synthetic-credential');
  assert.equal(secrets.size, 3);
});

test('secret storage failures use a specific safe error and a later retry prepares the profile key', async () => {
  const secrets = new Map<string, string>();
  let unavailable = true;
  const storage = {
    getSecret: (id: string) => secrets.get(id),
    setSecret: (id: string, value: string) => {
      if (unavailable) throw new Error('synthetic private storage details');
      secrets.set(id, value);
    },
  };
  const expected = (e: unknown) => e instanceof SyncError && e.code === 'plugin-secret' && !e.message.includes('private');
  await assert.rejects(loadSigningKey(storage, vault, a), expected);
  assert.equal(secrets.size, 0);
  unavailable = false;
  assert.ok(await loadSigningKey(storage, vault, a));
  await assert.rejects(loadSigningKey({ getSecret: () => null, setSecret: () => {} }, vault, b), expected);
  await assert.rejects(loadSigningKey({ getSecret: () => { throw new Error('synthetic'); }, setSecret: () => {} }, vault, b), expected);
});

test('signed profiles bind vault, source and payload and reject tampering and embedded private keys', async () => {
  const key = await newSigningKey();
  const data: PluginHead = { schema: 1, vault, device: a, seq: 1, edits: {} };
  const signed = await signHead(data, key);
  assert.equal((await verifyHead(encodeHead(signed), vault, a)).data.seq, 1);
  await assert.rejects(verifyHead(encodeHead({ ...signed, body: signed.body.replace('"seq":1', '"seq":2') }), vault, a));
  await assert.rejects(verifyHead(encodeHead(signed), b, a));
  await assert.rejects(verifyHead(encodeHead(signed), vault, b));
  await assert.rejects(verifyHead(encodeHead({ ...signed, publicKey: key }), vault, a));
  assert.ok(!signed.publicKey.includes('"d"'));
});

test('per-field clocks retain concurrent edits while causal updates supersede ancestors', async () => {
  const make = async (device: string, seq: number, seen: Record<string, number>, value: number) => verifyHead(encodeHead(await signHead({
    schema: 1, vault, device, seq, edits: { 'calendar/setting/wordsPerDot': { seq, seen, value } },
  }, await newSigningKey())), vault, device);
  const x = await make(a, 1, {}, 100), y = await make(b, 1, {}, 200);
  assert.equal(candidates([x, y])['calendar/setting/wordsPerDot']!.length, 2);
  const z = await make(c, 1, { [a]: 1, [b]: 1 }, 300);
  assert.equal(candidates([x, y, z])['calendar/setting/wordsPerDot']![0]!.device, c);
});

test('fresh recipient verifies source once, installs exact package and settings, excludes own plugin and secrets', async () => {
  const { cloud, left, right } = await paired();
  assert.equal(right.sync.rows[0]?.status, 'same');
  assert.equal((await right.files.scan())[0]?.pkg.version, '1.5.10');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
  assert.equal(right.runtime.loaded('calendar'), true);
  assert.ok((await right.files.enabled()).includes('total-sync'));
  assert.ok(![...cloud.data.keys()].some(path => path.endsWith('/lock')));
  const count = cloud.writes.length;
  await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(cloud.writes.length, count, 'an idle sync must not republish plugin files or heads');
});

test('catalog installs an exact official release without trusting arbitrary WebDAV code', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud);
  await install(left);
  await left.sync.initialize(a); await left.sync.run([a, b]);
  const pub = new Map<string, ArrayBuffer>();
  pub.set('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json', encode('[{"id":"calendar","repo":"fixture/calendar"}]'));
  for (const name of ['main.js', 'manifest.json']) pub.set('https://github.com/fixture/calendar/releases/download/1.5.10/' + name, await left.files.packageBytes('calendar', name));
  const right = await client(b, cloud, pub);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'same');
  assert.deepEqual(right.state()?.trustedCode, {});
});

test('unsigned private package is held until the out-of-band fingerprint matches', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud), right = await client(b, cloud);
  await install(left, 'pdf-annotator');
  await left.sync.initialize(a); await left.sync.run([a, b]);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'trust');
  assert.equal((await right.files.scan()).length, 0);
  assert.throws(() => right.sync.trust(a, '0'.repeat(64)));
  right.sync.trust(a, left.sync.fingerprint);
  await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'same');
});

test('receiving over an existing installation keeps local secrets and queues loaded plugin changes', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud), right = await client(b, cloud);
  await install(left, 'obsidian-book-search-plugin', '0.7.5', { folder: 'Books', apiKey: 'source-synthetic' });
  await install(right, 'obsidian-book-search-plugin', '0.7.5', { folder: 'Default', apiKey: 'target-synthetic' });
  await left.sync.initialize(a); await left.sync.run([a, b]);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'pending');
  assert.equal((await right.files.rawSettings('obsidian-book-search-plugin')).folder, 'Default');
  await right.sync.run([a, b], true);
  assert.deepEqual(await right.files.rawSettings('obsidian-book-search-plugin'), { folder: 'Books', apiKey: 'target-synthetic' });
  assert.ok(![...cloud.data.values()].some(bytes => decode(bytes).includes('source-synthetic')));
});

test('independent settings converge in both directions without echo or false conflicts', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 });
  await setting(right, 'calendar', { weekStart: 'monday' });
  await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.conflicts.length, 0);
  await right.sync.run([a, b], true); await left.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 100);
  assert.equal((await left.files.rawSettings('calendar')).weekStart, 'monday');
  assert.equal(left.sync.rows[0]?.status, 'same');
});

test('concurrent edits of one field require an explicit choice and then converge', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 }); await setting(right, 'calendar', { wordsPerDot: 300 });
  await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'conflict');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 300);
  await right.sync.resolve('calendar/setting/wordsPerDot', a);
  await right.sync.run([a, b], true); await left.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 100);
  assert.equal(left.sync.rows[0]?.status, 'same');
});

test('editing while a received change is pending creates a conflict instead of silently winning', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]);
  await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'pending');
  await setting(right, 'calendar', { wordsPerDot: 400 }); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'conflict');
});

test('disable and uninstall remain disabled or absent after repeated synchronization', async () => {
  const { left, right } = await paired();
  await left.runtime.enable('calendar', false); await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal(right.runtime.loaded('calendar'), false);
  await left.disk.remove(config + '/plugins/calendar/manifest.json');
  await left.disk.remove(config + '/plugins/calendar/main.js');
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal((await right.files.scan()).length, 0);
  assert.ok(await right.disk.exists(config + '/plugins/calendar/data.json'), 'uninstall keeps local preferences recoverable');
  await right.sync.run([a, b]); await left.sync.run([a, b]);
  assert.equal((await right.files.scan()).length, 0);
});

test('private-source trust survives restart and covers a subsequent version', async () => {
  const { left, right } = await paired();
  right.restart();
  await install(left, 'calendar', '1.5.11', { wordsPerDot: 777 });
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal((await right.files.scan())[0]?.pkg.version, '1.5.11');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 777);
});

test('rollback preserves the old complete installation if writing a package fails', async () => {
  const { left, right } = await paired();
  await install(left, 'calendar', '1.5.11'); await left.sync.run([a, b]);
  let failed = false;
  right.disk.failWrite = path => !failed && path === config + '/plugins/calendar/main.js' ? (failed = true) : false;
  await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.status, 'error');
  assert.equal((await right.files.scan(true))[0]?.pkg.version, '1.5.10');
  assert.equal(right.runtime.loaded('calendar'), true);
  assert.equal(await right.files.interrupted(), false);
});

test('startup errors and settings migrations trigger a verified rollback', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]);
  let migrated = false;
  right.runtime.onEnable = async id => { if (!migrated) { migrated = true; await setting(right, id, { wordsPerDot: 999 }); } };
  await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.status, 'error');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
});

test('an unload hook that saves a portable edit does not lose that edit', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]);
  right.runtime.onUnload = async id => { await setting(right, id, { wordsPerDot: 666 }); };
  await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.status, 'error');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 666);
});

test('a journal survives rollback failure and recovers the previous files on retry', async () => {
  const { left, right } = await paired();
  await install(left, 'calendar', '1.5.11'); await left.sync.run([a, b]);
  right.disk.failWrite = path => path === config + '/plugins/calendar/manifest.json';
  await assert.rejects(right.sync.run([a, b], true), (e: unknown) => e instanceof SyncError && e.code === 'plugin-recovery');
  assert.equal(await right.files.interrupted(), true);
  right.disk.failWrite = undefined;
  await right.files.recover();
  assert.equal((await right.files.scan(true))[0]?.pkg.version, '1.5.10');
  assert.equal(await right.files.interrupted(), false);
});

test('corrupt cloud blobs never replace a working plugin', async () => {
  const { cloud, left, right } = await paired();
  await install(left, 'calendar', '1.5.11'); await left.sync.run([a, b]);
  const pkg = (await left.files.scan())[0]!.pkg;
  const blobPath = [...cloud.data.keys()].find(p => p.endsWith(pkg.files['main.js']!.hash))!;
  cloud.data.set(blobPath, encode('corrupted'));
  await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.error, 'integrity');
  assert.equal((await right.files.scan(true))[0]?.pkg.version, '1.5.10');
});

test('replayed or replaced device heads are rejected after a successful sync', async () => {
  const { cloud, left, right } = await paired();
  const path = [...cloud.data.keys()].find(p => p.endsWith(a + '.json'))!;
  const old = cloud.data.get(path)!;
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]); await right.sync.run([a, b]);
  cloud.data.set(path, old);
  await assert.rejects(right.sync.run([a, b]), (e: unknown) => e instanceof SyncError && e.code === 'integrity');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
});

test('uncertain successful cloud PUTs are verified and an unpublished outbox is retried after restart', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud);
  await install(left); await left.sync.initialize(a);
  cloud.uncertain = true;
  await left.sync.run([a]);
  assert.equal(left.state()?.outbox, false);
  cloud.uncertain = false;
  await setting(left, 'calendar', { wordsPerDot: 300 });
  cloud.fail = path => path.endsWith(a + '.json');
  await assert.rejects(left.sync.run([a]));
  const pending = left.state()?.own;
  assert.equal(left.state()?.outbox, true);
  cloud.fail = undefined; left.restart();
  await left.sync.run([a]);
  assert.equal(left.state()?.outbox, false);
  assert.equal(left.state()?.own?.body, pending?.body);
});

test('an interrupted own head is repaired from the exact durable signed outbox and archive', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud);
  await install(left); await left.sync.initialize(a); await left.sync.run([a]);
  await setting(left, 'calendar', { wordsPerDot: 300 });
  const put = cloud.put.bind(cloud);
  cloud.put = async (path, bytes) => {
    if (path.endsWith(a + '.json')) {
      cloud.data.set(path, bytes.slice(0, 40));
      throw new SyncError('uncertain', 504);
    }
    return put(path, bytes);
  };
  await assert.rejects(left.sync.run([a]));
  const pending = left.state()?.own;
  assert.equal(left.state()?.outbox, true);
  cloud.put = put; left.restart();
  await left.sync.run([a]);
  assert.equal(left.state()?.outbox, false);
  assert.equal(left.state()?.own?.body, pending?.body);
  const transfer = new PluginTransfer(cloud, vault);
  assert.equal((await transfer.head(a))?.envelope.body, pending?.body);
});

test('retry repairs a partial content-addressed upload using verified local bytes', async () => {
  const cloud = new Cloud();
  const transfer = new PluginTransfer(cloud, vault);
  const bytes = encode('synthetic complete package');
  const put = cloud.put.bind(cloud);
  cloud.put = async (path, body) => {
    cloud.data.set(path, body.slice(0, 3));
    throw new SyncError('uncertain', 504);
  };
  await assert.rejects(transfer.upload(bytes));
  cloud.put = put;
  const ref = await transfer.upload(bytes);
  assert.deepEqual(await transfer.blob(ref), bytes);
});

test('retry finishes an interrupted history upload before publishing its head', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud);
  await install(left); await left.sync.initialize(a);
  const put = cloud.put.bind(cloud);
  cloud.put = async (path, bytes) => {
    if (path.includes('/history/')) {
      cloud.data.set(path, bytes.slice(0, 30));
      throw new SyncError('uncertain', 504);
    }
    return put(path, bytes);
  };
  await assert.rejects(left.sync.run([a]));
  const transfer = new PluginTransfer(cloud, vault);
  assert.equal(await transfer.head(a), null);
  assert.equal(left.state()?.outbox, true);
  cloud.put = put; left.restart();
  await left.sync.run([a]);
  assert.equal(left.state()?.outbox, false);
  assert.equal((await transfer.archived(a, 1)).envelope.body, (await transfer.head(a))?.envelope.body);
});

test('additional ordinary fields need consent on both devices; removing consent does not publish deletion', async () => {
  const { left, right, cloud } = await paired();
  await setting(left, 'calendar', { customColor: 'purple' });
  left.sync.approveFields('calendar', ['customColor']); await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'review');
  right.sync.approveFields('calendar', ['customColor']); await right.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings('calendar')).customColor, 'purple');
  const edit = (JSON.parse(left.state()!.own!.body) as PluginHead).edits['calendar/setting/customColor'];
  const count = cloud.writes.filter(path => path.includes('/blobs/')).length;
  left.sync.approveFields('calendar', []); await left.sync.run([a, b]);
  assert.equal(cloud.writes.filter(path => path.includes('/blobs/')).length, count);
  assert.deepEqual((JSON.parse(left.state()!.own!.body) as PluginHead).edits['calendar/setting/customColor'], edit);
  assert.equal((await left.files.rawSettings('calendar')).customColor, 'purple');
});

test('a local-only plugin remains untouched while other plugin settings converge', async () => {
  const { left, right } = await paired();
  right.sync.exclude('calendar', true);
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.status, 'excluded');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
});

test('a reviewed application plan is rejected if the source changes before applying', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { wordsPerDot: 100 }); await left.sync.run([a, b]); await right.sync.run([a, b]);
  const signature = right.sync.planSignature();
  await setting(left, 'calendar', { wordsPerDot: 200 }); await left.sync.run([a, b]);
  await assert.rejects(right.sync.run([a, b], true, signature), (e: unknown) => e instanceof SyncError && e.code === 'changed');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
});

test('nullable settings and deleted settings remain distinct and propagate correctly', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { localeOverride: null });
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings('calendar')).localeOverride, null);
  const raw = await left.files.rawSettings('calendar'); delete raw.localeOverride;
  await left.files.write(config + '/plugins/calendar/data.json', raw);
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal(Object.prototype.hasOwnProperty.call(await right.files.rawSettings('calendar'), 'localeOverride'), false);
});

test('hot reload applies settings without unloading an open plugin view', async () => {
  const { left, right } = await paired();
  let reloaded = 0;
  right.runtime.onReloadSettings = async () => { reloaded++; };
  right.runtime.onUnload = async () => { throw new Error('A live view must not be closed'); };
  await setting(left, 'calendar', { wordsPerDot: 123 }); await left.sync.run([a, b]);
  await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'same');
  assert.equal(reloaded, 1);
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 123);
});

test('a failing hot-reload hook restores settings without unloading the plugin', async () => {
  const { left, right } = await paired();
  let calls = 0;
  right.runtime.onReloadSettings = async () => { if (++calls === 1) throw new SyncError('local'); };
  right.runtime.onUnload = async () => { throw new Error('Hot rollback must not close the view'); };
  await setting(left, 'calendar', { wordsPerDot: 123 }); await left.sync.run([a, b]); await right.sync.run([a, b]);
  assert.equal(right.sync.rows[0]?.status, 'error');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
  assert.equal(calls, 2);
  assert.equal(await right.files.interrupted(), false);
});

test('a nonportable local value is neither uploaded as deletion nor overwritten by the old profile', async () => {
  const { left, right } = await paired();
  await setting(left, 'calendar', { weeklyNoteFolder: 'Weekly' });
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  await setting(left, 'calendar', { weeklyNoteFolder: 'C:\\LocalOnly' });
  await left.sync.run([a, b]);
  assert.equal(left.sync.rows[0]?.status, 'same');
  assert.ok(left.sync.rows[0]?.localFields.includes('weeklyNoteFolder'));
  assert.equal((await left.files.rawSettings('calendar')).weeklyNoteFolder, 'C:\\LocalOnly');
  await right.sync.run([a, b]);
  assert.equal((await right.files.rawSettings('calendar')).weeklyNoteFolder, 'Weekly');
});

test('an incompatible Obsidian minimum version preserves all installed files', async () => {
  const { left, right } = await paired();
  await install(left, 'calendar', '1.5.11');
  await left.files.write(config + '/plugins/calendar/manifest.json', { id: 'calendar', version: '1.5.11', minAppVersion: '999.0.0' });
  await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal(right.sync.rows[0]?.error, 'plugin-version');
  assert.equal((await right.files.scan(true))[0]?.pkg.version, '1.5.10');
  assert.equal(await right.files.interrupted(), false);
});

test('corrupted primary recovery journal uses the verified second copy', async () => {
  const { left, right } = await paired();
  await install(left, 'calendar', '1.5.11'); await left.sync.run([a, b]);
  right.disk.failWrite = path => path === config + '/plugins/calendar/manifest.json';
  await assert.rejects(right.sync.run([a, b], true));
  right.disk.failWrite = undefined;
  await right.disk.writeBinary(right.files.base + '/transaction.json', encode('{broken'));
  await right.files.recover();
  assert.equal((await right.files.scan(true))[0]?.pkg.version, '1.5.10');
  assert.equal(await right.files.interrupted(), false);
});

test('initial receiver defaults do not replace the working Excalidraw 2.25.3 profile', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud), right = await client(b, cloud);
  await install(left, 'obsidian-excalidraw-plugin', '2.25.3', { width: '720', customPens: [{ width: 2 }] });
  await install(right, 'obsidian-excalidraw-plugin', '2.25.3', { width: '300' });
  await left.sync.initialize(a); await left.sync.run([a, b]);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  assert.equal(right.state()?.initialized, false);
  assert.equal(right.state()?.own, null);
  await right.sync.run([a, b], true); await left.sync.run([a, b]);
  assert.equal((await right.files.rawSettings('obsidian-excalidraw-plugin')).width, '720');
  assert.equal((await left.files.rawSettings('obsidian-excalidraw-plugin')).width, '720');
});

test('source secret changes flushed by unload survive application of portable settings', async () => {
  const { left, right } = await paired();
  await setting(right, 'calendar', { privateToken: 'before' });
  right.runtime.onUnload = async id => { await setting(right, id, { privateToken: 'after' }); };
  await setting(left, 'calendar', { wordsPerDot: 123 }); await left.sync.run([a, b]); await right.sync.run([a, b], true);
  assert.equal((await right.files.rawSettings('calendar')).privateToken, 'after');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 123);
});

test('a missing published head does not uninstall plugins or erase settings', async () => {
  const { cloud, left, right } = await paired();
  const path = [...cloud.data.keys()].find(p => p.endsWith(a + '.json'))!;
  cloud.data.delete(path);
  await assert.rejects(right.sync.run([a, b]), (e: unknown) => e instanceof SyncError && e.code === 'missing');
  assert.equal((await right.files.rawSettings('calendar')).wordsPerDot, 250);
  assert.equal((await left.files.scan()).length, 1);
});

test('the recipient sees required local sign-in fields without receiving their values', async () => {
  const cloud = new Cloud();
  const left = await client(a, cloud), right = await client(b, cloud);
  await install(left, 'vk-inbox', '1.1.0', { targetNotePath: 'Inbox.md', vkToken: 'source-synthetic-token-value' });
  await left.sync.initialize(a); await left.sync.run([a, b]);
  await right.sync.initialize(a); await right.sync.run([a, b]);
  right.sync.trust(a, left.sync.fingerprint); await right.sync.run([a, b]);
  assert.deepEqual(right.sync.rows[0]?.localTasks, ['vkToken']);
  assert.equal((await right.files.rawSettings('vk-inbox')).vkToken, undefined);
  assert.ok(![...cloud.data.values()].some(bytes => decode(bytes).includes('source-synthetic-token-value')));
});

test('plugin profiles use real HTTP WebDAV without changing the note index and retain immutable signed history', async t => {
  const server = await new DavServer().start();
  t.after(() => server.close());
  const remote = new RemoteVault(server.dav(), vault);
  const noteHead = await remote.create(Date.now());
  const transfer = new PluginTransfer(server.dav(), vault);
  const bytes = encode('synthetic plugin bytes');
  const ref = await transfer.upload(bytes);
  assert.deepEqual(await transfer.blob(ref), bytes);
  const key = await newSigningKey();
  const first: PluginHead = { schema: 1, vault, device: a, seq: 1, edits: {} };
  const signed = await signHead(first, key);
  server.afterMutation = (method, path) => method === 'PUT' && path.endsWith(a + '.json') ? { status: 504 } : undefined;
  await transfer.publish(a, signed);
  assert.equal((await transfer.head(a))?.data.seq, 1);
  const next = await signHead({ ...first, seq: 2 }, key);
  await transfer.publish(a, next);
  const original = server.files.get('/TotalSync-beta/vaults/' + vault + '/plugin-profiles-v1/history/' + a + '/1.json')!;
  assert.equal((await verifyHead(original, vault, a)).data.seq, 1);
  await assert.rejects(transfer.publish(a, await signHead({ ...first, edits: {
    'calendar/setting/wordsPerDot': { seq: 1, seen: {}, value: 700 },
  } }, key)), (e: unknown) => e instanceof SyncError && e.code === 'integrity');
  assert.equal((await transfer.head(a))?.data.seq, 2);
  assert.equal((await remote.head(null, true)).hash, noteHead.hash);
  assert.ok(!server.requests.some(r => r.path.includes('plugin-profiles-v1') && r.path.includes('/lock')));
});

test('built-in object property names do not bypass preference validation', () => {
  assert.deepEqual(preferences('constructor', { color: 'blue' }, ['color']), { color: 'blue' });
  assert.deepEqual(preferences('toString', { color: 'blue' }), {});
  assert.equal(safePreferenceKey('__proto__'), false);
});

test('signature verification rejects secret-bearing and traversal fields before installation', async () => {
  const key = await newSigningKey();
  for (const path of ['calendar/setting/apiKey', '../calendar/package', 'total-sync/enabled']) {
    const head = await signHead({ schema: 1, vault, device: a, seq: 1, edits: { [path]: { seq: 1, seen: {}, value: 'synthetic' } } }, key);
    await assert.rejects(verifyHead(encodeHead(head), vault, a));
  }
});
