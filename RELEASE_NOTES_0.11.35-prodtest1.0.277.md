# WeTongbu 0.11.35-prodtest1.0.277

This candidate packages the current Vault Sync client. Delete confirmation work runs per note outside the main sync queue, so a pending cloud-delete decision does not hold up unrelated note pushes. Local apply and retry paths also retain editor and path-generation checks while work is in flight.

Validation in the source repository:

- `npm run plugin:check`
- Exact candidate bundle tests: 783 passed
- Release-repository `npm run check` and `npm run build` passed; the built bundle matches the verified candidate byte for byte
- Source provenance: schema 2, 74 source inputs and 2 build inputs; production bundle reproduced
- Candidate ZIP and mobile bundle verification passed

This is a BRAT prerelease for testing. Windows/iPad device acceptance, provider E2E, production parity and backend deployment remain separate gates. It does not change the Community Plugins listing or backend deployment.
