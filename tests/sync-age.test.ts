import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSyncAge } from '../src/sync-age';

const start = 1_800_000_000_000;

test('Russian sync age changes at the minute boundary', () => {
  assert.deepEqual(formatSyncAge(start, start + 59_999, 'ru'), {
    text: 'Синхронизация была сейчас', refreshIn: 1,
  });
  assert.deepEqual(formatSyncAge(start, start + 60_000, 'ru'), {
    text: 'Синхронизация была 1 мин назад', refreshIn: 60_000,
  });
});

test('English sync age pluralizes and increases the refresh interval for older timestamps', () => {
  assert.equal(formatSyncAge(start, start + 60_000, 'en').text, 'Successfully synced 1 minute ago');
  assert.equal(formatSyncAge(start, start + 120_000, 'en').text, 'Successfully synced 2 minutes ago');
  assert.deepEqual(formatSyncAge(start, start + 3_600_000, 'en'), {
    text: 'Successfully synced 1 hour ago', refreshIn: 3_600_000,
  });
  assert.deepEqual(formatSyncAge(start, start + 86_400_000, 'en'), {
    text: 'Successfully synced 1 day ago', refreshIn: 86_400_000,
  });
});

test('missing or invalid sync time has no timer and clock rollback cannot give a negative age', () => {
  assert.deepEqual(formatSyncAge(null, start, 'ru'), { text: 'Синхронизации ещё не было', refreshIn: null });
  assert.deepEqual(formatSyncAge(Infinity, start, 'en'), { text: 'Not synced yet', refreshIn: null });
  assert.deepEqual(formatSyncAge(start, start - 1, 'en'), { text: 'Successfully synced just now', refreshIn: 60_000 });
});
