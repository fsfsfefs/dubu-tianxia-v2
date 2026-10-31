# 读步天下第二版交接

当前项目目录：`C:\Users\HUAWEI\Documents\Codex\dubu-tianxia-v2`。

2026-10-31用户要求：后续仅维护、打包和更新Windows端，不同步更新安卓安装包；安卓CI仅保留workflow_dispatch手动入口，不随源码推送自动运行。

安卓平板工程apps/android，目标联想Android14，本地学习＋在线AI。见docs/android-tablet.md；签名位于忽略的.private/android-signing，禁止上传或丢弃。内置API18894，Keystore凭据，独立私有数据，安卓只用轻量向量；验证状态以本轮交付为准。

Windows EXE：build-windows.ps1生成dist/windows的免安装目录和ZIP，入口desktop.py/desktop/launcher.py；使用WebView2，固定127.0.0.1:8792，独立数据在LOCALAPPDATA/DubuTianxia/v2/data。默认不访问项目.data，迁移用完整备份恢复，单实例锁只覆盖桌面进程。详见docs/windows-desktop.md。产物与用户数据禁止提交。
GitHub：https://github.com/fsfsfefs/dubu-tianxia-v2；分支main。
来源为第一版终版，原项目与封存目录不修改。第二版接口端口8790，前端5174；默认.data位于新项目，凭据命名空间reader-next-v2。本机数据副本来自第一版封存包，未复制API Key。

用户初始文档为docs/user-guide.md；首页、顶部和阅读器可打开同源使用指南，内容变更在该文件维护。

接手顺序：AGENTS.md、README.md、docs/features.md、docs/architecture.md、docs/refactoring.md、CHANGELOG.md，再查git status与最近提交。
运行与验证命令见README。启动数据/任务只能由应用lifespan管理，不在模块导入时访问数据库。

最近优化：总览、助读、导航/布局、PDF搜索/标注均已有独立模块；总览导入/准备及页面OCR有过期响应保护。数据库使用schema_migrations显式事务迁移，检索编排见RetrievalService。Windows/Python3.12依赖锁与隔离浏览器测试已接入CI。验证命令、范围和当前结果见README及docs/refactoring.md。第一版历史中的宽松安装命令不再作为第二版推荐安装方式。 最近完整CI记录：后端125项、前端30项、浏览器4项及依赖锁/构建均通过，运行编号40866950396。

旧版交接背景保留如下，仅供历史参考；其中路径、Git状态、端口与模块位置以本文开头及第二版architecture.md为准。

---

# 读步天下项目交接说明

更新时间：2026-10-28

本文件用于把项目交给新的 Codex 工作或新的开发者。接手时不需要重放此前的长对话，先阅读本文件、`AGENTS.md`、`CHANGELOG.md` 和 `docs/` 下的专题文档，再检查代码与 Git 状态。

## 1. 项目身份

- 产品名称：读步天下
- 本地项目目录：`C:\Users\HUAWEI\Documents\Codex\2026-10-22\https-github-com-1433223-afk-408\reader-next`
- GitHub：`https://github.com/fsfsfefs/dubu-tianxia`
- 默认分支：`main`
- 产品定位：本地优先的 AI PDF 学习阅读器，覆盖教材管理、连续阅读、文字/OCR、学习结构、RAG 问答、引用核验、笔记、高亮、标注与复习。
- 来源关系：这是从零实现的新项目，不继续使用旧版 408 Guided Reader 的源码或数据；前端视觉、页面跳转和核心交互参考旧项目。

## 2. 开发原则与用户偏好

