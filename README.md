# 读步天下第二版

基于“读步天下第一版终版”建立的独立架构优化项目，保留教材阅读、OCR、AI问答、总结、笔记、练习与完整备份能力。

- GitHub：https://github.com/fsfsfefs/dubu-tianxia-v2
- 第一版基线：`a8f7b6e9a9374a6a340c50cd7d0dd1c6e7b96ea1`；原项目和封存包不受第二版开发影响。
- [功能清单](docs/features.md) · [架构说明](docs/architecture.md) · [优化记录与后续事项](docs/refactoring.md)

## 启动

依赖已安装时，运行 `start-dev.cmd`，或运行 `restart-dev.cmd` 隐藏启动并检查服务就绪。
第二版使用前端 http://127.0.0.1:5174 和后端 http://127.0.0.1:8790，与第一版端口分离。

新环境先在 `apps/api` 创建 `.venv`，执行 `.\.venv\Scripts\python.exe -m pip install -e ".[test]"；在 `apps/web` 执行 `npm ci`。

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
