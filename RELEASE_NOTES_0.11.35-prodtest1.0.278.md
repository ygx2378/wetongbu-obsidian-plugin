# WeTongbu 0.11.35-prodtest1.0.278

This candidate hardens local note replacement during Vault Sync. If an adapter reports a failed write after the target has diverged from both the original and intended remote content, the plugin now preserves the current file and recovery artifacts, blocks further Vault Sync writes, and reports the affected path instead of restoring an old backup over newer local content. If the intended remote bytes were committed despite an adapter error, the replacement is treated as committed and its temporary artifacts are cleaned up.

Validation in the source repository:

- `npm run plugin:check`
- Current-source plugin tests: 785 passed
- Release-repository `npm run check` and `npm run build` passed; the built bundle matches the source-repository reproduction byte for byte
- Source provenance: schema 2, production bundle reproduced
- Candidate ZIP and mobile bundle verification passed

This is a BRAT prerelease for testing. Windows/iPad device acceptance and real provider E2E remain separate gates. It does not change the Community Plugins listing or backend deployment.
