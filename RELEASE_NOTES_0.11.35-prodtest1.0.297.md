# WeTongbu 0.11.35-prodtest1.0.297

This BRAT prerelease updates the Obsidian Vault Sync V2 client.

- When the same Markdown file changes again before a create/update reaches the remote commit phase, the client can atomically replace the still-uncommitted local operation with the latest file bytes.
- Operations already committing, with an unknown remote result, in conflict resolution, or competing with another active operation remain protected and fail closed.
- This candidate is intended for isolated Windows/iPad regression testing of IME composition, editor protection, and needs-rebase behavior.

This prerelease does not alter the stable Community Plugins Marketplace release or production configuration.
