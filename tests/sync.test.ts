import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client, DavServer } from './fixture';
import { DAY, decode, encode, RETENTION, sha256, SyncError } from '../src/model';
import { RemoteVault } from '../src/repository';
import {
  catalogInstallCommand, checkPayload, EXCALIDRAW_ID, EXCALIDRAW_PROFILE, excalidrawPreferences,
  inChannel, jsonBytes, mergePreferences, pathKey, portablePath,
} from '../src/policy';
import { MAIL, mailEndpoint, ROOT } from '../src/webdav';

const fails = (code: string) => (error: unknown) => error instanceof SyncError && error.code === code;

async function setup(t: TestContext) {
  const server = await new DavServer().start();
  t.after(() => server.close());
  const id = crypto.randomUUID();
  const remote = new RemoteVault(server.dav(), id);
  await remote.create(server.clock);
  return { server, id, remote, a: new Client(server, id), b: new Client(server, id), mobile: new Client(server, id, 'mobile') };
}

test('connection probe verifies access, exclusive MKCOL, binary, DELETE and optional MOVE', async t => {
  const server = await new DavServer().start();
  t.after(() => server.close());
  assert.deepEqual(await RemoteVault.probe(server.dav()), { move: true, exclusiveMove: true });
  server.ignoreOverwrite = true;
  assert.deepEqual(await RemoteVault.probe(server.dav()), { move: true, exclusiveMove: false });
  server.ignoreOverwrite = false;
  server.moveCollections = false;
  assert.deepEqual(await RemoteVault.probe(server.dav()), { move: true, exclusiveMove: false });
  server.move = false;
  assert.deepEqual(await RemoteVault.probe(server.dav()), { move: false, exclusiveMove: false });
  assert.equal([...server.folders].some(path => path.includes('probe-')), false);
  assert.equal(mailEndpoint(MAIL + '/'), MAIL);
  for (const bad of ['http://webdav.cloud.mail.ru', 'https://example.com', MAIL + '/something', MAIL + '?x=1']) {
    assert.throws(() => mailEndpoint(bad), fails('configuration'));
  }
});

test('empty vault downloads synthetic notes and all three devices create notes', async t => {
  const { a, b, mobile } = await setup(t);
  a.local.put('Входящие/Привет мир.md', '# Первый');
  b.local.put('Desktop.md', '# Второй');
  mobile.local.put('Phone.md', '# Третий');
  for (const client of [a, b, mobile, a, b]) await client.run();
  for (const client of [a, b, mobile]) {
    assert.equal(client.local.text('Входящие/Привет мир.md'), '# Первый');
    assert.equal(client.local.text('Desktop.md'), '# Второй');
    assert.equal(client.local.text('Phone.md'), '# Третий');
  }
  assert.equal(Object.keys((await a.run()).devices).length, 3);
});

test('offline changes remain local until connection recovers', async t => {
  const { a, b, server } = await setup(t);
  a.local.put('Offline.md', 'before');
  await a.run();
  await b.run();
  a.local.put('Offline.md', 'offline edit');
  server.offline = true;
  await assert.rejects(a.run(), fails('network'));
  assert.equal(a.local.text('Offline.md'), 'offline edit');
  assert.equal(b.local.text('Offline.md'), 'before');
  server.offline = false;
  await a.run();
  await b.run();
  assert.equal(b.local.text('Offline.md'), 'offline edit');
});

