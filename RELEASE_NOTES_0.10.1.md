# 微同步 0.10.1

## 移动端 Vault 同步候选

- 支持 Obsidian iOS 和 Android 运行环境，插件不再标记为仅桌面端。
- 增加 Vault 多端同步 MVP：首次同步保护、增量同步、冲突副本、删除 tombstone 和失败重试。
- 增加可选端到端加密；密码只保存在 Obsidian SecretStorage，忘记密码无法恢复加密内容。
- 增加跨平台 Web Crypto 哈希与对象存储适配，移除移动端不支持的 Node.js 运行时依赖。

现有飞书文档、普通网页、生财 DOCX 和微信公众号同步入口保持不变。
