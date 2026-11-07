# TotalSync

[Русский](README.ru.md) · [Beta test guide in Russian](docs/BETA_TEST_INSTRUCTION_RU.md)

TotalSync is a free Obsidian plugin that syncs vault data through [Mail Cloud WebDAV](https://help.mail.ru/cloud/desktop/webdav/). It uses a dedicated remote vault ID and independent channels for notes and attachments, selected Windows settings, and optional Bookmarks snapshots.

**0.1.18 is a test prerelease.** It fixes settings synchronization for Outliner 4.10.2, including vertical indentation lines and list editing preferences. Both Windows laptops need this update through BRAT. It requires Obsidian 1.11.5 or later. Follow the [Outliner test](docs/OUTLINER_TEST_RU.md) or the full [plugin guide](docs/COMMUNITY_PLUGINS_RU.md). The existing [beta guide](docs/BETA_TEST_INSTRUCTION_RU.md) covers note synchronization.

## Data and privacy

- Notes, folders and attachments sync on Windows and mobile. On iOS, TotalSync applies no per-file cap. The limits are 128 MiB on desktop and 32 MiB on Android. The plugin schedules sync while Obsidian is active.
- Independent Markdown edits can merge into the original note. Resolve overlapping edits in TotalSync and recover the original versions from history.
- A compact badge shows file transfer progress and results and lets you stop the current run. The desktop status bar and TotalSync settings show how long ago the last successful sync finished. Run sync from the desktop ribbon or from Obsidian's bottom-right menu on phones.
- Windows can synchronize plugin packages, exact versions, enabled state, and portable preferences. Set up **Plugins and settings** once on each laptop. Matching catalog releases install without shell commands; other packages require verification of the source device's public key fingerprint. The feature is off by default and never updates TotalSync itself. Older limited Calendar/Excalidraw profiles remain available when this feature is off.
- Ordinary preferences have explicit mappings for 16 plugins, including Excalidraw 2.25.3. Additional fields require selection on both devices. Credentials, local paths and execution permissions stay local. Plugins with an external-settings hook can reload settings in place; other active plugins wait for **Apply pending changes**. A native plugin-manager adapter checks capabilities before changing files. [Windows plugin guide in Russian](docs/COMMUNITY_PLUGINS_RU.md)
- Bookmarks are shared as explicit snapshots. Exported snapshots and recovered copies appear under `TotalSync-Recovery`. The live Bookmarks file remains under Obsidian's control.
- Data is transferred over HTTPS. Mail Cloud can read the data at rest, including file names and retained versions. This version provides no client-side content encryption. It keeps credentials in local Obsidian SecretStorage and sends no telemetry.
- The optional plugin profile uploads signed preference records and plugin packages to your Mail vault. A signature authenticates the source; it is not encryption. Its private signing key stays in SecretStorage. Catalog resolution uses `raw.githubusercontent.com`; exact release downloads use `github.com` and its asset redirects, without Mail credentials. Source trust authorizes future signed packages from that device. Live authorization values and machine paths are excluded from automatic preference export; explicitly selected extra fields must be reviewed by the user.
- Plugin profile history and local installation backups are retained without automatic cleanup in this beta. Backups may contain local credentials and must not be published. Packages currently cover `main.js`, `manifest.json`, optional `styles.css`, and the Zotero helper `pdfannots2json.exe`. Other auxiliary files need separate setup. iPhone never downloads or applies Windows plugin profiles.
- The connection probe checks exclusive `MKCOL` and tests whether the server accepts collection `MOVE` with no overwrite. A verified move allows publication without the legacy global lock. Read the [known limitations](docs/RISKS_RU.md) before testing.

## Development

Use Node.js 24 and run `npm ci`, then `npm run check`. The build produces `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. The HTTP integration fixture listens on localhost and uses synthetic data.

MIT. The distribution contains original code and uses the external Obsidian host API. Development dependencies and their licenses are documented in [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
