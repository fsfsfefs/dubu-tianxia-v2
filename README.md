# 读步天下第二版

基于“读步天下第一版终版”建立的独立架构优化项目，保留教材阅读、OCR、AI问答、总结、笔记、练习与完整备份能力。

- GitHub：https://github.com/fsfsfefs/dubu-tianxia-v2
- 第一版基线：`a8f7b6e9a9374a6a340c50cd7d0dd1c6e7b96ea1`；原项目和封存包不受第二版开发影响。
- [功能清单](docs/features.md) · [架构说明](docs/architecture.md) · [优化记录与后续事项](docs/refactoring.md)

## 初次使用

打开项目首页的“打开使用指南”，或在顶部/阅读器点击“使用指南”。手册按16个主题说明主要功能的用途、用法、条件和常见问题，支持目录定位、搜索与下载Markdown。关闭后继续原页面，无需AI模型或联网服务即可阅读。

项目初始文档：[读步天下使用指南](docs/user-guide.md)。界面按需加载同一份文档，维护时修改该文件即可同步，不另建易失配的内容副本。

## 启动

依赖已安装时，运行 `start-dev.cmd`，或运行 `restart-dev.cmd` 隐藏启动并检查服务就绪。
第二版使用前端 http://127.0.0.1:5174 和后端 http://127.0.0.1:8790，与第一版端口分离。

新环境使用 Windows x64 / Python 3.12，在 `apps/api` 创建 `.venv`，先执行 `.\.venv\Scripts\python.exe -m pip install -r requirements-win-py312.lock`，再执行 `.\.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e ".[test]"；在 `apps/web` 执行 `npm ci`。

默认数据目录为本项目 `.data/`，可通过 `READER_NEXT_DATA` 指定其他目录。不要指向正在使用的第一版数据目录。
本机已从第一版封存包建立独立数据副本；远端源码不包含私人数据。第二版使用独立的系统凭据命名空间，需重新填写 API Key。

## 验证

```powershell
# 项目根目录，使用新项目自己的Python环境
.\apps\api\.venv\Scripts\python.exe -m pytest apps/api/tests -q
# apps/web
npm test
npm run build
```

## 数据兼容

支持恢复第一版完整ZIP；章节总结从位置编号迁移到内容范围键。无法确认归属的旧记录保留为历史，不自动绑定到新目录章节。
目录替换前请暂停或结束对应总结任务。恢复备份期间独占数据访问，其他请求返回503；正在处理请求时发起恢复也返回503，请稍后重试。

此项目仍是本地 Web 应用，尚未制作 EXE。模型调用、下载及联网能力依赖外部服务。

前端构建同时检查初始静态依赖JS合计不超过400kB及PDF相关按需加载边界，报告未压缩体积；完整PDF/OCR资源不包含在该初始预算内。

## 浏览器与并发验证

在 `apps/web` 执行 `npm run test:e2e`。默认使用已安装的 Edge，分别运行鼠标与触控项目，验证画笔保存/刷新、局部擦除/撤销、全文搜索及真实扫描页OCR。测试自动生成PDF和独立数据，服务使用8791/5175；目录位于忽略的`.tmp`，不会连接正式`.data`，不调用AI模型。CI同样执行该流程。

独立受限环境可能无法启动浏览器子进程；此时不要跳过或伪造通过结果，使用GitHub Checks的端到端结果及内置浏览器冒烟记录。Python本机验证为3.12.4，依赖锁覆盖运行、测试与构建的全部57个包；`.python-version`固定3.12系列，CI允许该系列安全补丁更新。该锁面向Windows x64，不宣称其他操作系统已复现。

新数据库及第一版旧数据库均由`schema_migrations`依次记录版本；升级在同一事务执行，失败回滚，未来版本或不连续记录拒绝自动升级。完整备份自动包含迁移记录。
