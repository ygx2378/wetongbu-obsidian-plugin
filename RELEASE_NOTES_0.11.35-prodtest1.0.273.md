# WeTongbu 0.11.35-prodtest1.0.273

BRAT prerelease candidate. Fixes VST-03 restart recovery when a local edit races cleanup of a duplicate plaintext stage. Recovery verifies the promoted destination, removes the duplicate stage, then rechecks the destination path generation before advancing the baseline or applied cursor. A concurrent local edit stays intact and the inbox remains pending for resolution.

Automated validation: schema 2 provenance verified (74/74 source inputs, 2/2 build inputs, reproducible bundle); exact candidate ZIP and mobile bundle verified; `plugin:check` passed; plugin tests 765/765; staged-apply process recovery tests 15/15; isolated sync fault suite client 390/390, WebSocket 6/6, PostgreSQL 58 passed / 2 real-R2-only skips. Windows/iPad device acceptance and real provider E2E remain pending.