test('overlapping Markdown edits survive in history and resolve in the original file after restart', async t => {
  const { a, b } = await setup(t);
  a.local.put('Конфликт.md', 'common');
  await a.run();
  await b.run();
  a.local.put('Конфликт.md', 'laptop edit');
  b.local.put('Конфликт.md', 'PC edit');
  const outcomes = await Promise.allSettled([a.run(), b.run()]);
  assert.equal(outcomes.reduce((count, outcome) =>
    count + (outcome.status === 'fulfilled' ? outcome.value.counts.push : 0), 0), 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(fails('cloud-advanced')(outcome.reason));
  for (const client of [a, b, a, b]) await client.run();
  assert.equal(a.local.text('Конфликт.md'), 'laptop edit');
  assert.equal(b.local.text('Конфликт.md'), 'PC edit');
  const owner = a.state.pending?.['Конфликт.md'] ? a : b;
  assert.equal((await owner.run()).counts.review, 1);
  owner.state = JSON.parse(JSON.stringify(owner.state));
  const review = await owner.engine.reviewConflict(owner.state, 'Конфликт.md');
  assert.equal(review.kind, 'fragments');
  assert.equal(review.merge.parts.filter(part => part.kind === 'conflict').length, 1);
  const archived = new Set<string>();
  for (const item of (await owner.engine.history(owner.state)).filter(row => row.reason === 'conflict')) {
    await owner.engine.restore(owner.state, item.id, async (_item, data) => { archived.add(decode(data)); });
  }
  assert.deepEqual(archived, new Set(['laptop edit', 'PC edit']));
  owner.state = await owner.engine.resolveConflict(owner.state, review, { kind: 'text', text: 'laptop edit\nPC edit' });
  for (const client of [a, b]) {
    await client.run();
    assert.deepEqual([...client.local.group('content').keys()], ['Конфликт.md']);
    assert.equal(client.local.text('Конфликт.md'), 'laptop edit\nPC edit');
    assert.equal(client.state.pending?.['Конфликт.md'], undefined);
  }
});

test('large Markdown conflicts retain both originals in history and save either full version without copies', async t => {
  const { a, mobile } = await setup(t);
  const path = 'Большая заметка.MD';
  const prefix = 'Строка для теста синхронизации.\r\n'.repeat(10_000);
  assert.ok(encode(prefix).byteLength > 512 * 1024);
  a.local.put(path, prefix + 'Исходная строка');
  await a.run();
  await mobile.run();

  for (const kind of ['local', 'remote'] as const) {
    const laptop = prefix + 'Строка Windows ' + kind;
    const phone = prefix + 'Строка iPhone ' + kind;
    a.local.put(path, laptop);
    mobile.local.put(path, phone);
    await a.run();
    assert.equal((await mobile.run()).counts.review, 1);
    assert.equal(mobile.local.text(path), phone);
    assert.deepEqual([...mobile.local.group('content').keys()], [path]);
    const review = await mobile.engine.reviewConflict(mobile.state, path);
    assert.equal(review.kind, 'whole');
    assert.match(review.previews.local, /Строка iPhone/);
    assert.match(review.previews.remote, /Строка Windows/);
    assert.ok(review.previews.local.length < 2200 && review.previews.remote.length < 2200);
    mobile.state = await mobile.engine.resolveConflict(mobile.state, review, { kind });
    await a.run();
    for (const client of [a, mobile]) {
      assert.deepEqual([...client.local.group('content').keys()], [path]);
      assert.equal(client.local.text(path), kind === 'local' ? phone : laptop);
    }
    const archived = new Set<string>();
    for (const item of (await mobile.engine.history(mobile.state)).filter(row => row.path === path && row.reason === 'conflict')) {
      await mobile.engine.restore(mobile.state, item.id, async (_item, data) => { archived.add(decode(data)); });
    }
    assert.ok(archived.has(phone) && archived.has(laptop));
  }
});

test('Markdown with unsupported encoding can be resolved with byte-exact versions and no copies', async t => {
  const { a, b } = await setup(t);
  const path = 'Encoded.md';
  const local = Uint8Array.from([255, 97]).buffer;
  const cloud = Uint8Array.from([255, 98]).buffer;
  a.local.put(path, 'base');
  await a.run();
  await b.run();
  a.local.put(path, cloud);
  b.local.put(path, local);
  await a.run();
  assert.equal((await b.run()).counts.review, 1);
  const review = await b.engine.reviewConflict(b.state, path);
  assert.equal(review.kind, 'whole');
  b.state = await b.engine.resolveConflict(b.state, review, { kind: 'local' });
  await a.run();
  assert.deepEqual([...a.local.group('content').keys()], [path]);
  assert.deepEqual(await a.local.read('content', path), local);
});

test('configuration conflict keeps the active setting and archives both exact JSON files', async t => {
  const { a, b } = await setup(t);
  const name = 'hotkeys.json';
  const channel = 'desktop-config';
  a.local.put(name, '{}', channel);
  await a.run();
  await b.run();
  a.local.put(name, '{"a":[1]}', channel);
  b.local.put(name, '{"a":[2]}', channel);
  await a.run();
  assert.equal((await b.run()).counts.conflict, 1);
  assert.equal(b.local.text(name, channel), '{"a":[2]}');
  a.local.put(name, '{"a":[3]}', channel);
  await a.run();
  assert.equal((await b.run()).counts.conflict, 1);
  assert.equal(b.local.text(name, channel), '{"a":[2]}');
  const restored = new Set();
  for (const item of (await b.engine.history(b.state)).filter(item => item.reason === 'conflict')) {
    await b.engine.restore(b.state, item.id, async (_item, data) => { restored.add(decode(data)); });
  }
  assert.deepEqual(restored, new Set(['{"a":[1]}', '{"a":[2]}', '{"a":[3]}']));
});

test('file and directory move preserve structure and all attachment bytes', async t => {
  const { a, b } = await setup(t);
  const media = Uint8Array.from([137, 80, 78, 71, 0, 255]).buffer;
  a.local.put('Раньше/Схема 1.png', media);
  a.local.put('Раньше/Ссылка.md', '![[Схема 1.png]]');
  a.local.group('content').set('Раньше/Пустая', 'folder');
  await a.run();
  await b.run();
  const group = a.local.group('content');
  for (const [path, bytes] of [...group]) {
    group.set(path.replace('Раньше', 'Теперь'), bytes);
    group.delete(path);
  }
  const aPlan = await a.engine.preview(a.state);
  await a.run(aPlan.approval);
  const bPlan = await b.engine.preview(b.state);
  await b.run(bPlan.approval);
  assert.equal(b.local.text('Теперь/Ссылка.md'), '![[Схема 1.png]]');
  assert.equal(await sha256(await b.local.read('content', 'Теперь/Схема 1.png')), await sha256(media));
  assert.equal(b.local.group('content').get('Теперь/Пустая'), 'folder');
  assert.equal(b.local.group('content').has('Раньше'), false);
});

test('explicit tombstone, restore and 30-day cleanup retain active bytes', async t => {
  const { a, b, remote, server } = await setup(t);
  a.local.put('Recover.md', 'original');
  a.local.put('Active.md', 'active');
  await a.run();
  await b.run();
  a.local.group('content').delete('Recover.md');
  await a.run();
  await b.run();
  const head = await remote.head(a.state.checkpoint);
  assert.equal(head.manifest.files.content['Recover.md']?.kind, 'deleted');
  assert.equal(b.local.text('Recover.md'), undefined);
  server.clock += RETENTION - DAY;
  await a.run();
  const item = (await a.engine.history(a.state)).find(item => item.path === 'Recover.md');
  assert.ok(item);
  await a.engine.restore(a.state, item.id, async (_item, bytes) => { a.local.put('Recover.md', bytes); });
  await a.run();
  await b.run();
  assert.equal(b.local.text('Recover.md'), 'original');
  server.clock += 2 * DAY;
  await a.run();
  await a.run();
  assert.equal((await a.engine.history(a.state)).some(row => row.id === item.id), false);
  assert.equal([...server.files.keys()].some(path => path.endsWith(item.file.blob)), false);
  assert.equal(b.local.text('Active.md'), 'active');
  const active = (await remote.head(a.state.checkpoint)).manifest.files.content['Recover.md'];
  assert.ok(active?.kind === 'file');
  assert.equal(decode(await remote.download('content', active)), 'original');
});

for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'integrity'], [429, 'rate'], [500, 'server']] as const) {
  test('HTTP ' + status + ' during state read leaves active data intact', async t => {
    const { a, server } = await setup(t);
    a.local.put('Keep.md', 'keep');
    await a.run();
    const before = a.state.checkpoint;
    server.fault = (method, path) => method === 'PROPFIND' && path.includes('/commits/') ? { status } : undefined;
    await assert.rejects(a.run(), fails(code));
    assert.deepEqual(a.state.checkpoint, before);
    assert.equal(a.local.text('Keep.md'), 'keep');
  });
}

