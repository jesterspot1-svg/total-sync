# Changelog

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
