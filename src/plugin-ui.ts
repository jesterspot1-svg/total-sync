import { Modal, Setting } from 'obsidian';
import type TotalSync from './main';
import { errorText, t } from './i18n';
import { SyncError } from './model';
import { field, canonical } from './plugin-profile';
import { allowedPreference, portableValue, safePreferenceKey } from './plugin-preferences';
import type { PluginRow, PluginSync } from './plugin-sync';

const statusText = (status: PluginRow['status']): string => ({
  same: t('Applied', 'Применено'), pending: t('Awaiting application', 'Ожидает применения'),
  excluded: t('Local only on this device', 'Только локально на этом устройстве'),
  conflict: t('Conflicting changes', 'Конфликт изменений'), trust: t('Verify source', 'Подтвердите источник'),
  review: t('Review settings fields', 'Выберите поля настроек'), error: t('Not applied', 'Не применено'),
})[status];

function actions(el: HTMLElement): Setting {
  const setting = new Setting(el).setClass('total-sync-button-row');
  setting.infoEl.hidden = true;
  return setting;
}

export async function showPluginProfiles(plugin: TotalSync): Promise<void> {
  if (plugin.profile !== 'windows') return;
  const modal = new Modal(plugin.app);
  modal.modalEl.addClass('total-sync-plugin-dialog');
  modal.setTitle(t('Plugins and settings', 'Плагины и настройки'));
  let closed = false;
  modal.onClose = () => { closed = true; };
  modal.open();
  let service: PluginSync | undefined;
  let devices: string[] = [];
  let error = '';
  let running = false;
  const enteredFingerprints = new Map<string, string>();
  const act = async (action: () => Promise<void>) => {
    if (running) return;
    running = true;
    error = '';
    render();
    const result = await plugin.operate(async () => { await action(); return true; }, false);
    if (!result) error = errorText(plugin.currentError ?? 'local');
    running = false;
    if (!closed) render();
  };
  const render = () => {
    if (closed) return;
    const el = modal.contentEl;
    el.empty();
    el.createEl('p', { text: t('Windows plugin versions, enabled state and portable settings. Passwords and machine paths stay local.',
      'Версии плагинов, включение и переносимые настройки Windows. Пароли и пути конкретного компьютера остаются локальными.') });
    if (error) el.createEl('p', { cls: 'total-sync-plugin-error', text: error, attr: { role: 'alert' } });
    if (running) el.createEl('p', { text: t('Working…', 'Выполняется…'), attr: { role: 'status', 'aria-live': 'polite' } });
    if (!service) {
      if (!running) actions(el).addButton(b => b.setButtonText(t('Retry', 'Повторить')).onClick(() => act(load)));
      return;
    }
    const sync = service;
    new Setting(el).setName(t('This device', 'Это устройство')).setDesc(plugin.config.device.slice(0, 8));
    if (sync.fingerprint) {
      el.createEl('p', { text: t('Public key fingerprint. Copy it to the other laptop to allow packages outside the catalog.',
        'Отпечаток открытого ключа. Скопируйте его на другой ноутбук, чтобы разрешить пакеты вне каталога.') });
      el.createEl('code', { cls: 'total-sync-plugin-fingerprint', text: sync.fingerprint });
      actions(el).addButton(b => b.setButtonText(t('Copy fingerprint', 'Скопировать отпечаток')).setDisabled(running)
        .onClick(() => act(() => navigator.clipboard.writeText(sync.fingerprint))));
    }
    if (!sync.configured()) {
      el.createEl('p', { text: t('On the laptop with the desired setup, publish the initial profile. On the other laptop, receive that profile. Existing defaults will not replace source settings.',
        'На ноутбуке с нужными настройками опубликуйте исходный профиль. На втором — получите его. Настройки чистой установки не заменят настройки источника.') });
      actions(el).addButton(b => b.setButtonText(t('Use this laptop as the initial source', 'Этот ноутбук — исходный')).setDisabled(running).onClick(() => act(async () => {
        await sync.initialize(plugin.config.device);
        plugin.update({ plugins: true, calendar: false, excalidraw: false });
        await plugin.syncPlugins(false);
      })));
      for (const head of sync.heads) new Setting(el).setName(t('Windows device ', 'Ноутбук ') + head.data.device.slice(0, 8))
        .setDesc(t('Published profile, revision ', 'Опубликованный профиль, ревизия ') + head.data.seq)
        .addButton(b => b.setButtonText(t('Receive this profile', 'Получить этот профиль')).setDisabled(running).onClick(() => act(async () => {
          await sync.initialize(head.data.device);
          plugin.update({ plugins: true, calendar: false, excalidraw: false });
          await plugin.syncPlugins(false);
        })));
      if (!sync.heads.length) el.createEl('p', { text: t('No source profile yet. Publish it on the first laptop, then refresh.',
        'Профиля другого ноутбука пока нет. Опубликуйте его на первом ноутбуке, затем обновите список.') });
      actions(el).addButton(b => b.setButtonText(t('Refresh sources', 'Обновить источники')).setDisabled(running).onClick(() => act(load)));
      return;
    }
    new Setting(el).setName(t('Sync plugin profile', 'Синхронизация профиля плагинов'))
      .addToggle(toggle => toggle.setValue(plugin.config.plugins).setDisabled(running).onChange(value => plugin.update({ plugins: value })));
    actions(el).addButton(b => b.setButtonText(t('Sync plugins', 'Синхронизировать плагины')).setDisabled(running)
      .onClick(() => act(() => plugin.syncPlugins(false))));
    actions(el).addButton(b => b.setButtonText(t('Apply pending changes', 'Применить ожидающие изменения')).setDisabled(running || !sync.rows.some(r => r.status !== 'same'))
      .onClick(() => confirmApply(plugin, sync, () => act(() => plugin.syncPlugins(true)))));
    actions(el).addButton(b => b.setButtonText(t('Restore interrupted installation', 'Восстановить установку')).setDisabled(running)
      .onClick(() => act(async () => { await sync.files.recover(true); await plugin.syncPlugins(false); })));
    for (const head of sync.heads.filter(h => h.data.device !== plugin.config.device)) {
      const box = el.createEl('details');
      box.createEl('summary', { text: (sync.trusts(head.data.device) ? t('Trusted device ', 'Доверенный ноутбук ')
        : t('Trust packages from device ', 'Доверие к пакетам с ноутбука ')) + head.data.device.slice(0, 8) });
      if (sync.trusts(head.data.device)) {
        actions(box).addButton(b => b.setButtonText(t('Revoke code trust', 'Отозвать доверие к коду')).setDisabled(running).onClick(() => act(async () => {
          sync.revoke(head.data.device);
        })));
        continue;
      }
      box.createEl('p', { text: t('On the source laptop, open this screen and copy its fingerprint. Paste it below. Trust covers future signed packages from that device; it never copies passwords.',
        'На ноутбуке-источнике откройте этот раздел и скопируйте его отпечаток. Вставьте ниже. Доверие действует для будущих подписанных пакетов этого ноутбука и не разрешает перенос паролей.') });
      new Setting(box).setName(t('Fingerprint from the source laptop', 'Отпечаток с ноутбука-источника'))
        .addText(input => input.setPlaceholder('SHA-256').setValue(enteredFingerprints.get(head.data.device) ?? '')
          .onChange(value => { enteredFingerprints.set(head.data.device, value); }));
      actions(box).addButton(b => b.setButtonText(t('Verify and trust source', 'Сверить и доверять источнику')).setDisabled(running)
        .onClick(() => act(async () => { sync.trust(head.data.device, enteredFingerprints.get(head.data.device) ?? ''); await plugin.syncPlugins(false); })));
    }
    el.createEl('p', { text: t('Applied: ', 'Применено: ') + sync.rows.filter(r => r.status === 'same').length + ' / ' + sync.rows.length,
      attr: { role: 'status', 'aria-live': 'polite' } });
    for (const row of sync.rows) {
      const section = el.createDiv({ cls: 'total-sync-plugin-row' });
      new Setting(section).setName(row.id).setDesc([
        (row.localVersion || t('Not installed', 'Не установлен')) + ' → ' + (row.version || t('Remove', 'Удалить')),
        statusText(row.status), row.enabled ? t('Enabled', 'Включён') : t('Disabled', 'Выключен'),
      ].join(' · '));
      new Setting(section).setName(t('Sync this plugin on this laptop', 'Синхронизировать этот плагин на ноутбуке'))
        .addToggle(toggle => toggle.setValue(row.status !== 'excluded').setDisabled(running).onChange(value => act(async () => {
          sync.exclude(row.id, !value); await plugin.syncPlugins(false);
        })));
      if (row.error) section.createEl('p', { text: errorText(row.error), cls: 'total-sync-plugin-error', attr: { role: 'alert' } });
      if (row.localTasks.length) section.createEl('p', { text: t('Set up locally in this plugin (sign-in or machine path): ',
        'Настройте локально в этом плагине (вход или путь на компьютере): ') + row.localTasks.join(', ') });
      if (row.localFields.length || row.unapproved.length) {
        const detail = section.createEl('details');
        detail.createEl('summary', { text: t('Local fields and additional settings', 'Локальные поля и дополнительные настройки') });
        detail.createEl('p', { text: [...new Set([...row.localFields, ...row.unapproved])].join(', ') });
        actions(detail).addButton(b => b.setButtonText(t('Choose additional fields', 'Выбрать дополнительные поля')).setDisabled(running)
          .onClick(() => chooseFields(plugin, sync, row, () => act(() => plugin.syncPlugins(false)))));
      }
      for (const conflict of row.conflicts) {
        const detail = section.createEl('details');
        detail.createEl('summary', { text: t('Conflict: ', 'Конфликт: ') + field(conflict.path).kind + ' ' + field(conflict.path).key });
        for (const choice of conflict.choices) {
          detail.createEl('p', { text: t('Device ', 'Устройство ') + choice.device.slice(0, 8) });
          detail.createEl('pre', { cls: 'total-sync-plugin-preview', text: canonical(choice.edit.value).slice(0, 2000) });
          actions(detail).addButton(b => b.setButtonText(t('Use this value', 'Использовать это значение')).setDisabled(running).onClick(() => act(async () => {
            await sync.resolve(conflict.path, choice.device);
            await plugin.syncPlugins(false);
          })));
        }
      }
    }
  };
  const load = async () => {
    service = plugin.pluginProfiles();
    await service.identify();
    devices = await plugin.pluginDevices();
    if (!service.configured()) service.heads = await service.discover(devices);
  };
  await act(load);
}