test('read timeout, empty and truncated XML fail closed', async t => {
  const { a, server } = await setup(t);
  a.local.put('Keep.md', 'keep');
  await a.run();
  await assert.rejects(server.dav(5, 30).collection(''), fails('timeout'));
  for (const body of ['', '<d:multistatus xmlns:d="DAV:"/>', '<d:multistatus xmlns:d="DAV:"><d:response>']) {
    server.fault = (method, path) => method === 'PROPFIND' && path.includes('/commits/') ? { status: 207, body } : undefined;
    await assert.rejects(a.run(), fails('protocol'));
    assert.equal(a.local.text('Keep.md'), 'keep');
  }
});

test('mass deletion requires approval for the current revision and deletion list', async t => {
  const { a, b } = await setup(t);
  for (let i = 0; i < 8; i++) a.local.put(i + '.md', 'keep ' + i);
  await a.run();
  await b.run();
  a.local.group('content').delete('0.md');
  a.local.group('content').delete('1.md');
  await assert.rejects(a.run(), fails('mass-delete'));
  const preview = await a.engine.preview(a.state);
  assert.equal(preview.plan.destructive.length, 2);
  a.local.group('content').delete('2.md');
  await assert.rejects(a.run(preview.approval), fails('mass-delete'));
  await a.run((await a.engine.preview(a.state)).approval);
  await assert.rejects(b.run(), fails('mass-delete'));
  await b.run((await b.engine.preview(b.state)).approval);
  assert.deepEqual([...b.local.group('content').keys()].sort(), ['3.md', '4.md', '5.md', '6.md', '7.md']);
});

