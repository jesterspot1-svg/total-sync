import {
  channels, stamp, SyncError,
  type Channel, type LocalEntry, type Manifest, type RemoteEntry, type Scan, type SyncState,
} from './model';
import { isNote, pathKey } from './policy';

export interface Selection {
  channels: readonly Channel[];
  attachments: boolean;
  exclude: readonly string[];
  calendar?: boolean;
}
export type Action = 'push' | 'pull' | 'delete-remote' | 'delete-local' | 'conflict' | 'equal' | 'blocked';
export interface Operation {
  action: Action;
  channel: Channel;
  path: string;
  local?: LocalEntry;
  remote?: RemoteEntry;
}
export interface Plan {
  operations: Operation[];
  destructive: Operation[];
  requiresApproval: boolean;
}

function selected(channel: Channel, path: string, selection: Selection, folder: boolean): boolean {
  if (channel === 'desktop-config' && path === 'plugins/calendar/preferences.json') return !!selection.calendar;
  if (channel !== 'content') return true;
  const alias = pathKey(path);
  return (folder || selection.attachments || isNote(path))
    && !selection.exclude.some(prefix => alias === prefix || alias.startsWith(prefix + '/'));
}

export function planSync(manifest: Manifest, state: SyncState, scans: ReadonlyMap<Channel, Scan>, selection: Selection): Plan {
  const operations: Operation[] = [];
  let requiresApproval = false;
  for (const channel of channels) {
    const scan = scans.get(channel);
    if (!scan || !selection.channels.includes(channel)) continue;
    const remoteGroup = manifest.files[channel];
    const baseline = state.base[channel];
    const paths = new Set([...Object.keys(remoteGroup), ...scan.entries.keys(), ...Object.keys(baseline), ...scan.blocked]);
    const aliases = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const path of paths) {
      if (!path) continue;
      const key = pathKey(path);
      const previous = aliases.get(key);
      if (previous && previous !== path) {
        duplicates.add(previous);
        duplicates.add(path);
      }
      aliases.set(key, path);
    }
    const blockedBranches = new Set([...scan.blocked, ...duplicates]);
    let count = 0;
    let deletions = 0;
    for (const path of paths) {
      if (!path) continue;
      const local = scan.entries.get(path);
      const remote = remoteGroup[path];
      const base = Object.prototype.hasOwnProperty.call(baseline, path) ? baseline[path] : undefined;
      const folder = local?.kind === 'folder' || remote?.kind === 'folder' || base?.local === 'folder';
      if (!selected(channel, path, selection, folder)) continue;
      if (remote === undefined && base?.remote) throw new SyncError('integrity');
      if (local || (remote && remote.kind !== 'deleted')) count++;
      const localStamp = stamp(local);
      const remoteStamp = stamp(remote);
      const incompatible = !!local && !!remote && remote.kind !== 'deleted' && local.kind !== remote.kind;
      let action: Action = 'equal';
      if (blockedBranches.has(path) || incompatible || hasBlockedParent(path, blockedBranches)) action = 'blocked';
      else if (localStamp !== remoteStamp) {
        const localChanged = localStamp !== (base?.local ?? null);
        const remoteChanged = remoteStamp !== (base?.remote ?? null);
        if (channel !== 'content' && local?.kind === 'file' && remote?.kind === 'file'
          && base?.local !== base?.remote && (localChanged || remoteChanged)) action = 'conflict';
        else if (localChanged && remoteChanged) action = local || remote?.kind === 'file' || remote?.kind === 'folder' ? 'conflict' : 'equal';
        else if (localChanged) action = local ? 'push' : 'delete-remote';
        else if (remoteChanged) action = remote?.kind === 'deleted' ? local ? 'delete-local' : 'equal' : 'pull';
      }
      if (action === 'delete-local' || action === 'delete-remote') {
        if (scan.blocked.size > 0 || duplicates.size > 0 || (!selection.attachments && folder)) action = 'blocked';
        else deletions++;
      }
      operations.push({ action, channel, path, local, remote });
    }
    if (deletions >= 25 || (deletions >= 2 && deletions / Math.max(1, count) > 0.1)) requiresApproval = true;
  }
  const destructive = operations.filter(op => op.action === 'delete-remote' || op.action === 'delete-local');
  return { operations, destructive, requiresApproval };
}

function hasBlockedParent(path: string, blocked: ReadonlySet<string>): boolean {
  let end = path.lastIndexOf('/');
  while (end >= 0) {
    if (blocked.has(path.slice(0, end))) return true;
    end = path.lastIndexOf('/', end - 1);
  }
  return false;
}
