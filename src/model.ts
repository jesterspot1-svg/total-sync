export const channels = ['content', 'shared-state', 'desktop-config'] as const;
export type Channel = typeof channels[number];
export type Profile = 'windows' | 'mobile' | 'desktop';
export const DAY = 86_400_000;
export const RETENTION = 30 * DAY;
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const hashPattern = /^[a-f0-9]{64}$/;
export const index = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export type ErrorCode =
  | 'auth' | 'forbidden' | 'missing' | 'rate' | 'server' | 'network' | 'timeout' | 'uncertain'
  | 'dav' | 'protocol' | 'busy' | 'integrity' | 'identity' | 'path' | 'changed'
  | 'mass-delete' | 'size' | 'configuration' | 'local' | 'inactive';

export class SyncError extends Error {
  constructor(readonly code: ErrorCode, readonly status?: number) {
    super(code);
    this.name = 'SyncError';
  }
}

export type LocalEntry = { kind: 'folder' } | { kind: 'file'; hash: string; size: number };
export type Stamp = string | null;
export type RemoteFile = Extract<LocalEntry, { kind: 'file' }> & {
  blob: string;
  at: number;
  device: string;
};
export type RemoteEntry =
  | RemoteFile
  | { kind: 'folder'; at: number; device: string }
  | { kind: 'deleted'; at: number; device: string };
export interface HistoryItem {
  id: string;
  channel: Channel;
  path: string;
  reason: 'updated' | 'deleted' | 'conflict';
  at: number;
  file: RemoteFile;
}
export interface Garbage {
  channel: Channel;
  blob: string;
}
export interface Manifest {
  schema: 1;
  vault: string;
  revision: number;
  parent: string | null;
  at: number;
  devices: Record<string, Profile>;
  files: Record<Channel, Record<string, RemoteEntry>>;
  history: HistoryItem[];
  garbage: Garbage[];
}
export interface Checkpoint {
  revision: number;
  hash: string;
}
export interface Baseline {
  local: Stamp;
  remote: Stamp;
}
export interface SyncState {
  schema: 1;
  checkpoint: Checkpoint | null;
  base: Record<Channel, Record<string, Baseline>>;
}
export interface Scan {
  entries: Map<string, LocalEntry>;
  blocked: Set<string>;
  issues?: Set<ErrorCode>;
}
export interface LocalFiles {
  scan(channel: Channel): Promise<Scan>;
  read(channel: Channel, path: string): Promise<ArrayBuffer>;
  verify(channel: Channel, path: string, expected: Stamp): Promise<void>;
  apply(channel: Channel, path: string, expected: Stamp, next: LocalEntry | null, bytes?: ArrayBuffer): Promise<void>;
}

export function newState(): SyncState {
  return { schema: 1, checkpoint: null, base: { content: index(), 'shared-state': index(), 'desktop-config': index() } };
}

export function stamp(entry?: LocalEntry | RemoteEntry | null): Stamp {
  if (!entry) return null;
  return entry.kind === 'file' ? 'file:' + entry.hash : entry.kind;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

export function encode(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

export function decode(bytes: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parse(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    throw new SyncError('integrity');
  }
}