test('invalid and case-colliding paths and incomplete local scan never trigger deletion', async t => {
  for (const bad of ['a/../b', 'NUL.md', 'folder/COM¹.txt', '/root.md', 'bad?.md', '.obsidian/data.json', 'trail.']) {
    assert.throws(() => portablePath(bad), fails('path'));
  }
  assert.equal(portablePath('Данные/e\u0301 .md'), 'Данные/é .md');
  assert.equal(pathKey('ИМЯ.md'), pathKey('имя.md'));
  const { a, b } = await setup(t);
  a.local.put('First.md', 'original');
  a.local.put('Second.md', 'keep');
  await a.run();
  await b.run();
  a.local.group('content').delete('First.md');
  a.local.put('first.md', 'case-only alias');
  a.local.group('content').delete('Second.md');
  a.local.blocked.set('content', new Set(['Second.md']));
  const result = await a.run();
  assert.ok(result.counts.blocked >= 3);
  await b.run();
  assert.equal(b.local.text('First.md'), 'original');
  assert.equal(b.local.text('Second.md'), 'keep');
});

test('over-limit attachment does not prevent other notes and media from syncing', async t => {
  const { a, server, id } = await setup(t);
  const constrained = new Client(server, id, 'mobile', 400_000);
  a.local.put('01.mp4', new Uint8Array(600_000).fill(43).buffer);
  a.local.put('02.pdf', encode('%PDF-1.7'));
  a.local.put('03.ogg', encode('OggS synthetic fixture'));
  a.local.put('04.md', 'small');
  await a.run();
  const result = await constrained.run();
  assert.deepEqual(result.errors, ['size']);
  assert.equal(constrained.local.text('02.pdf'), '%PDF-1.7');
  assert.equal(constrained.local.text('03.ogg'), 'OggS synthetic fixture');
  assert.equal(constrained.local.text('04.md'), 'small');
  assert.equal(constrained.local.group('content').has('01.mp4'), false);
});

test('same-client overlap is rejected and committed state survives restart', async t => {
  const { a, b } = await setup(t);
  a.local.put('Saved.md', 'once');
  const first = a.run();
  await assert.rejects(a.run(), fails('busy'));
  await first;
  a.state = JSON.parse(JSON.stringify(a.state));
  assert.equal((await a.run()).counts.push, 0);
  await b.run();
  assert.equal(b.local.text('Saved.md'), 'once');
});

test('separate vault IDs keep files and metadata isolated', async t => {
  const { a, id, server } = await setup(t);
  const otherId = crypto.randomUUID();
  await new RemoteVault(server.dav(), otherId).create(server.clock);
  const other = new Client(server, otherId);
  a.local.put('Same.md', 'first');
  other.local.put('Same.md', 'second');
  await a.run();
  await other.run();
  assert.equal(a.local.text('Same.md'), 'first');
  assert.equal(other.local.text('Same.md'), 'second');
  await assert.rejects(new RemoteVault(server.dav(), id).create(server.clock), fails('identity'));
});

test('mobile never downloads desktop blobs but receives the explicitly staged Bookmarks snapshot', async t => {
  const { a, b, mobile, server } = await setup(t);
  a.local.put('snippets/test.css', '.markdown { color: red; }', 'desktop-config');
  a.local.put('bookmarks.json', '{"items":[]}', 'shared-state');
  a.local.put('Mobile.md', 'hello');
  await a.run();
  await b.run();
  const offset = server.requests.length;
  await mobile.run();
  assert.equal(mobile.local.text('Mobile.md'), 'hello');
  assert.equal(mobile.local.text('bookmarks.json', 'shared-state'), '{"items":[]}');
  assert.equal(mobile.local.group('desktop-config').size, 0);
  assert.equal(server.requests.slice(offset).some(request => request.path.includes('/desktop-config/')), false);
  assert.equal(b.local.text('snippets/test.css', 'desktop-config'), '.markdown { color: red; }');
});

test('unsafe config, secrets and executable files are excluded from cloud', async t => {
  assert.equal(inChannel('desktop-config', 'plugins/total-sync/data.json'), false);
  assert.equal(inChannel('desktop-config', 'plugins/calendar/main.js'), false);
  assert.equal(inChannel('desktop-config', 'workspace.json'), false);
  assert.equal(inChannel('content', 'TotalSync-Recovery/copy.md'), false);
  assert.throws(() => checkPayload('desktop-config', 'snippets/bad.CSS', encode('x { background: url(https://example.com) }')), fails('configuration'));
  assert.throws(() => checkPayload('desktop-config', 'plugins/calendar/preferences.json', encode('{"token":"sensitive"}')), fails('configuration'));
  const { a, server } = await setup(t);
  const seed = 'fixture-value-excluded';
  a.local.put('app.json', JSON.stringify({ nested: { accessToken: seed } }), 'desktop-config');
  a.local.put('Public fixture.md', 'synthetic note');
  const result = await a.run();
  assert.deepEqual(result.errors, ['configuration']);
  for (const bytes of server.files.values()) {
    const text = decode(bytes);
    assert.equal(text.includes(seed) || text.includes('synthetic-fixture') || text.includes('tester@example.com'), false);
  }
});

