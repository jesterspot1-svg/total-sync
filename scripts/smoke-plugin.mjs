import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync('dist/main.js', 'utf8');
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

class Element {
  children = [];
  style = {};
  dataset = {};
  hidden = false;
  addEventListener(name, callback) { this[name] = callback; }
  appendText() {}
  setText(text) { this.text = text; }
  empty() { this.children = []; }
  addClass(cls) { this.cls = [this.cls, cls].filter(Boolean).join(' '); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }
  createDiv(options) { return this.createEl('div', options); }
  createEl(tag, options) {
    const child = new Element();
    Object.assign(child, { tag, parent: this, ...options });
    this.children.push(child);
    return child;
  }
}

class Control {
  inputEl = new Element();
  setValue(value) { this.value = value; return this; }
  setDisabled(value) { this.disabled = value; return this; }
  setPlaceholder() { return this; }
  setButtonText(value) { this.label = value; return this; }
  onChange(callback) { this.change = callback; return this; }
  onClick(callback) { this.click = callback; return this; }
  setCta() { return this; }
}

class Setting {
  controls = [];
  infoEl = new Element();
  constructor(container) { container.children.push(this); }
  setName(name) { this.name = name; return this; }
  setClass(cls) { this.cls = cls; return this; }
  setHeading() { return this; }
  setDesc(value) { this.description = value; return this; }
  add(init) {
    const control = new Control();
    init(control);
    this.controls.push(control);
    return this;
  }
  addButton(init) { return this.add(init); }
  addText(init) { return this.add(init); }
  addToggle(init) { return this.add(init); }
  addTextArea(init) { return this.add(init); }
}

