# TotalSync

[Русский](README.ru.md) · [Beta test guide in Russian](docs/BETA_TEST_INSTRUCTION_RU.md)

TotalSync is a free Obsidian plugin that syncs vault data through [Mail Cloud WebDAV](https://help.mail.ru/cloud/desktop/webdav/). It uses a dedicated remote vault ID and independent channels for notes and attachments, selected Windows settings, and optional Bookmarks snapshots.

**0.1.14 is a test prerelease for disposable vaults with synthetic data.** It requires Obsidian 1.11.5 or later. Verify the provider and iPhone scenarios in the [beta guide](docs/BETA_TEST_INSTRUCTION_RU.md) before planning a migration.

## Data and privacy

- Notes, folders and attachments sync on Windows and mobile. On iOS, TotalSync applies no per-file cap. The limits are 128 MiB on desktop and 32 MiB on Android. The plugin schedules sync while Obsidian is active.
- Independent Markdown edits can merge into the original note. Resolve overlapping edits in TotalSync and recover the original versions from history.
- A compact badge shows file transfer progress and results and lets you stop the current run. The desktop status bar and TotalSync settings show how long ago the last successful sync finished. Desktop users can enable a manual sync button in the left ribbon.
- Windows transfers selected core settings, hotkeys, safe CSS and theme files, plugin inventory, and opt-in portable Calendar and Excalidraw preferences. Install missing catalog plugins through Obsidian's community plugin manager or its official CLI. Update every TotalSync client before enabling Excalidraw preferences. [Windows plugin guide in Russian](docs/COMMUNITY_PLUGINS_RU.md)
- Bookmarks are shared as explicit snapshots. Exported snapshots and recovered copies appear under `TotalSync-Recovery`. The live Bookmarks file remains under Obsidian's control.
- Data is transferred over HTTPS. Mail Cloud can read the data at rest, including file names and retained versions. This version provides no client-side content encryption. It keeps credentials in local Obsidian SecretStorage and sends no telemetry.
- The connection probe checks exclusive `MKCOL` and tests whether the server accepts collection `MOVE` with no overwrite. A verified move allows publication without the legacy global lock. Read the [known limitations](docs/RISKS_RU.md) before testing.

## Development

Use Node.js 24 and run `npm ci`, then `npm run check`. The build produces `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. The HTTP integration fixture listens on localhost and uses synthetic data.

MIT. The distribution contains original code and uses the external Obsidian host API. Development dependencies and their licenses are documented in [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
