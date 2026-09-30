# PersonalHub

PersonalHub 是只在当前 Windows 电脑上使用的工作与生活管理工具。它不需要账号、互联网、云数据库或部署；浏览器只负责显示页面，正式数据保存在电脑上的独立 SQLite 文件中。

## 直接使用打包版

1. 打开 `dist\PersonalHub` 文件夹。
2. 双击 `PersonalHub.exe`。程序会启动本地服务并自动打开默认浏览器。
3. 使用期间保留 PersonalHub 的命令窗口；关闭该窗口即可停止程序。再次启动不会丢失数据。
4. 若程序已经运行，再次双击会打开已有页面，不会启动第二份数据服务。

程序只监听 `127.0.0.1`，同一网络中的其他电脑无法访问。

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

打包后独立运行验收：

```powershell
.\scripts\smoke-package.cmd
```
