# WeTongbu Obsidian 0.11.35-prodtest1.0.266

This BRAT prerelease moves the server-provided Vault Sync Retry-After deadline into per-vault local storage. The deadline survives plugin disable/enable and a graceful Obsidian restart without being written into plugin settings that can sync across devices. Automatic sync stays deferred until the deadline expires.

Validation: plugin tests 740/740 and plugin type checks pass; candidate schema 2 provenance matches all 74 source inputs and 2 build inputs, reproduces the bundle, and verifies the ZIP/mobile package. An isolated Obsidian 1.12.7 lifecycle POC confirms the exact candidate restores the retry deadline after disable/enable and full process reopen while outbound network is blocked. This is not real-provider, Windows, or iPadOS acceptance.

Please install on Windows and iPad and include this candidate in the next consolidated sync/device acceptance. The existing needs-rebase records, cursor 77, and 001.md should remain untouched.