function confirmApply(plugin: TotalSync, service: PluginSync, apply: () => Promise<void>): void {
  const modal = new Modal(plugin.app);
  modal.setTitle(t('Apply plugin changes', 'Применить изменения плагинов'));
  modal.modalEl.addClass('total-sync-plugin-dialog');
  modal.contentEl.createEl('p', { text: t('Finish editing drawings and plugin dialogs first. Affected plugins will be restarted. Obsidian will stay open. Previous files are backed up locally.',
    'Сначала завершите редактирование рисунков и диалогов плагинов. Затронутые плагины будут перезагружены. Obsidian останется открыт. Предыдущие файлы сохраняются в локальной копии.') });
  for (const row of service.rows.filter(r => r.status !== 'same')) modal.contentEl.createEl('p', {
    text: row.id + ': ' + (row.localVersion || '—') + ' → ' + (row.version || t('Remove', 'Удалить')) + ' · ' + statusText(row.status),
  });
  actions(modal.contentEl).addButton(b => b.setButtonText(t('Apply', 'Применить')).setCta().onClick(async () => { modal.close(); await apply(); }));
  modal.open();
}

async function chooseFields(plugin: TotalSync, service: PluginSync, row: PluginRow, refresh: () => Promise<void>): Promise<void> {
  const raw = await plugin.operate(() => service.files.rawSettings(row.id));
  if (!raw) return;
  const modal = new Modal(plugin.app);
  modal.setTitle(row.id);
  modal.modalEl.addClass('total-sync-plugin-dialog');
  modal.contentEl.createEl('p', { text: t('Selected additional fields will be sent to your Mail cloud. Review their meaning in the plugin settings first. Keep account data and machine-specific state local. The receiving laptop must also approve these fields.',
    'Выбранные дополнительные поля будут отправлены в ваше Облако Mail. Сначала проверьте их назначение в настройках плагина. Авторизацию и состояние конкретного компьютера оставьте локально. На принимающем ноутбуке эти поля тоже нужно разрешить.') });
  const selected = new Set(service.files.extra[row.id] ?? []);
  for (const key of [...new Set([...Object.keys(raw), ...row.unapproved])].sort()) {
    if (allowedPreference(row.id, key)) continue;
    const canSelect = safePreferenceKey(key) && (raw[key] === undefined || portableValue(raw[key]));
    new Setting(modal.contentEl).setName(key).setDesc(canSelect ? t('Review before enabling.', 'Проверьте перед включением.') : t('Stays local.', 'Остаётся локально.'))
      .addToggle(toggle => toggle.setValue(selected.has(key)).setDisabled(!canSelect).onChange(value => {
        if (value) selected.add(key); else selected.delete(key);
      }));
  }
  const failure = modal.contentEl.createEl('p', { attr: { role: 'alert' } });
  actions(modal.contentEl).addButton(b => b.setButtonText(t('Save selection', 'Сохранить выбор')).setCta().onClick(async () => {
    if (plugin.working) { failure.setText(errorText('busy')); return; }
    try {
      service.approveFields(row.id, [...selected]);
      plugin.savePluginFields();
      modal.close();
      await refresh();
    } catch (error) { failure.setText(errorText(error instanceof SyncError ? error.code : 'local')); }
  }));
  modal.open();
}