test('failed local theme update is retried without advancing that file baseline', async t => {
  const { a, b } = await setup(t);
  const path = 'themes/Test/theme.css';
  a.local.put(path, 'body { color: green; }', 'desktop-config');
  await a.run();
  await b.run();
  a.local.put(path, 'body { color: blue; }', 'desktop-config');
  await a.run();
  b.local.failNextPath = path;
  assert.deepEqual((await b.run()).errors, ['local']);
  assert.equal(b.local.text(path, 'desktop-config'), 'body { color: green; }');
  b.state = JSON.parse(JSON.stringify(b.state));
  assert.equal((await b.run()).counts.pull, 1);
  assert.equal(b.local.text(path, 'desktop-config'), 'body { color: blue; }');
});

test('interrupted cloud commit leaves old bytes and a lock, with no blind retry', async t => {
  const { a, b, server } = await setup(t);
  a.local.put('Keep.md', 'published');
  await a.run();
  await b.run();
  a.local.put('Keep.md', 'uncommitted');
  server.fault = (method, path) => method === 'MKCOL' && path.includes('/commits/') ? { status: 500 } : undefined;
  await assert.rejects(a.run(), fails('uncertain'));
  assert.equal(b.local.text('Keep.md'), 'published');
  assert.equal(a.local.text('Keep.md'), 'uncommitted');
  assert.ok([...server.folders].some(path => path.endsWith('/metadata/lock')));
  server.fault = undefined;
  b.local.put('Another.md', 'must wait');
  assert.deepEqual((await b.run()).errors, ['cloud-lock']);
  assert.equal(b.local.text('Keep.md'), 'published');
});

