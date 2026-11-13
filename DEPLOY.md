# PersonalHub 网页与微信小程序部署

## 仓库结构

- `frontend/`：React 网页；`backend/`：FastAPI 个人业务后端。
- `personalhub-miniprogram/`：完整小程序工程，包括好友监督群页面及 `cloudfunctions/phgroup`。
- `_tools/`：本机代理、提醒服务和调试脚本，不上传到小程序前端。

## 网页与个人业务启动

完整 Windows 包在 [Releases](https://github.com/lixingle0202/PersonalHub/releases/latest) 下载 `PersonalHub.zip`，完整解压后运行 `PersonalHub/PersonalHub.exe`。源码运行、AI 与构建方法见[开发说明](docs/DEVELOPMENT.md)。个人账号、数据库与模型不得提交到 Git。

## 小程序导入

1. 微信开发者工具导入仓库中的 `personalhub-miniprogram` 文件夹。
2. 使用自己有权限的 AppID；手机端完整功能需配置对应云开发环境。
3. 在 `config.js` 或“小程序 → 数据与设置 → 服务地址”配置个人业务后端。本机模拟器默认 `http://127.0.0.1:8771。

个人业务使用同一后端和同一账号后共享数据，一端保存后另一端刷新读取。监督群数据在微信云开发中独立保存，不会自动修改网页个人计划。

## 本机代理与每日任务提醒

先启动完整后端（默认 8770），再在仓库根目录运行：

```powershell
node _tools/wechat-notifier.js
```

该服务监听 `127.0.0.1:8771`，普通请求转发到后端，微信提醒接口由伴生服务处理。需要其他后端地址时设置 `TARGET`；配置目录可通过 `PERSONAL_HUB_WECHAT_DATA_DIR` 指定。

```powershell
New-Item -ItemType Directory -Force _tmpapi
Copy-Item docs/examples/wechat_conf.example.json _tmpapi/wechat_conf.json
```

填写自己的 `appid`、`secret`、`tmpl_id` 后重启提醒服务，在小程序点击“开启提醒”并授权。真实配置、会话、额度和去重状态均保存在被 Git 忽略的 `_tmpapi/`，不得上传或分享。服务会创建首次运行所需目录。

仅需普通代理时运行 `$env:TARGET='http://127.0.0.1:8770'; node _tools/proxy.js`，监听 8786。代理会转发登录 Cookie 和写令牌；不要把仅供调试的入口当作公网安全网关。

任务提醒需后端和提醒服务持续运行。一次性订阅受用户授权、可用额度与平台规则限制，不代表永久自动推送。扩展提醒偏好保存在小程序本机；当前提醒服务未实现 `/wx/reminders`，其开关不代表喝水、结束今日等通知已启用。

## 好友监督群云开发

1. 开通当前 AppID 的微信云开发环境，必要时在 `config.js` 配置 `cloudEnv`。
2. 在开发者工具中右键 `personalhub-miniprogram/cloudfunctions/phgroup`，选择“上传并部署 云端安装依赖”。
3. 群组页首次使用会调用云函数创建四个集合；数据库和云存储保持最小权限，不向客户端开放任意读写。
4. 需要催办微信通知时，在云函数 `SUBSCRIBE` 中填写自己的模板 ID 和字段映射后重新部署。模板留空时群内催办仍可使用，但不发送服务通知。

支持建群、邀请码加入、群主修改资料、发布并勾选自己的计划、近七天看板、复用昨天和成员催办。

## 检查与发布

```powershell
node --test scripts/test-miniprogram.mjs
```

离线检查覆盖工程依赖、JS 与 JSON、WXML 事件绑定、监督群身份边界及提醒接口隔离。网页和后端测试命令见[开发说明](docs/DEVELOPMENT.md)。提交前运行格式检查，发布前使用独立账号检查手机端登录、数据刷新、群内交互及真实通知。
