import { decode, encode, SyncError } from './model';

export const MAIL = 'https://webdav.cloud.mail.ru';
export const ROOT = 'TotalSync-beta';
const DAV = 'DAV:';
const propBody = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
type Method = 'PROPFIND' | 'GET' | 'PUT' | 'MKCOL' | 'MOVE' | 'DELETE';
export interface Request {
  url: string;
  method: Method;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}
export interface Response {
  status: number;
  bytes: ArrayBuffer;
  date?: string;
}
export type Transport = (request: Request) => Promise<Response>;
export type DavParser = (text: string, url: string) => boolean;

export function mailEndpoint(value: string): string {
  if (value.trim() !== MAIL && value.trim() !== MAIL + '/') throw new SyncError('configuration');
  return MAIL;
}

export function collectionResponse(doc: Document, url: string): boolean {
  const root = doc.documentElement;
  if (root?.namespaceURI !== DAV || root.localName !== 'multistatus'
    || doc.getElementsByTagName('parsererror').length) throw new SyncError('protocol');
  const rows = root.getElementsByTagNameNS(DAV, 'response');
  const row = rows.item(0);
  if (rows.length !== 1 || !row) throw new SyncError('protocol');
  const href = row.getElementsByTagNameNS(DAV, 'href').item(0)?.textContent;
  try {
    const requested = new URL(url);
    const returned = new URL(href ?? '', url);
    const clean = (path: string) => decodeURIComponent(path).replace(/\/$/, '');
    if (!href || returned.origin !== requested.origin || returned.search || returned.hash
      || clean(returned.pathname) !== clean(requested.pathname)) throw new Error();
  } catch {
    throw new SyncError('protocol');
  }
  for (const propstat of Array.from(row.getElementsByTagNameNS(DAV, 'propstat'))) {
    if (/^HTTP\/\d(?:\.\d)?\s+200(?:\s|$)/.test(propstat.getElementsByTagNameNS(DAV, 'status').item(0)?.textContent?.trim() ?? '')
      && propstat.getElementsByTagNameNS(DAV, 'resourcetype').item(0)?.getElementsByTagNameNS(DAV, 'collection').length) {
      return true;
    }
  }
  throw new SyncError('protocol');
}

function statusError(status: number): SyncError {
  if (status === 401) return new SyncError('auth', status);
  if (status === 403) return new SyncError('forbidden', status);
  if (status === 404) return new SyncError('missing', status);
  if (status === 429) return new SyncError('rate', status);
  if (status >= 500) return new SyncError('server', status);
  return new SyncError('dav', status);
}

export class WebDav {
  private readonly authorization: string;
  serverTime: number | null = null;

  constructor(
    private readonly endpoint: string,
    username: string,
    password: string,
    private readonly send: Transport,
    private readonly parseProp: DavParser,
    private readonly timeout = 90_000,
  ) {
    mailEndpoint(endpoint);
    if (!username.trim() || !password || /[:\r\n]/.test(username)) throw new SyncError('configuration');
    const bytes = new Uint8Array(encode(username + ':' + password));
    this.authorization = 'Basic ' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  }

  private url(path: string): string {
    const segments = path ? path.split('/') : [];
    if (segments.some(segment => !/^[a-z0-9][a-z0-9.-]*$/i.test(segment))) throw new SyncError('path');
    return this.endpoint + '/' + segments.map(encodeURIComponent).join('/');
  }

  private async call(method: Method, path: string, headers: Record<string, string> = {}, body?: ArrayBuffer): Promise<Response> {
    const mutates = method !== 'GET' && method !== 'PROPFIND';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SyncError(mutates ? 'uncertain' : 'timeout')), this.timeout);
    });
    try {
      const result = await Promise.race([
        this.send({ url: this.url(path), method, headers: { Authorization: this.authorization, ...headers }, body }),
        deadline,
      ]);
      const time = Date.parse(result.date ?? '');
      if (Number.isFinite(time)) this.serverTime = time;
      return result;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError(mutates ? 'uncertain' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async collection(path: string): Promise<boolean> {
    const response = await this.call('PROPFIND', path, {
      Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache',
    }, encode(propBody));
    if (response.status === 404) return false;
    if (response.status !== 207) throw statusError(response.status);
    if (response.bytes.byteLength > 256_000) throw new SyncError('protocol');
    try {
      const text = decode(response.bytes);
      if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || !this.parseProp(text, this.url(path))) throw new Error();
    } catch {
      throw new SyncError('protocol');
    }
    return true;
  }

  async mkdir(path: string): Promise<boolean> {
    const { status } = await this.call('MKCOL', path);
    if (status === 201) return true;
    if ([405, 409].includes(status) && await this.collection(path)) return false;
    if (status >= 500) throw new SyncError('uncertain', status);
    throw statusError(status);
  }

  async get(path: string): Promise<ArrayBuffer> {
    const response = await this.call('GET', path, { 'Cache-Control': 'no-cache' });
    if (response.status !== 200) throw statusError(response.status);
    return response.bytes;
  }

  async put(path: string, bytes: ArrayBuffer): Promise<void> {
    const { status } = await this.call('PUT', path, { 'Content-Type': 'application/octet-stream' }, bytes);
    if (![200, 201, 204].includes(status)) {
      if (status >= 500) throw new SyncError('uncertain', status);
      throw statusError(status);
    }
  }

  async remove(path: string): Promise<void> {
    const { status } = await this.call('DELETE', path);
    if (status >= 500) throw new SyncError('uncertain', status);
    if (![200, 204, 404].includes(status)) throw statusError(status);
  }

  async move(source: string, destination: string): Promise<boolean> {
    const { status } = await this.call('MOVE', source, { Destination: this.url(destination), Overwrite: 'F' });
    if ([403, 405, 501].includes(status)) return false;
    if (status >= 500) throw new SyncError('uncertain', status);
    if (![201, 204].includes(status)) throw statusError(status);
    return true;
  }

  async moveNewCollection(source: string, destination: string): Promise<'moved' | 'occupied' | 'unsupported'> {
    const { status } = await this.call('MOVE', source, {
      Destination: this.url(destination), Overwrite: 'F', Depth: 'infinity',
    });
    if (status === 201) return 'moved';
    if (status === 412) return 'occupied';
    if ([405, 409].includes(status) && await this.collection(destination) && await this.collection(source)) {
      return 'occupied';
    }
    if ([204, 400, 403, 405, 409, 501].includes(status)) return 'unsupported';
    if (status === 207 || status >= 500) throw new SyncError('uncertain', status);
    throw statusError(status);
  }
}
