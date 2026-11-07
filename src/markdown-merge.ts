type Edit = { start: number; end: number; lines: string[] };
type SideEdit = Edit & { side: 'local' | 'remote' };
export type MergePart =
  | { kind: 'text'; lines: string[] }
  | { kind: 'conflict'; base: string[]; local: string[]; remote: string[] };

export interface MarkdownMerge {
  parts: MergePart[];
  eol: string;
}

export const maxMergeBytes = 512 * 1024;
const maxDiffCells = 2_000_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function markdownText(bytes: ArrayBuffer): string | undefined {
  if (bytes.byteLength > maxMergeBytes) return undefined;
  try {
    const text = decoder.decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

export function markdownPreviews(local: ArrayBuffer, remote: ArrayBuffer): { local: string; remote: string } {
  const a = new Uint8Array(local);
  const b = new Uint8Array(remote);
  const shared = Math.min(a.length, b.length);
  let firstChange = 0;
  while (firstChange < shared && a[firstChange] === b[firstChange]) firstChange++;
  const previewDecoder = new TextDecoder();
  const preview = (bytes: Uint8Array) => {
    let start = Math.max(0, firstChange - 512);
    const end = Math.min(bytes.length, firstChange + 1536);
    while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
    const text = previewDecoder.decode(bytes.subarray(start, end), { stream: end < bytes.length });
    previewDecoder.decode();
    return (start > 0 ? '…\n' : '') + text + (end < bytes.length ? '\n…' : '');
  };
  return { local: preview(a), remote: preview(b) };
}

const equal = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

function edits(base: string[], target: string[]): Edit[] | undefined {
  let start = 0;
  while (start < base.length && start < target.length && base[start] === target[start]) start++;
  let baseEnd = base.length;
  let targetEnd = target.length;
  while (baseEnd > start && targetEnd > start && base[baseEnd - 1] === target[targetEnd - 1]) {
    baseEnd--;
    targetEnd--;
  }
  if (start === baseEnd && start === targetEnd) return [];
  const rows = baseEnd - start + 1;
  const cols = targetEnd - start + 1;
  if (rows * cols > maxDiffCells) return undefined;
  const table = new Uint32Array(rows * cols);
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = cols - 2; j >= 0; j--) {
      const p = i * cols + j;
      table[p] = base[start + i] === target[start + j] ? 1 + table[p + cols + 1]!
        : Math.max(table[p + cols]!, table[p + 1]!);
    }
  }

  const result: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < rows - 1 || j < cols - 1) {
    if (i < rows - 1 && j < cols - 1 && base[start + i] === target[start + j]) {
      i++;
      j++;
      continue;
    }
    const from = i;
    const targetFrom = j;
    while (i < rows - 1 || j < cols - 1) {
      if (i < rows - 1 && j < cols - 1 && base[start + i] === target[start + j]) break;
      if (j === cols - 1 || (i < rows - 1 && table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)) i++;
      else j++;
    }
    result.push({ start: start + from, end: start + i, lines: target.slice(start + targetFrom, start + j) });
  }
  return result;
}

function touches(from: number, to: number, next: Edit): boolean {
  if (from === to || next.start === next.end) return next.start <= to && next.end >= from;
  return next.start < to && next.end > from;
}

function applyEdits(base: string[], start: number, end: number, changes: Edit[]): string[] {
  const result: string[] = [];
  let cursor = start;
  for (const change of changes) {
    for (; cursor < change.start; cursor++) result.push(base[cursor]!);
    for (const line of change.lines) result.push(line);
    cursor = change.end;
  }
  for (; cursor < end; cursor++) result.push(base[cursor]!);
  return result;
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let index = 0;
  for (const line of haystack) if (line === needle[index]) index++;
  return index === needle.length;
}

function appendBoth(base: string[], start: number, end: number, local: string[], remote: string[]): string[] | undefined {
  const logicalEnd = base[base.length - 1] === '' ? base.length - 1 : base.length;
  if (start !== logicalEnd || end > base.length || !local.some(Boolean) || !remote.some(Boolean)) return undefined;
  // Combining two insertions at one location is only safe for plain text at the end.
  const plain = (line: string) => line === '' || (/^[\p{L}\p{N}][^[\]{}<>|`]*$/u.test(line) && !/^\d+[.)](?:\s|$)/.test(line));
  if (![...base, ...local, ...remote].every(plain)) return undefined;
  if (isSubsequence(local, remote)) return remote;
  if (isSubsequence(remote, local)) return local;
  const tail = end === base.length && (local[local.length - 1] === '' || remote[remote.length - 1] === '');
  const withoutTail = (lines: string[]) => tail && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...withoutTail(remote), ...withoutTail(local), ...(tail ? [''] : [])];
}

export function mergeMarkdown(baseText: string | undefined, localText: string, remoteText: string): MarkdownMerge {
  const eol = remoteText.includes('\r\n') ? '\r\n' : '\n';
  const split = (text: string) => text.replace(/\r\n/g, '\n').split('\n');
  const base = baseText === undefined ? [] : split(baseText);
  const local = split(localText);
  const remote = split(remoteText);
  const fullConflict: MarkdownMerge = { parts: [{ kind: 'conflict', base, local, remote }], eol };
  if (baseText === undefined || [...base, ...local, ...remote].some(line => line.includes('\r'))) return fullConflict;
  const localEdits = edits(base, local);
  const remoteEdits = edits(base, remote);
  if (!localEdits || !remoteEdits) return fullConflict;
  const all: SideEdit[] = [
    ...localEdits.map(edit => ({ ...edit, side: 'local' as const })),
    ...remoteEdits.map(edit => ({ ...edit, side: 'remote' as const })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: MergePart[] = [];
  let cursor = 0;
  for (let i = 0; i < all.length;) {
    const first = all[i++]!;
    const group = [first];
    let end = first.end;
    while (i < all.length && touches(first.start, end, all[i]!)) {
      const next = all[i++]!;
      group.push(next);
      end = Math.max(end, next.end);
    }
    if (cursor < first.start) parts.push({ kind: 'text', lines: base.slice(cursor, first.start) });
    const l = group.filter(edit => edit.side === 'local');
    const r = group.filter(edit => edit.side === 'remote');
    const left = applyEdits(base, first.start, end, l);
    const right = applyEdits(base, first.start, end, r);
    const joined = l.length && r.length && !equal(left, right) ? appendBoth(base, first.start, end, left, right) : undefined;
    if (l.length && r.length && !equal(left, right) && !joined) {
      parts.push({ kind: 'conflict', base: base.slice(first.start, end), local: left, remote: right });
    } else {
      parts.push({ kind: 'text', lines: joined ?? (l.length ? left : right) });
    }
    cursor = end;
  }
  if (cursor < base.length) parts.push({ kind: 'text', lines: base.slice(cursor) });
  return { parts, eol };
}
