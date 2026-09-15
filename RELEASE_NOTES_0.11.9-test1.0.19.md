# WeTongbu 0.11.9-test1.0.19

- 修复轻量网页剪藏本地图片下载后的附件扩展名，避免 WebP 图片在 Obsidian 中显示“找不到”。
- 剪藏先打开正文，再后台保存图片；同一篇文章重剪藏时会迁移旧版无扩展名 WTB 图片引用。
- 修复多图片部分失败时的序号错配，并保存轻量剪藏编辑后的 `capture_level`、`platform` 和 `tags`。
- 本版本仅用于 BRAT 测试，连接 `https://staging-api.wetongbu.com`，不影响正式 `0.11.8`。
