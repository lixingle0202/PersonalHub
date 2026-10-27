# PersonalHub

PersonalHub 是只在当前 Windows 电脑上使用的工作与生活管理工具。它不需要账号、互联网、云数据库或部署；浏览器只负责显示页面，正式数据保存在电脑上的独立 SQLite 文件中。

## 直接使用打包版

1. 打开 `dist\PersonalHub` 文件夹。
2. 双击 `PersonalHub.exe`。程序会启动本地服务并自动打开默认浏览器。
3. 使用期间保留 PersonalHub 的命令窗口；关闭该窗口即可停止程序。再次启动不会丢失数据。
4. 若程序已经运行，再次双击会打开已有页面，不会启动第二份数据服务。

程序只监听 `127.0.0.1`，同一网络中的其他电脑无法访问。

## 分享独立的多人网页

本机版继续使用自己的数据库和 `127.0.0.1:8765`。多人版使用另一个本机服务 `127.0.0.1:8766`，每位访客注册账号后拥有独立的学习、饮食、设置和备份数据。默认的共享 AI 生成请求由这台主机上的 `qwen2.5:1.5b` 处理，访客电脑不需要 Ollama。共享模型请求一次只运行一个；占用时网页最多自动等待并重试 10 分钟，可随时取消，等待期间不消耗次数。每个账号每天最多成功生成 12 次，以免轻量模型被并发请求拖慢。

访客也可登录共享网页后，在“数据与设置 → 大模型”切换为“本地大模型”，让浏览器直接访问访客电脑上的 Ollama；不会通过网站主机转发 Ollama 请求。访客需要先安装、启动 Ollama 并下载模型，把网页显示的**准确来源**加入本机 Ollama 的 `OLLAMA_ORIGINS`，重启 Ollama，再允许浏览器提出的本地网络访问请求。服务地址只能填写访客电脑的 `http://127.0.0.1:11434`（或其他本机端口），不可填写公网地址。检查连接、选择已安装模型并保存后，学习计划和饮食计划中的 AI 生成都会使用该模型。切回“共享大模型”即可继续使用主机模型；访客本地模式不消耗共享模型的每日次数。访客本机模型设置保存在该浏览器、该账号的本地存储中，换电脑或浏览器需要重新配置；学习草稿仍按账号保存在网页数据空间。临时隧道网址改变后，访客需要更新 `OLLAMA_ORIGINS` 中允许的来源。[Ollama 来源配置说明](https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama)

先按“从源码启动”准备 Python 环境并构建前端；在主机上启动 Ollama 和 `qwen2.5:1.5b`。从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/)取得 Windows 64 位 `cloudflared.exe`，放到项目下 `.public-runtime/cloudflared.exe`。文件和公开版数据库都保存在本项目的 D 盘目录，已加入 Git 忽略。然后运行：

```powershell
.\scripts\Start-PublicHub.ps1
```

脚本验证模型与 cloudflared 的数字签名，启动独立服务和 HTTPS 隧道，并打印可以分享的网址。访客在该网址注册和登录后使用完整网页。关闭分享时运行 `.\scripts\Stop-PublicHub.ps1`；账号数据仍保存在 `.public-hub-data`。主机必须保持开机、联网并运行 Ollama。

如果**主机自己**也要从上述公网网址选择“本地大模型”，运行 `.\scripts\Configure-HostLocalModel.ps1`。脚本读取当前临时网址，验证运行中的 Ollama 确属本项目，再用仅允许该网址的 `OLLAMA_ORIGINS` 重启它，并检查跨域预检、已安装模型和公网网页。网址改变后重新运行此脚本。浏览器首次访问本地网络时，还需要在浏览器提示中允许该网页；若此前拒绝，可在该网址的站点设置中允许“本地网络访问”后刷新。此设置不会开放 Ollama 的网络监听端口。可重复运行 `.\scripts\Test-PublicLocalModel.ps1 -Origin <当前公网网址>` 验证连接。

