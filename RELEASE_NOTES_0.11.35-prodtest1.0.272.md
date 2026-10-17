# WeTongbu 0.11.35-prodtest1.0.272

BRAT prerelease candidate. Hardens VST-03 recovery when a platform move leaves both the verified destination and its private plaintext stage: recovery verifies the destination, removes the duplicate stage before baseline/ACK advancement, and retries later if stage cleanup fails. A local edit made after promotion but before recovery remains untouched and keeps the inbox pending.

Automated validation: exact package verifier passed with 74/74 source inputs, 2/2 build inputs, reproducible bundle and mobile compatibility; apply-process recovery 13/13; plugin tests 763/763; isolated fault suite client 388/388, WebSocket 6/6, PostgreSQL 58 passed / 2 real-R2-only skips. Windows/iPad native acceptance and real provider E2E remain pending.
