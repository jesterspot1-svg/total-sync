# TotalSync

[Русский](README.ru.md) · [Install TotalSync](https://community.obsidian.md/plugins/total-sync) · [Step-by-step guide](docs/USER_GUIDE_RU.md)

**Keep your Obsidian notes and files in sync across devices using your own WebDAV storage.** Edit on your laptop, sync, and continue on your phone. TotalSync is free.

## What you can sync

| Data | Computers and phones | Between Windows computers |
| --- | --- | --- |
| Notes, folders and attachments | Yes | Yes |
| Selected Obsidian settings | — | Yes |
| Plugins and their portable settings | — | Optional |
| Bookmarks | Optional snapshots | Optional snapshots |

Independent edits to a Markdown note can merge automatically. If two edits overlap, TotalSync asks which text to keep and retains recovery copies.

## Get started

You need **Obsidian 1.11.5+** and a **WebDAV HTTPS address, login and password**. Use an app password if your provider requires one. Mail Cloud and other compatible WebDAV servers are supported; storage subscriptions are separate from this free plugin.

1. **Install.** Open **Settings → Community plugins → Browse → TotalSync**, install and enable it. Back up existing notes and turn off other sync tools for this vault.
2. **Connect the first device.** In **Settings → TotalSync**, enter the full WebDAV address and credentials, then **Check connection**. Choose **Generate ID → Create remote vault**.
3. **Start syncing.** Review **Show sync plan**, enable sync and select **Sync now**. Wait for the first upload to finish.
4. **Add another device.** Install TotalSync in its local vault. Enter the same WebDAV connection and remote vault ID, then **Join by ID**. Review the plan and enable sync. Enter the password locally on each device.

For Windows plugins, open **Plugins and settings** on the computer with the desired setup, publish its profile, and receive it on the other computer. [Detailed instructions](docs/COMMUNITY_PLUGINS_RU.md).

## Everyday controls

- **Language:** choose English, Russian or the Obsidian language in TotalSync settings.
- **Desktop status bar:** a spinning icon and file count while syncing, a check mark after every successful run, and the time since the last success. Stop an active run from the same bar.
- **Automatic sync:** at startup, after edits or at your chosen interval. Temporary network errors are retried automatically.
- **Another server or account:** select **Change server or account**, then enter the new connection. Local notes and files in the old cloud are kept. Review the new sync plan before enabling it.
- **Updates:** **Check and update** opens TotalSync's native Obsidian catalog page. Obsidian handles installation; BRAT is optional for test releases.

On iPhone, keep Obsidian open during sync. Its compact progress control and quick-access command remain available.

## Your data

Your files go directly to your chosen WebDAV server over HTTPS. **There is no client-side content encryption or telemetry.** Your storage provider can read uploaded data. Credentials stay in local Obsidian SecretStorage.

Optional Windows plugin sync also transfers plugin code and selected settings. Packages outside the catalog require a trusted source. Catalog packages are retrieved from GitHub; login details and machine-specific paths stay local. Some active plugins need **Apply pending changes**. [Data, network access and limitations](docs/DATA_AND_PRIVACY.md).

**Already using TotalSync?** Update each device; keep your existing vault, ID and settings. Mail connections migrate automatically. Do not reconnect just to install 0.3.0. [Recovery and troubleshooting](docs/USER_GUIDE_RU.md#ошибки-сети-и-блокировки).

## Development

Node.js 24: `npm ci`, then `npm run check`. MIT. [Third-party notices](docs/THIRD_PARTY_NOTICES.md).
