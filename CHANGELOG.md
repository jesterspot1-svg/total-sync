# Changelog

## 0.1.13 · Test prerelease

- Prepare the legacy WebDAV index before reserving its revision number. The originating device can finish its interrupted publication after a timeout or an Obsidian restart, then continue with the remaining files.
- Verify the saved index and the preceding revision before recovery. Protect unknown locks and conflicting indexes. Record `publication-recovered` in diagnostics after a recovered sync.

## 0.1.12 · Test prerelease

- Verify cloud metadata after a gateway timeout during legacy publication. Retry a missing write once and keep uncertain lock ownership protected.
- Include the failed write phase in diagnostic output for legacy locks, revision reservation, index storage and commit markers.

## 0.1.11 · Test prerelease

- Publish large uploads of new files in batches of up to 24 operations. Upload and verify each file before taking the legacy write lock for its batch.
- Preserve published batches across gateway timeouts. Defer an individual unverified transfer and stop attempting further files after three consecutive timeouts. Verify a blob after an uncertain PUT reply before deciding whether it needs another upload.

## 0.1.10 · Test prerelease

- Show completed file transfers out of the planned total in the sync badge.
- Add a Stop button to the badge. Finish in-flight work safely, stop the current run and keep confirmed data available for the next run.

## 0.1.9 · Test prerelease

- Fit all three sync actions on the mobile TotalSync settings page. Apply the same vertical button layout to connection, recovery and confirmation controls.

## 0.1.8 · Test prerelease

- Stack conflict review buttons on mobile, wrap long labels and limit preview height. Keep the floating sync badge clear of the review dialog.

## 0.1.7 · Test prerelease

- Keep Markdown conflicts in the original note even when a version exceeds the automatic merge limit. Review a preview of the first difference, choose either full version and recover both originals from history.

## 0.1.6 · Test prerelease

- Merge independent Markdown edits into the original note. Review overlapping edits in Obsidian and recover the two originals from history.
- Reuse recently verified local fingerprints for unchanged content. Check revision metadata concurrently and transfer up to three small files in parallel while preserving verified publication and local write checks.

## 0.1.5 · Test prerelease

- Show the elapsed time since the last successful sync in the desktop status bar and TotalSync settings, in Russian and English.
- Refresh the label as time passes and after manual or scheduled success. Failed and partial attempts preserve the last successful time.

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
