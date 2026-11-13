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
export type DavParser = (text: string) => Document;
type Child = { name: string; modified: number; collection: boolean };

export function webdavEndpoint(value: string): string {
  try {
    const input = value.trim();
    if (!input || /[\r\n\t\\]/.test(input)) throw new Error();
    const url = new URL(input);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    // Validate escaping before appending our own paths. Keep provider-specific prefixes, ports and Unicode.
    const path = decodeURIComponent(url.pathname);
    if (path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32) || /%2f|%5c/i.test(url.pathname)) throw new Error();
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { throw new SyncError('configuration'); }
}

function davRows(doc: Document): Element[] {
  const root = doc.documentElement;
  if (root?.namespaceURI !== DAV || root.localName !== 'multistatus'
    || doc.getElementsByTagName('parsererror').length) throw new SyncError('protocol');
  return Array.from(root.getElementsByTagNameNS(DAV, 'response'));
}

function responsePath(row: Element, url: string): string {
  const href = row.getElementsByTagNameNS(DAV, 'href').item(0)?.textContent;
  try {
    const returned = new URL(href ?? '', url);
    if (!href || returned.origin !== new URL(url).origin || returned.search || returned.hash) throw new Error();
    return decodeURIComponent(returned.pathname).replace(/\/$/, '');
  } catch {
    throw new SyncError('protocol');
  }
}

function property(row: Element, name: string): Element | undefined {
  for (const propstat of Array.from(row.getElementsByTagNameNS(DAV, 'propstat'))) {
    if (!/^HTTP\/\d(?:\.\d)?\s+200(?:\s|$)/.test(propstat.getElementsByTagNameNS(DAV, 'status').item(0)?.textContent?.trim() ?? '')) continue;
    const value = propstat.getElementsByTagNameNS(DAV, name).item(0);
    if (value) return value;
  }
  return undefined;
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
    this.endpoint = webdavEndpoint(endpoint);
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
      // Use the current host's timer API: a window in Obsidian and Node in the HTTP fixture.
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

  private async properties(path: string, depth: '0' | '1'): Promise<Element[] | null> {
    const response = await this.call('PROPFIND', path, {
      Depth: depth, 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache',
    }, encode(depth === '0' ? propBody : propBody.replace('</d:prop>', '<d:getlastmodified/></d:prop>')));
    if (response.status === 404) return null;
    if (depth === '1' && [400, 403, 405, 501].includes(response.status)) return null;
    if (response.status !== 207) throw statusError(response.status);
    if (response.bytes.byteLength > 256_000) throw new SyncError('protocol');
    try {
      const text = decode(response.bytes);
      if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new Error();
      return davRows(this.parseProp(text));
    } catch {
      throw new SyncError('protocol');
    }
  }

  async collection(path: string): Promise<boolean> {
    const rows = await this.properties(path, '0');
    if (!rows) return false;
    const url = this.url(path);
    const row = rows[0];
    if (rows.length !== 1 || !row || responsePath(row, url) !== decodeURIComponent(new URL(url).pathname).replace(/\/$/, '')
      || !property(row, 'resourcetype')?.getElementsByTagNameNS(DAV, 'collection').length) throw new SyncError('protocol');
    return true;
  }

  async children(path: string): Promise<Child[] | null> {
    const rows = await this.properties(path, '1');
    if (!rows) return null;
    const url = this.url(path);
    const parent = decodeURIComponent(new URL(url).pathname).replace(/\/$/, '');
    const children: Child[] = [];
    let rootSeen = false;
    for (const row of rows) {
      const href = responsePath(row, url);
      const type = property(row, 'resourcetype');
      if (!type) return null;
      const collection = type.getElementsByTagNameNS(DAV, 'collection').length > 0;
      if (href === parent) {
        if (!collection || rootSeen) return null;
        rootSeen = true;
        continue;
      }
      const name = href.slice(parent.length + 1);
      if (!href.startsWith(parent + '/') || !name || name.includes('/')) return null;
      children.push({ name, collection, modified: Date.parse(property(row, 'getlastmodified')?.textContent ?? '') });
    }
    return rootSeen ? children : null;
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