- 保持浅色纸张、墨绿色、偏编辑排版的视觉风格，避免通用后台管理系统风格。
- 优先保证中文教材阅读体验、宽屏布局和 Windows/Edge 可用性，同时提供窄屏适配。
- 修改应在现有架构上增量完成，不要重新创建项目或替换用户数据目录。
- 每次用户要求的源码修改都必须更新 `CHANGELOG.md`。
- 修改后运行相应前端构建或后端测试；除非用户明确要求不同步，否则提交并同步 GitHub。
- 禁止提交 `.env`、API Key、凭据、本地数据库、PDF、下载模型、备份、日志、虚拟环境、依赖目录和构建产物。
- 本项目当前不依赖 Ant Design、Element Plus 或 Tailwind CSS；界面主要由 React 组件和项目内 CSS 构成。

## 3. 技术架构

### 前端

- React + TypeScript + Vite
- PDF.js：PDF 渲染、文字层、连续页面与缩略图
- Tesseract.js：扫描页本地 OCR
- 原生 CSS：阅读器、学习空间、AI 助读、结构化内容和响应式布局
- 入口与主要状态：`apps/web/src/main.tsx`
- PDF 阅读器：`apps/web/src/PdfReader.tsx`
- HTTP/SSE 客户端：`apps/web/src/api.ts`
- 结构化 AI 内容：`apps/web/src/StructuredContent.tsx`
- 分块总结与重试：`apps/api/reader_next_api/summary_tasks.py`；断点存入 SQLite `summary_checkpoints` 表，通过 `/api/documents/{document_id}/summary-checkpoints/{key}` 读写，教材删除时级联删除。
- 本地索引协调：`apps/web/src/ragIndex.ts`

### 后端

- Python 3.11+
- FastAPI + Uvicorn
- SQLite + FTS5
- pypdf：后台读取 PDF 文字层
- FastEmbed：可选本地向量模型
- HTTPX：OpenAI 兼容模型和可选网络检索
- API 入口：`apps/api/reader_next_api/main.py`
- 数据仓库：`repository.py`
- 模型适配：`providers.py`
- 混合检索：`rag.py`
- 深度问答 Agent：`reading_agent.py`
- 引用核验：`citation_verification.py`
- 总结任务：`summary_tasks.py`（后端分块、汇总和断点，原文/OCR准备保留在前端）
- 后台任务：`background_tasks.py`（索引与总结持久化队列）
- 完整备份：`full_backup.py`

### 架构边界

前端只通过 `/api` 和 SSE 与后端交互。领域数据放在 `domain.py`，SQLite 与本地文件访问集中在 `repository.py`。模型服务必须保持 OpenAI-compatible，支持 Chat Completions 和 Responses API，不要把服务商专用逻辑散落到页面组件中。

## 4. 本地数据与安全

- 默认数据根目录：项目根目录的 `.data/`
- 可用环境变量 `READER_NEXT_DATA` 覆盖数据目录。
- SQLite、教材 PDF、OCR、索引、后台任务、学习记录和本地向量模型都保存在本机。
- 向量模型目录：`.data/embedding-models/`
- API Key 优先进入系统凭据管理器；不可用时降级为 `.data/credentials.json`。
- API Key 不得进入 SQLite、普通备份、日志、Git 或前端查询结果。
- 完整 ZIP 备份包含教材、学习数据、索引和本地向量模型；恢复前会创建安全快照。

## 5. 当前主要功能

### 教材与导航

- 导入、重命名、删除 PDF；文件夹创建、重命名、删除、筛选及教材移动。
- 学习空间、教材总览、PDF 阅读器、学习记忆之间支持历史回退。
- 记录每本书最后页码、页内滚动位置和缩放比例。
- 总览页支持整页滚动，同时左右内容区可独立滚动。

### PDF 阅读

- PDF.js 连续滚动、页码输入、前后翻页、缩放与恢复阅读位置。
- 原生文字层可选择、复制；扫描页可执行本地 OCR。
- 页面/目录共享侧栏、缩略图、书签目录、当前页跟随和页面星标。
- 全文关键词搜索显示原文片段及 PDF 页码。
- 顶部工具栏已经做响应式处理：标签不逐字换行，窄阅读区使用紧凑图标和横向滚动。

### 高亮、手写标注与笔记

