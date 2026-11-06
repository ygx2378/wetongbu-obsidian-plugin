# WeTongbu 0.11.39

- Adds an optional "paste image upload" setting for active Plus hosted accounts: images pasted or dropped into a note are uploaded to WeTongbu cloud storage and inserted as an image link. It is off by default.
- If an upload fails (for example no active Plus, an image over 20 MB, or a network error), the image is saved as a normal local attachment instead.
- Cloud image links remain readable for 30 days after a Plus subscription ends; after that grace period the links stop working and the images are removed. The setting explains this before you turn it on.
