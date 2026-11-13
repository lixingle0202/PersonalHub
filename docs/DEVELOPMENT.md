# 开发与运行说明

本文包含源码启动、AI 配置、测试和打包说明。产品功能概览见 [项目首页](../README.md)。

开发依赖安装后，执行 `.\scripts\setup-dev-hooks.ps1` 启用提交前 Ruff、Prettier 与空白检查；安装方法、修正后重新暂存及 GitHub 检查说明见[自动格式化指南](code-style.md)。

## 完整本机版：登录与内置 AI

分发 `PersonalHub.zip`，使用者完整解压后双击 `PersonalHub/PersonalHub.exe`，首次在登录页创建本机账号。包内包含 Ollama CPU 运行环境及 `qwen2.5:1.5b` 模型，学习与饮食 AI 均可离线使用，无需另装 Python、Node.js、Ollama 或下载模型。

数据位于 `%LOCALAPPDATA%\PersonalHubDesktop`，每个账号使用独立数据库。它与旧免登录版、共享网页版的数据分开；不同电脑的账号与数据不会自动同步。关闭程序会一并关闭它启动的模型服务，不修改用户原先安装的 Ollama。

“数据与设置 → 大模型”支持在内置模型和其他已下载的本机 Ollama 模型之间切换；学习与饮食生成共用当前账号的选择，重启后保留。饮食库包含 2213 条食物数据及 250 道参考配方，支持多菜品、份数、克数和搜索补全。

源码验收入口为 `Start-PersonalHub-Full.cmd`。构建完整包运行 `scripts/Build-FullPackage.ps1`；构建脚本会校验模型文件摘要并保留第三方许可，产物不包含个人数据库。完整使用说明见 [FullDesktopGuide.txt](FullDesktopGuide.txt)。

最新完整发布为 v0.1.2，最终 ZIP、真实 exe、浏览器、AI 和旧版升级的验收记录见 [v0.1.2 软件包验收](releases/v0.1.2.md)。维护者可用手动 GitHub Actions 工作流 `Assemble verified desktop release asset` 校验并合并草稿 Release 的分段附件；工作流不会直接公开发布，完整附件核对后再设为 Latest。

## 更新到最新 main

1. 在当前版本创建数据备份，关闭 PersonalHub 程序窗口及本项目正在运行的共享网站后端。保留 `%LOCALAPPDATA%\PersonalHubDesktop` 和 `.public-hub-data`，不要用演示数据库覆盖。
2. 确认本地修改已提交或另行保存，再运行 `git switch main`、`git pull --ff-only origin main`。
3. 在 `frontend` 目录运行 `pnpm install --frozen-lockfile`、`pnpm build`，回到项目根目录。使用项目虚拟环境按 `requirements.txt` 安装依赖。
4. 共享网页版运行 `scripts/Start-PublicHub.ps1`；仅本机使用可加 `-LocalOnly`。若旧后端仍在运行，脚本会复用它，必须先关闭旧后端。分享隧道地址可能变化，以脚本实际返回且通过健康检查的地址为准。
5. 完整本机版运行 `scripts/Build-FullPackage.ps1`，将输出目录中的整个 `PersonalHub` 文件夹压缩为 `PersonalHub.zip`，包含 `PersonalHub.exe`、`_internal`、`ai`、许可和使用说明。不要将账号数据库、个人备份或 `.env` 放入分发包。
6. 启动新版 exe，确认登录、内置模型与顶部“搜索或提问”可用，再用 Ctrl+F5 刷新原浏览器页面。同一数据目录的单实例机制会复用正在运行的程序，因此要先关闭旧版。

v0.1.2 加入[学习趋势](learning-trends.md)和[饮食 AI 任务及草稿恢复](diet-ai-recovery.md)，保留 v0.1.1 的自然语言搜索与计划对照。接口与前端须一同更新；本次无需新建账号或迁移数据库结构。旧版发布附件保留在对应 GitHub Release，升级前仍应创建备份。

## 使用原免登录打包版

1. 打开 `dist\PersonalHub` 文件夹。
2. 双击 `PersonalHub.exe`。程序会启动本地服务并自动打开默认浏览器。
3. 使用期间保留 PersonalHub 的命令窗口；关闭该窗口即可停止程序。再次启动不会丢失数据。
4. 若程序已经运行，再次双击会打开已有页面，不会启动第二份数据服务。

程序只监听 `127.0.0.1`，同一网络中的其他电脑无法访问。

## 使用本地大模型生成学习计划

学习计划页会在打开时检查本计划是否连续三个自然日没有完成学习任务。若有已到期且未完成的任务，第四天自动将该计划所有未完成且排定日期的任务等距顺延，让最早一项落在当天；已完成任务不变。页面显示可确认的站内提醒，重新打开后仍可查看未确认的提醒。未打开学习计划页时不会推送系统通知；首页与今日计划会在顺延后显示更新的日期。

