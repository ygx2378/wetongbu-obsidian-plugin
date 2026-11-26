# WeTongbu 0.11.45

Improvements to "Auto-upload pasted images" (Plus):

- Faster uploads: large pasted or dropped images are resized to at most 2560 px on the long edge and converted to WebP before upload. GIFs are uploaded unchanged so animations are kept.
- The image now shows in the note immediately while it uploads, and is swapped for the cloud link when the upload finishes.
- Uploads that fail because of an unstable network are retried automatically (twice). Uploads that still fail are saved as a local attachment, as before.
- If an image could not be uploaded, the notice now stays on screen until you close it, and explains why.
- The upload placeholder no longer shows as a broken internal link.
