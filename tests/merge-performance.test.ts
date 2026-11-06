import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fingerprints } from '../src/fingerprints';
import { markdownText, mergeMarkdown } from '../src/markdown-merge';
import { encode, SyncError } from '../src/model';

function merged(base: string, local: string, remote: string): string {
  const result = mergeMarkdown(base, local, remote);
  return result.parts.flatMap(part => {
    assert.equal(part.kind, 'text');
    return part.lines;
  }).join(result.eol);
}

test('three-way Markdown merge combines edits to separate lines without changing CRLF', () => {
  assert.equal(merged('A\r\nMiddle\r\nC\r\n', 'Local\r\nMiddle\r\nC\r\n', 'A\r\nMiddle\r\nCloud\r\n'),
    'Local\r\nMiddle\r\nCloud\r\n');
});

test('plain concurrent additions at EOF preserve both lines and replay without duplicates', () => {
  const base = 'Общий текст';
  const local = base + '\nПравка iPhone';
  const remote = base + '\nПравка Windows';
  const combined = base + '\nПравка Windows\nПравка iPhone';
  assert.equal(merged(base, local, remote), combined);
  assert.equal(merged(base, local, combined), combined);
  assert.equal(merged(base + '\n', local, remote), combined);
  assert.equal(merged(base + '\n', local + '\n', remote + '\n'), combined + '\n');
});

test('overlap exposes the disputed fragment; unknown base and structured insertions require review', () => {
  const review = mergeMarkdown('Top\nBase\nEnd', 'Top\nLeft\nEnd', 'Top\nRight\nEnd');
  assert.deepEqual(review.parts, [
    { kind: 'text', lines: ['Top'] },
    { kind: 'conflict', base: ['Base'], local: ['Left'], remote: ['Right'] },
    { kind: 'text', lines: ['End'] },
  ]);
  assert.equal(mergeMarkdown(undefined, 'A', 'B').parts[0]?.kind, 'conflict');
  assert.ok(mergeMarkdown('Items', 'Items\n1. First', 'Items\n1. Second').parts.some(part => part.kind === 'conflict'));
  assert.equal(markdownText(Uint8Array.from([255]).buffer), undefined);
  assert.equal(markdownText(encode('binary\0data')), undefined);
});

test('a large comparison falls back to review instead of allocating an unbounded matrix', () => {
  const lines = (prefix: string) => Array.from({ length: 2000 }, (_, i) => prefix + i).join('\n');
  const result = mergeMarkdown(lines('base'), lines('local'), lines('remote'));
  assert.equal(result.parts[0]?.kind, 'conflict');
});

test('fingerprints avoid unchanged reads and invalidate on events and expiry', async () => {
  const cache = new Fingerprints<object>();
  const file = {};
  const stat = () => ({ mtime: 1, ctime: 1, size: 3 });
  let bytes = 'one';
  let reads = 0;
  const read = async () => { reads++; return encode(bytes); };
  const first = await cache.scan(file, stat, read, 0);
  assert.equal((await cache.scan(file, stat, read, 1)).hash, first.hash);
  assert.equal(reads, 1);
  bytes = 'two';
  cache.invalidate(file);
  assert.notEqual((await cache.scan(file, stat, read, 2)).hash, first.hash);
  bytes = 'new';
  const expired = await cache.scan(file, stat, read, 15 * 60_000 + 2);
  assert.notEqual(expired.hash, first.hash);
  assert.equal(reads, 3);
});

test('a vault event during hashing discards the in-flight fingerprint', async () => {
  const cache = new Fingerprints<object>();
  const file = {};
  const stat = () => ({ mtime: 1, ctime: 1, size: 3 });
  await assert.rejects(cache.scan(file, stat, async () => {
    cache.invalidate(file);
    return encode('old');
  }), (error: unknown) => error instanceof SyncError && error.code === 'changed');
  assert.equal((await cache.scan(file, stat, async () => encode('new'))).size, 3);
});
