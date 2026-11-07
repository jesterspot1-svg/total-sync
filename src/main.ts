import { Notice, Platform, Plugin, TFile, requestUrl, requireApiVersion, type TAbstractFile } from 'obsidian';
import { SyncEngine, type ConflictChoice, type ConflictReview, type SyncControls } from './engine';
import { Fingerprints } from './fingerprints';
import { errorText, interfaceLocale, setInterfaceLanguage, t } from './i18n';
import { validState } from './manifest';
import { idPattern, newState, object, SyncError, type Manifest, type Profile, type SyncState } from './model';
import { ObsidianFiles } from './obsidian-files';
import { RemoteVault } from './repository';
import { options, prefixes, type Options } from './settings';
import { formatSyncAge } from './sync-age';
import { SyncFeedback } from './sync-feedback';
import { SettingsTab, showHistory, showPlan, showInventory, showMarkdownConflicts, notifyMarkdownConflicts } from './ui';
import { collectionResponse, MAIL, webdavEndpoint, WebDav, type Transport } from './webdav';
import { PluginFiles, type PluginRuntime } from './plugin-disk';
import { loadSigningKey } from './plugin-profile';
import { PluginSync } from './plugin-sync';
import { PluginCatalog, PluginTransfer } from './plugin-transfer';
import { showPluginProfiles } from './plugin-ui';

const storageKey = 'total-sync-options-v1';
const legacySecretKey = 'total-sync-mail-webdav';
const syncIcon = 'refresh-cw';
type Credential = { login: string; password: string };
type Logged = { at: number; event: string; status?: number; phase?: SyncError['phase'] };
type Timer = number;

const request: Transport = async ({ url, method, headers, body }) => {
  const response = await requestUrl({ url, method, headers, body, throw: false });
  const date = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'date')?.[1];
  return { status: response.status, bytes: response.arrayBuffer, date };
};

export default class TotalSync extends Plugin {
  config!: Options;
  readonly profile: Profile = Platform.isMobile ? 'mobile' : Platform.isWin ? 'windows' : 'desktop';
  readonly maxBytes = Platform.isIosApp ? Infinity : (Platform.isMobile ? 32 : 128) * 1024 * 1024;
  devices: Manifest['devices'] = {};
  private lastSuccess: number | null = null;
  working = false;
  queued = false;
  get canStop(): boolean { return !!this.syncController && !this.syncController.signal.aborted; }
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
  private retryAt = 0;
  private retryCount = 0;
  private changedWhileWorking = false;
  private feedback?: SyncFeedback;
  private syncController?: AbortController;
  private ribbon?: HTMLElement;
  private statusItem?: HTMLElement;
  private statusTimer?: Timer;
  private readonly fingerprints = new Fingerprints<TFile>();
  private pluginService?: PluginSync;
  private pluginServiceKey = '';
  private pluginWatchTimer?: Timer;
  private pluginWatchStamp = '';

