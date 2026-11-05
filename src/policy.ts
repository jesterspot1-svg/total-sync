import { type Channel, idPattern, object, parse, decode, encode, SyncError } from './model';

const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
const markdown = /\.(md|canvas|base)$/i;
const pluginId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const semver = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][a-zA-Z0-9.-]{1,64})?$/;
const core = new Set([
  'hotkeys.json', 'appearance.json', 'app.json', 'core-plugins.json',
  'core-plugins-migration.json', 'daily-notes.json', 'templates.json',
  'graph.json', 'page-preview.json', 'switcher.json', 'backlink.json',
  'outgoing-link.json', 'tag-pane.json', 'word-count.json', 'canvas.json',
]);

export function portablePath(path: string): string {
  const normalized = path.normalize('NFC');
  if (!normalized || normalized.length > 1024) throw new SyncError('path');
  for (const segment of normalized.split('/')) {
    if (!segment || segment.startsWith('.') || segment.length > 240 || /[. ]$/.test(segment)
      || reserved.test(segment) || /[<>:"|?*\\]/.test(segment)
      || Array.from(segment).some(char => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
      })) {
      throw new SyncError('path');
    }
  }
  return normalized;
}

export function pathKey(path: string): string {
  return path.normalize('NFC').toUpperCase();
}

export function safePluginId(value: string): boolean {
  return pluginId.test(value);
}

export function safeVersion(value: string): boolean {
  return semver.test(value);
}

export function inChannel(channel: Channel, path: string): boolean {
  if (portablePath(path) !== path) return false;
  if (channel === 'content') return !/^TotalSync-Recovery(?:\/|$)/i.test(path);
  if (channel === 'shared-state') return path === 'bookmarks.json';
  if (core.has(path) || /^snippets\/[^/]+\.css$/i.test(path)
    || /^themes\/[^/]+\/(?:theme\.css|manifest\.json)$/.test(path)
    || path === 'plugins/calendar/preferences.json') return true;
  const inventory = /^inventory\/([^/]+)\.json$/.exec(path);
  return !!inventory?.[1] && idPattern.test(inventory[1]);
}

export function isNote(path: string): boolean {
  return markdown.test(path);
}

const secretKey = /pass(?:word|phrase|wd)?|secret|token|(?:api|private|access|client|encrypt|signing)[\s_-]*key|credential|authorization|cookie|session[_-]?id|webdav|auth[_-]?(?:key|data)|license[_-]?key/i;

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, item]) =>
    !secretKey.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && safeJson(item, depth + 1));
}

export function calendarPreferences(value: unknown): Record<string, boolean | string | number> {
  const result: Record<string, boolean | string | number> = {};
  if (!object(value)) return result;
  for (const key of ['showWeekNumber', 'confirmCreate', 'shouldConfirmBeforeCreate', 'showWeeklyNote']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Number.isInteger(value.wordsPerDot) && Number(value.wordsPerDot) > 0 && Number(value.wordsPerDot) <= 10000) {
    result.wordsPerDot = Number(value.wordsPerDot);
  }
  if (typeof value.weekStart === 'string' && /^(?:locale|sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(value.weekStart)) {
    result.weekStart = value.weekStart;
  }
  return result;
}

export function checkPayload(channel: Channel, path: string, bytes: ArrayBuffer): void {
  if (!inChannel(channel, path)) throw new SyncError('path');
  if (channel === 'content') return;
  if (bytes.byteLength > 2 * 1024 * 1024) throw new SyncError('size');
  if (path.toLowerCase().endsWith('.css')) {
    let css: string;
    try {
      css = decode(bytes).replace(/\/\*[\s\S]*?\*\//g, '');
    } catch {
      throw new SyncError('configuration');
    }
    if (/\\|@\s*import|\b(?:url|src|image|(?:-webkit-)?image-set)\s*\(/i.test(css)) {
      throw new SyncError('configuration');
    }
    return;
  }
  const data = parse(bytes);
  if (path.startsWith('inventory/')) {
    if (!Array.isArray(data) || data.length > 5000 || !data.every(row =>
      object(row) && Object.keys(row).length === 3 && typeof row.id === 'string'
      && safePluginId(row.id) && row.id !== 'total-sync' && typeof row.version === 'string'
      && safeVersion(row.version) && typeof row.enabled === 'boolean')) throw new SyncError('configuration');
    return;
  }
  if (path === 'plugins/calendar/preferences.json') {
    if (!object(data) || Object.keys(data).length !== Object.keys(calendarPreferences(data)).length) {
      throw new SyncError('configuration');
    }
    return;
  }
  if (channel === 'shared-state' && (!object(data) || !Array.isArray(data.items))) {
    throw new SyncError('configuration');
  }
  if ((!object(data) && !Array.isArray(data)) || !safeJson(data)) throw new SyncError('configuration');
}

export function jsonBytes(value: unknown): ArrayBuffer {
  return encode(JSON.stringify(value));
}
