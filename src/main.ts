import { Notice, Platform, Plugin, requestUrl, type TAbstractFile } from 'obsidian';
import { SyncEngine } from './engine';
import { errorText, t } from './i18n';
import { validState } from './manifest';
import { idPattern, newState, object, SyncError, type Manifest, type Profile, type SyncState } from './model';
import { ObsidianFiles } from './obsidian-files';
import { RemoteVault } from './repository';
import { options, prefixes, type Options } from './settings';
import { SettingsTab, showHistory, showPlan, showInventory } from './ui';
import { collectionResponse, MAIL, mailEndpoint, WebDav, type Transport } from './webdav';

const storageKey = 'total-sync-options-v1';
const secretKey = 'total-sync-mail-webdav';
type Credential = { login: string; password: string };
type Logged = { at: number; event: string; status?: number };
type Timer = number;

const request: Transport = async ({ url, method, headers, body }) => {
  const response = await requestUrl({ url, method, headers, body, throw: false });
  const date = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'date')?.[1];
  return { status: response.status, bytes: response.arrayBuffer, date };
};

export default class TotalSync extends Plugin {
  config!: Options;
  readonly profile: Profile = Platform.isMobile ? 'mobile' : Platform.isWin ? 'windows' : 'desktop';
  readonly maxBytes = (Platform.isMobile ? 32 : 128) * 1024 * 1024;
  devices: Manifest['devices'] = {};
  lastSuccess: number | null = null;
  working = false;
  queued = false;
  currentError: SyncError['code'] | null = null;
  log: Logged[] = [];
  onStatus?: () => void;
  private state: SyncState = newState();
  private stopped = false;
  private suspended = false;
  private stateError = false;
  private debounceTimer?: Timer;
  private periodicTimer?: Timer;
  private retryTimer?: Timer;
  private retryCount = 0;
  private changedWhileWorking = false;