  async onload(): Promise<void> {
    this.suspended = Platform.isMobile && activeDocument.hidden;
    try {
      const previous: unknown = this.app.loadLocalStorage(storageKey);
      this.config = options(previous);
      // Copy the old shared Mail secret once, without removing it from other existing vaults.
      if ((!object(previous) || previous.endpoint === undefined) && !this.app.secretStorage.getSecret(this.credentialKey())) {
        const legacy = this.app.secretStorage.getSecret(legacySecretKey);
        let credential: unknown;
        try { credential = legacy ? JSON.parse(legacy) as unknown : null; } catch { credential = null; }
        if (object(credential) && typeof credential.login === 'string' && typeof credential.password === 'string') {
          this.app.secretStorage.setSecret(this.credentialKey(), JSON.stringify({ endpoint: MAIL, credential }));
        }
      }
      this.app.saveLocalStorage(storageKey, this.config);
      const saved: unknown = await this.loadData();
      if (this.config.binding) {
        if (!object(saved) || saved.binding !== this.config.binding || saved.device !== this.config.device
          || (saved.endpoint ?? MAIL) !== this.config.endpoint
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
    setInterfaceLanguage(this.config.language);
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerCommands();
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
    this.registerDomEvent(activeDocument, 'visibilitychange', () => {
      this.suspended = Platform.isMobile && activeDocument.hidden;
      this.refreshStatus();
      if (Platform.isMobile && !this.suspended) this.scheduleRetry(1000);
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      if (!Platform.isMobile) {
        this.statusItem = this.addStatusBarItem();
        this.statusItem.addClass('total-sync-last-sync');
      }
      this.feedback = new SyncFeedback(this.statusItem ?? activeDocument.body, Platform.isMobile, () => this.stopSync());
      this.refreshStatus();
      this.updateRibbon();
      this.configureTimer();
      if (this.config.startup && this.allowed()) void this.sync(false);
    });
  }

  private commandsRegistered = false;

  private registerCommands(): void {
    if (this.commandsRegistered) {
      for (const id of ['sync-now', 'show-plan', 'history', 'resolve-conflicts', 'plugin-profiles', 'inventory', 'publish-bookmarks', 'export-bookmarks', 'stop-sync']) this.removeCommand(id);
    }
    this.commandsRegistered = true;
    this.addCommand({ id: 'sync-now', name: t('Sync now', 'Синхронизировать сейчас'), icon: syncIcon, callback: () => { void this.sync(true); } });
    this.addCommand({ id: 'show-plan', name: t('Show sync plan', 'Показать план операций'), callback: () => { void showPlan(this); } });
    this.addCommand({ id: 'history', name: t('Show recovery history', 'Показать историю восстановления'), callback: () => { void showHistory(this); } });
    this.addCommand({ id: 'resolve-conflicts', name: t('Resolve conflicts', 'Разобрать конфликты'), callback: () => showMarkdownConflicts(this) });
    this.addCommand({ id: 'plugin-profiles', name: t('Plugins and settings', 'Плагины и настройки'),
      checkCallback: checking => {
        if (this.profile !== 'windows') return false;
        if (!checking) void showPluginProfiles(this);
        return true;
      } });
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
    this.addCommand({ id: 'stop-sync', name: t('Stop sync', 'Остановить синхронизацию'), callback: () => this.stopSync() });
  }

  openUpdates(): void {
    if (this.working) { new Notice(errorText('busy')); return; }
    window.open('obsidian://show-plugin?id=total-sync');
  }

  onunload(): void {
    this.stopped = true;
    window.clearTimeout(this.debounceTimer);
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.periodicTimer);
    window.clearInterval(this.pluginWatchTimer);
    window.clearTimeout(this.statusTimer);
    this.feedback?.dispose();
    this.feedback = undefined;
    this.ribbon?.remove();
    this.statusItem?.remove();
  }

  private claim(binding: string): void {
    const key = 'total-sync-claim-' + binding;
    // This guard must span vaults in the same app; vault-scoped App storage would miss duplicate bindings.
    const existing = window.localStorage.getItem(key);
    if (existing && existing !== this.config.device) throw new SyncError('identity');
    window.localStorage.setItem(key, this.config.device);
  }

  private credentialKey(): string { return 'total-sync-dav-' + this.config.device; }

  credentials(endpoint = this.config.endpoint): Credential | null {
    try {
      const stored = this.app.secretStorage.getSecret(this.credentialKey());
      const data: unknown = stored ? JSON.parse(stored) : null;
      if (object(data) && data.endpoint === webdavEndpoint(endpoint) && object(data.credential)) {
        const credential = data.credential;
        if (typeof credential.login === 'string' && typeof credential.password === 'string' && credential.password) {
          return { login: credential.login, password: credential.password };
        }
      }
    } catch {
      // An invalid local credential is presented as missing.
    }
    return null;
  }

  private dav(endpoint: string, credential: Credential): WebDav {
    return new WebDav(webdavEndpoint(endpoint), credential.login, credential.password, request,
      (text, url) => collectionResponse(new DOMParser().parseFromString(text, 'application/xml'), url));
  }

  private credential(endpoint: string, login: string, password: string): Credential {
    if (this.config.binding && webdavEndpoint(endpoint) !== this.config.endpoint) throw new SyncError('identity');
    const stored = this.credentials(endpoint);
    const trimmed = login.trim();
    if (this.config.binding && (!stored || stored.login !== trimmed)) throw new SyncError('identity');
    const result = { login: trimmed, password: password || (stored?.login === trimmed ? stored.password : '') };
    if (!result.login || !result.password) throw new SyncError('configuration');
    return result;
  }

  async verifyConnection(endpoint: string, login: string, password: string): Promise<void> {
    await this.operate(async () => {
      endpoint = webdavEndpoint(endpoint);
      const credential = this.credential(endpoint, login, password);
      const result = await RemoteVault.probe(this.dav(endpoint, credential));
      this.app.secretStorage.setSecret(this.credentialKey(), JSON.stringify({ endpoint, credential }));
      this.pluginService = undefined;
      this.update({ endpoint, exclusiveMove: result.exclusiveMove });
      this.record(result.exclusiveMove ? 'probe-exclusive-move' : result.move ? 'probe-move' : 'probe');
      new Notice(t('WebDAV verified. Password saved locally.', 'WebDAV проверен. Пароль сохранён локально.'));
    });
  }

  async bind(endpoint: string, login: string, password: string, binding: string, create: boolean): Promise<void> {
    await this.operate(async () => {
      if (this.config.binding || this.stateError || !idPattern.test(binding)) throw new SyncError('identity');
      const claimKey = 'total-sync-claim-' + binding;
      const existingClaim = window.localStorage.getItem(claimKey);
      if (existingClaim && existingClaim !== this.config.device) throw new SyncError('identity');
      endpoint = webdavEndpoint(endpoint);
      const credential = this.credential(endpoint, login, password);
      const dav = this.dav(endpoint, credential);
      const probe = await RemoteVault.probe(dav);
      const remote = new RemoteVault(dav, binding);
      const head = create ? await remote.create(Date.now()) : await remote.head(null, true);
      if (this.stopped) throw new SyncError('inactive');
      const next = newState();
      next.checkpoint = { revision: head.revision, hash: head.hash };
      this.app.secretStorage.setSecret(this.credentialKey(), JSON.stringify({ endpoint, credential }));
      await this.saveData({ endpoint, binding, device: this.config.device, state: next, lastSuccess: null });
      this.claim(binding);
      this.state = next;
      this.devices = head.manifest.devices;
      this.update({ endpoint, binding, enabled: false, exclusiveMove: probe.exclusiveMove });
      this.record(create ? 'created' : 'joined');
      new Notice(t('Vault connected. Review the sync plan before enabling sync.', 'Хранилище подключено. Перед включением синхронизации проверьте план.'));
    });
  }

  async disconnect(): Promise<void> {
    await this.operate(async () => {
      const key = 'total-sync-claim-' + this.config.binding;
      const credentialKey = this.credentialKey();
      // Stop scheduling before clearing checkpoints. Keep abandoned journals scoped to the old identity.
      this.update({ enabled: false });
      await this.saveData(null);
      if (window.localStorage.getItem(key) === this.config.device) window.localStorage.removeItem(key);
      this.update({ binding: '', device: crypto.randomUUID(), enabled: false, plugins: false, exclusiveMove: false });
      this.app.secretStorage.setSecret(credentialKey, '');
      this.pluginService = undefined;
      this.pluginServiceKey = '';
      this.pluginWatchStamp = '';
      this.changedWhileWorking = false;
      this.state = newState();
      this.stateError = false;
      this.lastSuccess = null;
      this.devices = {};
      this.feedback?.reset();
      this.record('disconnected');
    });
  }

  update(change: Partial<Options>): void {
    const value = options({ ...this.config, ...change });
    if (this.config.binding && value.endpoint !== this.config.endpoint) throw new SyncError('identity');
    const languageChanged = value.language !== this.config.language;
    this.app.saveLocalStorage(storageKey, value);
    this.config = value;
    setInterfaceLanguage(value.language);
    if (languageChanged) { this.registerCommands(); this.feedback?.clear(); }
    if (!value.enabled) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
      this.clearRetry();
    }
    this.updateRibbon();
    this.configureTimer();
    this.refreshStatus();
  }

  private updateRibbon(): void {
    if (!this.feedback) return;
    // On phones Obsidian manages this action in its ribbon menu and quick access settings.
    const show = Platform.isMobile || this.config.ribbonButton;
    if (show && !this.ribbon) {
      this.ribbon = this.addRibbonIcon(syncIcon, t('TotalSync: Sync now', 'TotalSync: Синхронизировать сейчас'),
        () => { void this.sync(true); });
      this.ribbon.addClass('total-sync-ribbon');
    }
    if (this.ribbon) {
      this.ribbon.hidden = !show;
      this.ribbon.setAttribute('aria-label', t('TotalSync: Sync now', 'TotalSync: Синхронизировать сейчас'));
    }
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
      this.statusItem.hidden = !this.config.binding && !this.working;
    }
    this.feedback?.setIdle(age.text, exactTime, this.lastSuccess !== null);
    this.onStatus?.(age.text, exactTime);
    if (age.refreshIn !== null && !activeDocument.hidden && (this.onStatus || this.config.binding)) {
      this.statusTimer = window.setTimeout(() => this.refreshStatus(), age.refreshIn);
    }
  }