当前使用 Cloudflare 临时隧道；重启隧道后网址会改变，也没有长期可用保证。要固定网址，需在自己的 Cloudflare 账号和域名下创建正式隧道，并把它指向 `http://127.0.0.1:8766`。不要把原本的 `8765` 本机服务或 `11434` Ollama 端口公开到互联网。[临时隧道说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 使用本地大模型生成学习计划

学习计划页会在打开时检查本计划是否连续三个自然日没有完成学习任务。若有已到期且未完成的任务，第四天自动将该计划所有未完成且排定日期的任务等距顺延，让最早一项落在当天；已完成任务不变。页面显示可确认的站内提醒，重新打开后仍可查看未确认的提醒。未打开学习计划页时不会推送系统通知；首页与今日计划会在顺延后显示更新的日期。

1. 安装并启动 [Ollama Windows 版](https://ollama.com/download/windows)，在 Ollama 中下载一个支持 JSON 输出的本地模型。首次下载需要联网；模型下载后可在本机使用。
2. 打开“数据与设置 → 本地大模型”，使用默认地址 `http://127.0.0.1:11434`，点击“检查连接并刷新模型”，选择已安装的模型并保存。
3. 打开“学习计划 → AI 生成学习计划”，填写主题、目标、目前基础、开始日期、天数和每天可用时间。
4. 生成后先查看草稿，可以修改名称、章节、任务内容、日期和时长，或移除任务。点击“确认加入学习计划”后才创建正式目标、章节和任务，并同步到首页和今日计划。

支持 1—30 天的计划。系统校验每天总时长、任务日期和章节引用；错误输出、连接失败或超时不会创建正式计划，重复确认同一草稿不会重复导入。已生成草稿保存在数据库中，当前浏览器会话刷新后可继续确认；关闭窗口再打开会保留当前页面中尚未提交的编辑。取消等待不会导入正式计划。

模型只收到生成窗口填写的需求，不会自动读取其他笔记。此功能可选，其他功能不依赖 Ollama。程序不会自动安装 Ollama 或下载模型。

导入后的学习任务直接显示 AI 生成的具体步骤和预计分钟，点击任务可继续修改说明。学习目标内的番茄钟可关联任务；点击“开始专注”和“结束专注”后，服务端记录实际时长并统计当天专注时间。网页刷新后仍能恢复正在计时的专注，跨午夜的时间按浏览器所在日期拆分。

## 饮食热量、AI 菜谱和周期模板

饮食页顶部可保存身高和体重。热量按食物和用餐份数估算，同样食物和份量在早、午、晚餐及加餐中使用同一计算依据。优先采用手动填写的整餐 kcal；否则汇总菜品设置的每份 kcal，或按食材用量计算配方总热量、除以“以上食材可做几份”，再乘本餐用餐份数。可记录半份或双份；购物清单也按实际份数换算食材。身高体重不参与餐食热量计算。

自填餐食支持常见食物和明确用量，例如“米饭200克+鸡蛋1个”；未填写用量时会显示所采用的参考份量。信息不足时显示“热量待补充”，不再按餐次给出固定数值，也不会把已知菜品的部分热量当作整餐总量。点击餐食可查看估算依据，补充食材、份数，或使用包装上的热量手动校正。食材参考沿用[USDA FoodData Central](https://fdc.nal.usda.gov/)的每100克口径。“红豆小丸子”使用明确标注的示例配方：红豆糖水200克（[香港食物安全中心研究](https://www.cfs.gov.hk/english/programme/programme_rafs/programme_rafs_n_01_21_abstract.html)，66 kcal/100克）加无馅小汤圆50克包装重量（[卫生福利部营养标签参考表](https://mohw.gov.tw/dl-15745-93035175-b28d-40f9-b5eb-adb7a43c4c99.html)，258 kcal/100克），约261 kcal/份。这是参考配方；实际配方、加糖量、油量和品牌不同，应修改用量或按包装校正。

“饮食模板”包含减脂餐、备考周和养胃清淡示例。可复制后修改，也可手动填写循环天数及每餐菜名、估算 kcal。选择开始日期和导入天数后，一键循环加入日历；同日同餐次已有安排会跳过，不覆盖原记录。“AI 生成菜谱 / 模板”默认生成一日三餐，也可生成最多七天；先预览并编辑草稿，再保存为模板或导入日历。网页多人版沿用数据与设置中的共享或访客本机模型选择。AI 菜谱与热量均需核对食材、份量和过敏情况；“养胃”示例不用于治疗疾病。

### 本机 D 盘安装与启动

已安装的独立 Ollama 程序位于项目下 `.local-ai/ollama`，模型位于 `.local-ai/models`，下载包、日志和临时目录均位于 `.local-ai`，不放到 C 盘。该目录已加入 Git 忽略，不提交模型大文件。

双击项目根目录 `Start-PersonalHub-With-AI.cmd` 可同时启动模型服务与网页；重启电脑后也使用这个入口。只启动模型服务可双击 `Start-LocalAI.cmd`。重复启动会复用已验证的现有服务，不创建第二个进程。服务只监听 `127.0.0.1:11434`，禁用云端模型功能。

当前轻量模型为 [Qwen2.5 1.5B](https://ollama.com/library/qwen2.5:1.5b)，约 986 MB。网页“本地大模型”设置中使用 `qwen2.5:1.5b`；首次生成会加载模型，建议先从 2—7 天的学习计划开始。

生成时按用户主题、目标、基础和偏好制定任务，每天使用填写的全部学习分钟，说明中包含具体步骤、产出和验收标准。模型分项分钟相加不一致时，按原比例换算到每日预算，保留活动内容。结构化输出限制日期与时长，并检查重复标题、空泛任务、指定工具或图表类型遗漏、缺少成果的说明；首次输出未通过时自动携带具体错误重试一次，仍失败则不创建草稿或正式计划。超过7天的共享/本机服务生成请求按最多7天分段，每段保留原始需求和前段进度，禁止后段复用前段任务标题，最后合并完整日期。阶段按实际主题合并，不要求每天新增阶段。这些检查不能代替人工核对专业内容，导入前仍可修改说明、缩短时长或移除任务。

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
