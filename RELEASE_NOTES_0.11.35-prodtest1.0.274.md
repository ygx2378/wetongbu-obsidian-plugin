# WeTongbu 0.11.35-prodtest1.0.274

BRAT prerelease candidate for production API testing. Adds per-device received/applied cursor diagnostics to sync settings and shows the cloud change cursor after a confirmed deletion. This lets testers compare a tombstone cursor with the receiver's applied cursor; device status query timestamps remain snapshot times, not propagation latency.

No sync protocol or server behavior changed. The candidate uses the existing production API endpoint.

Automated validation: schema 2 provenance verified (74/74 source inputs, 2/2 build inputs, reproducible bundle); exact candidate ZIP and mobile bundle verified; `plugin:check` passed; exact candidate bundle tests passed 769/769. Windows/iPad installation, real provider E2E, and device acceptance remain pending.
