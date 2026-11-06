# WeTongbu 0.11.41

- Clips can now be saved to a folder you choose in the WeTongbu browser extension. The folder is remembered for each Vault, and notes go directly into it (no year/month subfolders). Leaving it empty keeps the default inbox.
- Folders from the extension are checked again before use: paths with "..", hidden folders, or invalid characters fall back to the default inbox.
- Image follow-up and duplicate detection also look in the chosen folder, so clips saved there are not duplicated.
