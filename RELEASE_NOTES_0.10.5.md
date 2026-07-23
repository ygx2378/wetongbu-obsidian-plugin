# 微同步 0.10.5

## 修复手机端 Pro 登录

- 修复 iOS/Android 端将官方 `app.wetongbu.com/device` 授权页误判为“不受信任”的问题。
- 授权页只接受官方主机和 `/device`、`/browser-device` 路径，保持其他网络请求的安全校验不变。
