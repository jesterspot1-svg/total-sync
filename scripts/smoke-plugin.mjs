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
  addEventListener() {}
  appendText() {}
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
  setDisabled() { return this; }
  setPlaceholder() { return this; }
  setButtonText(value) { this.label = value; return this; }
  onChange(callback) { this.change = callback; return this; }
  onClick() { return this; }
}

class Setting {
  controls = [];
  constructor(container) { container.children.push(this); }
  setName(name) { this.name = name; return this; }
  setHeading() { return this; }
  setDesc() { return this; }
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

for (const [language, mobile] of [['ru', false], ['fr', true]]) {
  const stored = new Map();
  const body = new Element();
  const ribbon = new Element();
  const timers = new Map();
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
    Modal: class {},
    Notice: class {},
    Plugin: class {
      app = mockApp;
      manifest = manifest;
      commands = [];
      async loadData() { return null; }
      async saveData() {}
      addSettingTab(tab) { this.tab = tab; }
      addCommand(command) { this.commands.push(command); }
      addRibbonIcon(icon, title, activate) { return ribbon.createEl('button', { icon, title, activate }); }
      registerDomEvent() {}
      registerEvent() {}
    },
    PluginSettingTab: class { containerEl = new Element(); },
    Setting,
    Platform: { isMobile: mobile, isWin: !mobile },
    getLanguage: () => language,
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
    crypto: globalThis.crypto,
  }, { filename: 'dist/main.js' });
  const plugin = new module.exports.default();
  await plugin.onload();
  plugin.tab.display();
  const all = plugin.tab.containerEl.children;
  const labels = all.map(row => row.name);
  assert.ok(labels.includes('TotalSync-Beta'));
  assert.ok(labels.includes(mobile ? 'Mail WebDAV connection' : 'Подключение к WebDAV Mail'));
  assert.equal(labels.includes('Настройки Windows'), !mobile);
  assert.equal(labels.includes('Windows settings'), false);
  const password = all.find(row => row.name === (mobile ? 'App password' : 'Пароль приложения'));
  assert.equal(password.controls[0].inputEl.type, 'password');
  assert.equal(plugin.config.enabled, false);
  assert.equal(plugin.config.binding, '');
  assert.ok(plugin.commands.some(command => command.id === 'sync-now'));
  const indicator = body.children.find(node => node.cls?.includes('total-sync-feedback'));
  const badge = indicator.children[0];
  const [icon, text] = badge.children;
  assert.equal(indicator.attr.role, 'status');
  assert.equal(indicator.cls.includes('-mobile'), mobile);
  assert.equal(icon.attr['aria-hidden'], 'true');
  assert.equal(badge.hidden, true);
  const ribbonSetting = all.find(row => row.name === 'Кнопка синхронизации в левой панели');
  assert.equal(!!ribbonSetting, !mobile);
  assert.equal(ribbon.children.length, 0);
  if (!mobile) {
    const toggle = ribbonSetting.controls[0];
    assert.equal(toggle.value, false);
    toggle.change(true);
    const button = ribbon.children[0];
    assert.equal(button.hidden, false);
    assert.match(button.title, /TotalSync/);
    const actualSync = plugin.sync;
    let manual;
    plugin.sync = value => { manual = value; };
    button.activate();
    assert.equal(manual, true);
    plugin.sync = actualSync;
    toggle.change(false);
    assert.equal(button.hidden, true);
    toggle.change(true);
    assert.equal(button.hidden, false);
    assert.equal(ribbon.children.length, 1);
  }

  plugin.update({ binding: globalThis.crypto.randomUUID(), enabled: true, interval: 0 });
  let resolve;
  let calls = 0;
  plugin.engine = () => ({
    run: state => {
      calls++;
      return new Promise(done => { resolve = outcome => done({ ...outcome, state }); });
    },
  });
  const count = { push: 1, pull: 0, 'delete-local': 0, 'delete-remote': 0, conflict: 0, equal: 0, blocked: 0 };
  const success = { counts: count, errors: [], devices: {}, desktopChanged: false };
  const inProgress = plugin.sync(true);
  assert.equal(badge.dataset.state, 'running');
  assert.equal(badge.hidden, false);
  assert.equal(icon.icon, 'refresh-cw');
  assert.equal(text.textContent, mobile ? 'Syncing…' : 'Синхронизация…');
  await plugin.sync(true);
  assert.equal(calls, 1);
  resolve(success);
  await inProgress;
  assert.equal(badge.dataset.state, 'success');
  assert.equal(icon.icon, 'check');
  assert.equal(text.textContent, mobile ? 'Sync complete' : 'Синхронизация завершена');
  assert.equal([...timers.values()][0].delay, 3500);
  [...timers.values()][0].callback();
  assert.equal(badge.hidden, true);

  const idle = plugin.sync(false);
  resolve({ ...success, counts: { ...count, push: 0 } });
  await idle;
  assert.equal(badge.hidden, true);

  const partial = plugin.sync(true);
  resolve({ ...success, counts: { ...count, blocked: 1 }, errors: ['cloud-lock'] });
  await partial;
  assert.equal(badge.dataset.state, 'error');
  assert.equal(icon.icon, 'circle-alert');
  assert.match(text.textContent, /locked|заблокирована/);
  assert.ok([...timers.values()].some(timer => timer.delay === 7000));
  plugin.engine = () => ({ run: async () => { throw new Error('synthetic private exception'); } });
  await plugin.sync(true);
  assert.equal(badge.dataset.state, 'error');
  assert.doesNotMatch(text.textContent, /synthetic private exception/);
  plugin.tab.hide();
  plugin.onunload();
  assert.equal(timers.size, 0);
  assert.equal(body.children.length, 0);
  assert.equal(ribbon.children.length, 0);
}
console.log('Built plugin verified with synthetic Obsidian API, including ribbon, feedback states and cleanup.');