1. 安装并启动 [Ollama Windows 版](https://ollama.com/download/windows)，在 Ollama 中下载一个支持 JSON 输出的本地模型。首次下载需要联网；模型下载后可在本机使用。
2. 打开“数据与设置 → 本地大模型”，使用默认地址 `http://127.0.0.1:11434`，点击“检查连接并刷新模型”，选择已安装的模型并保存。
3. 打开“学习计划 → AI 生成学习计划”，填写主题、目标、目前基础、开始日期、天数和每天可用时间。
4. 生成后先查看草稿，可以修改名称、章节、任务内容、日期和时长，或移除任务。点击“确认加入学习计划”后才创建正式目标、章节和任务，并同步到首页和今日计划。

支持 1—30 天的计划。系统校验每天总时长、任务日期和章节引用；错误输出、连接失败或超时不会创建正式计划，重复确认同一草稿不会重复导入。已生成草稿保存在数据库中，当前浏览器会话刷新后可继续确认；关闭窗口再打开会保留当前页面中尚未提交的编辑。取消等待不会导入正式计划。

模型只收到生成窗口填写的需求，不会自动读取其他笔记。此功能可选，其他功能不依赖 Ollama。程序不会自动安装 Ollama 或下载模型。

导入后的学习任务直接显示 AI 生成的具体步骤和预计分钟，点击任务可继续修改说明。学习目标内的番茄钟可关联任务；点击“开始专注”和“结束专注”后，服务端记录实际时长并统计当天专注时间。网页刷新后仍能恢复正在计时的专注，跨午夜的时间按浏览器所在日期拆分。

## 首页日常记录与今日计划

首页不再显示逾期和未来三天到期的黄色提醒。“今日计划”中手动新增的事项可直接编辑内容、日期、分组、优先级和备注，已完成事项也能修改；删除前需要确认，删除后可到“数据与设置 → 回收站”恢复。学习、饮食同步的事项保留“编辑来源计划”入口。

首页“日常记录”支持输入口语文字，例如“上午学了英语一小时，中午吃了牛肉面，下午跑步30分钟，晚上去超市买了牛奶”，点击“整理并记录”后按活动分条保存并归类。系统保留原话、数量和原始描述，明确的“明天打算”或“还没做”表述会单独提示；复杂表述可在保存后逐条修改内容、分类与日期。整理不依赖Ollama。记录按当前选择的日期保存，默认只显示当天；可选日期或点击“前一天”回看、补记历史，点击“回到今天”返回当天。不同日期的未提交文字分别保留在当前页面中，保存失败时可重试，同次请求不会重复创建条目。

日常记录保存在当前账号的数据库，刷新或重启后仍可查看，并纳入数据库备份；记录的事情不会自动勾选计划或另建饮食安排。单条可删除并从回收站恢复。数据库升级增加记录表，保留已有计划、饮食及其他数据。

日常记录能识别“上安卓课”“上了两节课”“听网课”“做实验”“写实验报告”和“实训”等学习活动，也能区分“下课后跑步”的运动、“买英语教材”的购物及“给学生授课”的工作；课程名称、原话和数量会保留。明确表示没有做或准备以后做的上课事项仍单独提示，不计入已做记录。

## 饮食热量、AI 菜谱和周期模板

饮食页顶部可保存身高和体重。热量按食物和用餐份数估算，同样食物和份量在早、午、晚餐及加餐中使用同一计算依据。优先采用手动填写的整餐 kcal；否则汇总菜品设置的每份 kcal，或按食材用量计算配方总热量、除以“以上食材可做几份”，再乘本餐用餐份数。可记录半份或双份；购物清单也按实际份数换算食材。身高体重不参与餐食热量计算。

自填餐食支持常见食物和明确用量，例如“米饭200克+鸡蛋1个”；未填写用量时会显示所采用的参考份量。信息不足时显示“热量待补充”，不再按餐次给出固定数值，也不会把已知菜品的部分热量当作整餐总量。点击餐食可查看估算依据，补充食材、份数，或使用包装上的热量手动校正。食材参考沿用[USDA FoodData Central](https://fdc.nal.usda.gov/)的每100克口径。“红豆小丸子”使用明确标注的示例配方：红豆糖水200克（[香港食物安全中心研究](https://www.cfs.gov.hk/english/programme/programme_rafs/programme_rafs_n_01_21_abstract.html)，66 kcal/100克）加无馅小汤圆50克包装重量（[卫生福利部营养标签参考表](https://mohw.gov.tw/dl-15745-93035175-b28d-40f9-b5eb-adb7a43c4c99.html)，258 kcal/100克），约261 kcal/份。这是参考配方；实际配方、加糖量、油量和品牌不同，应修改用量或按包装校正。

“饮食模板”包含减脂餐、备考周和养胃清淡示例。可复制后修改，也可手动填写循环天数及每餐菜名、估算 kcal。选择开始日期和导入天数后，一键循环加入日历；同日同餐次已有安排会跳过，不覆盖原记录。“AI 生成菜谱 / 模板”默认生成一日三餐，也可生成最多七天；先预览并编辑草稿，再保存为模板或导入日历。网页多人版沿用数据与设置中的共享或访客本机模型选择。AI 菜谱与热量均需核对食材、份量和过敏情况；“养胃”示例不用于治疗疾病。

### 本地 AI 启动说明

- **完整软件包**：完整解压后双击 `PersonalHub/PersonalHub.exe`，程序会自动启动网页和内置模型。
- **源码运行**：按“从源码启动”准备环境，并准备好本地 Ollama 与模型后，运行 `Start-PersonalHub-With-AI.cmd`；仅启动模型服务可运行 `Start-LocalAI.cmd`。
- **切换模型**：进入“数据与设置 → 大模型”，选择内置模型，或刷新并选择其他已下载的本机模型，再保存切换。

## 微信小程序开发

小程序与网页源码现已同时保存在 main；开发者工具应导入 `personalhub-miniprogram`，不要导入仓库根目录。个人业务访问现有后端；好友监督群通过独立的微信云函数访问云数据库。

完整启动、提醒与云函数配置见[小程序说明](../personalhub-miniprogram/README.md)和[部署说明](../DEPLOY.md)。本机代理、提醒服务位于 `_tools/`，不随小程序前端上传；私有凭据及提醒运行数据存放在被 Git 忽略的 `_tmpapi/`。

离线检查运行 `node --test scripts/test-miniprogram.mjs`；它覆盖工程入口、相对依赖、WXML 事件、群成员权限和提醒接口隔离。云开发真机、消息投递和多设备同步需在自己的 AppID、环境和测试账号下验收，不把离线检查视为真机测试。

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

生成 Windows 可执行版：在文件管理器中打开项目的 `scripts` 文件夹，双击 `build.cmd`。也可以先在 PowerShell 中切换到项目根目录（包含 `scripts` 文件夹的目录），再执行：

```powershell
.\scripts\build.cmd
```

产物位于 `dist\PersonalHub\PersonalHub.exe`。打包目录中的其余文件是程序运行所需内容，不要只复制 exe。

学习计划浏览器集成测试（自动启动隔离数据库及模拟 Ollama HTTP 服务，不修改个人数据；不代表真实模型推理）：

```powershell
node scripts/test-ai-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/ai-browser-review
```

将第一个参数换为 `dist/PersonalHub/PersonalHub.exe` 并添加 `--packaged`，可对打包版执行同样的浏览器集成验收。

访客本机模型浏览器验收（独立的公开账号数据库、模拟访客本机 Ollama，真实 Chromium 验证切换、跨源请求、草稿校验和导入）：

```powershell
node scripts/test-visitor-model-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/visitor-model-browser-review
```

视觉与交互浏览器验收（使用独立数据库，涵盖五个页面、明暗模式、键盘操作、窄屏布局、减少动态效果/透明度和玻璃材质回退）：

```powershell
node scripts/test-visual-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/visual-review
```

报告及各页面截图保存在指定目录；打包版同样支持 `--packaged`。

饮食删除浏览器回归测试（独立数据库，验证小窗口确认按钮可点击、取消保留草稿、失败重试、防止重复删除，以及首页、今日计划、搜索和日历同步）：

```powershell
node scripts/test-diet-delete-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/diet-delete-review
```

打包版同样将第一个参数换为程序路径并追加 `--packaged`；每次运行使用新的测试目录。

学习计划逐项编辑与删除浏览器回归测试（独立数据库，验证目标及任务编辑、取消、失败重试、防重复删除、小窗口确认与跨模块同步）：

```powershell
node scripts/test-learning-delete-browser.mjs .venv/Scripts/python.exe <playwright模块路径> .test-runtime/learning-delete-review
```

打包版同样支持程序路径和 `--packaged`，每次运行使用新的测试目录。

已安装本机模型时，可执行真实推理验收，测试使用隔离数据库：

```powershell
node scripts/test-local-ai.mjs <playwright模块路径> .test-runtime/local-ai-review
```

该测试验证 D 盘模型存储、重复启动复用服务、实际生成 2 天和 7 天学习计划、编辑确认与首页同步，不创建个人数据库中的测试目标。

打包后独立运行验收：

```powershell
.\scripts\smoke-package.cmd
```
