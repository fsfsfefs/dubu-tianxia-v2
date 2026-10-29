# 读步天下 Windows 桌面版

## 使用

适用 Windows 10/11 x64。完整解压 `DubuTianxia-Windows-x64.zip`，双击 `DubuTianxia.exe`。无需安装 Python、Node.js 或启动开发服务器。保留相邻的 `_internal` 文件夹，单独复制 EXE 无法运行。

需要 Microsoft Edge WebView2 Runtime。多数 Windows 11 已安装；缺失时从微软官网下载 Evergreen x64：https://developer.microsoft.com/microsoft-edge/webview2/ 。程序不自动安装运行时。

桌面版保留原有界面及主要功能，首页“使用指南”可查阅用途与用法。PDF、标注和中英文 OCR 本地运行；聊天模型、联网查证及首次下载向量模型需要网络和配置。下载的向量模型不随程序分发。

## 数据与迁移

- 用户目录：`%LOCALAPPDATA%\DubuTianxia\v2`；`data` 保存数据库、教材、索引、模型及凭据降级文件；`webview` 保存网页缓存与界面偏好。
- 更新只替换程序目录，保留用户目录。删除免安装程序不会自动删除学习数据。
- 原网页项目 `.data` 不会自动移动或覆盖。先在原网页“更多设置 → 完整备份”下载 ZIP，再在桌面版“更多设置 → 恢复备份”导入。恢复替换桌面版当前数据并先建安全快照。
- 第一版完整 ZIP 也可恢复。备份不含 API Key；相同 Windows 用户恢复第二版相同模型配置时可复用系统凭据，换电脑需重填。
- 不要让开发服务器和桌面版同时使用同一个数据目录。桌面实例间有文件锁，开发服务器不识别桌面锁。
- 高级用法：`DubuTianxia.exe --data-dir "D:\我的学习数据"`，程序在该目录下再建立 `data`；不要直接指向网页 `.data`。
- 分发 ZIP 不含私人教材、数据库、下载模型和密钥。应用内完整备份包含私人数据，请自行保管。

## 启动与退出

仅监听 `127.0.0.1:8792`，与网页开发版 8790/5174 分开。重复打开同一数据目录会提示已有实例；端口占用时拒绝启动，不停止其他进程。可用 `--port 8793` 避让；界面偏好按端口分别保存，学习数据仍在原用户目录。

关闭窗口会确认退出并关闭本地服务。后台总结随程序退出停止，已完成章节和分块保留，重开后可在任务中心重新执行。正在请求的任务可能需要等待取消或超时后才完全退出，期间再次打开会被单实例锁拦截。需要任务继续时请最小化。

可右键 EXE 创建 Windows 快捷方式。当前是免安装目录版，无安装器、自动更新和数字签名；程序不修改 Windows 安全设置。

## 从源码构建

构建机需要 Windows x64、Python 3.12（`py -3.12`）和 Node.js 24：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build-windows.ps1
```

脚本在 `.tmp/desktop-venv` 创建独立环境，按 `desktop/requirements-win-py312.lock` 安装固定版本，构建前端并用 PyInstaller 打包。`dist/windows` 包含完整目录、分发 ZIP、SHA256 和依赖许可声明。输入仅限程序、前端及明确列出的 OCR 资源，不读取 `.data`；产物和依赖不进入 Git。

环境已准备时可加 `-SkipInstall`，仍检查锁并重新构建。`-OutputDirectory dist/windows-release` 可生成另一份输出，避开正在运行的旧EXE；输出必须在项目目录内。主入口为 `apps/api/reader_next_api/desktop.py`，开发运行可用打包环境 Python 执行 `desktop/launcher.py`。窗口默认最大化，可还原或缩放。

隔离验收（真实原生窗口，自动退出，不访问正式数据）：

```powershell
.\dist\windows\DubuTianxia\DubuTianxia.exe --data-dir "$PWD\.tmp\desktop-smoke" --port 18792 --smoke-test --smoke-report "$PWD\.tmp\desktop-smoke.json"
```

报告检查冻结后的原生窗口、首页、API、OCR资源和向量运行库，不下载模型或调用收费 AI。真正模型调用仍需在自己的服务配置下验证。
