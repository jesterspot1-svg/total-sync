import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import { errorText, t } from './i18n';
import type TotalSync from './main';
import { idPattern, type Channel, type Profile } from './model';
import type { Action } from './planner';
import { catalogInstallCommand } from './policy';
import type { Options } from './settings';
import { MAIL } from './webdav';

const project = 'https://github.com/jesterspot1-svg/total-sync';

function channelName(channel: Channel): string {
  const labels: Record<Channel, [string, string]> = {
    content: ['Content', 'Контент'],
    'shared-state': ['Bookmarks snapshots', 'Снимки закладок'],
    'desktop-config': ['Windows settings', 'Настройки Windows'],
  };
  return t(...labels[channel]);
}

function profileName(profile: Profile): string {
  return profile === 'windows' ? 'Windows' : profile === 'mobile' ? t('Mobile', 'Мобильный') : t('Other desktop', 'Другой настольный');
}

function actionName(action: Action): string {
  const labels: Record<Action, [string, string]> = {
    push: ['Upload', 'Отправить'],
    pull: ['Download', 'Получить'],
    'delete-remote': ['Delete in cloud', 'Удалить в облаке'],
    'delete-local': ['Delete locally', 'Удалить локально'],
    conflict: ['Preserve both versions', 'Сохранить обе версии'],
    equal: ['No file changes', 'Без изменения файлов'],
    blocked: ['Skip', 'Пропустить'],
  };
  return t(...labels[action]);
}

function confirm(app: App, title: string, description: string, label: string, action: () => Promise<void>): void {
  const modal = new Modal(app);
  modal.setTitle(title);
  modal.contentEl.createEl('p', { text: description });
  new Setting(modal.contentEl)
    .addButton(btn => btn.setButtonText(t('Cancel', 'Отмена')).onClick(() => modal.close()))
    .addButton(btn => btn.setWarning().setButtonText(label).onClick(async () => {
      modal.close();
      await action();
    }));
  modal.open();
}

export async function showPlan(plugin: TotalSync): Promise<void> {
  const preview = await plugin.preview();
  if (!preview) return;
  const modal = new Modal(plugin.app);
  modal.setTitle(t('TotalSync operation plan', 'План операций TotalSync'));
  const changes = preview.plan.operations.filter(op => op.action !== 'equal');
  const heading = t('Planned changes', 'Запланировано изменений') + ' · ' + changes.length;
  modal.contentEl.createEl('p', { text: heading });
  if (changes.length) {
    const text = modal.contentEl.createEl('textarea', { attr: { readonly: '', rows: '14', 'aria-label': heading } });
    text.style.width = '100%';
    text.value = [...changes].sort((a, b) => Number(b.action.startsWith('delete')) - Number(a.action.startsWith('delete')))
      .map(op => [actionName(op.action), channelName(op.channel), op.path].join(' · ')).join('\n');
  }
  if (preview.plan.requiresApproval) {
    modal.contentEl.createEl('p', { text: t(
      'Review every deletion. The approval is valid only for the exact plan above. Sync must be enabled.',
      'Проверьте каждое удаление. Подтверждение действует только для плана выше. Синхронизация должна быть включена.',
    ) });
    new Setting(modal.contentEl).addButton(btn => btn.setWarning()
      .setButtonText(t('Confirm deletions and sync', 'Подтвердить удаления и синхронизировать'))
      .onClick(async () => { modal.close(); await plugin.sync(true, preview.approval); }));
  }
  modal.open();
}

