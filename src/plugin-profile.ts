import { encode, hashPattern, idPattern, index, object, parse, sha256, SyncError } from './model';
import { safePluginId, safeVersion } from './policy';
import { safePreferenceKey, portableValue, type Preference } from './plugin-preferences';

export const packageNames = ['main.js', 'manifest.json', 'styles.css', 'pdfannots2json.exe'] as const;
export type PackageName = typeof packageNames[number];
export interface BlobRef { hash: string; size: number }
export interface PluginPackage { version: string; files: Partial<Record<PackageName, BlobRef>> }
export type FieldValue = PluginPackage | Preference;
export type Clock = Record<string, number>;
export interface PluginEdit { seq: number; seen: Clock; value: FieldValue }
export interface PluginHead {
  schema: 1; vault: string; device: string; seq: number;
  edits: Record<string, PluginEdit>;
  local?: Record<string, { fields: string[]; required: string[] }>;
}
export interface SignedHead { publicKey: string; body: string; signature: string }
export interface VerifiedHead { data: PluginHead; fingerprint: string; envelope: SignedHead }
export interface Candidate { device: string; edit: PluginEdit; fingerprint: string }
export type Field = { id: string; kind: 'package' | 'enabled' | 'setting'; key: string };
export const removedSetting = { $totalSyncDeleted: true } as const;
export function isRemoved(value: unknown): boolean {
  return object(value) && Object.keys(value).length === 1 && value.$totalSyncDeleted === true;
}
export function fieldValue(values: Record<string, FieldValue>, path: string): FieldValue {
  if (Object.prototype.hasOwnProperty.call(values, path)) return values[path]!;
  const kind = field(path).kind;
  return kind === 'setting' ? removedSetting : kind === 'enabled' ? false : null;
}
export function settingValue(values: Record<string, FieldValue>, key: string): FieldValue {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : removedSetting;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function fieldName(id: string, kind: string, key = ''): string { return id + '/' + kind + (key ? '/' + key : ''); }
export function field(path: string): Field {
  const [id, kind, key = '', extra] = path.split('/');
  if (!id || !safePluginId(id) || id === 'total-sync' || extra !== undefined
    || !['package', 'enabled', 'setting'].includes(kind ?? '')
    || (kind === 'setting' ? !safePreferenceKey(key) : key !== '')) throw new SyncError('configuration');
  return { id, kind: kind as Field['kind'], key };
}

export function validPackage(value: unknown): value is PluginPackage {
  return object(value) && Object.keys(value).length === 2 && typeof value.version === 'string' && safeVersion(value.version)
    && object(value.files) && Object.prototype.hasOwnProperty.call(value.files, 'main.js') && Object.prototype.hasOwnProperty.call(value.files, 'manifest.json')
    && Object.entries(value.files).every(([name, ref]) => packageNames.includes(name as PackageName)
      && object(ref) && Object.keys(ref).length === 2 && typeof ref.hash === 'string' && hashPattern.test(ref.hash)
      && Number.isSafeInteger(ref.size) && Number(ref.size) > 0 && Number(ref.size) <= 128 * 1024 * 1024);
}

export function validClock(value: unknown): value is Clock {
  return object(value) && Object.keys(value).length <= 100
    && Object.entries(value).every(([id, n]) => idPattern.test(id) && Number.isSafeInteger(n) && Number(n) >= 0);
}

export function validateHead(value: unknown, vault: string, device: string): PluginHead {
  if (!object(value) || value.schema !== 1 || value.vault !== vault || value.device !== device
    || !idPattern.test(vault) || !idPattern.test(device) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1
    || !object(value.edits) || Object.keys(value.edits).length > 20_000) throw new SyncError('integrity');
  if (value.local !== undefined && (!object(value.local) || Object.entries(value.local).some(([id, info]) =>
    !safePluginId(id) || id === 'total-sync' || !object(info) || !['fields', 'required'].every(key =>
      Array.isArray(info[key]) && info[key].length <= 2000 && info[key].every((name: unknown) => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(name)))))) throw new SyncError('integrity');
  for (const [path, edit] of Object.entries(value.edits)) {
    const { kind } = field(path);
    if (!object(edit) || Object.keys(edit).length !== 3 || !validClock(edit.seen)
      || !Number.isSafeInteger(edit.seq) || Number(edit.seq) < 1 || Number(edit.seq) > Number(value.seq)
      || Number(edit.seen[device] ?? 0) >= Number(edit.seq)) throw new SyncError('integrity');
    if (kind === 'package' ? edit.value !== null && !validPackage(edit.value)
      : kind === 'enabled' ? typeof edit.value !== 'boolean' : !isRemoved(edit.value) && !portableValue(edit.value)) throw new SyncError('configuration');
  }
  return value as unknown as PluginHead;
}

export function base64(bytes: ArrayBuffer): string {
  let text = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 8192) text += String.fromCharCode(...view.subarray(i, i + 8192));
  return btoa(text);
}
export function unbase64(text: string): ArrayBuffer {
  try { return Uint8Array.from(atob(text), c => c.charCodeAt(0)).buffer; }
  catch { throw new SyncError('integrity'); }
}
export async function newSigningKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}
export interface SigningKeyStorage {
  getSecret(id: string): string | null | undefined;
  setSecret(id: string, value: string): void;
}
export async function loadSigningKey(storage: SigningKeyStorage, vault: string, device: string): Promise<string> {
  if (!idPattern.test(vault) || !idPattern.test(device)) throw new SyncError('identity');
  try {
    const scope = vault + '-' + device;
    // SecretStorage permits at most 64 lowercase characters. Keep both IDs in the hash input.
    const id = 'total-sync-plugin-key-' + (await sha256(encode(scope))).slice(0, 40);
    const current = storage.getSecret(id);
    if (current) return current;
    // Reuse any key accepted by an earlier host; never silently replace an established identity.
    const legacy = storage.getSecret('total-sync-plugin-signing-' + scope);
    const key = legacy || await newSigningKey();
    storage.setSecret(id, key);
    if (storage.getSecret(id) !== key) throw new SyncError('plugin-secret');
    return key;
  } catch { throw new SyncError('plugin-secret'); }
}
export async function signHead(data: PluginHead, privateKey: string): Promise<SignedHead> {
  const jwk = JSON.parse(privateKey) as JsonWebKey;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = canonical({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const body = canonical(data);
  const signature = base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encode(body)));
  return { publicKey, body, signature };
}
export async function verifyHead(bytes: ArrayBuffer, vault: string, device: string): Promise<VerifiedHead> {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new SyncError('size');
  const envelope = parse(bytes);
  if (!object(envelope) || Object.keys(envelope).length !== 3 || typeof envelope.publicKey !== 'string'
    || typeof envelope.body !== 'string' || typeof envelope.signature !== 'string'
    || envelope.publicKey.length > 1000 || envelope.signature.length > 1000) throw new SyncError('integrity');
  try {
    const jwk = JSON.parse(envelope.publicKey) as JsonWebKey;
    if (jwk.d || canonical(jwk) !== envelope.publicKey) throw new Error();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      unbase64(envelope.signature), encode(envelope.body))) throw new Error();
    const data = validateHead(JSON.parse(envelope.body), vault, device);
    return { data, fingerprint: await sha256(encode(envelope.publicKey)), envelope: envelope as unknown as SignedHead };
  } catch (error) { if (error instanceof SyncError) throw error; throw new SyncError('integrity'); }
}

export function candidates(heads: VerifiedHead[]): Record<string, Candidate[]> {
  const result = index<Candidate[]>();
  for (const head of heads) for (const [path, edit] of Object.entries(head.data.edits)) {
    (result[path] ??= []).push({ device: head.data.device, fingerprint: head.fingerprint, edit });
  }
  for (const [path, values] of Object.entries(result)) {
    result[path] = values.filter(a => !values.some(b => a !== b
      && (b.device === a.device ? b.edit.seq > a.edit.seq : (b.edit.seen[a.device] ?? 0) >= a.edit.seq)));
    if (!result[path].length) throw new SyncError('integrity');
  }
  return result;
}
export function sameValues(values: Candidate[]): boolean {
  return values.length > 0 && values.every(c => canonical(c.edit.value) === canonical(values[0]!.edit.value));
}

export function encodeHead(envelope: SignedHead): ArrayBuffer { return encode(JSON.stringify(envelope)); }
