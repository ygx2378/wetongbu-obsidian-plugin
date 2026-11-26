# WeTongbu 0.11.46

Improvements to "Auto-upload pasted images" (Plus):

- Pasted and dropped images are now uploaded straight to WeTongbu cloud storage instead of passing through the WeTongbu API server. On networks or proxies where uploads to the API were slow, images now upload in seconds instead of timing out.
- If you paste an image you have already uploaded before, the existing cloud link is reused without uploading it again.
- Uploads interrupted before they reach the cloud are retried automatically. Uploads that still fail are saved as a local attachment, as before.
