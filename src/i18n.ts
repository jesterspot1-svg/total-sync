import { getLanguage } from 'obsidian';
import type { SyncError } from './model';

export const t = (en: string, ru: string): string => /^ru(?:-|$)/i.test(getLanguage()) ? ru : en;

export function errorText(code: SyncError['code']): string {
  const messages: Record<SyncError['code'], [string, string]> = {
    auth: ['Mail rejected the login or app password.', 'Mail отклонил логин или пароль приложения.'],
    forbidden: ['Mail denied access. Check the app password permissions.', 'Mail отказал в доступе. Проверьте права пароля приложения.'],
    missing: ['The vault or an expected object is missing. Verify the vault ID and cloud folder.', 'Хранилище или ожидаемый объект отсутствует. Проверьте ID и папку в облаке.'],
    rate: ['Mail is rate-limiting requests. TotalSync will retry.', 'Mail ограничил частоту запросов. TotalSync повторит попытку.'],
    server: ['Mail returned a server error.', 'Mail вернул ошибку сервера.'],
    network: ['The WebDAV request failed. Check your connection.', 'Запрос WebDAV не удался. Проверьте интернет.'],
    timeout: ['The server took too long to respond.', 'Сервер не успел ответить.'],
    uncertain: ['A cloud write could not be confirmed. Check the lock recovery instructions.', 'Запись в облако не подтверждена. См. инструкцию по проверке блокировки.'],
    dav: ['The WebDAV operation was rejected.', 'WebDAV отклонил операцию.'],
    protocol: ['The WebDAV capability check failed or the server returned an unexpected response.', 'Проверка возможностей WebDAV не прошла или сервер вернул неожиданный ответ.'],
    busy: ['An operation is already running on this device.', 'На этом устройстве уже выполняется операция TotalSync.'],
    'cloud-lock': ['Cloud writes are locked. Published downloads can continue.', 'Запись в облако заблокирована. Опубликованные изменения можно получить.'],
    'cloud-unlock': ['The server did not confirm that the write lock was released.', 'Сервер не подтвердил снятие блокировки записи.'],
    'cloud-advanced': ['Another device published changes. TotalSync will recheck the plan.', 'Другое устройство опубликовало изменения. TotalSync пересчитает план.'],
    'cloud-preparing': ['A cloud revision is awaiting confirmation. TotalSync will recheck it.', 'Ревизия в облаке ждёт подтверждения. TotalSync повторит проверку.'],
    'upload-retry': ['Upload interrupted before publication. TotalSync will retry.', 'Передача прервалась до публикации. TotalSync повторит отправку.'],
    integrity: ['Cloud or local sync metadata could not be verified. Stop and consult the test instructions.', 'Проверка метаданных не прошла. Остановитесь и сверьтесь с инструкцией.'],
    identity: ['Verify the vault ID. This ID may already be in use.', 'Проверьте ID хранилища. Возможно, он уже используется.'],
    path: ['A file name, case collision or path is incompatible.', 'Недопустимый путь, имя файла или совпадение без учёта регистра.'],
    changed: ['The file changed during sync or the target already exists.', 'Файл изменился во время синхронизации или целевой файл уже существует.'],
    'mass-delete': ['Sync stopped. Open the sync plan to review and confirm the deletions.', 'Синхронизация остановлена. Откройте план и проверьте удаления перед подтверждением.'],
    size: ['A file exceeded the current device limit.', 'Файл превышает лимит для этого устройства.'],
    configuration: ['Check the settings. Some configuration files or credentials may be missing or unsupported.', 'Проверьте настройки. Конфигурация или учётные данные могут отсутствовать либо не поддерживаться.'],
    local: ['The local operation failed. Check free space and vault access.', 'Локальная операция не удалась. Проверьте свободное место и доступ к хранилищу.'],
    inactive: ['TotalSync is paused or the vault is closed.', 'TotalSync приостановлен или хранилище закрыто.'],
  };
  return t(...messages[code]);
}
