import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { DOMParser } from '@xmldom/xmldom';
import { SyncEngine } from '../src/engine';
import { encode, newState, sha256, stamp, SyncError, type Channel, type LocalEntry, type LocalFiles, type Profile, type Scan, type Stamp } from '../src/model';
import { RemoteVault } from '../src/repository';
import { collectionResponse, MAIL, WebDav, type Request } from '../src/webdav';

const auth = 'Basic ' + btoa('tester@example.com:synthetic-fixture');
type Fault = (method: string, path: string) => { status: number; body?: string } | undefined;

export class DavServer {
  readonly folders = new Set<string>(['/']);
  readonly files = new Map<string, ArrayBuffer>();
  readonly requests: { method: string; path: string }[] = [];
  clock = Date.UTC(2026, 10, 5);
  fault?: Fault;
  afterMutation?: Fault;
  move = true;
  offline = false;
  private readonly server: Server;
  private origin = '';

  constructor() {
    this.server = createServer(async (request, response) => {
      const path = request.url ?? '/';
      const method = request.method ?? '';
      this.requests.push({ method, path });
      const send = (status: number, body?: string | Uint8Array) => {
        response.setHeader('Date', new Date(this.clock).toUTCString());
        response.writeHead(status);
        response.end(body);
      };
      if (request.headers.authorization !== auth) return send(401);
      const injected = this.fault?.(method, path);
      if (injected) return send(injected.status, injected.body);
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      switch (method) {
        case 'PROPFIND':
          if (!this.folders.has(path)) return send(404);
          if (request.headers.depth !== '0') return send(400);
          return send(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:href>' + path
            + '</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
            + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
        case 'MKCOL':
          if (this.folders.has(path) || this.files.has(path)) return send(405);
          if (!this.folders.has(parent)) return send(409);
          this.folders.add(path);
          {
            const reply = this.afterMutation?.(method, path);
            return send(reply?.status ?? 201, reply?.body);
          }
        case 'GET': {
          const data = this.files.get(path);
          return data ? send(200, new Uint8Array(data)) : send(404);
        }
        case 'PUT': {
          if (!this.folders.has(parent)) return send(409);
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk as Uint8Array);
          const data = Uint8Array.from(Buffer.concat(chunks)).buffer;
          this.files.set(path, data);
          return send(201);
        }
        case 'DELETE':
          if (this.files.delete(path)) return send(204);
          if (!this.folders.has(path)) return send(404);
          for (const file of this.files.keys()) if (file.startsWith(path + '/')) this.files.delete(file);
          for (const folder of this.folders) if (folder === path || folder.startsWith(path + '/')) this.folders.delete(folder);
          {
            const reply = this.afterMutation?.(method, path);
            return send(reply?.status ?? 204, reply?.body);
          }
        case 'MOVE': {
          if (!this.move) return send(405);
          const data = this.files.get(path);
          const destination = new URL(String(request.headers.destination)).pathname;
          if (!data) return send(404);
          if (this.files.has(destination)) return send(412);
          this.files.set(destination, data);
          this.files.delete(path);
          return send(201);
        }
        default:
          return send(405);
      }
    });
  }

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No local server');
    this.origin = 'http://127.0.0.1:' + address.port;
    return this;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  dav(timeout = 5000, delay = 0): WebDav {
    const send = async (request: Request) => {
      if (this.offline) throw new Error('Synthetic disconnected network');
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const url = new URL(request.url);
      if (url.origin !== MAIL) throw new Error('Non-fixture origin');
      const result = await fetch(this.origin + url.pathname, {
        method: request.method, headers: request.headers, body: request.body, redirect: 'error',
      });
      return { status: result.status, bytes: await result.arrayBuffer(), date: result.headers.get('date') ?? undefined };
    };
    return new WebDav(MAIL, 'tester@example.com', 'synthetic-fixture', send, (value, url) => {
      const document = new DOMParser({ onError: () => { throw new Error('Malformed XML'); } }).parseFromString(value, 'application/xml');
      return collectionResponse(document as unknown as Document, url);
    }, timeout);
  }
}

export class MemoryVault implements LocalFiles {
  readonly data = new Map<Channel, Map<string, ArrayBuffer | 'folder'>>();
  readonly blocked = new Map<Channel, Set<string>>();
  readonly applied: string[] = [];
  failNextPath = '';

  group(channel: Channel): Map<string, ArrayBuffer | 'folder'> {
    let group = this.data.get(channel);
    if (!group) {
      group = new Map();
      this.data.set(channel, group);
    }
    return group;
  }

  put(path: string, value: string | ArrayBuffer, channel: Channel = 'content'): void {
    const group = this.group(channel);
    if (channel === 'content') {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) group.set(parts.slice(0, i).join('/'), 'folder');
    }
    group.set(path, typeof value === 'string' ? encode(value) : value);
  }

  text(path: string, channel: Channel = 'content'): string | undefined {
    const value = this.group(channel).get(path);
    return value instanceof ArrayBuffer ? new TextDecoder().decode(value) : undefined;
  }

  async scan(channel: Channel): Promise<Scan> {
    const entries = new Map<string, LocalEntry>();
    const blocked = this.blocked.get(channel) ?? new Set();
    for (const [path, data] of this.group(channel)) {
      if (blocked.has(path)) continue;
      entries.set(path, data === 'folder' ? { kind: 'folder' } : { kind: 'file', size: data.byteLength, hash: await sha256(data) });
    }
    return { entries, blocked };
  }

  async read(channel: Channel, path: string): Promise<ArrayBuffer> {
    const bytes = this.group(channel).get(path);
    if (!(bytes instanceof ArrayBuffer)) throw new SyncError('changed');
    return bytes;
  }

  async verify(channel: Channel, path: string, expected: Stamp): Promise<void> {
    if (stamp((await this.scan(channel)).entries.get(path)) !== expected) throw new SyncError('changed');
  }

  async apply(channel: Channel, path: string, expected: Stamp, next: LocalEntry | null, bytes?: ArrayBuffer): Promise<void> {
    if (this.failNextPath === path) {
      this.failNextPath = '';
      throw new SyncError('local');
    }
    await this.verify(channel, path, expected);
    const group = this.group(channel);
    if (!next) {
      if ([...group.keys()].some(key => key.startsWith(path + '/'))) throw new SyncError('changed');
      group.delete(path);
    } else if (next.kind === 'folder') group.set(path, 'folder');
    else if (bytes) group.set(path, bytes);
    else throw new SyncError('local');
    this.applied.push(channel + '/' + path);
  }
}

export class Client {
  readonly local = new MemoryVault();
  state = newState();
  engine: SyncEngine;
  readonly device = crypto.randomUUID();

  constructor(server: DavServer, id: string, profile: Profile = 'windows', maxBytes = 8 * 1024 * 1024) {
    const remote = new RemoteVault(server.dav(), id);
    this.engine = new SyncEngine(remote, this.local, {
      device: this.device, profile, maxBytes, active: () => true, now: () => server.clock,
      selection: { channels: profile === 'windows' ? ['content', 'desktop-config', 'shared-state'] : ['content', 'shared-state'],
        attachments: true, exclude: [], calendar: true },
    });
  }

  async run(approval?: string) {
    const result = await this.engine.run(this.state, approval);
    this.state = result.state;
    return result;
  }
}
