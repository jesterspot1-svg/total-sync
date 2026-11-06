import { Notice, Platform, Plugin, TFile, requestUrl, type TAbstractFile } from 'obsidian';
import { SyncEngine, type ConflictChoice, type ConflictReview, type SyncControls } from './engine';
import { Fingerprints } from './fingerprints';
import { errorText, interfaceLocale, t } from './i18n';
import { validState } from './manifest';
import { idPattern, newState, object, SyncError, type Manifest, type Profile, type SyncState } from './model';
import { ObsidianFiles } from './obsidian-files';
import { RemoteVault } from './repository';
import { options, prefixes, type Options } from './settings';
import { formatSyncAge } from './sync-age';
import { SyncFeedback } from './sync-feedback';
import { SettingsTab, showHistory, showPlan, showInventory, showMarkdownConflicts, notifyMarkdownConflicts } from './ui';
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
  private lastSuccess: number | null = null;
  working = false;
  queued = false;
  currentError: SyncError['code'] | null = null;
  log: Logged[] = [];
  private onStatus?: (lastSync: string, exactTime: string | null) => void;
  private state: SyncState = newState();
  private stopped = false;
  private suspended = false;
  private stateError = false;
  private debounceTimer?: Timer;
  private periodicTimer?: Timer;
  private retryTimer?: Timer;
  private retryCount = 0;
  private changedWhileWorking = false;
  private feedback?: SyncFeedback;
  private syncController?: AbortController;
  private ribbon?: HTMLElement;
  private statusItem?: HTMLElement;
  private statusTimer?: Timer;
  private readonly fingerprints = new Fingerprints<TFile>();

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
        this.lastSuccess = typeof saved.lastSuccess === 'number' && Number.isFinite(saved.lastSuccess) ? saved.lastSuccess : null;
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
    this.addCommand({ id: 'resolve-conflicts', name: t('Resolve conflicts', 'Разобрать конфликты'), callback: () => showMarkdownConflicts(this) });
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
      if (file instanceof TFile) this.fingerprints.invalidate(file);
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
      this.refreshStatus();
      if (Platform.isMobile && !this.suspended) this.scheduleRetry(1000);
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.feedback = new SyncFeedback(document.body, Platform.isMobile, () => this.stopSync());
      if (!Platform.isMobile) {
        this.statusItem = this.addStatusBarItem();
        this.statusItem.addClass('total-sync-last-sync');
      }
      this.refreshStatus();
      this.updateRibbon();
      this.configureTimer();
      if (this.config.startup && this.allowed()) void this.sync(false);
    });
  }

  onunload(): void {
    this.stopped = true;
    window.clearTimeout(this.debounceTimer);
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.periodicTimer);
    window.clearTimeout(this.statusTimer);
    this.feedback?.dispose();
    this.feedback = undefined;
    this.ribbon?.remove();
    this.statusItem?.remove();
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
      this.update({ exclusiveMove: result.exclusiveMove });
      this.record(result.exclusiveMove ? 'probe-exclusive-move' : result.move ? 'probe-move' : 'probe');
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
      const probe = await RemoteVault.probe(dav);
      const remote = new RemoteVault(dav, binding);
      const head = create ? await remote.create(Date.now()) : await remote.head(null, true);
      if (this.stopped) throw new SyncError('inactive');
      const next = newState();
      next.checkpoint = { revision: head.revision, hash: head.hash };
      this.app.secretStorage.setSecret(secretKey, JSON.stringify(credential));
      await this.saveData({ binding, device: this.config.device, state: next, lastSuccess: null });
      this.claim(binding);
      this.state = next;
      this.devices = head.manifest.devices;
      this.update({ binding, enabled: false, exclusiveMove: probe.exclusiveMove });
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
    this.updateRibbon();
    this.configureTimer();
  }

  private updateRibbon(): void {
    if (Platform.isMobile || !this.feedback) return;
    if (this.config.ribbonButton && !this.ribbon) {
      this.ribbon = this.addRibbonIcon('refresh-cw', t('TotalSync: Sync now', 'TotalSync: Синхронизировать сейчас'),
        () => { void this.sync(true); });
      this.ribbon.addClass('total-sync-ribbon');
    }
    if (this.ribbon) this.ribbon.hidden = !this.config.ribbonButton;
  }

  setStatusListener(listener?: (lastSync: string, exactTime: string | null) => void): void {
    this.onStatus = listener;
    this.refreshStatus();
  }

  private refreshStatus(): void {
    window.clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    if (this.stopped || (!this.statusItem && !this.onStatus)) return;
    const locale = interfaceLocale();
    const age = formatSyncAge(this.lastSuccess, Date.now(), locale);
    const exactTime = this.lastSuccess === null ? null : new Date(this.lastSuccess).toLocaleString(locale);
    if (this.statusItem) {
      this.statusItem.hidden = !this.config.binding;
      this.statusItem.textContent = age.text;
      this.statusItem.title = exactTime ?? age.text;
    }
    this.onStatus?.(age.text, exactTime);
    if (age.refreshIn !== null && !document.hidden && (this.onStatus || this.config.binding)) {
      this.statusTimer = window.setTimeout(() => this.refreshStatus(), age.refreshIn);
    }
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
    this.refreshStatus();
    this.debounceTimer = window.setTimeout(() => {
      this.queued = false;
      void this.sync(false);
    }, this.config.debounce * 1000);
  }

  private scheduleRetry(delay: number): void {
    if (!this.allowed() || this.syncController?.signal.aborted || this.retryTimer !== undefined) return;
    this.queued = true;
    this.refreshStatus();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.queued = false;
      if (this.allowed()) void this.sync(false);
    }, delay);
  }

  private retryAfterFailure(code: SyncError['code']): void {
    if (!['network', 'timeout', 'cloud-lock', 'cloud-advanced', 'cloud-preparing', 'upload-retry', 'rate', 'server'].includes(code)) return;
    const delay = Math.min(300, this.config.retry * 2 ** Math.min(8, this.retryCount++));
    this.scheduleRetry((delay + Math.random()) * 1000);
  }

  files(): ObsidianFiles {
    return new ObsidianFiles(this.app.vault, this.config.device, this.maxBytes, this.config.attachments,
      prefixes(this.config.exclude), this.config.calendar, this.config.excalidraw, this.fingerprints);
  }

  private engine(files = this.files(), controls?: SyncControls): SyncEngine {
    if (!this.config.binding || this.stateError) throw new SyncError(this.stateError ? 'integrity' : 'identity');
    const credential = this.credentials();
    if (!credential) throw new SyncError('configuration');
    const remote = new RemoteVault(this.dav(MAIL, credential), this.config.binding, this.config.exclusiveMove);
    return new SyncEngine(remote, files, {
      device: this.config.device, profile: this.profile, maxBytes: this.maxBytes,
      active: () => !this.stopped && !this.suspended,
      controls,
      selection: {
        channels: [
          ...(this.config.content ? ['content' as const] : []),
          ...(this.config.bookmarks ? ['shared-state' as const] : []),
          ...(this.profile === 'windows' && this.config.desktop ? ['desktop-config' as const] : []),
        ],
        attachments: this.config.attachments, exclude: prefixes(this.config.exclude), calendar: this.config.calendar,
        excalidraw: this.profile === 'windows' && this.config.excalidraw,
      },
    });
  }

  async preview() {
    return this.operate(() => this.engine().preview(this.state));
  }

  async history() {
    return this.operate(() => this.engine().history(this.state));
  }

  pendingConflicts(): string[] {
    return Object.keys(this.state.pending ?? {}).sort();
  }

  async reviewConflict(path: string) {
    return this.operate(() => this.engine().reviewConflict(this.state, path));
  }

  async resolveConflict(review: ConflictReview, choice: ConflictChoice): Promise<boolean> {
    return !!await this.operate(async () => {
      if (!this.allowed()) throw new SyncError(this.stateError ? 'integrity' : 'inactive');
      const state = await this.engine().resolveConflict(this.state, review, choice);
      await this.saveData({ binding: this.config.binding, device: this.config.device, state, lastSuccess: this.lastSuccess });
      this.state = state;
      this.record('markdown-conflict-resolved');
      new Notice(t('Conflict resolved. The original note has been synced.', 'Конфликт разобран. Исходная заметка синхронизирована.'));
      return true;
    });
  }

  async acceptExcalidraw(): Promise<void> {
    await this.operate(async () => {
      const state = await this.engine().acceptExcalidraw(this.state);
      await this.saveData({ binding: this.config.binding, device: this.config.device, state, lastSuccess: this.lastSuccess });
      this.state = state;
      this.record('excalidraw-profile-applied');
      new Notice(t('Excalidraw preferences received. Reopen the vault if its settings panel is stale.',
        'Настройки Excalidraw получены. Если настройки ещё не обновились, заново откройте хранилище.'));
    });
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

  private stopSync(): void {
    const controller = this.syncController;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    this.feedback?.stopping();
    window.clearTimeout(this.debounceTimer);
    window.clearTimeout(this.retryTimer);
    this.debounceTimer = undefined;
    this.retryTimer = undefined;
    this.queued = false;
    this.changedWhileWorking = false;
  }

  async sync(manual: boolean, approval?: string): Promise<void> {
    if (!this.allowed()) {
      if (manual) this.showSyncError(this.stateError ? 'integrity' : 'inactive');
      return;
    }
    if (this.working) {
      if (manual && !this.feedback?.running) new Notice(errorText('busy'));
      return;
    }
    const controller = new AbortController();
    this.syncController = controller;
    this.feedback?.start();
    const outcome = await this.operate(async () => {
      const result = await this.engine(undefined, {
        signal: controller.signal,
        progress: (completed, total) => this.feedback?.progress(completed, total),
      }).run(this.state, approval);
      const complete = result.counts.blocked === 0 && result.counts.review === 0 && result.errors.length === 0;
      const lastSuccess = complete ? Date.now() : this.lastSuccess;
      await this.saveData({ binding: this.config.binding, device: this.config.device, state: result.state, lastSuccess });
      this.lastSuccess = lastSuccess;
      this.state = result.state;
      this.devices = result.devices;
      if (complete) this.retryCount = 0;
      const n = result.counts;
      this.record('sync push=' + n.push + ' pull=' + n.pull + ' deleted=' + (n['delete-local'] + n['delete-remote'])
        + ' conflicts=' + n.conflict + ' review=' + n.review + ' merged=' + result.merged
        + ' blocked=' + n.blocked + ' checked=' + (n.equal + n.push + n.pull + n.conflict + n.review));
      if (!complete) {
        this.currentError = result.errors[0] ?? (n.review ? 'merge-conflict' : 'path');
        this.record(this.currentError, this.currentError === 'upload-retry' ? result.uploadRetryStatus : undefined);
        if (!controller.signal.aborted) this.retryAfterFailure(this.currentError);
      }
      if (result.newConflicts) notifyMarkdownConflicts(this);
      if (n.conflict > result.merged) new Notice(t('TotalSync saved conflicting versions. Check conflict copies and history.', 'TotalSync сохранил конфликтующие версии. Проверьте копии и историю.'));
      if (result.desktopChanged) new Notice(t('Desktop settings changed. Close and reopen the vault to apply them.', 'Настройки Windows изменились. Закройте и заново откройте хранилище для их применения.'));
      return {
        error: complete ? null : this.currentError,
        changed: n.push + n.pull + n['delete-local'] + n['delete-remote'] + n.conflict > 0,
      };
    }, false, true).finally(() => { this.syncController = undefined; });
    if (this.stopped) return;
    if (this.suspended) {
      this.feedback?.clear();
      return;
    }
    const error = outcome ? outcome.error : this.currentError ?? 'local';
    if (error) {
      this.showSyncError(error);
    } else if (manual || outcome?.changed) {
      const message = t('Sync complete', 'Синхронизация завершена');
      if (this.feedback) this.feedback.finish('success', message);
      else new Notice(message);
    } else {
      this.feedback?.clear();
    }
  }

  private showSyncError(code: SyncError['code']): void {
    const message = errorText(code);
    if (this.feedback) this.feedback.finish(code === 'cancelled' ? 'cancelled' : 'error', message);
    else new Notice(message);
  }

  async operate<T>(action: () => Promise<T>, notify = true, retry = false): Promise<T | undefined> {
    if (this.working) {
      if (notify) new Notice(errorText('busy'));
      return;
    }
    this.working = true;
    this.currentError = null;
    this.refreshStatus();
    try {
      return await action();
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError('local');
      this.currentError = failure.code;
      this.record(failure.code, failure.status);
      if (notify) new Notice(errorText(failure.code));
      if (retry && !this.syncController?.signal.aborted) this.retryAfterFailure(failure.code);
      return undefined;
    } finally {
      this.working = false;
      if (this.changedWhileWorking) {
        this.changedWhileWorking = false;
        if (!this.syncController?.signal.aborted) this.debounce();
      }
      this.refreshStatus();
    }
  }

  private record(event: string, status?: number): void {
    this.log = [...this.log.slice(-49), { at: Date.now(), event, status }];
  }
}
