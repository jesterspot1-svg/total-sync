import {
  channels, hashPattern, idPattern, index, object, parse, SyncError,
  type Channel, type Manifest, type RemoteEntry, type RemoteFile, type SyncState,
} from './model';
import { inChannel, pathKey } from './policy';

const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isChannel = (value: unknown): value is Channel => channels.some(channel => channel === value);
const keys = (data: Record<string, unknown>, allowed: string[]) => Object.keys(data).every(key => allowed.includes(key));

function file(value: unknown): value is RemoteFile {
  return object(value) && value.kind === 'file' && validHash(value.hash) && validId(value.blob)
    && validId(value.device) && integer(value.size) && integer(value.at)
    && keys(value, ['kind', 'hash', 'blob', 'device', 'size', 'at']);
}

function entry(value: unknown, channel: Channel): value is RemoteEntry {
  return file(value) || (object(value) && (value.kind === 'deleted' || (value.kind === 'folder' && channel === 'content'))
    && validId(value.device) && integer(value.at) && keys(value, ['kind', 'device', 'at']));
}

export function emptyManifest(vault: string, now: number): Manifest {
  return {
    schema: 1, vault, revision: 0, parent: null, at: now,
    devices: index(), files: { content: index(), 'shared-state': index(), 'desktop-config': index() },
    history: [], garbage: [],
  };
}

export function validateManifest(bytes: ArrayBuffer, vault: string): Manifest {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new SyncError('size');
  const data = parse(bytes);
  if (!object(data) || !keys(data, ['schema', 'vault', 'revision', 'parent', 'at', 'devices', 'files', 'history', 'garbage'])
    || data.schema !== 1 || data.vault !== vault || !validId(data.vault) || !integer(data.revision)
    || (data.revision === 0 ? data.parent !== null : !validHash(data.parent)) || !integer(data.at)
    || !object(data.devices) || !object(data.files) || !keys(data.files, [...channels])
    || !Array.isArray(data.history) || !Array.isArray(data.garbage)) throw new SyncError('integrity');
  const result = emptyManifest(vault, data.at);
  result.revision = data.revision;
  result.parent = typeof data.parent === 'string' ? data.parent : null;
  for (const [id, profile] of Object.entries(data.devices)) {
    if (!validId(id) || (profile !== 'windows' && profile !== 'desktop' && profile !== 'mobile')) throw new SyncError('integrity');
    result.devices[id] = profile;
  }
  const liveBlobs = new Set<string>();
  for (const channel of channels) {
    const group = data.files[channel];
    if (!object(group)) throw new SyncError('integrity');
    const aliases = new Set<string>();
    for (const [path, item] of Object.entries(group)) {
      const alias = pathKey(path);
      if (!inChannel(channel, path) || aliases.has(alias) || !entry(item, channel)) throw new SyncError('integrity');
      aliases.add(alias);
      if (item.kind === 'file') liveBlobs.add(channel + '/' + item.blob);
      result.files[channel][path] = item;
    }
    if (channel === 'content') {
      for (const [path, item] of Object.entries(result.files.content)) {
        const parent = path.lastIndexOf('/');
        if (item.kind !== 'deleted' && parent >= 0 && result.files.content[path.slice(0, parent)]?.kind !== 'folder') {
          throw new SyncError('integrity');
        }
      }
    }
  }
  const historyIds = new Set<string>();
  for (const item of data.history) {
    if (!object(item) || !keys(item, ['id', 'channel', 'path', 'reason', 'at', 'file'])
      || !validId(item.id) || historyIds.has(item.id) || !isChannel(item.channel)
      || typeof item.path !== 'string' || !inChannel(item.channel, item.path) || !integer(item.at)
      || (item.reason !== 'updated' && item.reason !== 'deleted' && item.reason !== 'conflict')
      || !file(item.file)) throw new SyncError('integrity');
    historyIds.add(item.id);
    liveBlobs.add(item.channel + '/' + item.file.blob);
    result.history.push({ id: item.id, channel: item.channel, path: item.path, at: item.at, reason: item.reason, file: item.file });
  }
  const garbage = new Set<string>();
  for (const item of data.garbage) {
    if (!object(item) || !keys(item, ['channel', 'blob']) || !isChannel(item.channel) || !validId(item.blob)) {
      throw new SyncError('integrity');
    }
    const key = item.channel + '/' + item.blob;
    if (liveBlobs.has(key) || garbage.has(key)) throw new SyncError('integrity');
    garbage.add(key);
    result.garbage.push({ channel: item.channel, blob: item.blob });
  }
  return result;
}

function isStamp(value: unknown): boolean {
  return value === null || value === 'folder' || value === 'deleted'
    || (typeof value === 'string' && value.startsWith('file:') && validHash(value.slice(5)));
}

export function validState(value: unknown): value is SyncState {
  if (!object(value) || value.schema !== 1 || !object(value.base)) return false;
  const checkpoint = value.checkpoint;
  if (checkpoint !== null && (!object(checkpoint) || !integer(checkpoint.revision) || !validHash(checkpoint.hash))) return false;
  const base = value.base;
  return channels.every(channel => {
    const group = base[channel];
    return object(group) && Object.entries(group).every(([path, item]) =>
      inChannel(channel, path) && object(item) && isStamp(item.local) && item.local !== 'deleted' && isStamp(item.remote));
  });
}