- 文本高亮支持颜色、备注、标签、搜索、定位和删除。
- PDF 标注图层支持画笔、荧光笔、黑色、正红色及其他颜色。
- 画笔使用平滑曲线和 Pointer 合并采样；普通鼠标与 Edge 的空采样已兼容。
- 橡皮擦只切除命中位置；`Ctrl+Z` 可撤销新增或擦除。
- 页边便签按 PDF 页保存，支持创建、编辑和删除。
- 笔记支持标题、正文、摘录、页码、标签、置顶、搜索、编辑、原文返回和 Markdown 导出。

### AI 助读与练习

- 模型配置支持自定义 Base URL/完整 Endpoint、模型名、API Key、温度和最大输出 Token。
- 支持 Chat Completions 与 Responses API。
- Assistant 临时解释、Master 长期学习、练习卡和笔记。
- 问答范围包含当前原文、单书全文和多书联系；联网查证由用户显式开关。
- PDF 框选后自动识别全部问题并生成答案，数量不做固定限制。
- 问题卡可打开为可拖动右侧悬浮窗，支持上一题、下一题和回到原题。
- AI 助读侧栏、回答区、摘录区和主阅读区具有独立滚动或可调分隔线。

### 本地 RAG、Agent 与引用

- SQLite FTS5 关键词检索 + 本地向量检索 + RRF 融合，无需独立向量数据库。
- 向量模型可切换，支持 FastEmbed 在线下载和本地 ONNX ZIP 导入。
- PDF/OCR 写入后自动更新索引；任务中心提供进度、取消、重试和清理。
- 深度问答 Agent 最多两轮补充检索，最多四次模型调用，并可读取相关页上下文。
- AI 回答保留教材、PDF 页码和摘录；引用核验区分支持、部分支持、缺失和不支持。
- 多书联系可比较一致、互补和分歧，并分别展示教材来源；网络来源独立展示。

### 学习结构、记忆与备份

- 按大章、小章实际页码范围生成总结；大章汇总直属子章节，小章总结自身范围。
- 全书结构支持暂停、继续、取消和断点续传；已完成的小章节会保留。
- 支持 JSON、Markdown、TXT 外部导入结构与总结，自动识别章节及可选页码范围。
- AI 总结和回答使用结构化排版，清理原始 Markdown 特殊符号和数字序号。
- 完整 ZIP 备份/恢复、恢复前快照、路径/大小/SHA-256 校验，以及学习数据 JSON 导出。

更完整的功能清单见 `docs/features.md`（2026-10-29 已按代码重新盘点，含能力边界与需求去重对照）。提议或新增功能前必须先查清单及对应实现；功能或限制变化时同步维护，避免把已有问答、练习、关联和溯源功能重复新增。专题说明见：

- `docs/architecture.md`
- `docs/background-tasks.md`
- `docs/reading-agent.md`
- `docs/summary-import.md`

### 内容审核与部分总结

明确的内容审核错误仅跳过当前章节，其余章节继续生成。任务状态 `partial` 表示“部分完成”，不是全部覆盖。
待补充项持久化在 SQLite `summary_gaps` 表；任务中心、教材总览和目录显示缺失标记。
部分大章/全书总结以“总结不完整：存在待补充章节”标识并列出缺失，不传入被拦截原文重新改写。
人工导入/成功保存对应章节会清除该项标记；清理历史不删除清单，删除教材时级联清理；完整备份包含该表。

## 6. 启动方式

依赖已经安装时，双击项目根目录的 `start-dev.cmd`。它会启动：

- 后端：`http://127.0.0.1:8789`
- 前端：`http://127.0.0.1:5173`
- Vite 会把 `/api` 代理到后端。

手动启动后端：

```powershell
cd apps/api
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
.\.venv\Scripts\python.exe -m uvicorn reader_next_api.main:app --host 127.0.0.1 --port 8789
```

手动启动前端：

```powershell
cd apps/web
npm install
npm run dev
```

