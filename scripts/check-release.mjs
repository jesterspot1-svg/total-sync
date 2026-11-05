import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(path, 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const versions = JSON.parse(read('versions.json'));
const pkg = JSON.parse(read('package.json'));
assert.equal(manifest.id, 'total-sync');
assert.equal(manifest.isDesktopOnly, false);
assert.equal(manifest.version, pkg.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(read('dist/manifest.json'), read('manifest.json'));
assert.deepEqual(pkg.dependencies ?? {}, {});

const bundle = read('dist/main.js');
const imports = [...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]);
assert.ok(imports.length);
assert.deepEqual([...new Set(imports)], ['obsidian']);
assert.doesNotMatch(bundle, /\b(?:node:|electron\b|process\.env\b|console\.)/i);

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const secret = new RegExp([
  'gh' + '[opusr]_[A-Za-z0-9_]{30,}',
  'github_' + 'pat_[A-Za-z0-9_]{30,}',
  '-----BEGIN (?:[A-Z0-9 ]+ )?' + 'PRIVATE KEY-----',
  'https?://[^\\s/:"<>]+:[^\\s/@"<>]+@',
].join('|'));
for (const path of new Set([...files, 'dist/main.js', 'dist/manifest.json'])) {
  assert.doesNotMatch(path, /(?:^|\/)(?:\.obsidian[^/]*|data\.json|\.env[^/]*|\.npmrc)(?:\/|$)|\.(?:pem|key|pfx|p12|har|zip|7z|log)$/i);
  if (/\.(?:png|jpe?g|webp)$/i.test(path)) continue;
  if (secret.test(read(path))) throw new Error('Potential secret in tracked file: ' + path);
}
console.log('Release assets, runtime imports and repository secret patterns verified.');
