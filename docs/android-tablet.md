# 安卓平板单机版

目标设备：联想 Android 14、64位平板。模式为本地教材、笔记、OCR和检索＋用户配置的在线AI，不依赖电脑或局域网服务器。不是离线大语言模型。

原生应用位于apps/android，内置Chaquopy Python、本地API、前端及中英文OCR资源。横屏并排阅读/助读，竖屏上下分区；支持系统文件选择、触控/手写及返回键。API Key由Android Keystore加密保存，不降级到明文文件。没有账号注册和云端数据同步。

## 数据和任务

教材与数据库放在应用私有files/study目录；升级保留，卸载或清除应用数据会删除。迁移时先在电脑版导出完整ZIP，再在平板更多设置中恢复；备份不包含密钥，需重新配置。向量检索提供内置轻量模型，也可以下载或从 ZIP 导入 BGE Small 中文与 Multilingual MiniLM。下载需要能访问 Hugging Face，安装后可离线运行。跨平台恢复并使用外部模型时，向量按安卓运行时重新建立。

后台使用前台服务并显示通知。返回桌面不等于停止；通知的“停止服务”会关闭应用服务。系统省电或强制停止仍可能中断，已提交任务保存断点，重启后可在任务中心重新执行。原文/OCR准备仍依赖阅读界面。不能承诺锁屏或厂商省电策略下永不中断。

导入使用系统文件选择器。单书及整库 ZIP 通过系统“保存文档”分块导出，遵循后端 1 GB 与 12 GB 的备份限制，并需要足够的应用缓存及目标存储空间。安装包不包含个人学习资料和API Key。

## 构建与签名

构建环境：JDK17/21、Gradle8.11.1、AndroidSDK35/build-tools35.0.0、Python3.12及已有web依赖。运行build-android.ps1，可通过-JavaHome/-SdkRoot/-GradleCommand指定工具。输出dist/android/DubuTianxia-tablet.apk和SHA256。首次构建创建.private/android-signing下的个人签名和密码；该目录不进Git，必须另行安全备份，今后升级须保留相同签名并增加versionCode。不要把签名文件发给其他用户。

CI 构建测试签名 APK，在 Android 14 模拟器检查离线启动、PDF、OCR、图片解码、分词及 ONNX 推理、系统密钥加密与旋转布局。CI 测试签名不作为个人正式升级签名使用。依赖固定见 android/requirements.txt，Chaquopy 提供 FTS5，安卓原生轮子来自 Flet 包仓库。[Chaquopy](https://chaquo.com/chaquopy/doc/current/android.html) · [Flet](https://pypi.flet.dev/onnxruntime/)

2026-10-30已通过APK构建与Android14模拟器4项验证：离线首页/本地API/OCR资源、Keystore加密、原生PDF与真实扫描页OCR/系统返回、横竖屏与指南。完整门禁同时通过后端133项、前端38项、浏览器10项。模拟器运行记录40998745202；尚未在用户的联想平板实机验收，真实AI服务仍需自行配置后测试。
