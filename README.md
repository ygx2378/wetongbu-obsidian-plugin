# WeTongbu for Obsidian

![WeTongbu logo](icon.png)

微同步把你主动选择的微信文章、飞书文档和文章型网页同步到 Obsidian Vault，并保存为本地 Markdown 和附件。

## 功能

- 在 Obsidian 中自动轮询微同步任务，并把 Markdown、图片和附件保存到当前 Vault。
- 不登录也可通过一次性 6 位绑定码连接 Chrome 扩展，使用 Free 自有对象存储。
- 登录后可使用 Pro 托管版；Pro 可以选择把图片下载到本地，或保存在微同步云端并以稳定链接写入笔记。
- Free 使用自己的 Cloudflare R2、Amazon S3、阿里云 OSS 或腾讯云 COS；Pro 使用微同步托管对象存储。
- 对象存储只作为临时任务信箱，任务完成、失败或过期后由服务端清理；最终文件保存在本地 Vault。
- 支持桌面端 Obsidian；插件声明 `isDesktopOnly: true`，因为需要本地二进制附件写入和对象存储 SDK。

## 开始使用

1. 安装并启用插件。
2. 选择 Free 自有对象存储，或登录使用 Pro 托管版。
3. Free 用户按官网教程创建私有 Bucket 和最小权限密钥，再点击“测试并保存”。
4. Free 用户点击“生成绑定码”，在 Chrome 扩展中输入 6 位绑定码；这条流程不要求登录。
5. Pro 用户在插件中点击“登录 Pro 账号”，在浏览器完成登录并明确授权此设备。
6. 在浏览器中主动点击“同步到 Obsidian”，保持 Obsidian 打开等待任务完成。

官网、详细教程、隐私政策和支持入口：

- https://wetongbu.com/docs/quick-start/
- https://wetongbu.com/privacy/
- https://wetongbu.com/support/

## 隐私与权限

插件只处理用户主动选择同步的内容，以及完成任务所需的任务状态和临时对象。不会读取浏览器历史，不会用于广告、画像或客户端遥测，也不会把对象存储长期密钥交给浏览器扩展。Free 密钥使用 Obsidian SecretStorage 保存，并由服务端以加密字段保存用于任务处理。

插件通过 `api.wetongbu.com` 创建或恢复 Vault、验证 Free 对象存储、获取同步任务、完成网页登录授权，并通知服务端清理远端任务对象。任务包和 Pro 云端图片可能经由服务端签发的临时对象存储或媒体地址传输；旧微信回调域名 `wx.wetongbu.com` 不由插件直接调用。插件会校验任务包哈希、文件大小和安全路径。

插件只在当前 Vault 内写入同步产生的 Markdown 和附件。若一次写入失败，它会将本次新建附件移入 Obsidian 回收站；不会访问 Vault 外的文件。Pro 托管版需要微同步账号和付费订阅才能使用完整功能，具体数据处理说明见 [隐私政策](https://wetongbu.com/privacy/)。

## 本地开发

```bash
npm install
npm run check
npm run build
```

`manifest.json`、`main.js` 和可选的 `styles.css` 应作为同版本 GitHub Release 附件提供。默认分支不提交构建生成的 `main.js`。

## 支持

请通过 https://wetongbu.com/support/ 反馈问题。不要在反馈中发送 Access Key、Secret Key、验证码、恢复码或完整预签名链接。
