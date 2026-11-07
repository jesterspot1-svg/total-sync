import { idPattern, object, SyncError } from './model';
import { pathKey, portablePath } from './policy';
import { MAIL, webdavEndpoint } from './webdav';

export interface Options {
  language: 'auto' | 'en' | 'ru';
  endpoint: string;
  exclusiveMove: boolean;
  binding: string;
  device: string;
  enabled: boolean;
  ribbonButton: boolean;
  content: boolean;
  attachments: boolean;
  desktop: boolean;
  plugins: boolean;
  bookmarks: boolean;
  calendar: boolean;
  excalidraw: boolean;
  startup: boolean;
  change: boolean;
  debounce: number;
  interval: number;
  retry: number;
  exclude: string;
}

export function prefixes(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(path => pathKey(portablePath(path)));
}

export function options(data: unknown): Options {
  const stored = object(data) ? data : {};
  const binding = typeof stored.binding === 'string' ? stored.binding : '';
  if (binding && !idPattern.test(binding)) throw new SyncError('identity');
  if (binding && (typeof stored.device !== 'string' || !idPattern.test(stored.device))) throw new SyncError('identity');
  const bool = (key: string, fallback: boolean) => typeof stored[key] === 'boolean' ? stored[key] : fallback;
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = stored[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  const exclude = typeof stored.exclude === 'string' ? stored.exclude : '';
  prefixes(exclude);
  return {
    language: stored.language === 'en' || stored.language === 'ru' ? stored.language : 'auto',
    endpoint: webdavEndpoint(typeof stored.endpoint === 'string' ? stored.endpoint : MAIL),
    exclusiveMove: bool('exclusiveMove', false),
    binding, device: typeof stored.device === 'string' && idPattern.test(stored.device) ? stored.device : crypto.randomUUID(),
    enabled: bool('enabled', false), ribbonButton: bool('ribbonButton', false),
    content: bool('content', true), attachments: bool('attachments', true),
    desktop: bool('desktop', true), plugins: bool('plugins', false), bookmarks: bool('bookmarks', false), calendar: bool('calendar', false),
    excalidraw: bool('excalidraw', false),
    startup: bool('startup', true), change: bool('change', true),
    debounce: integer('debounce', 5, 1, 3600), interval: integer('interval', 5, 0, 1440),
    retry: integer('retry', 10, 3, 300), exclude,
  };
}
