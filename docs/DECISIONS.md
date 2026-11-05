# Decisions

1. Use a fresh TypeScript project based on the official Obsidian sample's plugin entry point and esbuild packaging pattern. Source is original and MIT-licensed.
2. Use a WebDAV collection as an exclusive lock and another collection as the commit marker. The connection probe checks exclusive creation. A stale lock requires a stopped-client recovery procedure.
3. Use SHA-256 and explicit tombstones. A sequence of committed manifests is independent of WebDAV listing order and timestamps.
4. Store application passwords with Obsidian SecretStorage, available with encrypted storage on supported versions from 1.11.5. The plugin bundle has only the host Obsidian API as an external dependency.
5. Sync inventory and explicitly allowlisted configuration. Installation, activation and upgrades of third-party plugins remain user actions in Obsidian.
6. Exchange Bookmarks snapshots. Applying a snapshot to live Bookmarks is deferred because the public API provides no safe reload and write integration.

Sources: [official sample](https://github.com/obsidianmd/obsidian-sample-plugin), [Vault API](https://docs.obsidian.md/Plugins/Vault), [mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development), [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins), [developer policies](https://docs.obsidian.md/community-directory/developer-policies), [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), [Mail WebDAV](https://help.mail.ru/cloud/desktop/webdav/), [Remotely Save project documentation](https://github.com/remotely-save/remotely-save).