for (const [language, mobile, ios, maxMiB] of [['ru', false, false, 128], ['fr', true, false, 32], ['fr', true, true, Infinity]]) {
  const stored = new Map();
  const claims = new Map();
  const body = new Element();
  const ribbon = new Element();
  const statusBar = new Element();
  const modals = [];
  const timers = new Map();
  let now = 1_800_000_000_000;
  let savedData = null;
  let timerId = 0;
  const window = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval,
    clearInterval,
  };
  const mockApp = {
    loadLocalStorage: key => stored.get(key),
    saveLocalStorage: (key, data) => stored.set(key, data),
    vault: { on() {}, getName: () => 'TotalSync-Beta' },
    workspace: { onLayoutReady: callback => callback() },
    secretStorage: { getSecret: () => null },
  };
  const api = {
    App: class {},
    Modal: class {
      contentEl = new Element();
      modalEl = new Element();
      setTitle(title) { this.title = title; }
      open() { modals.push(this); }
      close() { this.closed = true; this.onClose?.(); }
    },
    Notice: class {},
    Plugin: class {
      app = mockApp;
      manifest = manifest;
      commands = [];
      async loadData() { return savedData; }
      async saveData(value) { savedData = value; }
      addSettingTab(tab) { this.tab = tab; }
      addCommand(command) { this.commands.push(command); }
      addRibbonIcon(icon, title, activate) { return ribbon.createEl('button', { icon, title, activate }); }
      addStatusBarItem() { return statusBar.createDiv(); }
      registerDomEvent() {}
      registerEvent() {}
    },
    PluginSettingTab: class { containerEl = new Element(); },
    Setting,
    Platform: { isMobile: mobile, isWin: !mobile, isIosApp: ios },
    getLanguage: () => language,
    requireApiVersion: () => true,
    setIcon(element, icon) { element.icon = icon; },
    requestUrl() { throw new Error('Unbound plugin must not send network requests'); },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, {
    module,
    exports: module.exports,
    require: name => { assert.equal(name, 'obsidian'); return api; },
    window,
    document: { body, hidden: false },
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: key => claims.get(key), setItem: (key, value) => claims.set(key, value) },
    crypto: globalThis.crypto,
    AbortController,
    TextDecoder,
    TextEncoder,
    atob, btoa, structuredClone,
  }, { filename: 'dist/main.js' });
  const plugin = new module.exports.default();
  await plugin.onload();
  plugin.tab.display();
  const all = plugin.tab.containerEl.children;
  const labels = all.map(row => row.name);
  const status = all.find(row => row.name === (mobile ? 'Status' : 'Состояние'));
  const syncAgeText = mobile ? () => status.description : () => statusBar.children[0].textContent;
  const justNow = mobile ? 'Successfully synced just now' : 'Синхронизация была сейчас';
  const minuteAgo = mobile ? 'Successfully synced 1 minute ago' : 'Синхронизация была 1 мин назад';
  const tick = delay => {
    const timer = [...timers.values()].find(candidate => candidate.delay === delay);
    assert.ok(timer, 'Expected a timer for ' + delay + ' ms');
    timer.callback();
  };
  assert.equal(statusBar.children.length, mobile ? 0 : 1);
  if (!mobile) assert.equal(statusBar.children[0].hidden, true);
  assert.ok(labels.includes('TotalSync-Beta'));
  assert.ok(labels.includes(mobile ? 'Mail WebDAV connection' : 'Подключение к WebDAV Mail'));
  assert.equal(labels.includes('Настройки Windows'), !mobile);
  assert.equal(labels.includes('Windows settings'), false);
  const attachments = all.find(row => row.name === (mobile ? 'Attachments' : 'Вложения'));
  assert.equal(plugin.maxBytes, maxMiB * 1024 * 1024);
  assert.ok(attachments.description.includes(ios ? 'does not cap file size' : String(maxMiB)));
  const password = all.find(row => row.name === (mobile ? 'App password' : 'Пароль приложения'));
  assert.equal(password.controls[0].inputEl.type, 'password');
  assert.equal(plugin.config.enabled, false);
  assert.equal(plugin.config.binding, '');
  const syncCommand = plugin.commands.find(command => command.id === 'sync-now');
  assert.equal(syncCommand.icon, 'refresh-cw');
  const settingsActions = all.filter(row => row.cls === 'total-sync-button-row');
  assert.deepEqual(settingsActions.map(row => row.controls.length), mobile ? [1, 3, 3, 2] : [1, 3, 3, 1, 2]);
  assert.equal(plugin.config.plugins, false);
  assert.equal(plugin.commands.find(command => command.id === 'plugin-profiles').checkCallback(true), !mobile);
  assert.ok(settingsActions.every(row => row.infoEl.hidden === !row.name));
  assert.deepEqual(settingsActions[2].controls.map(control => control.label), mobile
    ? ['Sync now', 'Show sync plan', 'Resolve conflicts']
    : ['Синхронизировать сейчас', 'Показать план операций', 'Разобрать конфликты']);
  let review = { path: 'Note.md', kind: 'fragments', merge: { eol: '\n', parts: [
    { kind: 'text', lines: ['Before'] },
    { kind: 'conflict', local: ['Phone'], remote: ['Laptop'] },
    { kind: 'conflict', local: ['This'], remote: ['Cloud'] },
    { kind: 'text', lines: ['After', ''] },
  ] } };
  const pendingConflicts = plugin.pendingConflicts;
  plugin.pendingConflicts = () => [review.path];
  plugin.reviewConflict = async path => { assert.equal(path, review.path); return review; };
  let resolution;
  plugin.resolveConflict = async (value, content) => { assert.equal(value, review); resolution = content; return true; };
  plugin.commands.find(command => command.id === 'resolve-conflicts').callback();
  const [list] = modals;
  assert.equal(list.modalEl.cls, 'total-sync-conflict-dialog');
  assert.equal(list.contentEl.children[0].name, review.path);
  await list.contentEl.children[0].controls[0].click();
  const [, editor] = modals;
  assert.equal(list.closed, true);
  const rows = editor.contentEl.children.filter(child => child instanceof Setting);
  assert.ok(rows.every(row => row.cls === 'total-sync-button-row' && row.infoEl.hidden));
  const save = rows[2].controls[0];
  assert.equal(save.disabled, true);
  rows[0].controls[2].click();
  assert.equal(save.disabled, true);
  const secondArea = editor.contentEl.children.filter(child => child.tag === 'textarea')[1];
  secondArea.value = 'Edited';
  secondArea.input();
  assert.equal(save.disabled, false);
  await save.click();
  assert.deepEqual({ ...resolution }, { kind: 'text', text: 'Before\nLaptop\nPhone\nEdited\nAfter\n' });
  assert.equal(editor.closed, true);
  review = { path: 'Large.md', kind: 'whole', previews: { local: 'From phone', remote: 'From laptop' } };
  plugin.commands.find(command => command.id === 'resolve-conflicts').callback();
  await modals[2].contentEl.children[0].controls[0].click();
  const largeEditor = modals[3];
  assert.equal(largeEditor.modalEl.cls, 'total-sync-conflict-dialog');
  assert.equal(largeEditor.contentEl.children.some(child => child.tag === 'textarea'), false);
  const largeControls = largeEditor.contentEl.children.find(child => child.cls === 'total-sync-button-row').controls;
  assert.equal(largeControls.length, 2);
  await largeControls[1].click();
  assert.deepEqual({ ...resolution }, { kind: 'remote' });
  assert.equal(largeEditor.closed, true);
  plugin.pendingConflicts = pendingConflicts;
  const indicator = body.children.find(node => node.cls?.includes('total-sync-feedback'));
  const badge = indicator.children[0];
  const [icon, text, stop] = badge.children;
  assert.equal(indicator.attr.role, 'status');
  assert.equal(indicator.cls.includes('-mobile'), mobile);
  assert.equal(icon.attr['aria-hidden'], 'true');
  assert.equal(badge.hidden, true);
  const ribbonSetting = all.find(row => row.name === 'Кнопка синхронизации в левой панели');
  assert.equal(!!ribbonSetting, !mobile);
  assert.equal(labels.includes('Mobile quick access'), mobile);
  assert.equal(ribbon.children.length, mobile ? 1 : 0);
  if (ribbonSetting) {
    const toggle = ribbonSetting.controls[0];
    assert.equal(toggle.value, false);
    toggle.change(true);
    toggle.change(false);
    assert.equal(ribbon.children[0].hidden, true);
    toggle.change(true);
  }
  assert.equal(ribbon.children.length, 1);
  const button = ribbon.children[0];
  assert.equal(button.hidden, false);
  assert.equal(button.icon, syncCommand.icon);
  assert.match(button.title, /TotalSync/);
  const actualSync = plugin.sync;
  const manualStarts = [];
  plugin.sync = value => { manualStarts.push(value); };
  button.activate();
  syncCommand.callback();
  assert.deepEqual(manualStarts, [true, true]);
  plugin.sync = actualSync;

  plugin.update({ binding: globalThis.crypto.randomUUID(), enabled: true, interval: 0 });
  assert.equal(ribbon.children.length, 1);
  if (!mobile) {
    const secrets = new Map([['total-sync-mail-webdav', JSON.stringify({ login: 'fixture@example.com', password: 'synthetic' })]]);
    mockApp.secretStorage = { getSecret: key => secrets.get(key), setSecret: (key, value) => secrets.set(key, value) };
    mockApp.vault.configDir = '.obsidian';
    let scheduled = false, persisted = 0;
    mockApp.plugins = {
      plugins: {},
      async disablePlugin(id) { delete this.plugins[id]; },
      async enablePluginAndSave(id) { this.plugins[id] = {}; scheduled = true; },
      async disablePluginAndSave(id) { delete this.plugins[id]; scheduled = true; },
      async loadManifests() {},
      async saveConfig() { assert.equal(scheduled, true); scheduled = false; persisted++; },
    };
    const service = plugin.pluginProfiles();
    await service.files.runtime.enable('fixture-plugin', true);
    assert.equal(scheduled, false, 'enable must await native saveConfig, which is normally scheduled');
    await service.files.runtime.enable('fixture-plugin', false);
    assert.equal(persisted, 2);
    const originalDevices = plugin.pluginDevices;
    plugin.pluginDevices = async () => [plugin.config.device];
    const settled = async predicate => {
      for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('Plugin profile panel did not settle');
    };
    plugin.commands.find(command => command.id === 'plugin-profiles').checkCallback(false);
    await settled(() => modals.at(-1).contentEl.children.some(child => child.cls === 'total-sync-plugin-fingerprint'));
    const setup = modals.at(-1);
    assert.ok(setup.contentEl.children.some(row => row.controls?.some(c => c.label === 'Этот ноутбук — исходный')));
    assert.match(setup.contentEl.children.find(child => child.cls === 'total-sync-plugin-fingerprint').text, /^[a-f0-9]{64}$/);
    setup.close();
    const wasConfigured = service.configured;
    service.configured = () => true;
    service.rows = [{ id: 'calendar', localVersion: '1.0.0', version: '1.1.0', enabled: true, status: 'pending',
      localFields: [], localTasks: [], unapproved: [], conflicts: [] }];
    plugin.commands.find(command => command.id === 'plugin-profiles').checkCallback(false);
    await settled(() => modals.at(-1).contentEl.children.some(child => child.cls === 'total-sync-plugin-row'));
    const panel = modals.at(-1);
    const apply = panel.contentEl.children.flatMap(row => row.controls ?? []).find(c => c.label === 'Применить ожидающие изменения');
    assert.ok(apply);
    apply.click();
    assert.ok(modals.at(-1).contentEl.children.some(child => child.text?.includes('calendar: 1.0.0 → 1.1.0')));
    modals.at(-1).close(); panel.close();
    service.configured = wasConfigured;
    service.rows = [];
    plugin.pluginDevices = originalDevices;
  }
  let resolve;
  let controls;
  let calls = 0;
  plugin.engine = (_files, options) => ({
    run: state => {
      calls++;
      controls = options;
      return new Promise(done => { resolve = outcome => done({ ...outcome, state }); });
    },
  });
  const count = { push: 1, pull: 0, 'delete-local': 0, 'delete-remote': 0, conflict: 0, review: 0, equal: 0, blocked: 0 };
  const success = { counts: count, errors: [], devices: {}, desktopChanged: false, merged: 0, newConflicts: 0 };
  const inProgress = plugin.sync(true);
  assert.equal(badge.dataset.state, 'running');
  assert.equal(badge.hidden, false);
  assert.equal(icon.icon, 'refresh-cw');
  assert.equal(text.textContent, mobile ? 'Syncing…' : 'Синхронизация…');
  assert.equal(stop.hidden, false);
  assert.equal(stop.text, mobile ? 'Stop' : 'Остановить');
  controls.progress(0, 2);
  assert.equal(text.textContent, mobile ? 'Syncing… 0 of 2 files' : 'Синхронизация… 0 из 2 файлов');
  controls.progress(1, 2);
  assert.equal(text.textContent, mobile ? 'Syncing… 1 of 2 files' : 'Синхронизация… 1 из 2 файлов');
  controls.progress(2, 2);
  assert.equal(text.textContent, mobile ? 'Finalizing… 2 of 2 files' : 'Завершение… 2 из 2 файлов');
  await plugin.sync(true);
  assert.equal(calls, 1);
  resolve(success);
  await inProgress;
  assert.equal(badge.dataset.state, 'success');
  assert.equal(stop.hidden, true);
  assert.equal(icon.icon, 'check');
  assert.equal(text.textContent, mobile ? 'Sync complete' : 'Синхронизация завершена');
  assert.ok(syncAgeText().includes(justNow));
  if (!mobile) assert.equal(statusBar.children[0].hidden, false);
  tick(3500);
  assert.equal(badge.hidden, true);
  now += 60_000;
  tick(60_000);
  assert.ok(syncAgeText().includes(minuteAgo));

  const idle = plugin.sync(false);
  controls.progress(0, 0);
  assert.equal(text.textContent, mobile ? 'Syncing…' : 'Синхронизация…');
  resolve({ ...success, counts: { ...count, push: 0 } });
  await idle;
  assert.equal(badge.hidden, true);
  assert.ok(syncAgeText().includes(justNow));
  const lastSuccessfulTime = savedData.lastSuccess;
  now += 60_000;

  plugin.debounce();
  const stopped = plugin.sync(true);
  stop.click();
  assert.equal(controls.signal.aborted, true);
  assert.equal(plugin.queued, false);
  assert.equal(stop.disabled, true);
  controls.progress(2, 2);
  assert.equal(text.textContent, mobile ? 'Stopping…' : 'Остановка…');
  resolve({ ...success, errors: ['cancelled'] });
  await stopped;
  assert.equal(badge.dataset.state, 'cancelled');
  assert.equal(stop.hidden, true);
  assert.equal(text.textContent, mobile ? 'Sync stopped' : 'Синхронизация остановлена');
  assert.equal(savedData.lastSuccess, lastSuccessfulTime);

  const partial = plugin.sync(true);
  assert.equal(stop.disabled, false);
  resolve({ ...success, counts: { ...count, blocked: 1 }, errors: ['cloud-lock'] });
  await partial;
  assert.equal(badge.dataset.state, 'error');
  assert.equal(icon.icon, 'circle-alert');
  assert.match(text.textContent, /locked|заблокирована/);
  assert.ok([...timers.values()].some(timer => timer.delay === 7000));
  assert.ok(syncAgeText().includes(minuteAgo));
  assert.equal(savedData.lastSuccess, lastSuccessfulTime);
  plugin.engine = () => ({ run: async () => { throw new Error('synthetic private exception'); } });
  await plugin.sync(true);
  assert.equal(badge.dataset.state, 'error');
  assert.doesNotMatch(text.textContent, /synthetic private exception/);
  plugin.tab.hide();
  plugin.onunload();
  assert.equal(timers.size, 0);
  assert.equal(body.children.length, 0);
  assert.equal(ribbon.children.length, 0);
  assert.equal(statusBar.children.length, 0);

  const restarted = new module.exports.default();
  await restarted.onload();
  assert.equal(ribbon.children.length, 1);
  restarted.tab.display();
  const restoredStatus = restarted.tab.containerEl.children.find(row => row.name === (mobile ? 'Status' : 'Состояние'));
  assert.ok(restoredStatus.description.includes(minuteAgo));
  restarted.tab.hide();
  restarted.onunload();
  assert.equal(timers.size, 0);
}
console.log('Built plugin verified with synthetic Obsidian API, including Markdown review, ribbon, feedback, persisted sync age and cleanup.');
