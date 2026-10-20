# WeTongbu 0.11.35-prodtest1.0.298

This BRAT prerelease tightens Vault Sync V2 recovery around the local commit marker.

- If the note changes after the prepared bytes have been validated but while the client persists the `committing` marker, the current request commits only that already-validated snapshot; the next scan then syncs the newer local bytes.
- Recovered `committing` requests still require the local file to match the durable payload, because their remote commit outcome may be unknown.
- This avoids parking a request that has not reached the server in `needs_rebase`; bytes entered after this preflight remain local for the next scan, and independent paths can proceed.

Use fresh canary paths for device acceptance. Keep existing needs-rebase and conflict records unchanged.

This prerelease does not alter the stable Community Plugins Marketplace release or production configuration.
