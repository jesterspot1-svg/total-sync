import { getLanguage } from 'obsidian';
import type { SyncError } from './model';
import type { Locale } from './sync-age';

export const interfaceLocale = (): Locale => /^ru(?:-|$)/i.test(getLanguage()) ? 'ru' : 'en';
export const t = (en: string, ru: string): string => interfaceLocale() === 'ru' ? ru : en;

export function errorText(code: SyncError['code']): string {
  const messages: Record<SyncError['code'], [string, string]> = {
    auth: ['Mail rejected the login or app password.', 'Mail отклонил логин или пароль приложения.'],
    forbidden: ['Mail denied access. Check the app password permissions.', 'Mail отказал в доступе. Проверьте права пароля приложения.'],
    missing: ['The vault or an expected object is missing. Verify the vault ID and cloud folder.', 'Хранилище или ожидаемый объект отсутствует. Проверьте ID и папку в облаке.'],
    rate: ['Mail is rate-limiting requests. TotalSync will retry.', 'Mail ограничил частоту запросов. TotalSync повторит попытку.'],
    server: ['Mail returned a server error.', 'Mail вернул ошибку сервера.'],
    network: ['The WebDAV request failed. Check your connection.', 'Запрос WebDAV не удался. Проверьте интернет.'],
    timeout: ['The server took too long to respond.', 'Сервер не успел ответить.'],
    uncertain: ['A cloud write could not be confirmed. Retry sync on this device. If the error persists, save the diagnostics.', 'Запись в облако не подтверждена. Повторите синхронизацию на этом устройстве. Если ошибка повторится, сохраните диагностику.'],
    dav: ['The WebDAV operation was rejected.', 'WebDAV отклонил операцию.'],
    protocol: ['The WebDAV capability check failed or the server returned an unexpected response.', 'Проверка возможностей WebDAV не прошла или сервер вернул неожиданный ответ.'],
    busy: ['An operation is already running on this device.', 'На этом устройстве уже выполняется операция TotalSync.'],
    'cloud-lock': ['Cloud writes are locked. Published downloads can continue.', 'Запись в облако заблокирована. Опубликованные изменения можно получить.'],
    'cloud-unlock': ['The server did not confirm that the write lock was released.', 'Сервер не подтвердил снятие блокировки записи.'],
    'cloud-advanced': ['Another device published changes. TotalSync will recheck the plan.', 'Другое устройство опубликовало изменения. TotalSync пересчитает план.'],
    'cloud-preparing': ['A cloud revision is awaiting confirmation. TotalSync will recheck it.', 'Ревизия в облаке ждёт подтверждения. TotalSync повторит проверку.'],
    'upload-retry': ['Some uploads could not be verified. TotalSync will retry.', 'Часть отправок не подтверждена. TotalSync повторит отправку.'],
    integrity: ['Cloud or local sync metadata could not be verified. Stop and consult the test instructions.', 'Проверка метаданных не прошла. Остановитесь и сверьтесь с инструкцией.'],
    identity: ['Verify the vault ID. This ID may already be in use.', 'Проверьте ID хранилища. Возможно, он уже используется.'],
    path: ['A file name, case collision or path is incompatible.', 'Недопустимый путь, имя файла или совпадение без учёта регистра.'],
    changed: ['The file changed during sync or the target already exists.', 'Файл изменился во время синхронизации или целевой файл уже существует.'],
    'mass-delete': ['Sync stopped. Open the sync plan to review and confirm the deletions.', 'Синхронизация остановлена. Откройте план и проверьте удаления перед подтверждением.'],
    'merge-conflict': ['Some note edits need review. Open Resolve conflicts in TotalSync.', 'Некоторые правки ждут выбора. Откройте «Разобрать конфликты» в TotalSync.'],
    size: ['A file exceeded the current device limit.', 'Файл превышает лимит для этого устройства.'],
    configuration: ['Check the settings. Some configuration files or credentials may be missing or unsupported.', 'Проверьте настройки. Конфигурация или учётные данные могут отсутствовать либо не поддерживаться.'],
    local: ['The local operation failed. Check free space and vault access.', 'Локальная операция не удалась. Проверьте свободное место и доступ к хранилищу.'],
    inactive: ['TotalSync is paused or the vault is closed.', 'TotalSync приостановлен или хранилище закрыто.'],
    cancelled: ['Sync stopped', 'Синхронизация остановлена'],
    'plugin-pending': ['Open Plugins and settings in TotalSync to set up, apply or review plugin changes.', 'Откройте «Плагины и настройки» в TotalSync: настройте профиль, примените или проверьте изменения плагинов.'],
    'plugin-trust': ['This exact package is unavailable in the catalog. Verify and trust its source device in Plugins and settings.', 'Точный пакет недоступен в каталоге. Сверьте и подтвердите ноутбук-источник в разделе «Плагины и настройки».'],
    'plugin-key': ['The fingerprint does not match. Copy it from the selected source laptop, not from a different device.', 'Отпечаток не совпал. Скопируйте его с выбранного ноутбука-источника, а не с другого устройства.'],
    'plugin-version': ['This plugin version is incompatible with your Obsidian. The previous installation was preserved.', 'Версия плагина несовместима с Obsidian. Прежняя установка сохранена.'],
    'plugin-recovery': ['A plugin installation was interrupted. Open Plugins and settings and choose Restore installation.', 'Установка плагина была прервана. Откройте «Плагины и настройки» и нажмите «Восстановить установку».'],
  };
  return t(...messages[code]);
}
