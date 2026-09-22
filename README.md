# WeTongbu

WeTongbu saves user-selected WeChat articles, Feishu documents, web pages, and AI conversations to the current Obsidian Vault as editable Markdown notes with local images and attachments.

## Features

- Clip selected content from the WeTongbu browser extension to the active Obsidian Vault.
- Keep Markdown notes, images, and attachments in the local Vault.
- Preserve user edits and avoid creating duplicate notes when the same source is delivered again.
- Connect an Obsidian Vault to your WeTongbu account and synchronize Vault content across desktop and mobile devices.
- Use WeTongbu-managed synchronization storage. You do not need to create a bucket, configure an object-storage provider, or enter access keys.
- Review deletions, pause unusually large changes, and create conflict copies instead of silently overwriting local content.
- Choose the synchronization scope, enable manual or automatic synchronization, and optionally protect Vault content with end-to-end encryption.
- Works on Obsidian desktop, iOS, and Android.

## Getting started

1. Install and enable the plugin.
2. Sign in to your WeTongbu account and authorize this Obsidian installation in the browser.
3. Select the Vault and enable multi-device synchronization when it is available for your account.
4. In the WeTongbu browser extension, explicitly select a supported article, document, web page, or AI conversation and choose **Clip to Obsidian**.
5. Keep Obsidian open while the plugin receives the task. You can run synchronization manually or configure an automatic interval.

Local clipping and local attachments remain available in the current Vault without configuring third-party object storage. Account authorization is required for account-based Vault synchronization and other account features.

Guides, support, and privacy policy:

- https://wetongbu.com/docs/quick-start/
- https://wetongbu.com/support/report/
- https://wetongbu.com/privacy/

## Network, accounts, and privacy

The plugin processes content that you explicitly choose to clip, together with the task and Vault metadata required to deliver and synchronize it. It does not read browser history, display advertising, profile users, or include client-side telemetry.

The plugin communicates with `api.wetongbu.com` for account authorization, Vault registration, account capabilities, clipping tasks, and synchronization. Temporary task objects and service-issued media URLs may be used during delivery. Completed task objects are cleaned up by the service; the resulting Markdown notes and local attachments remain in your Vault.

Long-lived storage access keys are not required or provided to the plugin. Plugin credentials and optional encryption passphrases are stored in Obsidian SecretStorage. When end-to-end encryption is enabled, the encryption passphrase remains on your devices and the service does not receive the plaintext Vault content.

The plugin writes clipping and synchronization results only inside the current Vault. It does not silently overwrite files when it detects a real content conflict. Deletions and unusually large changes can be reviewed before they are applied.

## Support

Use the private form at https://wetongbu.com/support/report/ for account, billing, synchronization, or private-content context. Use GitHub Issues only for reproducible public bugs. Do not send access keys, secret keys, verification codes, recovery codes, cookies, device tokens, note contents, or complete signed URLs.

## 中文说明

微同步将用户主动选择的微信文章、飞书文档、网页和 AI 对话保存到当前 Obsidian Vault，生成可编辑的 Markdown 笔记，并把图片和附件保存到本地 Vault。

## 功能

- 从微同步浏览器扩展将用户主动选择的内容剪藏到当前 Obsidian Vault。
- Markdown 笔记、图片和附件最终保存在本地 Vault。
- 保留用户编辑内容；同一来源重复投递时，尽量复用已有笔记，避免生成重复笔记。
- 登录并授权当前 Vault 后，可在电脑和手机之间同步 Vault 内容。
- 使用微同步托管的同步服务，不需要用户创建 Bucket、配置对象存储服务商或填写访问密钥。
- 发现删除或大批量变更时提供审核和保护；真实内容冲突会生成冲突副本，不会静默覆盖本地内容。
- 可选择同步范围，支持手动同步和自动同步，并可选启用端到端加密保护 Vault 内容。
- 支持 Obsidian 桌面端、iOS 和 Android。

## 开始使用

1. 安装并启用插件。
2. 登录微同步账号，在浏览器中授权当前 Obsidian 安装。
3. 选择要连接的 Vault；如果账号已开放多端同步，可开启 Vault 多端同步。
4. 在微同步浏览器扩展中主动选择文章、文档、网页或 AI 对话，然后点击 **剪藏到 Obsidian**。
5. 保持 Obsidian 打开以接收任务。你可以手动执行同步，也可以设置自动同步间隔。

本地剪藏和本地附件不需要配置第三方对象存储。账号授权用于账号管理、Vault 多端同步及其他需要账号的功能。

快速开始、反馈和隐私政策：

- https://wetongbu.com/docs/quick-start/
- https://wetongbu.com/support/report/
- https://wetongbu.com/privacy/

## 网络、账号与隐私

插件只处理你主动选择剪藏的内容，以及完成投递和同步所需的任务、账号和 Vault 元数据。插件不会读取浏览器历史记录，不展示广告，不进行用户画像，也不包含客户端遥测。

插件通过 `api.wetongbu.com` 完成账号授权、Vault 连接、账号能力查询、剪藏任务和 Vault 同步。投递过程中可能使用临时任务对象和服务端签发的媒体链接；任务完成后，服务端会清理临时任务对象，生成的 Markdown 笔记和本地附件保留在你的 Vault 中。

插件不要求用户配置或提供长期对象存储访问密钥。插件凭证和可选的加密密码保存在 Obsidian SecretStorage 中。启用端到端加密后，加密密码只保留在你的设备上，服务端无法获得 Vault 明文内容。

插件只会在当前 Vault 内写入剪藏和同步结果。检测到真实内容冲突时不会静默覆盖文件；删除操作和大批量变更可以在执行前审核。

## 支持

账号、付费、同步或私人内容问题请使用私密反馈表单：https://wetongbu.com/support/report/。只有可公开复现的问题才建议提交 GitHub Issue。请勿发送访问密钥、密钥密码、验证码、恢复码、Cookie、设备令牌、笔记内容或完整的签名 URL。
