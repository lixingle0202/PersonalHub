# PersonalHub

PersonalHub 是只在当前 Windows 电脑上使用的工作与生活管理工具。它不需要账号、互联网、云数据库或部署；浏览器只负责显示页面，正式数据保存在电脑上的独立 SQLite 文件中。

## 直接使用打包版

1. 打开 `dist\PersonalHub` 文件夹。
2. 双击 `PersonalHub.exe`。程序会启动本地服务并自动打开默认浏览器。
3. 使用期间保留 PersonalHub 的命令窗口；关闭该窗口即可停止程序。再次启动不会丢失数据。
4. 若程序已经运行，再次双击会打开已有页面，不会启动第二份数据服务。

程序只监听 `127.0.0.1`，同一网络中的其他电脑无法访问。

## 使用本地大模型生成学习计划

1. 安装并启动 [Ollama Windows 版](https://ollama.com/download/windows)，在 Ollama 中下载一个支持 JSON 输出的本地模型。首次下载需要联网；模型下载后可在本机使用。
2. 打开“数据与设置 → 本地大模型”，使用默认地址 `http://127.0.0.1:11434`，点击“检查连接并刷新模型”，选择已安装的模型并保存。
3. 打开“学习计划 → AI 生成学习计划”，填写主题、目标、目前基础、开始日期、天数和每天可用时间。
4. 生成后先查看草稿，可以修改名称、章节、任务内容、日期和时长，或移除任务。点击“确认加入学习计划”后才创建正式目标、章节和任务，并同步到首页和今日计划。

支持 1—30 天的计划。系统校验每天总时长、任务日期和章节引用；错误输出、连接失败或超时不会创建正式计划，重复确认同一草稿不会重复导入。已生成草稿保存在数据库中，当前浏览器会话刷新后可继续确认；关闭窗口再打开会保留当前页面中尚未提交的编辑。取消等待不会导入正式计划。

模型只收到生成窗口填写的需求，不会自动读取其他笔记。此功能可选，其他功能不依赖 Ollama。程序不会自动安装 Ollama 或下载模型。

## 数据、备份和恢复

- 正式数据库：`%LOCALAPPDATA%\PersonalHub\data\personal_data.db`
- 备份目录：`%LOCALAPPDATA%\PersonalHub\backups`
- 运行日志：`%LOCALAPPDATA%\PersonalHub\logs\personalhub.log`
- 可以在“数据与设置”页面立即备份、恢复备份、恢复回收站内容或永久删除。
- 恢复备份前，程序会自动备份当前数据库；损坏的备份不会替换当前数据。

迁移电脑时，先停止 PersonalHub，再复制整个 `%LOCALAPPDATA%\PersonalHub` 文件夹。不要在程序运行时手动改动数据库文件。

## 从源码启动

首次准备：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
cd frontend
pnpm install
cd ..
```

构建一次前端后，可双击项目根目录的 `Start-PersonalHub.cmd`：

```powershell
cd frontend
pnpm build
```

## 测试与打包

后端和验收测试：

```powershell
.\.venv\Scripts\python.exe -m pytest tests backend\tests -q
```

前端测试：

```powershell
cd frontend
pnpm test -- --run
```

生成 Windows 可执行版：

```powershell
.\scripts\build.cmd
```

产物位于 `dist\PersonalHub\PersonalHub.exe`。打包目录中的其余文件是程序运行所需内容，不要只复制 exe。

学习计划浏览器集成测试（自动启动隔离数据库及模拟 Ollama HTTP 服务，不修改个人数据；不代表真实模型推理）：

```powershell
node scripts/test-ai-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/ai-browser-review
```

将第一个参数换为 `dist/PersonalHub/PersonalHub.exe` 并添加 `--packaged`，可对打包版执行同样的浏览器集成验收。

打包后独立运行验收：

```powershell
.\scripts\smoke-package.cmd
```
