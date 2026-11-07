import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, DavServer } from './fixture';
import { RemoteVault } from '../src/repository';
import { MAIL, ROOT, webdavEndpoint } from '../src/webdav';
import { options } from '../src/settings';

test('WebDAV endpoints retain provider paths and ports, normalize safely and reject embedded credentials', () => {
  assert.equal(webdavEndpoint(' https://CLOUD.example.com:8443/remote.php/dav/files/user/Мои заметки/ '),
    'https://cloud.example.com:8443/remote.php/dav/files/user/' + encodeURIComponent('Мои заметки'));
  assert.equal(webdavEndpoint('https://dav.example.com/'), 'https://dav.example.com');
  const withCredentials = new URL('https://cloud.example.com/dav');
  withCredentials.username = 'tester'; withCredentials.password = 'synthetic';
  for (const value of [withCredentials.href, 'https://example.com/?secret=test', 'https://example.com/#secret',
    'https://example.com/\nother', 'https://example.com/%5cpath', 'ftp://example.com/dav', 'https://example.com/%00']) {
    assert.throws(() => webdavEndpoint(value));
  }
  const old = options({ binding: crypto.randomUUID(), device: crypto.randomUUID(), enabled: true });
  assert.equal(old.endpoint, MAIL);
  assert.equal(old.enabled, true);
  assert.equal(old.language, 'auto');
  assert.equal(options({ endpoint: 'https://dav.example.com/dav/', language: 'ru' }).endpoint, 'https://dav.example.com/dav');
  assert.equal(options({ language: 'ru' }).language, 'ru');
  assert.equal(options({ language: 'de' }).language, 'auto');
});

for (const exclusive of [false, true]) test(`custom WebDAV path supports probe and two-way sync (exclusive MOVE=${exclusive})`, async t => {
  const server = await new DavServer().start();
  t.after(() => server.close());
  const endpoint = 'https://cloud.example.com:8443/remote.php/dav/files/tester/Notes%20and%20files';
  const prefix = new URL(endpoint).pathname;
  let folder = '';
  for (const part of prefix.slice(1).split('/')) { folder += '/' + part; server.folders.add(folder); }
  server.moveCollections = exclusive;
  const dav = server.dav(5000, 0, endpoint);
  assert.equal((await RemoteVault.probe(dav)).exclusiveMove, exclusive);
  const id = crypto.randomUUID();
  await new RemoteVault(dav, id).create(server.clock);
  const a = new Client(server, id, 'windows', undefined, exclusive, false, undefined, undefined, undefined, endpoint);
  const b = new Client(server, id, 'mobile', undefined, exclusive, false, undefined, undefined, undefined, endpoint);
  a.local.put('Notes/Привет.md', 'from desktop');
  assert.equal((await a.run()).counts.blocked, 0);
  await b.run();
  assert.equal(b.local.text('Notes/Привет.md'), 'from desktop');
  b.local.put('Notes/Привет.md', 'from phone');
  await b.run(); await a.run();
  assert.equal(a.local.text('Notes/Привет.md'), 'from phone');
  assert.ok(server.requests.every(request => request.path === prefix || request.path.startsWith(prefix + '/')));
  assert.ok(!server.folders.has('/' + ROOT), 'No data is written at the provider root outside the selected folder');
});