  async onload(): Promise<void> {
    this.suspended = Platform.isMobile && document.hidden;
    try {
      this.config = options(this.app.loadLocalStorage(storageKey));
      this.app.saveLocalStorage(storageKey, this.config);
      const saved: unknown = await this.loadData();
      if (this.config.binding) {
        if (!object(saved) || saved.binding !== this.config.binding || saved.device !== this.config.device
          || !validState(saved.state)) throw new SyncError('integrity');
        this.state = saved.state;
        this.lastSuccess = typeof saved.lastSuccess === 'number' ? saved.lastSuccess : null;
        this.claim(this.config.binding);
      }
    } catch {
      this.config ??= options(null);
      this.stateError = true;
      this.currentError = 'integrity';
    }
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({ id: 'sync-now', name: t('Sync now', 'Синхронизировать сейчас'), callback: () => { void this.sync(true); } });
    this.addCommand({ id: 'show-plan', name: t('Show sync plan', 'Показать план операций'), callback: () => { void showPlan(this); } });
    this.addCommand({ id: 'history', name: t('Show recovery history', 'Показать историю восстановления'), callback: () => { void showHistory(this); } });
    this.addCommand({
      id: 'inventory', name: t('Compare installed plugins', 'Сравнить установленные плагины'),
      checkCallback: checking => {
        if (this.profile !== 'windows') return false;
        if (!checking) void showInventory(this);
        return true;
      },
    });
    this.addCommand({
      id: 'publish-bookmarks', name: t('Publish Bookmarks snapshot', 'Опубликовать снимок закладок'),
      checkCallback: checking => {
        if (!this.config.bookmarks) return false;
        if (!checking) void this.bookmarks(true);
        return true;
      },
    });
    this.addCommand({
      id: 'export-bookmarks', name: t('Export received Bookmarks snapshot', 'Экспортировать полученный снимок закладок'),
      checkCallback: checking => {
        if (!this.config.bookmarks) return false;
        if (!checking) void this.bookmarks(false);
        return true;
      },
    });
    const changed = (file: TAbstractFile) => {
      const path = file.path;
      if (!this.config.change || path.startsWith('.') || /^TotalSync-Recovery(?:\/|$)/i.test(path)) return;
      if (this.working) this.changedWhileWorking = true;
      else this.debounce();
    };
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('delete', changed));
    this.registerEvent(this.app.vault.on('rename', changed));
    this.registerDomEvent(window, 'online', () => this.scheduleRetry(1000));
    this.registerDomEvent(document, 'visibilitychange', () => {
      this.suspended = Platform.isMobile && document.hidden;
      if (Platform.isMobile && !this.suspended) this.scheduleRetry(1000);
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.configureTimer();
      if (this.config.startup && this.allowed()) void this.sync(false);
    });
  }

  onunload(): void {
    this.stopped = true;
    window.clearTimeout(this.debounceTimer);
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.periodicTimer);
  }

  private claim(binding: string): void {
    const key = 'total-sync-claim-' + binding;
    const existing = localStorage.getItem(key);
    if (existing && existing !== this.config.device) throw new SyncError('identity');
    localStorage.setItem(key, this.config.device);
  }

  credentials(): Credential | null {
    try {
      const stored = this.app.secretStorage.getSecret(secretKey);
      const data: unknown = stored ? JSON.parse(stored) : null;
      if (object(data) && typeof data.login === 'string' && typeof data.password === 'string' && data.password) {
        return { login: data.login, password: data.password };
      }
    } catch {
      // An invalid local credential is presented as missing.
    }
    return null;
  }

  private dav(endpoint: string, credential: Credential): WebDav {
    return new WebDav(mailEndpoint(endpoint), credential.login, credential.password, request,
      (text, url) => collectionResponse(new DOMParser().parseFromString(text, 'application/xml'), url));
  }

  private credential(login: string, password: string): Credential {
    const stored = this.credentials();
    const trimmed = login.trim();
    if (this.config.binding && stored && stored.login.toLowerCase() !== trimmed.toLowerCase()) throw new SyncError('identity');
    const result = { login: trimmed, password: password || (stored?.login === trimmed ? stored.password : '') };
    if (!result.login || !result.password) throw new SyncError('configuration');
    return result;
  }

  async verifyConnection(endpoint: string, login: string, password: string): Promise<void> {
    await this.operate(async () => {
      const credential = this.credential(login, password);
      const result = await RemoteVault.probe(this.dav(endpoint, credential));
      this.app.secretStorage.setSecret(secretKey, JSON.stringify(credential));
      this.record(result.move ? 'probe-move' : 'probe');
      new Notice(t('WebDAV verified. App password saved locally.', 'WebDAV проверен. Пароль приложения сохранён локально.'));
    });
  }

  async bind(endpoint: string, login: string, password: string, binding: string, create: boolean): Promise<void> {
    await this.operate(async () => {
      if (this.config.binding || this.stateError || !idPattern.test(binding)) throw new SyncError('identity');
      const claimKey = 'total-sync-claim-' + binding;
      if (localStorage.getItem(claimKey) && localStorage.getItem(claimKey) !== this.config.device) throw new SyncError('identity');
      const credential = this.credential(login, password);
      const dav = this.dav(endpoint, credential);
      await RemoteVault.probe(dav);
      const remote = new RemoteVault(dav, binding);
      const head = create ? await remote.create(Date.now()) : await remote.head(null);
      if (this.stopped) throw new SyncError('inactive');
      const next = newState();
      next.checkpoint = { revision: head.revision, hash: head.hash };
      this.app.secretStorage.setSecret(secretKey, JSON.stringify(credential));
      await this.saveData({ binding, device: this.config.device, state: next, lastSuccess: null });
      this.claim(binding);
      this.state = next;
      this.devices = head.manifest.devices;
      this.update({ binding, enabled: false });
      this.record(create ? 'created' : 'joined');
      new Notice(t('Vault connected. Review the sync plan before enabling sync.', 'Хранилище подключено. Перед включением синхронизации проверьте план.'));
    });
  }

  async disconnect(): Promise<void> {
    await this.operate(async () => {
      const key = 'total-sync-claim-' + this.config.binding;
      await this.saveData(null);
      if (localStorage.getItem(key) === this.config.device) localStorage.removeItem(key);
      this.update({ binding: '', enabled: false });
      this.app.secretStorage.setSecret(secretKey, '');
      this.state = newState();
      this.stateError = false;
      this.lastSuccess = null;
      this.devices = {};
      this.record('disconnected');
    });
  }

  update(change: Partial<Options>): void {
    const value = options({ ...this.config, ...change });
    this.app.saveLocalStorage(storageKey, value);
    this.config = value;
    this.configureTimer();
  }

  private allowed(): boolean {
    return !this.stopped && !this.stateError && !!this.config.binding && this.config.enabled
      && !(Platform.isMobile && document.hidden);
  }

  private configureTimer(): void {
    window.clearInterval(this.periodicTimer);
    if (this.config.interval > 0 && this.config.enabled && !this.stopped) {
      this.periodicTimer = window.setInterval(() => { if (this.allowed()) void this.sync(false); }, this.config.interval * 60_000);
    }
  }

  private debounce(): void {
    if (!this.allowed()) return;
    window.clearTimeout(this.debounceTimer);
    this.queued = true;
    this.onStatus?.();
    this.debounceTimer = window.setTimeout(() => {
      this.queued = false;
      void this.sync(false);
    }, this.config.debounce * 1000);
  }

  private scheduleRetry(delay: number): void {
    if (!this.allowed() || this.retryTimer !== undefined) return;
    this.queued = true;
    this.onStatus?.();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.queued = false;
      if (this.allowed()) void this.sync(false);
    }, delay);
  }

  private retryAfterFailure(code: SyncError['code']): void {
    if (!['network', 'timeout', 'cloud-lock', 'cloud-advanced', 'upload-retry', 'rate', 'server'].includes(code)) return;
    const delay = Math.min(300, this.config.retry * 2 ** Math.min(8, this.retryCount++));
    this.scheduleRetry((delay + Math.random()) * 1000);
  }

  files(): ObsidianFiles {
    return new ObsidianFiles(this.app.vault, this.config.device, this.maxBytes, this.config.attachments,
      prefixes(this.config.exclude), this.config.calendar);
  }

  private engine(files = this.files()): SyncEngine {
    if (!this.config.binding || this.stateError) throw new SyncError(this.stateError ? 'integrity' : 'identity');
    const credential = this.credentials();
    if (!credential) throw new SyncError('configuration');
    const remote = new RemoteVault(this.dav(MAIL, credential), this.config.binding);
    return new SyncEngine(remote, files, {
      device: this.config.device, profile: this.profile, maxBytes: this.maxBytes,
      active: () => !this.stopped && !this.suspended,
      selection: {
        channels: [
          ...(this.config.content ? ['content' as const] : []),
          ...(this.config.bookmarks ? ['shared-state' as const] : []),
          ...(this.profile === 'windows' && this.config.desktop ? ['desktop-config' as const] : []),
        ],
        attachments: this.config.attachments, exclude: prefixes(this.config.exclude), calendar: this.config.calendar,
      },
    });
  }

  async preview() {
    return this.operate(() => this.engine().preview(this.state));
  }

  async history() {
    return this.operate(() => this.engine().history(this.state));
  }

  async restore(id: string, original: boolean): Promise<void> {
    await this.operate(async () => {
      const local = this.files();
      await this.engine(local).restore(this.state, id, (item, bytes) => local.restore(item, bytes, original));
      this.record('restored');
      new Notice(t('Version restored. Check the vault or TotalSync-Recovery.', 'Версия восстановлена. Проверьте хранилище или папку TotalSync-Recovery.'));
    });
  }

  private async bookmarks(publish: boolean): Promise<void> {
    await this.operate(async () => {
      if (publish) await this.files().stageBookmarks();
      else await this.files().exportBookmarks();
      new Notice(publish
        ? t('Snapshot staged. Run sync to publish it.', 'Снимок подготовлен. Запустите синхронизацию для публикации.')
        : t('Snapshot saved in TotalSync-Recovery.', 'Снимок сохранён в TotalSync-Recovery.'));
    });
  }

  async sync(manual: boolean, approval?: string): Promise<void> {
    if (!this.allowed()) {
      if (manual) new Notice(errorText(this.stateError ? 'integrity' : 'inactive'));
      return;
    }
    if (this.working) {
      if (manual) new Notice(errorText('busy'));
      return;
    }
    await this.operate(async () => {
      const result = await this.engine().run(this.state, approval);
      const complete = result.counts.blocked === 0 && result.errors.length === 0;
      const lastSuccess = complete ? Date.now() : this.lastSuccess;
      await this.saveData({ binding: this.config.binding, device: this.config.device, state: result.state, lastSuccess });
      this.lastSuccess = lastSuccess;
      this.state = result.state;
      this.devices = result.devices;
      if (complete) this.retryCount = 0;
      const n = result.counts;
      this.record('sync push=' + n.push + ' pull=' + n.pull + ' deleted=' + (n['delete-local'] + n['delete-remote'])
        + ' conflicts=' + n.conflict + ' blocked=' + n.blocked + ' checked=' + (n.equal + n.push + n.pull + n.conflict));
      if (!complete) {
        this.currentError = result.errors[0] ?? 'path';
        this.record(this.currentError);
        this.retryAfterFailure(this.currentError);
      }
      if (n.conflict) new Notice(t('TotalSync saved conflicting versions. Check conflict copies and history.', 'TotalSync сохранил конфликтующие версии. Проверьте копии и историю.'));
      if (result.desktopChanged) new Notice(t('Desktop settings changed. Close and reopen the vault to apply them.', 'Настройки Windows изменились. Закройте и заново откройте хранилище для их применения.'));
      if (manual) new Notice(complete
        ? t('TotalSync finished.', 'TotalSync завершил синхронизацию.')
        : errorText(this.currentError ?? 'local'));
    }, manual, true);
  }

  async operate<T>(action: () => Promise<T>, notify = true, retry = false): Promise<T | undefined> {
    if (this.working) {
      if (notify) new Notice(errorText('busy'));
      return;
    }
    this.working = true;
    this.currentError = null;
    this.onStatus?.();
    try {
      return await action();
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError('local');
      this.currentError = failure.code;
      this.record(failure.code, failure.status);
      if (notify || failure.code === 'mass-delete') new Notice(errorText(failure.code));
      if (retry) this.retryAfterFailure(failure.code);
      return undefined;
    } finally {
      this.working = false;
      if (this.changedWhileWorking) {
        this.changedWhileWorking = false;
        this.debounce();
      }
      this.onStatus?.();
    }
  }

  private record(event: string, status?: number): void {
    this.log = [...this.log.slice(-49), { at: Date.now(), event, status }];
  }
}
