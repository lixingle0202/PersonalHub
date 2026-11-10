# 提交前自动格式化

项目使用 pre-commit 管理 Git 提交钩子。安装一次后，正常执行 `git commit` 就会处理本次暂存文件；Ruff 负责 Python，Prettier 负责网页和通用配置，基础钩子处理空白与格式错误。

## 一次性安装

在项目根目录执行。开发环境需要 Python 3.11 或更高版本和 Node.js；CI 使用 Python 3.12、Node.js 22。尚未创建虚拟环境时先执行第一行。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\scripts\setup-dev-hooks.ps1
```

已有 `.venv` 时从第二行开始。安装需要联网获取固定版本工具，之后复用本机缓存；Prettier 使用钩子管理的独立 Node.js 22.23.4 环境，保证 Windows 与 CI 一致。安装脚本启用 Python UTF-8 模式，支持中文项目目录。脚本不下载模型或启动业务服务。

macOS / Linux 在安装开发依赖后执行：

```bash
python -m pre_commit install --install-hooks
```

Git 钩子属于各自克隆目录的本地设置，每位开发者都需要安装；仓库中的配置文件不会仅凭下载自动启用本地钩子。

## 日常提交流程

1. 只暂存本次需要的文件，再执行 `git commit`。
2. 全部检查通过时，提交正常完成。
3. 如果工具自动修正了文件，本次提交暂停，终端会显示修改结果。
4. 查看 `git diff`，确认格式修正后，重新暂存对应文件并再次提交。

```powershell
git add -- frontend/src/components/Example.tsx
git commit -m "feat(web): add example interaction"
# 若工具修正了该文件，检查后重新暂存并提交。
git diff -- frontend/src/components/Example.tsx
git add -- frontend/src/components/Example.tsx
git commit -m "feat(web): add example interaction"
```

以上文件名仅为流程示例，实际操作换成本次修改的文件。使用部分暂存时，pre-commit 会临时保存未暂存的改动；若格式修正与这些内容冲突，会回滚修正并恢复工作区。根据提示检查后再处理，不使用 `git add .` 把未计划提交的内容一并加入。

## 自动处理范围

| 工具             | 固定版本 | 范围与行为                                                    |
| ---------------- | -------- | ------------------------------------------------------------- |
| pre-commit       | 4.7.0    | 运行暂存文件钩子、保护未暂存修改                              |
| Ruff formatter   | 0.17.4   | Python / Python 类型声明，4 空格、双引号、100 列目标宽度      |
| Prettier         | 3.9.10   | JS、TS、JSX、TSX、JSON、CSS、SCSS、WXSS、HTML、Markdown、YAML |
| pre-commit-hooks | 6.0.0    | 合并冲突标记、JSON/TOML/YAML 语法、文件末尾、行尾空格和换行   |

前端使用 2 空格、单引号和无语句末尾分号。Markdown 保留正文换行方式，不格式化其中的示例代码块；必要的 Markdown 双空格换行保留。WXML、PowerShell 和批处理不做语法级重排，仅执行适用的基础文本检查。`.cmd`、`.bat`、`.ps1` 不强制转换成 LF。

工具跳过模型、数据库所在运行目录、依赖、构建与临时输出、第三方许可目录，以及生成的食物数据和依赖锁文件。图片不会进入文本格式化。排除规则见 [pre-commit 配置](../.pre-commit-config.yaml) 与 [Prettier 排除文件](../.prettierignore)。

默认按本次提交的文件逐步统一格式。首次修改某个历史文件时，可能产生该文件内部的排版变化；涉及较大整理时应单独提交。现有业务代码不因启用工具而全部重排。

## 手动运行与维护

检查并修正当前暂存文件：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pre_commit run
```

仅对指定文件执行，便于提交前预览：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pre_commit run --files frontend/src/pages/TodayPage.tsx
```

这些手动命令也会修正文件，完成后需要检查并重新暂存。`--all-files` 会处理全仓库受支持文件，适合安排独立的格式整理任务，不用于本次功能提交的常规检查。

修改工具配置后可先校验并更新环境：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pre_commit validate-config
.\.venv\Scripts\python.exe -X utf8 -m pre_commit install --install-hooks
```

升级工具时同时核对配置中的版本、`requirements-dev.txt` 和本文版本表，并运行隔离验收：

```powershell
.\.venv\Scripts\python.exe scripts/test-format-hooks.py
```

该验收创建 `.test-runtime` 内的独立 Git 仓库，实际验证自动修正后暂停提交、再次暂存后成功、部分暂存保护、语法错误拦截及生成文件排除。它不使用真实账号数据库。

## GitHub 自动检查

[Code style 工作流](../.github/workflows/code-style.yml) 在 PR 和指定业务分支推送时检查本次变更文件；手动运行时检查最近一次提交。工作流使用与本机相同的固定版本工具，发现需要修正的文件即失败并展示差异，不自动改写或提交代码。格式检查通过后，继续在隔离仓库验证真实提交行为。

格式化不能代替 TypeScript 构建、业务测试、模型验证和真机检查；继续按[开发与提交规范](../CONTRIBUTING.md)选择相关验证。

## 官方参考

- [pre-commit 使用与暂存文件处理](https://pre-commit.com/)
- [Ruff formatter](https://docs.astral.sh/ruff/formatter/)
- [Prettier 与提交钩子](https://prettier.io/docs/precommit)
