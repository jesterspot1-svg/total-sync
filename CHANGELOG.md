# Changelog

## 0.1.4 · Test prerelease

- Add an optional desktop ribbon button for manual synchronization.
- Show a bottom-right progress badge while sync is active, with a short success message or a specific error afterward.
- Use Obsidian theme colors, safe-area spacing and the system reduced-motion preference. Release assets now include `styles.css`.

## 0.1.3 · Test prerelease

- Show catalog links and an optional batch of official Obsidian CLI commands for missing plugins on Windows.
- Sync an opt-in, validated subset of Excalidraw 2.29.x preferences. Keep credentials, script permissions and unrelated settings local.
- Allow the receiving Windows vault to accept the published Excalidraw profile on first setup. Update every TotalSync client to 0.1.3 before publishing this profile.

## 0.1.2 · Test prerelease

- Probe whether the server supports exclusive WebDAV collection moves, including collisions with an empty legacy reservation and simultaneous moves.
- When verified, publish prepared revisions without depending on the legacy global lock. Concurrent writers replan against the winning revision.
- Verify and finish a prepared revision after a lost network response or an interrupted client. Keep the previous publication path when the capability is unavailable.

## 0.1.1 · Test prerelease

- Download published changes while a cloud write lock is present. Uploads and deletions still require the lock.
- Shorten the lock by moving local scan and application outside the write transaction.
- Distinguish local contention, cloud contention and unconfirmed release in diagnostics.
- Verify a commit or lock release when the server reports a failed response after applying it.
- Retry interrupted uploads of unpublished objects without leaving the cloud lock behind.

## 0.1.0 · Test prerelease

- Obsidian plugin with Russian and English settings and Mail Cloud WebDAV.
- Two-way content sync, a Windows settings channel, and optional Bookmarks snapshots.
- SHA-256 validation, guarded deletions, conflict copies and recovery history.
- Preview, device inventory, scheduled sync and redacted diagnostics.
- Synthetic WebDAV tests and a Windows and iPhone test guide.