  private allowed(): boolean {
    return !this.stopped && !this.stateError && !!this.config.binding && this.config.enabled
      && !(Platform.isMobile && activeDocument.hidden);
  }

  private configureTimer(): void {
    window.clearInterval(this.periodicTimer);
    window.clearInterval(this.pluginWatchTimer);
    if (this.config.interval > 0 && this.config.enabled && !this.stopped) {
      this.periodicTimer = window.setInterval(() => { if (this.allowed()) void this.sync(false); }, this.config.interval * 60_000);
    }
    if (this.profile === 'windows' && this.config.plugins && this.config.change && this.config.enabled && !this.stopped) {
      this.pluginWatchTimer = window.setInterval(() => {
        if (this.working || !this.allowed()) return;
        void (async () => {
          try {
            const stamp = await this.pluginProfiles().files.watchStamp();
            if (this.pluginWatchStamp && stamp !== this.pluginWatchStamp) this.debounce();
            this.pluginWatchStamp = stamp;
          } catch { /* The next explicit or periodic sync reports filesystem errors. */ }
        })();
      }, 15_000);
    }
  }

  private debounce(): void {
    if (!this.allowed()) return;
    window.clearTimeout(this.debounceTimer);
    this.queued = true;
    this.refreshStatus();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      this.queued = false;
      void this.sync(false);
    }, this.config.debounce * 1000);
  }

  private scheduleRetry(delay: number): void {
    if (!this.allowed() || this.syncController?.signal.aborted) return;
    const at = Date.now() + delay;
    if (this.retryTimer !== undefined && this.retryAt <= at) return;
    window.clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.queued = true;
    this.refreshStatus();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.queued = false;
      if (!this.allowed()) return;
      // A profile preview or another local operation may still be running when this
      // timer fires. Keep the retry rather than silently dropping it as "busy".
      if (this.working) this.scheduleRetry(1000);
      else void this.sync(false);
    }, delay);
  }

  private clearRetry(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = 0;
    this.queued = this.debounceTimer !== undefined;
  }

  private retryAfterFailure(code: SyncError['code']): void {
    // A full pass rechecks the journal and published head. It never blindly repeats
    // an ambiguous lock acquisition or DELETE; RemoteVault retains those safeguards.
    if (!['network', 'timeout', 'uncertain', 'cloud-lock', 'cloud-unlock', 'cloud-advanced', 'cloud-preparing', 'upload-retry', 'rate', 'server'].includes(code)
      || this.retryTimer !== undefined) return;
    const delay = Math.min(300, this.config.retry * 2 ** Math.min(8, this.retryCount++));
    this.scheduleRetry((delay + Math.random()) * 1000);
    if (this.retryTimer !== undefined) this.record('retry-scheduled seconds=' + Math.ceil((this.retryAt - Date.now()) / 1000));
  }

  files(): ObsidianFiles {
    return new ObsidianFiles(this.app.vault, this.config.device, this.maxBytes, this.config.attachments,
      prefixes(this.config.exclude), !this.config.plugins && this.config.calendar, !this.config.plugins && this.config.excalidraw, this.fingerprints);
  }

  pluginProfiles(): PluginSync {
    if (this.profile !== 'windows' || !this.config.binding || this.stateError) throw new SyncError('inactive');
    const credential = this.credentials();
    if (!credential) throw new SyncError('configuration');
    const binding = this.config.binding, device = this.config.device;
    const scope = binding + '-' + device;
    if (this.pluginService && this.pluginServiceKey === scope) return this.pluginService;
    type Manager = {
      plugins: Record<string, { onExternalSettingsChange?: () => unknown }>; disablePlugin(id: string): Promise<void>;
      enablePluginAndSave(id: string): Promise<void>; disablePluginAndSave(id: string): Promise<void>;
      loadManifests(): Promise<void>; saveConfig(): Promise<void>;
    };
    const manager = (this.app as unknown as { plugins?: Manager }).plugins;
    const requireManager = (): Manager => {
      if (!manager || !object(manager.plugins) || ['disablePlugin', 'enablePluginAndSave', 'disablePluginAndSave', 'loadManifests', 'saveConfig']
        .some(name => typeof manager[name as keyof Manager] !== 'function')) throw new SyncError('plugin-version');
      return manager;
    };
    const runtime: PluginRuntime = {
      loaded: id => !!requireManager().plugins[id],
      unload: async id => {
        const current = requireManager();
        await current.disablePlugin(id);
        if (current.plugins[id]) throw new SyncError('local');
      },
      reloadManifests: async () => { await requireManager().loadManifests(); },
      enable: async (id, enabled) => {
        const current = requireManager();
        if (enabled) {
          await current.enablePluginAndSave(id);
          if (!current.plugins[id]) throw new SyncError('local');
        } else await current.disablePluginAndSave(id);
        // Native enable/disable only schedule saving; await the actual persisted list before verification.
        await current.saveConfig();
      },
      compatible: version => requireApiVersion(version),
      canReloadSettings: id => typeof requireManager().plugins[id]?.onExternalSettingsChange === 'function',
      reloadSettings: async id => { await requireManager().plugins[id]?.onExternalSettingsChange?.(); },
    };
    const extra = this.app.loadLocalStorage('total-sync-plugin-fields-' + scope) as unknown;
    if (extra !== null && extra !== undefined && (!object(extra)
      || !Object.values(extra).every(value => Array.isArray(value) && value.every(key => typeof key === 'string')))) throw new SyncError('integrity');
    const check = () => {
      if (this.stopped || this.suspended) throw new SyncError('inactive');
      if (this.syncController?.signal.aborted) throw new SyncError('cancelled');
    };
    const catalog = new PluginCatalog(async url => {
      check();
      try {
        const response = await requestUrl({ url, method: 'GET', throw: false });
        if (response.status !== 200) throw new SyncError(response.status === 404 ? 'missing' : response.status === 429 ? 'rate' : 'network', response.status);
        return response.arrayBuffer;
      } catch (error) { if (error instanceof SyncError) throw error; throw new SyncError('network'); }
    });
    this.pluginService = new PluginSync(new PluginFiles(this.app.vault.adapter, this.app.vault.configDir, runtime,
      (extra ?? {}) as Record<string, string[]>), new PluginTransfer(this.dav(this.config.endpoint, credential), this.config.binding, check),
    catalog, this.config.binding, this.config.device, {
      read: () => this.app.loadLocalStorage('total-sync-plugin-state-' + scope) as unknown,
      write: value => this.app.saveLocalStorage('total-sync-plugin-state-' + scope, value),
      signingKey: () => loadSigningKey(this.app.secretStorage, binding, device),
    }, check, (completed, total) => this.feedback?.progress(completed, total));
    this.pluginServiceKey = scope;
    return this.pluginService;
  }

  async pluginDevices(): Promise<string[]> {
    if (this.profile !== 'windows' || !this.config.binding || this.stateError) throw new SyncError('inactive');
    const credential = this.credentials();
    if (!credential) throw new SyncError('configuration');
    const head = await new RemoteVault(this.dav(this.config.endpoint, credential), this.config.binding).head(this.state.checkpoint, true);
    this.devices = head.manifest.devices;
    return Object.keys(this.devices).filter(id => this.devices[id] === 'windows');
  }

  savePluginFields(): void {
    this.app.saveLocalStorage('total-sync-plugin-fields-' + this.config.binding + '-' + this.config.device,
      this.pluginProfiles().files.extra);
  }

  async syncPlugins(apply: boolean): Promise<void> {
    if (!this.allowed() || !this.config.plugins) throw new SyncError('inactive');
    const service = this.pluginProfiles();
    if (!service.configured()) throw new SyncError('plugin-pending');
    const expected = apply ? service.planSignature() : undefined;
    const controller = new AbortController();
    this.syncController = controller;
    this.feedback?.start();
    try {
      const rows = await service.run(await this.pluginDevices(), apply, expected, true);
      const pending = rows.filter(row => row.status !== 'same' && row.status !== 'excluded').length;
      this.record('plugins ready=' + rows.filter(row => row.status === 'same').length + ' pending=' + pending);
      this.feedback?.finish(pending ? 'error' : 'success', pending ? errorText('plugin-pending') : t('Plugin profile synced', 'Профиль плагинов синхронизирован'));
    } catch (error) {
      const code = error instanceof SyncError ? error.code : 'local';
      this.feedback?.finish(code === 'cancelled' ? 'cancelled' : 'error', errorText(code));
      throw error;
    } finally { this.syncController = undefined; this.refreshStatus(); }
  }

  private engine(files = this.files(), controls?: SyncControls): SyncEngine {
    if (!this.config.binding || this.stateError) throw new SyncError(this.stateError ? 'integrity' : 'identity');
    const credential = this.credentials();
    if (!credential) throw new SyncError('configuration');
    const key = 'total-sync-publication-v1-' + this.config.binding + '-' + this.config.device;
    const remote = new RemoteVault(this.dav(this.config.endpoint, credential), this.config.binding, this.config.exclusiveMove, {
      read: () => this.app.loadLocalStorage(key) as unknown,
      write: intent => this.app.saveLocalStorage(key, intent),
    });
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
        attachments: this.config.attachments, exclude: prefixes(this.config.exclude), calendar: !this.config.plugins && this.config.calendar,
        excalidraw: this.profile === 'windows' && !this.config.plugins && this.config.excalidraw,
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
      await this.saveData({ endpoint: this.config.endpoint, binding: this.config.binding, device: this.config.device, state, lastSuccess: this.lastSuccess });
      this.state = state;
      this.record('markdown-conflict-resolved');
      new Notice(t('Conflict resolved. The original note has been synced.', 'Конфликт разобран. Исходная заметка синхронизирована.'));
      return true;
    });
  }

  async acceptExcalidraw(): Promise<void> {
    await this.operate(async () => {
      const state = await this.engine().acceptExcalidraw(this.state);
      await this.saveData({ endpoint: this.config.endpoint, binding: this.config.binding, device: this.config.device, state, lastSuccess: this.lastSuccess });
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

  stopSync(): void {
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
    this.refreshStatus();
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
    this.clearRetry();
    const controller = new AbortController();
    this.syncController = controller;
    this.feedback?.start();
    const outcome = await this.operate(async () => {
      const result = await this.engine(undefined, {
        signal: controller.signal,
        progress: (completed, total) => this.feedback?.progress(completed, total),
      }).run(this.state, approval);
      // Note checkpoints are durable even if the separate plugin operation subsequently fails.
      await this.saveData({ endpoint: this.config.endpoint, binding: this.config.binding, device: this.config.device, state: result.state, lastSuccess: this.lastSuccess });
      this.state = result.state;
      this.devices = result.devices;
      // A separate plugin-profile error must not hide a retryable note-sync error.
      if (!controller.signal.aborted) for (const code of result.errors) this.retryAfterFailure(code);
      if (this.profile === 'windows' && this.config.plugins) {
        const service = this.pluginProfiles();
        if (!service.configured()) throw new SyncError('plugin-pending');
        const rows = await service.run(Object.keys(result.devices).filter(id => result.devices[id] === 'windows'), false, undefined, manual);
        this.record('plugins ready=' + rows.filter(row => row.status === 'same').length + ' pending=' + rows.filter(row => row.status !== 'same').length);
        if (rows.some(row => row.status !== 'same' && row.status !== 'excluded')) result.errors.push('plugin-pending');
      }
      const complete = result.counts.blocked === 0 && result.counts.review === 0 && result.errors.length === 0;
      const lastSuccess = complete ? Date.now() : this.lastSuccess;
      await this.saveData({ endpoint: this.config.endpoint, binding: this.config.binding, device: this.config.device, state: result.state, lastSuccess });
      this.lastSuccess = lastSuccess;
      this.state = result.state;
      this.devices = result.devices;
      if (complete) this.retryCount = 0;
      const n = result.counts;
      if (result.recoveredPublication) this.record('publication-recovered');
      this.record('sync push=' + n.push + ' pull=' + n.pull + ' deleted=' + (n['delete-local'] + n['delete-remote'])
        + ' conflicts=' + n.conflict + ' review=' + n.review + ' merged=' + result.merged
        + ' blocked=' + n.blocked + ' checked=' + (n.equal + n.push + n.pull + n.conflict + n.review));
      if (!complete) {
        this.currentError = result.errors[0] ?? (n.review ? 'merge-conflict' : 'path');
        this.record(this.currentError, this.currentError === 'upload-retry' ? result.uploadRetryStatus : undefined);
      }
      if (result.newConflicts) notifyMarkdownConflicts(this);
      if (n.conflict > result.merged) new Notice(t('TotalSync saved conflicting versions. Check conflict copies and history.', 'TotalSync сохранил конфликтующие версии. Проверьте копии и историю.'));
      if (result.desktopChanged) new Notice(t('Desktop settings changed. Close and reopen the vault to apply them.', 'Настройки Windows изменились. Закройте и заново откройте хранилище для их применения.'));
      return {
        error: complete ? null : this.currentError,
        changed: result.recoveredPublication || n.push + n.pull + n['delete-local'] + n['delete-remote'] + n.conflict > 0,
      };
    }, false, true).finally(() => { this.syncController = undefined; this.refreshStatus(); });
    if (this.stopped) return;
    if (this.suspended) {
      this.feedback?.clear();
      return;
    }
    const error = outcome ? outcome.error : this.currentError ?? 'local';
    if (error) {
      this.showSyncError(error);
    } else {
      const message = t('Sync complete', 'Синхронизация завершена');
      if (this.feedback) this.feedback.finish('success', message);
      else if (manual) new Notice(message);
    }
  }

  private showSyncError(code: SyncError['code']): void {
    const seconds = Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000));
    const message = errorText(code) + (this.retryTimer === undefined ? ''
      : t(' Automatic retry in ' + seconds + ' s.', ' Автоповтор через ' + seconds + ' с.'));
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
      this.record(failure.code, failure.status, failure.phase);
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

  private record(event: string, status?: number, phase?: SyncError['phase']): void {
    this.log = [...this.log.slice(-49), { at: Date.now(), event, status, phase }];
  }
}
