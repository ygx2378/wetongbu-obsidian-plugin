# WeTongbu 0.11.38

- Adds encrypted local staging for Vault Sync uploads, so a fully prepared upload can be reused after a connection restart instead of being encoded again.
- Reports which synced-object formats this device can read, so a Vault only switches to a newer format once every active device supports it.
- Shows the current sync Vault UUID and adds a device management list for the current Vault.
- Pauses applying remote changes while a note or file name is still being edited locally, then resumes automatically.
- Explains when a sync scan stops because of oversized files.
- Improves the mobile layout of the sync scope setting.
