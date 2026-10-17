# WeTongbu 0.11.35-prodtest1.0.276

This candidate raises the periodic local hash-audit budget from 64 to 256 files per sync pass. It helps detect same-size/same-mtime local changes that arrive without an Obsidian index event sooner, while metadata-matching files continue to use cached hashes. In isolated 10,000-file macOS Obsidian 1.12.7 and 1.14.4 full-cycle tests, the missed-event edit was found on audit round 40.

This is desktop performance evidence only. Windows and iPad resource use and sync behavior still need device acceptance.

Validation in the source repository:

- `npm run plugin:check`
- Current-source plugin tests: 773 passed
- Source provenance: schema 2, 74 source inputs and 2 build inputs; production bundle reproduced
- Candidate ZIP and mobile bundle verification passed

Install through BRAT only for testing. This prerelease does not change the Community Plugins listing or backend deployment.
