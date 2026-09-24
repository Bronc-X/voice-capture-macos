# Apple Silicon 构建与验收

## 可复现构建

在 Apple Silicon、macOS 14+、Node 24 环境中：

```sh
npm ci
npm test
npm run dist:mac
VOICE_CAPTURE_EXECUTABLE="$PWD/dist/mac-arm64/Voice Capture.app/Contents/MacOS/Voice Capture" npm run test:desktop
```

输出：`dist/Voice-Capture-1.0.0-macOS-arm64.dmg` 和 `.zip`。版本依赖由 `package-lock.json` 固定。安装包只包含应用白名单文件及 Electron 运行时，不包含工作目录中的录音、播客母库、测试数据、Python 工具或凭据。

GitHub 工作流 `.github/workflows/macos.yml` 在 `main` 推送后执行，也可手动运行。测试通过才上传安装包 Artifact。常规构建使用 ad-hoc 签名且关闭 hardened runtime；它没有 Developer ID 身份或 Apple 公证。Apple Silicon 的运行签名与互联网下载的 Gatekeeper 信任检查是两个不同的检查。

## Developer ID 签名与公证

在仓库 Settings → Secrets and variables → Actions 中配置以下 Secrets，不要写入源码或聊天：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | 含私钥的 Developer ID Application `.p12` 证书的 Base64 内容 |
| `CSC_KEY_PASSWORD` | `.p12` 的密码 |
| `APPLE_ID` | Apple Developer 账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该账号的 App 专用密码 |
| `APPLE_TEAM_ID` | 开发团队 ID |

手动运行 Actions，勾选 `signed`。构建会启用 hardened runtime、Developer ID 签名与公证，并检查 stapled ticket 和 Gatekeeper 评估。如果缺少 Secrets，会明确失败，不会偷偷生成未公证版。仅在成功后用该包替换交付附件，并明确更新 Release 中的签名状态。

本地签名构建使用同名环境变量并设置 `MAC_SIGNED=1`。不要把密码直接写入 shell 历史。

## 验收边界

自动化验证以下内容：

- 真正的 arm64 可执行文件、有效 bundle、麦克风用途声明、代码签名结构。
- DMG 可挂载、复制到独立目录后可启动；测试时 PATH 为空。
- 离线界面、模拟麦克风接入、录音与复听、单段保存、18 段合并 WAV 和对应 JSON。
- 48 kHz / 16-bit / mono 文件头、非空音频、0.75 秒段间静音及时间轴对齐。
- 原生文件保存后才提示成功，取消/失败可重试，关闭录音窗口先提示确认。
- 只有显式启用签名的工作流才要求通过 Apple 公证与 Gatekeeper 评估。

人工验收仍需在目标 Mac 上完成：从浏览器下载后的首次打开、真实系统权限弹窗、真实大疆设备输入、耳机复听底噪/混响/喷麦。CI 模拟设备不构成这些行为的验证证据。

## 参考

- [Electron Builder macOS 配置](https://www.electron.build/docs/mac/)
- [GitHub 托管 Mac 构建机](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Apple 安全打开 Mac 应用](https://support.apple.com/102445)