重启已运行的服务：双击 `restart-dev.cmd`。它会核对进程归属，仅重启本项目的8789/5173服务，隐藏运行并打开页面；未知端口占用时拒绝停止。
桌面入口可运行 `install-desktop-shortcut.ps1` 创建“重新启动读步天下”。同名快捷方式存在时安装器拒绝覆盖。
可用 `powershell -NoProfile -ExecutionPolicy Bypass -File restart-dev.ps1 -ValidateOnly` 检查本地启动依赖，不实际重启。
重启会中断正在运行的模型调用；已保存分块保留，任务中心可重新执行未完成总结。日志位于忽略目录 `.tmp/restart-*`。

## 7. 验证命令

前端：

```powershell
cd apps/web
npm run build
```

后端：

```powershell
cd apps/api
.\.venv\Scripts\python.exe -m pytest
```

此处为第一版历史：当时入口存在超过500kB提示。第二版已按需拆分，当前加载预算与验证以docs/refactoring.md为准。

## 8. 当前 Git 与交付状态

- 本地分支：`main`
- GitHub 分支：`main`
- 2026-10-28 最近完成：PDF 标注平滑/橡皮擦/Ctrl+Z、普通鼠标画笔显示修复、阅读器顶部工具栏响应式优化。
- 本地最近提交：`41144f4 feat: polish responsive PDF toolbar`
- 对应 GitHub 提交：`ec8a0cb29f537e4d77526aeaa0562656f6f29009`

由于受限环境可能不能直接执行 `git push`，此前会在本地提交后通过 GitHub 连接器创建等价远端提交；因此本地和远端提交 SHA 可能不同，但文件树内容一致。新工作开始时不要因为 SHA 不同而覆盖或重置工作区，应先检查：

```powershell
git status --short
git log -8 --oneline
git remote -v
```

禁止使用 `git reset --hard` 或强制覆盖用户工作。同步前应核对远端 `main` 最新提交与本地文件内容。

## 9. 已知注意事项

- PDF、OCR、向量索引和模型下载可能耗时，长操作应显示进度、允许取消并保留已完成部分。
- 连续 PDF 阅读器曾出现滚动页码在相邻页之间反复跳动，相关逻辑修改时要避免由程序滚动和观察器互相触发。
- 阅读器工具栏宽度取决于阅读区而非整个浏览器宽度，响应式样式使用容器查询；不要退回仅依赖窗口媒体查询的实现。
- 画笔实时草稿依赖同步 ref，不能只依赖 React 状态闭包，否则快速落笔可能丢失移动事件。
- 禁止把全部 PDF 原文一次发送给模型。全文问答应通过本地索引分块召回，章节总结应分段处理并保存断点。
- 网络查证只有用户打开开关后才能使用；网络信息与教材来源必须分开展示。
- AI 输出不应伪造教材内容或页码，无证据时要明确说明信息不足。

## 10. 新工作的推荐首条消息

```text
继续维护“读步天下”项目。

项目路径：
C:\Users\HUAWEI\Documents\Codex\2026-10-22\https-github-com-1433223-afk-408\reader-next

开始前请完整阅读 AGENTS.md、PROJECT_HANDOFF.md、CHANGELOG.md，以及与本次任务有关的 docs 文档。然后检查 git status 和最近提交，在现有架构和本地数据之上继续开发，不要重新创建项目、重置工作区或覆盖用户数据。

完成源码修改后更新 CHANGELOG.md，运行相应构建/测试，并在没有用户反对时提交并同步 GitHub，同时说明本次增加或修改了什么。

本次任务：<在这里填写新需求>
```

## 11. 交接文件维护规则

以下情况应同步更新本文件：

- 架构、端口、数据目录或启动方式变化；
- 新增重要模块或删除核心功能；
- 安全和备份策略变化；
- 新增影响后续开发的关键约束；
- 项目路径、GitHub 仓库或默认分支变化。

普通小修复只需写入 `CHANGELOG.md`，不必把本文件变成逐条开发日志。
