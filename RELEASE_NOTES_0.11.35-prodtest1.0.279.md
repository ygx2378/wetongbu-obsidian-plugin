# WeTongbu 0.11.35-prodtest1.0.279

This candidate improves Vault Sync handling when a same-path remote Markdown update chain returns byte-for-byte to the previously shared content while this device has an independent local edit. When the update chain is contiguous and verified, the note is closed, and no local write is pending, the plugin advances the shared baseline without replacing local text. The local edit can then be submitted against the latest remote version instead of becoming a stale-base conflict.

The guard is intentionally narrow. Non-matching or ambiguous chains continue through the existing conflict handling, and this candidate does not automatically resolve conflicts already present in a device inbox.

This is a BRAT prerelease for Windows/iPad acceptance. Keep existing cursor 77, `001.md`, and old needs-rebase/conflict records outside the test. Use a new canary note with the specific sequence described in the device runbook.