test('laptop downloads an already published phone edit while a stale cloud lock exists', async t => {
  const { a, mobile, server, id } = await setup(t);
  a.local.put('Тест.md', 'windows');
  await a.run();
  await mobile.run();
  mobile.local.put('Тест.md', 'iPhone edit');
  await mobile.run();
  const lock = ROOT + '/vaults/' + id + '/metadata/lock';
  assert.equal(await server.dav().mkdir(lock), true);
  const offset = server.requests.length;
  const result = await a.run();
  assert.equal(a.local.text('Тест.md'), 'iPhone edit');
  assert.equal(result.counts.pull, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(server.requests.slice(offset).some(row => row.method === 'MKCOL' || row.method === 'DELETE'), false);
  assert.equal(server.folders.has('/' + lock), true);
});

test('a cloud lock defers writes and local deletions while unrelated published downloads continue', async t => {
  const { a, b, server, id } = await setup(t);
  a.local.put('Incoming.md', 'before');
  a.local.put('Delete.md', 'keep while locked');
  await a.run();
  await b.run();
  a.local.put('Incoming.md', 'published');
  a.local.group('content').delete('Delete.md');
  await a.run();
  b.local.put('Outgoing.md', 'local draft');
  const lock = ROOT + '/vaults/' + id + '/metadata/lock';
  assert.equal(await server.dav().mkdir(lock), true);
  const partial = await b.run();
  assert.equal(partial.counts.pull, 1);
  assert.equal(partial.counts.blocked, 2);
  assert.deepEqual(partial.errors, ['cloud-lock']);
  assert.equal(b.local.text('Incoming.md'), 'published');
  assert.equal(b.local.text('Delete.md'), 'keep while locked');
  assert.equal(b.local.text('Outgoing.md'), 'local draft');
  assert.equal(b.state.base.content['Outgoing.md'], undefined);
  await server.dav().remove(lock);
  const complete = await b.run();
  assert.equal(complete.counts.push, 1);
  assert.equal(complete.counts['delete-local'], 1);
  await a.run();
  assert.equal(a.local.text('Outgoing.md'), 'local draft');
});

test('uncertain upload of an unreferenced blob releases the lock and can be retried', async t => {
  const { a, b, server } = await setup(t);
  a.local.put('Retry.md', 'pending');
  server.fault = (method, path) => method === 'PUT' && path.includes('/content/') ? { status: 500 } : undefined;
  await assert.rejects(a.run(), fails('upload-retry'));
  assert.equal([...server.folders].some(path => path.endsWith('/metadata/lock')), false);
  assert.equal(a.local.text('Retry.md'), 'pending');
  server.fault = undefined;
  await a.run();
  await b.run();
  assert.equal(b.local.text('Retry.md'), 'pending');
});

test('successful commit and lock removal can be verified after the server loses both replies', async t => {
  const { a, b, server } = await setup(t);
  a.local.put('Verified.md', 'ready');
  server.afterMutation = (method, path) =>
    (method === 'MKCOL' && path.includes('/commits/')) || (method === 'DELETE' && path.endsWith('/metadata/lock'))
      ? { status: 500 } : undefined;
  await a.run();
  await b.run();
  assert.equal(b.local.text('Verified.md'), 'ready');
  assert.equal([...server.folders].some(path => path.endsWith('/metadata/lock')), false);
  assert.equal(server.requests.filter(row => row.method === 'DELETE' && row.path.endsWith('/metadata/lock')).length, 3);
});

test('a refused unlock reports the distinct error and leaves committed data available', async t => {
  const { a, b, server } = await setup(t);
  a.local.put('Refused unlock.md', 'before');
  await a.run();
  await b.run();
  a.local.put('Refused unlock.md', 'published');
  server.fault = (method, path) => method === 'DELETE' && path.endsWith('/metadata/lock') ? { status: 403 } : undefined;
  await assert.rejects(a.run(), fails('cloud-unlock'));
  assert.equal((await b.run()).counts.pull, 1);
  assert.equal(b.local.text('Refused unlock.md'), 'published');
  assert.equal([...server.folders].some(path => path.endsWith('/metadata/lock')), true);
});

test('exclusive MOVE publishes phone edits while the old empty lock still exists', async t => {
  const { a, server, id } = await setup(t);
  const phone = new Client(server, id, 'mobile', undefined, true);
  a.local.put('Бета.md', 'first');
  await a.run();
  await phone.run();
  const lock = ROOT + '/vaults/' + id + '/metadata/lock';
  await server.dav().mkdir(lock);
  phone.local.put('Бета.md', 'VPN round trip');
  assert.equal((await phone.run()).counts.push, 1);
  assert.equal((await a.run()).counts.pull, 1);
  assert.equal(a.local.text('Бета.md'), 'VPN round trip');
  assert.equal(server.folders.has('/' + lock), true);
});

test('concurrent exclusive publishers replan and combine two appended lines in one note', async t => {
  const { server, id } = await setup(t);
  const a = new Client(server, id, 'windows', undefined, true);
  const b = new Client(server, id, 'mobile', undefined, true);
  a.local.put('Race.md', 'before');
  await a.run();
  await b.run();
  a.local.put('Race.md', 'before\nlaptop edit');
  b.local.put('Race.md', 'before\nphone edit');
  const outcomes = await Promise.allSettled([a.run(), b.run()]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(fails('cloud-advanced')(outcome.reason));
  for (const client of [a, b, a, b]) await client.run();
  for (const client of [a, b]) {
    assert.deepEqual([...client.local.group('content').keys()], ['Race.md']);
    assert.deepEqual(new Set(client.local.text('Race.md')?.split('\n')), new Set(['before', 'laptop edit', 'phone edit']));
  }
  assert.equal(server.folders.has('/' + ROOT + '/vaults/' + id + '/metadata/lock'), false);
});

test('an automatic merge is replayed without duplicates if local application fails', async t => {
  const { a, b } = await setup(t);
  a.local.put('Merge.md', 'Общий текст');
  await a.run();
  await b.run();
  a.local.put('Merge.md', 'Общий текст\nПравка Windows');
  b.local.put('Merge.md', 'Общий текст\nПравка iPhone');
  await a.run();
  b.local.failNextPath = 'Merge.md';
  assert.equal((await b.run()).counts.blocked, 1);
  assert.equal(b.local.text('Merge.md'), 'Общий текст\nПравка iPhone');
  await b.run();
  await a.run();
  const expected = 'Общий текст\nПравка Windows\nПравка iPhone';
  assert.equal(a.local.text('Merge.md'), expected);
  assert.equal(b.local.text('Merge.md'), expected);
  assert.deepEqual([...b.local.group('content').keys()], ['Merge.md']);
});

test('the resolver refuses to overwrite a note that changed after opening the review', async t => {
  const { a, b } = await setup(t);
  a.local.put('Stale.md', 'base');
  await a.run();
  await b.run();
  a.local.put('Stale.md', 'cloud');
  b.local.put('Stale.md', 'local');
  await a.run();
  assert.equal((await b.run()).counts.review, 1);
  const review = await b.engine.reviewConflict(b.state, 'Stale.md');
  a.local.put('Stale.md', 'newer cloud');
  await a.run();
  await assert.rejects(b.engine.resolveConflict(b.state, review, { kind: 'text', text: 'old choice' }), fails('changed'));
  assert.equal(b.local.text('Stale.md'), 'local');
  assert.equal(a.local.text('Stale.md'), 'newer cloud');
  assert.equal((await b.run()).counts.review, 1);
});

test('conflicting binary attachments still get a separate byte-exact copy', async t => {
  const { a, b } = await setup(t);
  a.local.put('Drawing.pdf', 'base');
  await a.run();
  await b.run();
  a.local.put('Drawing.pdf', 'cloud bytes');
  b.local.put('Drawing.pdf', 'local bytes');
  await a.run();
  assert.equal((await b.run()).counts.conflict, 1);
  const copy = [...b.local.group('content').keys()].find(path => path.includes('(conflict '));
  assert.ok(copy);
  assert.equal(b.local.text(copy), 'local bytes');
  assert.equal(b.local.text('Drawing.pdf'), 'cloud bytes');
});

test('interrupted publisher is completed by another client from the verified ready record', async t => {
  const { a, server, id, remote } = await setup(t);
  const phone = new Client(server, id, 'mobile', undefined, true);
  a.local.put('Interrupted.md', 'before');
  await a.run();
  await phone.run();
  phone.local.put('Interrupted.md', 'prepared');
  server.fault = (method, path) => method === 'MKCOL' && path.includes('/commits/') ? { status: 500 } : undefined;
  assert.deepEqual((await phone.run()).errors, ['cloud-preparing']);
  assert.equal((await remote.head(null, true)).pending, true);
  server.fault = undefined;
  const helper = new Client(server, id, 'windows', undefined, true);
  await assert.rejects(helper.run(), fails('cloud-advanced'));
  await helper.run();
  await a.run();
  assert.equal(a.local.text('Interrupted.md'), 'prepared');
  assert.equal(helper.local.text('Interrupted.md'), 'prepared');
});

test('exclusive publisher verifies a moved revision after losing the MOVE reply', async t => {
  const { a, server, id } = await setup(t);
  const phone = new Client(server, id, 'mobile', undefined, true);
  phone.local.put('Lost response.md', 'publish once');
  server.afterMutation = (method, path) => method === 'MOVE' && path.includes('/metadata/staging/') ? { status: 500 } : undefined;
  assert.equal((await phone.run()).counts.push, 1);
  await a.run();
  assert.equal(a.local.text('Lost response.md'), 'publish once');
  assert.equal((await phone.run()).counts.push, 0);
});

test('exclusive publication leaves an abandoned legacy reservation untouched', async t => {
  const { a, server, id } = await setup(t);
  a.local.put('Old.md', 'committed');
  await a.run();
  const revision = (a.state.checkpoint?.revision ?? 0) + 1;
  const legacy = ROOT + '/vaults/' + id + '/metadata/revisions/' + revision;
  await server.dav().mkdir(legacy);
  const phone = new Client(server, id, 'mobile', undefined, true);
  phone.local.put('Pending.md', 'wait locally');
  assert.deepEqual((await phone.run()).errors, ['cloud-preparing']);
  assert.equal(phone.local.text('Old.md'), 'committed');
  assert.equal(phone.local.text('Pending.md'), 'wait locally');
  assert.equal(server.files.has('/' + legacy + '/index.json'), false);
});

test('a damaged ready record cannot publish an unconfirmed revision', async t => {
  const { a, server, id, remote } = await setup(t);
  const phone = new Client(server, id, 'mobile', undefined, true);
  a.local.put('Checked.md', 'known good');
  await a.run();
  await phone.run();
  const previous = phone.state.checkpoint?.revision ?? 0;
  phone.local.put('Checked.md', 'new draft');
  server.fault = (method, path) => method === 'MKCOL' && path.includes('/commits/') ? { status: 500 } : undefined;
  assert.deepEqual((await phone.run()).errors, ['cloud-preparing']);
  server.fault = undefined;
  const prefix = '/' + ROOT + '/vaults/' + id + '/metadata';
  server.files.set(prefix + '/revisions/' + (previous + 1) + '/ready', encode('0'.repeat(64)));
  await assert.rejects(phone.run(), fails('integrity'));
  assert.equal(server.folders.has(prefix + '/commits/' + (previous + 1)), false);
  assert.equal((await remote.head(null, true)).revision, previous);
  assert.equal(a.local.text('Checked.md'), 'known good');
  assert.equal(phone.local.text('Checked.md'), 'new draft');
});

test('Excalidraw profile contains portable values and leaves credentials and execution permissions local', () => {
  const source = {
    folder: 'Рисунки/Эскизы', width: '70%', embedType: 'SVG', pngExportScale: 2, isLeftHanded: true,
    cropFolder: '../elsewhere', zoomMax: 10_000, enableOnloadScripts: true, startupScriptPath: 'Unsafe.md',
    aiProviderProfiles: { Fake: { apiKey: 'synthetic-source-secret' } },
    taskboneAPIkey: 'synthetic-source-ocr', scriptEngineSettings: { plugin: { token: 'synthetic' } },
  };
  const profile = excalidrawPreferences(source);
  assert.deepEqual(profile, { folder: 'Рисунки/Эскизы', width: '70%', embedType: 'SVG', pngExportScale: 2, isLeftHanded: true });
  checkPayload('desktop-config', EXCALIDRAW_PROFILE, jsonBytes(profile));
  for (const extra of [{ taskboneAPIkey: 'never' }, { enableCommandLinks: true }, { folder: 'C:\\Other' }]) {
    assert.throws(() => checkPayload('desktop-config', EXCALIDRAW_PROFILE, jsonBytes({ ...profile, ...extra })), fails('configuration'));
  }
  assert.throws(() => checkPayload('desktop-config', EXCALIDRAW_PROFILE, jsonBytes({})), fails('configuration'));
  const existing = { width: '400', taskboneAPIkey: 'local-only', enableOnloadScripts: false, unknownSetting: { untouched: 1 } };
  const merged = mergePreferences(existing, profile, excalidrawPreferences);
  assert.deepEqual(excalidrawPreferences(merged), profile);
  assert.equal(merged.taskboneAPIkey, 'local-only');
  assert.equal(merged.enableOnloadScripts, false);
  assert.deepEqual(merged.unknownSetting, { untouched: 1 });
  assert.equal(inChannel('desktop-config', 'plugins/' + EXCALIDRAW_ID + '/main.js'), false);
  assert.equal(inChannel('desktop-config', 'plugins/' + EXCALIDRAW_ID + '/data.json'), false);
});

test('destination accepts the source Excalidraw profile and syncs later changes', async t => {
  const { server, id, mobile } = await setup(t);
  const source = new Client(server, id, 'windows', undefined, false, true);
  const destination = new Client(server, id, 'windows', undefined, false, true);
  const channel = 'desktop-config';
  source.local.put(EXCALIDRAW_PROFILE, '{"width":"700","isLeftHanded":true}', channel);
  destination.local.put(EXCALIDRAW_PROFILE, '{"width":"400","isLeftHanded":false}', channel);
  await source.run();
  assert.equal((await destination.run()).counts.conflict, 1);
  assert.equal(destination.local.text(EXCALIDRAW_PROFILE, channel), '{"width":"400","isLeftHanded":false}');
  destination.state = await destination.engine.acceptExcalidraw(destination.state);
  assert.equal(destination.local.text(EXCALIDRAW_PROFILE, channel), '{"width":"700","isLeftHanded":true}');
  source.local.put(EXCALIDRAW_PROFILE, '{"width":"900","isLeftHanded":true}', channel);
  await source.run();
  assert.equal((await destination.run()).counts.pull, 1);
  assert.equal(destination.local.text(EXCALIDRAW_PROFILE, channel), '{"width":"900","isLeftHanded":true}');
  const offset = server.requests.length;
  await mobile.run();
  assert.equal(mobile.local.text(EXCALIDRAW_PROFILE, channel), undefined);
  assert.equal(server.requests.slice(offset).some(row => row.path.includes('/desktop-config/')), false);
  await assert.rejects(mobile.engine.acceptExcalidraw(mobile.state), fails('configuration'));
});

test('missing Excalidraw install does not create a plugin or remove its cloud profile', async t => {
  const { server, id, remote } = await setup(t);
  const source = new Client(server, id, 'windows', undefined, false, true);
  const destination = new Client(server, id, 'windows', undefined, false, true);
  const channel = 'desktop-config';
  source.local.put(EXCALIDRAW_PROFILE, '{"width":"800"}', channel);
  await source.run();
  destination.local.ignored.set(channel, new Set([EXCALIDRAW_PROFILE]));
  await destination.run();
  assert.equal(destination.local.text(EXCALIDRAW_PROFILE, channel), undefined);
  await assert.rejects(destination.engine.acceptExcalidraw(destination.state), fails('configuration'));
  destination.local.ignored.delete(channel);
  assert.equal((await destination.run()).counts.pull, 1);
  destination.local.group(channel).delete(EXCALIDRAW_PROFILE);
  assert.equal((await destination.run()).counts.pull, 1);
  assert.equal((await remote.head(null)).manifest.files[channel][EXCALIDRAW_PROFILE]?.kind, 'file');
});

test('catalog install commands target the selected vault and cannot include shell tokens from plugin IDs', () => {
  assert.equal(catalogInstallCommand('TotalSync Beta', EXCALIDRAW_ID, true),
    "obsidian 'vault=TotalSync Beta' plugin:install id=obsidian-excalidraw-plugin enable");
  assert.equal(catalogInstallCommand("Artist's notes", 'calendar', false),
    "obsidian 'vault=Artist''s notes' plugin:install id=calendar");
  for (const id of ['bad;command', 'bad id', '../folder', 'total-sync']) {
    assert.equal(catalogInstallCommand('TotalSync Beta', id, true), undefined);
  }
  assert.equal(catalogInstallCommand('Unsafe\nName', 'calendar', false), undefined);
  assert.equal(catalogInstallCommand('Unsafe’Name', 'calendar', false), undefined);
});
