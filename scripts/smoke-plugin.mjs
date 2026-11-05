import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundle = readFileSync('dist/main.js', 'utf8');
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

class Element {
  children = [];
  style = {};
  addEventListener() {}
  appendText() {}
  empty() { this.children = []; }
  createEl(tag, options) {
    const child = new Element();
    Object.assign(child, { tag, ...options });
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
  onChange() { return this; }
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
      addSettingTab(tab) { this.tab = tab; }
      addCommand(command) { this.commands.push(command); }
      registerDomEvent() {}
      registerEvent() {}
    },
    PluginSettingTab: class { containerEl = new Element(); },
    Setting,
    Platform: { isMobile: mobile, isWin: !mobile },
    getLanguage: () => language,
    requestUrl() { throw new Error('Unbound plugin must not send network requests'); },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, {
    module,
    exports: module.exports,
    require: name => { assert.equal(name, 'obsidian'); return api; },
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    document: { hidden: false },
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
  plugin.tab.hide();
  plugin.onunload();
}
console.log('Built plugin loaded with synthetic Obsidian API on Windows and mobile profiles.');
