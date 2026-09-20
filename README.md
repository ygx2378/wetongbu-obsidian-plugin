# WeTongbu

WeTongbu receives user-selected web pages, Feishu documents, WeChat articles, and AI conversations in the current Obsidian Vault as editable Markdown notes with local attachments. Vault multi-device sync is an optional capability.

## Features

- Receives clipping tasks and quickly opens the saved Markdown note in the current Vault.
- Downloads local images after the note is written and keeps the original URL when an individual image fails.
- Free users can use a six-digit binding code to connect the Chrome extension without signing in.
- Pro users authorize the plugin in a browser and can choose local image downloads or stable hosted image links.
- New Free accounts do not configure object storage. Eligible signed-in accounts use WeTongbu-hosted storage for Vault sync; local clipping remains available without an account.
- Temporary task objects are deleted by the service after completion, failure, or expiry. Markdown and attachments remain in the Vault.
- Mobile-compatible: the plugin runs on Obsidian desktop, iOS, and Android. The Vault sync MVP supports Markdown and attachments across devices; install the same plugin version on each device and follow the sync setup guide.

## Getting started

1. Install and enable the plugin.
2. Sign in if you want account-based Vault sync; eligible Plus accounts use WeTongbu-hosted storage.
3. Free users can clip locally without configuring object storage or signing in.
4. Free users can also create a six-digit binding code and enter it in the Chrome extension. This path does not require an account login.
5. Signed-in users select **Sign in to Pro**, then complete the browser authorization for this Obsidian installation.
6. In Chrome, explicitly select a supported document, article, or AI conversation and choose **Clip to Obsidian**. Keep Obsidian open until the note opens.

Guides, support, and privacy policy:

- https://wetongbu.com/docs/quick-start/
- https://wetongbu.com/support/report/
- https://wetongbu.com/privacy/

## Network, accounts, and privacy

The plugin only processes content that the user explicitly chooses to clip, plus task metadata and temporary objects required to complete that clip. It does not read browser history, show advertising, profile users, or include client-side telemetry. Long-lived object-storage keys are never provided to the browser extension. Plugin credentials and optional encryption passphrases are stored in Obsidian SecretStorage.

The plugin calls `api.wetongbu.com` to create or recover a Vault, obtain account capabilities and tasks, complete browser-based account authorization, and request deletion of temporary task objects. Task packages and optional hosted images may be transferred through service-issued temporary object-storage or media URLs. The legacy WeChat callback domain is not called by the plugin.

The plugin writes clipping output only inside the current Vault. If a task write fails, it moves newly-created files to the Obsidian trash. The optional hosted-image migration reads Markdown notes only under the plugin's configured root folder. Pro requires a WeTongbu account and a valid trial or subscription. See the privacy policy above for server-side data handling.

## Development

```bash
npm install
npm run check
npm run build
```

Keep root `main.js`, `manifest.json`, and `versions.json` aligned for BRAT and Community Plugins updates. Attach `main.js` and `manifest.json` from the same version to each GitHub Release.

## 中文说明

微同步把用户主动选择的网页、飞书文档、微信文章和 AI 对话剪藏到当前 Obsidian Vault，并生成可编辑的 Markdown 与本地附件。Vault 多端同步是可选能力。

- Free 用户不登录也可本地剪藏，或通过六位绑定码连接 Chrome 扩展；新账号无需配置对象存储。
- 符合条件的登录账号在浏览器中明确授权插件，使用微同步托管存储进行 Vault 同步，并可选图片下载到本地或保存为稳定链接。
- 对象存储只承担临时任务中转；任务完成、失败或过期后由服务端清理，最终 Markdown 和附件保留在 Vault。
- 插件只处理用户主动剪藏的内容。网络请求、账号、付费能力和数据处理说明见上方英文说明与隐私政策。

## Support

Use the private form at https://wetongbu.com/support/report/ for account, billing, storage, or private-content context. Use GitHub Issues only for reproducible public bugs. See [SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md). Do not send access keys, secret keys, verification codes, recovery codes, cookies, device tokens, note contents, or complete signed URLs.