export async function showHistory(plugin: TotalSync): Promise<void> {
  const history = await plugin.history();
  if (!history) return;
  const modal = new Modal(plugin.app);
  modal.setTitle(t('TotalSync recovery history', 'История восстановления TotalSync'));
  const reasons = {
    updated: t('Previous version', 'Предыдущая версия'),
    deleted: t('Deleted', 'Удалённый файл'),
    conflict: t('Conflict', 'Конфликт'),
  };
  if (!history.length) modal.contentEl.createEl('p', { text: t('History is empty.', 'История пуста.') });
  const rows = modal.contentEl.createDiv();
  const pageSize = 25;
  let page = 0;
  const render = () => {
    rows.empty();
    for (const item of history.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = new Setting(rows).setName(item.path)
        .setDesc([channelName(item.channel), reasons[item.reason], new Date(item.at).toLocaleString(), item.file.hash.slice(0, 10)].join(' · '))
        .addButton(btn => btn.setButtonText(t('Save a copy', 'Сохранить копию')).onClick(() => plugin.restore(item.id, false)));
      if (item.channel === 'content' && item.reason === 'deleted') {
        row.addButton(btn => btn.setButtonText(t('Restore if absent', 'Вернуть, если файла нет')).onClick(() => confirm(
          plugin.app, t('Restore deleted file', 'Вернуть удалённый файл'),
          t('Restoring the original path will make the file available for the next sync.', 'Восстановленный по исходному пути файл будет участвовать в следующей синхронизации.'),
          t('Restore', 'Восстановить'), () => plugin.restore(item.id, true),
        )));
      }
    }
    if (history.length > pageSize) {
      new Setting(rows).setName((page + 1) + ' / ' + Math.ceil(history.length / pageSize))
        .addButton(btn => btn.setButtonText(t('Previous', 'Назад')).setDisabled(page === 0).onClick(() => { page--; render(); }))
        .addButton(btn => btn.setButtonText(t('Next', 'Далее')).setDisabled((page + 1) * pageSize >= history.length).onClick(() => { page++; render(); }));
    }
  };
  render();
  modal.open();
}

export async function showInventory(plugin: TotalSync): Promise<void> {
  const result = await plugin.operate(async () => {
    const files = plugin.files();
    return { own: await files.inventory(), others: await files.storedInventories() };
  });
  if (!result) return;
  const modal = new Modal(plugin.app);
  modal.setTitle(t('TotalSync plugin inventory', 'Инвентарь плагинов TotalSync'));
  modal.contentEl.createEl('p', { text: t(
    'Compare the source device with this vault. Install missing plugins from Obsidian’s Community catalog, individually or with the official CLI.',
    'Сверьте список выбранного устройства с этим vault. Недостающие плагины можно установить из каталога Obsidian по одному или пакетом через штатный CLI.',
  ) });
  const own = new Map(result.own.map(item => [item.id, item]));
  if (!result.others.length) modal.contentEl.createEl('p', { text: t('No other device inventory yet.', 'Инвентарь с другого устройства ещё не получен.') });
  for (const remote of result.others) {
    if (remote.device === plugin.config.device) continue;
    modal.contentEl.createEl('h3', { text: t('Device', 'Устройство') + ' ' + remote.device.slice(0, 8) });
    const list = modal.contentEl.createEl('ul');
    for (const item of remote.items) {
      const here = own.get(item.id);
      const local = here ? here.version + (here.enabled ? ' ✓' : '') : t('missing', 'отсутствует');
      const row = list.createEl('li', { text: item.id + ' · ' + item.version + (item.enabled ? ' ✓' : '') + ' → ' + local });
      if (!here) {
        row.appendText(' · ');
        row.createEl('a', { text: t('Open catalog', 'Открыть в каталоге'), href: 'https://community.obsidian.md/plugins/' + encodeURIComponent(item.id) });
      }
    }
    const commands = remote.items.filter(item => !own.has(item.id))
      .map(item => catalogInstallCommand(plugin.app.vault.getName(), item.id, item.enabled))
      .filter((line): line is string => !!line);
    if (commands.length) {
      new Setting(modal.contentEl).addButton(btn => btn
        .setButtonText(t('Review install commands', 'Команды для установки'))
        .onClick(() => showInstallCommands(plugin.app, commands)));
    }
  }
  modal.open();
}

