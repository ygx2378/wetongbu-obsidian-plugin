# WeTongbu 0.11.35-prodtest1.0.275

This candidate closes the snapshot-apply lease after every path that exits after a lease is acquired, including local snapshot application failures. A failed apply keeps its staged work available for retry and does not advance the local journal cursor. The successful ACK path still waits for lease release.

Validation in the source repository:

- `npm run plugin:check`
- Exact candidate bundle tests: 770 passed
- Source provenance: schema 2, 74 source inputs and 2 build inputs; production bundle reproduced
- Candidate ZIP and mobile bundle verification passed

Install through BRAT only for testing. This is a prerelease candidate; it does not change the Community Plugins listing or backend deployment.
