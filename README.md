# TotalSync

[Русский](README.ru.md) · [User guide in Russian](docs/USER_GUIDE_RU.md)

TotalSync is a free Obsidian plugin that syncs vault data through [Mail Cloud WebDAV](https://help.mail.ru/cloud/desktop/webdav/). It uses a dedicated remote vault ID and independent channels for notes and attachments, selected Windows settings, and optional Bookmarks snapshots.

Requires **Obsidian 1.11.5 or later**, a Mail Cloud account and an app password with WebDAV access. TotalSync has no paid features. Mail's storage limits and optional paid plans apply separately. Windows and iPhone have been used with a real vault; Android, macOS and Linux have not received the same manual acceptance testing.

## Setup

1. Back up the vault, including `.obsidian`. Disable other sync plugins for this vault to avoid competing writes.
2. Until TotalSync is approved in the Community Directory, install or update it through **BRAT** using `https://github.com/jesterspot1-svg/total-sync`. A GitHub release alone does not mean the directory listing has been approved.
3. On the first device, open **Settings → TotalSync**, enter the Mail login and app password, then **Check connection**. Choose **Generate ID**, then **Create remote vault**.
4. Review **Show sync plan**, enable synchronization, and run **Sync now**. Wait for the initial upload to finish.
5. On each other device, create or open the corresponding local vault, install TotalSync, enter the Mail credentials locally, and paste the same remote ID. Choose **Join by ID**, review the plan, then enable and run synchronization. The remote ID identifies the shared data; the local name alone does not connect vaults.
6. For Windows plugin migration, open **Plugins and settings**. Publish the source profile on the laptop with the desired plugins, receive that profile on the other laptop, and review any trust or pending-application prompts. Later changes sync in both directions. [Detailed Windows guide](docs/COMMUNITY_PLUGINS_RU.md)

**Updating an existing installation to 0.2.0:** keep the existing vault, remote ID and credentials. No cloud reset or repeated initial upload is required. Update every participating device. The historical cloud folder name `TotalSync-beta` is retained for compatibility.

## Reliability and recovery

Ordinary uploads are verified before acquiring the shared metadata lock. Transient connection errors, server errors and competing writers trigger automatic retries with increasing delays, up to about five minutes. Returning online expedites a pending retry. A retry waits for other local TotalSync operations instead of disappearing when they are busy. The feedback badge shows when a retry is scheduled.

The originating device can resume its own interrupted publication from a durable journal, including after restarting Obsidian. When exclusive collection MOVE passes the capability probe, publication does not use the legacy global write lock. **An empty legacy lock with an unknown owner, or a lock left after an ambiguous DELETE, cannot always be repaired automatically.** TotalSync must not delete another device's active lock. It rechecks safely and can receive already published changes; persistent cases need diagnosis. Do not rename cloud folders while devices may still be syncing. [Recovery and limitations](docs/USER_GUIDE_RU.md#ошибки-сети-и-блокировки)

## Data and privacy

- Notes, folders and attachments sync on Windows and mobile. On iOS, TotalSync applies no per-file cap. The limits are 128 MiB on desktop and 32 MiB on Android. The plugin schedules sync while Obsidian is active.
- Independent Markdown edits can merge into the original note. Resolve overlapping edits in TotalSync and recover the original versions from history.
- A compact badge shows file transfer progress and results and lets you stop the current run. The desktop status bar and TotalSync settings show how long ago the last successful sync finished. Run sync from the desktop ribbon or from Obsidian's bottom-right menu on phones.
- Windows can synchronize plugin packages, exact versions, enabled state, and portable preferences. Set up **Plugins and settings** once on each laptop. Matching catalog releases install without shell commands; other packages require verification of the source device's public key fingerprint. The feature is off by default and never updates TotalSync itself. Older limited Calendar/Excalidraw profiles remain available when this feature is off.
- Ordinary preferences have explicit mappings for 16 plugins, including Excalidraw 2.25.3. Additional fields require selection on both devices. Credentials, local paths and execution permissions stay local. Plugins with an external-settings hook can reload settings in place; other active plugins wait for **Apply pending changes**. A native plugin-manager adapter checks capabilities before changing files. [Windows plugin guide in Russian](docs/COMMUNITY_PLUGINS_RU.md)
- Bookmarks are shared as explicit snapshots. Exported snapshots and recovered copies appear under `TotalSync-Recovery`. The live Bookmarks file remains under Obsidian's control.
- Data is transferred over HTTPS. Mail Cloud can read the data at rest, including file names and retained versions. This version provides no client-side content encryption. It keeps credentials in local Obsidian SecretStorage and sends no telemetry.
- The optional plugin profile uploads signed preference records and plugin packages to your Mail vault. A signature authenticates the source; it is not encryption. Its private signing key stays in SecretStorage. Catalog resolution uses `raw.githubusercontent.com`; exact release downloads use `github.com` and its asset redirects, without Mail credentials. Source trust authorizes future signed packages from that device. Live authorization values and machine paths are excluded from automatic preference export; explicitly selected extra fields must be reviewed by the user.
- Plugin profile history and local installation backups are retained without automatic cleanup. Backups may contain local credentials and must not be published. Packages currently cover `main.js`, `manifest.json`, optional `styles.css`, and the Zotero helper `pdfannots2json.exe`. Other auxiliary files need separate setup. iPhone never downloads or applies Windows plugin profiles.
- iOS must keep Obsidian active during synchronization. Files are buffered in memory, so available memory and Mail's limits still apply even without a TotalSync size cap.
- Vault data, plugin installations, local recovery copies and configuration are accessed inside the vault. Credentials, device identity and recovery journals use Obsidian's local storage and SecretStorage. There is no background system service or arbitrary filesystem scan.

## Development

Use Node.js 24 and run `npm ci`, then `npm run check`. The build produces `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. The HTTP integration fixture listens on localhost and uses synthetic data.

MIT. The distribution contains original code and uses the external Obsidian host API. Development dependencies and their licenses are documented in [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
