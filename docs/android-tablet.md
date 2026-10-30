# 安卓平板单机版

目标设备：联想 Android 14、64位平板。模式为本地教材、笔记、OCR和检索＋用户配置的在线AI，不依赖电脑或局域网服务器。不是离线大语言模型。

原生应用位于apps/android，内置Chaquopy Python、本地API、前端及中英文OCR资源。横屏并排阅读/助读，竖屏上下分区；支持系统文件选择、触控/手写及返回键。API Key由Android Keystore加密保存，不降级到明文文件。没有账号注册和云端数据同步。

## 数据和任务

教材与数据库放在应用私有files/study目录；升级保留，卸载或清除应用数据会删除。迁移时先在电脑版导出完整ZIP，再在平板更多设置中恢复；备份不包含密钥，需重新配置。首版使用内置轻量检索，不运行桌面FastEmbed下载模型；恢复时保留这些模型的元数据，安卓重建自己的轻量向量。

后台使用前台服务并显示通知。返回桌面不等于停止；通知的“停止服务”会关闭应用服务。系统省电或强制停止仍可能中断，已提交任务保存断点，重启后可在任务中心重新执行。原文/OCR准备仍依赖阅读界面。不能承诺锁屏或厂商省电策略下永不中断。

导入使用系统文件选择器，不索取全盘文件权限。导出通过系统“保存文档”，单次上限512MB；原始备份较大时需避免打包桌面下载模型，或继续在电脑保存完整备份。安装包不包含个人学习资料和API Key。

## 构建与签名

构建环境：JDK17/21、Gradle8.11.1、AndroidSDK35/build-tools35.0.0、Python3.12及已有web依赖。运行build-android.ps1，可通过-JavaHome/-SdkRoot/-GradleCommand指定工具。输出dist/android/DubuTianxia-tablet.apk和SHA256。首次构建创建.private/android-signing下的个人签名和密码；该目录不进Git，必须另行安全备份，今后升级须保留相同签名并增加versionCode。不要把签名文件发给其他用户。

CI构建测试签名APK，在Android14模拟器检查离线启动、OCR资源、系统密钥加密及旋转布局。CI测试签名不作为个人正式升级签名使用。依赖固定见android/requirements.txt；Chaquopy17.2提供FTS5，pydantic-core安卓轮子来自Flet官方包仓库。参考：[Chaquopy](https://chaquo.com/chaquopy/doc/current/android.html)、[Flet原生轮子](https://pypi.flet.dev/pydantic_core/)。

当前移植仍需以实际构建和测试结果为准；未通过APK/模拟器验证之前，不视为可交付安装版。
