# Полная проверяемая копия рабочего vault

Выполняйте эту процедуру на старом ноутбуке перед реальной миграцией, после успешной beta и отдельного согласия. Архив включает заметки, вложения, скрытую `.obsidian`, плагины и их локальные данные. Храните архив как конфиденциальный файл на доверенном локальном носителе.

1. В рабочем Obsidian дождитесь окончания Remotely Save. Убедитесь, что ручной проход завершается без ошибок. В параметрах Remotely Save локально проверьте раздел шифрования и зафиксируйте только «включено», «выключено» или «неизвестно». При включённом или неопределённом шифровании приостановите миграцию. Не копируйте в отчёт пароль и другие значения полей.
2. Полностью закройте Obsidian. В Проводнике проверьте фактический путь исходного vault. Откройте PowerShell и задайте этот путь в `$source`. Для `$backup` выберите новый каталог вне исходного vault. В примере использован диск `E:`.

   ```powershell
   $source = (Resolve-Path -LiteralPath 'D:\Vaults\SourceVault').Path.TrimEnd('\')
   $backup = 'E:\Obsidian-Backup-2026-11-05'
   if (Test-Path -LiteralPath $backup) { throw 'Choose a new backup folder' }
   New-Item -ItemType Directory -Path $backup | Out-Null
   $archive = Join-Path $backup 'vault.tar'
   tar.exe -cf $archive -C $source .
   if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed' }
   Get-FileHash -Algorithm SHA256 -LiteralPath $archive
   ```

3. Проверьте архив распаковкой во временную папку рядом с ним и сравнением относительных путей, размеров и SHA-256. Ничего из результатов с частными именами файлов не отправляйте в чат.

   ```powershell
   $verify = Join-Path $backup 'verify'
   New-Item -ItemType Directory -Path $verify | Out-Null
   tar.exe -xf $archive -C $verify
   if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed' }
   function Get-VaultHashes([string]$root) {
       Get-ChildItem -File -Recurse -Force -LiteralPath $root | ForEach-Object {
           [pscustomobject]@{
               Path = $_.FullName.Substring($root.Length + 1)
               Size = $_.Length
               Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
           }
       }
   }
   $original = @(Get-VaultHashes $source)
   $extracted = @(Get-VaultHashes $verify)
   $diff = @(Compare-Object $original $extracted -Property Path,Size,Hash)
   if ($diff.Count -or !(Test-Path -LiteralPath (Join-Path $verify '.obsidian'))) {
       throw 'Verification failed'
   }
   "Verified files = $($original.Count)"
   ```

4. Сохраните архив и его SHA-256 отдельно от оригинала. На новом ноутбуке проверьте SHA-256 архива после копирования. В чистом Obsidian заранее создайте пустой локальный vault с точным именем исходного. Закройте Obsidian, сохраните копию чистой папки и перенесите содержимое проверенного архива в корень заранее созданного vault.
5. Первый запуск копии выполните без сети. Проверьте заметки, вложения, `.obsidian`, горячие клавиши, тему, сниппеты, плагины и закладки. До выхода в сеть согласуйте состояние Remotely Save в копии. Глобальные параметры, разрешения и входы в аккаунты проверьте отдельно, вводя секреты только в локальном интерфейсе. Настройки машины из `%APPDATA%\Obsidian` восстанавливайте выборочно после отдельной проверки.
6. Для отката закройте новый Obsidian, оставьте архив и рабочий оригинал на старом ноутбуке. Верните чистую целевую папку из её отдельной копии или откройте исходный vault на старом ноутбуке.