function showInstallCommands(app: App, commands: readonly string[]): void {
  const modal = new Modal(app);
  const title = t('Install missing plugins', 'Установка недостающих плагинов');
  modal.setTitle(title);
  modal.contentEl.createEl('p', { text: t(
    'Check the vault name and plugin IDs. Run the selected lines in PowerShell with Obsidian CLI configured. A line ending in enable also enables that plugin.',
    'Проверьте имя vault и ID. Запустите выбранные строки в PowerShell с настроенным Obsidian CLI. Строки с enable также включат плагин.',
  ) });
  const area = modal.contentEl.createEl('textarea', { attr: { readonly: '', rows: '8', 'aria-label': title } });
  area.style.width = '100%';
  area.value = commands.join('\n');
  modal.contentEl.createEl('a', { text: t('Obsidian CLI instructions', 'Настройка Obsidian CLI'), href: 'https://obsidian.md/help/cli' });
  new Setting(modal.contentEl).addButton(btn => btn
    .setButtonText(t('Copy commands', 'Скопировать команды')).onClick(async () => {
      try {
        await navigator.clipboard.writeText(area.value);
        new Notice(t('Commands copied.', 'Команды скопированы.'));
      } catch {
        area.select();
        new Notice(t('Copy the selected text.', 'Скопируйте выделенный текст.'));
      }
    }));
  modal.open();
}

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TotalSync) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.onStatus = undefined;
  }

  private toggle(key: keyof Options, en: string, ru: string, desc: [string, string], callback?: (value: boolean) => void): void {
    const plugin = this.plugin;
    new Setting(this.containerEl).setName(t(en, ru)).setDesc(t(...desc))
      .addToggle(control => control.setValue(plugin.config[key] === true).onChange(value => {
        if (plugin.working) {
          control.setValue(plugin.config[key] === true);
          new Notice(errorText('busy'));
          return;
        }
        plugin.update({ [key]: value });
        callback?.(value);
      }));
  }

  private number(key: 'debounce' | 'interval' | 'retry', en: string, ru: string, min: number, max: number): void {
    const plugin = this.plugin;
    new Setting(this.containerEl).setName(t(en, ru)).addText(input => {
      input.inputEl.type = 'number';
      input.inputEl.min = String(min);
      input.inputEl.max = String(max);
      input.setValue(String(plugin.config[key]));
      input.inputEl.addEventListener('change', () => {
        const value = Number(input.getValue());
        if (input.getValue() && Number.isInteger(value) && value >= min && value <= max && !plugin.working) plugin.update({ [key]: value });
        else {
          input.setValue(String(plugin.config[key]));
          new Notice(errorText(plugin.working ? 'busy' : 'configuration'));
        }
      });
    });
  }

  display(): void {
    const el = this.containerEl;
    const plugin = this.plugin;
    el.empty();
    new Setting(el).setName(t('Mail WebDAV connection', 'Подключение к WebDAV Mail')).setHeading();
    let endpoint = MAIL;
    let login = plugin.credentials()?.login ?? '';
    let password = '';
    let clearPassword = () => { password = ''; };
    new Setting(el).setName(t('WebDAV URL', 'Адрес WebDAV')).addText(text =>
      text.setValue(endpoint).setDisabled(!!plugin.config.binding).onChange(value => { endpoint = value; }));
    new Setting(el).setName(t('Mail login', 'Логин Mail')).addText(text =>
      text.setPlaceholder('name@example.com').setValue(login).setDisabled(!!plugin.config.binding).onChange(value => { login = value; }));
    new Setting(el).setName(t('App password', 'Пароль приложения'))
      .setDesc(t('Stored with Obsidian SecretStorage on this device.', 'Сохраняется в SecretStorage Obsidian на этом устройстве.'))
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.onChange(value => { password = value; });
        clearPassword = () => { password = ''; text.setValue(''); };
      });
    new Setting(el).setName(t('Connection and permissions', 'Соединение и права'))
      .addButton(btn => btn.setButtonText(t('Check connection', 'Проверить подключение')).onClick(async () => {
        await plugin.verifyConnection(endpoint, login, password);
        clearPassword();
      }));

    new Setting(el).setName(t('Vault and devices', 'Хранилище и устройства')).setHeading();
    new Setting(el).setName(plugin.app.vault.getName()).setDesc(profileName(plugin.profile) + ' · ' + plugin.config.device.slice(0, 8));
    let id = plugin.config.binding;
    let writeId = (value: string) => { id = value; };
    new Setting(el).setName(t('Remote vault ID', 'Удалённый ID хранилища'))
      .setDesc(t('Use a newly generated ID for the first test vault and the same ID on the other devices.',
        'Для первого тестового хранилища сгенерируйте ID. На остальных устройствах используйте тот же ID.'))
      .addText(text => {
        text.setValue(id).setDisabled(!!plugin.config.binding).onChange(value => { id = value.trim().toLowerCase(); });
        writeId = value => { id = value; text.setValue(value); };
      });
    if (!plugin.config.binding) {
      let generated = '';
      new Setting(el).setName(t('Set up a test vault', 'Подключение тестового хранилища'))
        .addButton(btn => btn.setButtonText(t('Generate ID', 'Создать ID')).onClick(() => {
          generated = crypto.randomUUID();
          writeId(generated);
        }))
        .addButton(btn => btn.setButtonText(t('Create remote vault', 'Создать в облаке')).onClick(async () => {
          if (id !== generated || !idPattern.test(id)) { new Notice(errorText('identity')); return; }
          await plugin.bind(endpoint, login, password, id, true);
          clearPassword();
          if (plugin.config.binding) this.display();
        }))
        .addButton(btn => btn.setButtonText(t('Join by ID', 'Подключить по ID')).onClick(() => confirm(
          plugin.app, t('Connect this local vault', 'Подключить локальное хранилище'),
          t('This ID identifies the shared test vault. Connect only this isolated test vault.', 'Этот ID указывает на общее тестовое хранилище. Подключайте только отдельный тестовый vault.'),
          t('Connect', 'Подключить'), async () => {
            await plugin.bind(endpoint, login, password, id, false);
            clearPassword();
            if (plugin.config.binding) this.display();
          },
        )));
    } else {
      new Setting(el).setName(t('Disconnect this vault', 'Отключить это хранилище'))
        .addButton(btn => btn.setButtonText(t('Disconnect', 'Отключить')).onClick(() => confirm(
          plugin.app, t('Disconnect this vault', 'Отключить это хранилище'),
          t('Clears the local sync checkpoint and saved login. Existing vault files and cloud data are kept.',
            'Локальная точка синхронизации и сохранённый вход будут очищены. Файлы хранилища и данные в облаке сохранятся.'),
          t('Disconnect', 'Отключить'), async () => { await plugin.disconnect(); this.display(); },
        )));
    }
    const devices = new Setting(el).setName(t('Registered devices', 'Зарегистрированные устройства'));
    new Setting(el).setName(t('Sync', 'Синхронизация')).setHeading();
    this.toggle('enabled', 'Enable sync', 'Включить синхронизацию',
      ['Review the plan before enabling. Use a separate synthetic test vault.', 'Перед включением проверьте план. Используйте отдельное хранилище с искусственными данными.']);
    if (plugin.profile !== 'mobile') {
      this.toggle('ribbonButton', 'Sync button in the ribbon', 'Кнопка синхронизации в левой панели',
        ['Adds a shortcut to run sync now.', 'Добавляет кнопку для ручного запуска.']);
    }
    const status = new Setting(el).setName(t('Status', 'Состояние'));
    new Setting(el).addButton(btn => btn.setButtonText(t('Sync now', 'Синхронизировать сейчас')).onClick(() => plugin.sync(true)))
      .addButton(btn => btn.setButtonText(t('Show sync plan', 'Показать план операций')).onClick(() => showPlan(plugin)));

    new Setting(el).setName(t('Data channels', 'Области данных')).setHeading();
    this.toggle('content', 'Content', 'Контент', ['Notes and folders.', 'Заметки и папки.']);
    this.toggle('attachments', 'Attachments', 'Вложения',
      ['One file at a time. Device limit: ' + plugin.maxBytes / 1024 / 1024 + ' MiB.',
        'По одному файлу. Лимит на устройстве — ' + plugin.maxBytes / 1024 / 1024 + ' МиБ.']);
    this.toggle('bookmarks', 'Bookmarks snapshots', 'Снимки закладок',
      ['Publish and export snapshots through the command palette.', 'Публикация и экспорт снимков через палитру команд.']);
    if (plugin.profile === 'windows') {
      this.toggle('desktop', 'Windows settings', 'Настройки Windows',
        ['Allowed vault settings, styles and plugin inventory.', 'Разрешённые настройки vault, стили и инвентарь плагинов.']);
      this.toggle('calendar', 'Calendar preferences', 'Настройки Calendar',
        ['Syncs a small allowlist of typed preferences. Enable on each Windows client.', 'Синхронизирует небольшой перечень проверяемых параметров. Включите на каждом Windows-клиенте.']);
      this.toggle('excalidraw', 'Excalidraw preferences', 'Настройки Excalidraw',
        ['Update TotalSync on every device first. Syncs approved preferences of an installed Excalidraw 2.29.x.',
          'Сначала обновите TotalSync на всех устройствах. Переносит проверенные настройки установленного Excalidraw 2.29.x.']);
      new Setting(el).addButton(btn => btn
        .setButtonText(t('Accept cloud Excalidraw preferences', 'Принять настройки Excalidraw из облака'))
        .onClick(() => confirm(plugin.app,
          t('Use the cloud Excalidraw profile', 'Применить облачный профиль Excalidraw'),
          t('The cloud profile replaces the synchronized preferences. The previous portable settings are backed up locally.',
            'Профиль из облака заменит синхронизируемые параметры. Предыдущие переносимые настройки сохранятся в локальной копии.'),
          t('Apply profile', 'Применить профиль'), () => plugin.acceptExcalidraw())));
      new Setting(el).addButton(btn => btn.setButtonText(t('Compare installed plugins', 'Сравнить установленные плагины')).onClick(() => showInventory(plugin)));
    }
    new Setting(el).setName(t('Excluded content paths', 'Исключённые пути контента'))
      .setDesc(t('One vault-relative path per line. Changes apply on the next sync.', 'По одному пути относительно vault на строку. Изменения применяются при следующей синхронизации.'))
      .addTextArea(area => {
        area.setValue(plugin.config.exclude);
        area.inputEl.addEventListener('change', () => {
          try {
            if (plugin.working) throw new Error();
            plugin.update({ exclude: area.getValue() });
          } catch {
            area.setValue(plugin.config.exclude);
            new Notice(errorText(plugin.working ? 'busy' : 'path'));
          }
        });
      });

    new Setting(el).setName(t('Schedule', 'Периодичность')).setHeading();
    this.toggle('startup', 'At startup', 'При открытии', ['Check when the vault opens.', 'Проверять при открытии хранилища.']);
    this.toggle('change', 'After editing', 'После изменений', ['Debounce vault changes.', 'Ждать завершения серии изменений.']);
    this.number('debounce', 'Editing delay (seconds)', 'Задержка после изменений (сек.)', 1, 3600);
    this.number('interval', 'Check interval (minutes, 0 to disable)', 'Интервал проверки (мин., 0 — выключить)', 0, 1440);
    this.number('retry', 'Initial retry delay (seconds)', 'Начальная задержка повтора (сек.)', 3, 300);

    new Setting(el).setName(t('Recovery and help', 'Восстановление и справка')).setHeading();
    new Setting(el).addButton(btn => btn.setButtonText(t('History', 'История')).onClick(() => showHistory(plugin)))
      .addButton(btn => btn.setButtonText(t('Diagnostics', 'Диагностика')).onClick(() => this.diagnostics()));
    const help = el.createEl('p');
    help.createEl('a', { text: t('Beta test instructions', 'Инструкция для beta'), href: project + '/blob/main/docs/BETA_TEST_INSTRUCTION_RU.md' });
    help.appendText(' · ');
    help.createEl('a', { text: 'GitHub Issues', href: project + '/issues' });

    const refresh = () => {
      devices.setDesc(Object.entries(plugin.devices).map(([uuid, profile]) => profileName(profile) + ' · ' + uuid.slice(0, 8)).join(', ') || '—');
      const state = plugin.working ? t('Working', 'Выполняется') : plugin.queued ? t('Queued', 'В очереди')
        : plugin.config.enabled ? t('Ready', 'Готово') : t('Paused', 'Приостановлено');
      const last = t('Last successful sync', 'Последняя успешная синхронизация') + ' · ' + (plugin.lastSuccess ? new Date(plugin.lastSuccess).toLocaleString() : '—');
      const counts = [...plugin.log].reverse().find(entry => entry.event.startsWith('sync '))?.event;
      status.setDesc([state, last, counts, plugin.currentError ? errorText(plugin.currentError) : undefined].filter(Boolean).join('\n'));
    };
    plugin.onStatus = refresh;
    refresh();
  }

  private diagnostics(): void {
    const modal = new Modal(this.app);
    const label = t('TotalSync diagnostics', 'Диагностика TotalSync');
    modal.setTitle(label);
    const data = [
      'TotalSync ' + this.plugin.manifest.version,
      'profile=' + this.plugin.profile,
      ...this.plugin.log.map(item => new Date(item.at).toISOString() + ' ' + item.event + (item.status ? ' HTTP ' + item.status : '')),
    ].join('\n');
    const area = modal.contentEl.createEl('textarea', { attr: { rows: '12', readonly: '', 'aria-label': label } });
    area.style.width = '100%';
    area.value = data;
    new Setting(modal.contentEl).addButton(btn => btn.setButtonText(t('Copy diagnostics', 'Скопировать диагностику')).onClick(async () => {
      try {
        await navigator.clipboard.writeText(data);
        new Notice(t('Diagnostics copied.', 'Диагностика скопирована.'));
      } catch {
        area.select();
        new Notice(t('Copy the selected text.', 'Скопируйте выделенный текст.'));
      }
    }));
    modal.open();
  }
}
