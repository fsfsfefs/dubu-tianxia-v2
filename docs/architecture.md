# 第二版架构

Windows桌面组合根为`reader_next_api/desktop.py`：复用Runtime和create_app，挂载只读前端产物、指定OCR目录，Edge WebView2同源访问。会话Cookie、Origin/Host检查限制本地API；进程持有数据文件锁直至后端与任务完成退出。数据位于LOCALAPPDATA，程序包与私人数据分开；PyInstaller构建见desktop目录和build-windows.ps1。

## 功能与模块

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 用户指南 | web/src/features/guide/、docs/user-guide.md | 单一Markdown来源、按需模态阅读、目录/搜索/下载；首页与各工作区入口 |
| 启动 | web/src/main.tsx | 仅挂载React根组件 |
| 应用装配 | web/src/App.tsx | 装配功能、书架操作与备份入口 |
| 导航/布局 | web/src/features/workspace/useWorkspaceNavigation.ts、features/assistant/usePanelLayout.ts | 历史回退、教材与指定页、布局持久化与监听释放 |
| 总览 | web/src/features/overview/ | 目录/导入/原文准备/溯源控制器与独立视图 |
| 助读视图 | web/src/features/assistant/AssistantDock.tsx | 问答、笔记和练习展示装配 |
| 问答状态 | web/src/features/assistant/useConversation.ts | 问答、索引、流式证据、取消及回答身份 |
| 练习 | web/src/features/practice/ | 卡片控制器、练习视图与浮动题目 |
| 书架 | web/src/features/library/LibraryHome.tsx | 书架展示、筛选及显式操作回调 |
| 访问隔离 | web/src/shared/ | 教材访问守卫和学习记录异步加载 |
| 总结溯源 | web/src/features/summary/sourceTrace.ts | 纯文本来源定位 |
| 设置 | web/src/features/settings/ModelSettings.tsx | 模型表单、临时连接测试、向量模型管理 |
| 任务视图 | web/src/features/tasks/TaskCenter.tsx | 接收任务和回调，展示状态及操作 |
| 笔记状态 | web/src/features/notes/useNotes.ts | 笔记表单、编辑、导出和异步切书保护 |
| PDF控制 | web/src/PdfReader.tsx、features/reader/ | 阅读位置、独立搜索及标注Hook |
| PDF渲染 | web/src/PdfPages.tsx | 缩略图、单页渲染与OCR文字层 |
| 内容身份 | web/src/chapters.ts、api/chapters.py | 同构章节范围键，使用共享Unicode/层级测试样例 |
| HTTP适配 | api/main.py、application.py | ASGI入口、应用工厂、生命周期、维护门禁 |
| 输入契约 | api/schemas.py | 独立Pydantic请求模型 |
| 路由 | api/routes/ | assets、documents、learning、models、tasks、chat、backup |
| 资源所有者 | api/runtime.py | 每应用独立仓库、模型适配器、凭据及工作线程；协调恢复 |
| 持久化门面 | api/repository.py | 保持既有调用接口，组合各领域仓库 |
| 数据库 | api/repositories/database.py、migrations.py | 显式版本迁移、连接事务及确定性关闭 |
| 检索编排 | api/retrieval_service.py | 模型选择、失败恢复、回填与重建；协调并发模型读写 |
| 领域数据操作 | api/repositories/ | documents、learning、retrieval、tasks、profiles |
| AI适配与算法 | providers、reading_agent、citation_verification、rag | 模型协议、问答编排、证据核验及检索算法 |
| 后台工作 | background_tasks、summary_tasks | 持久化队列、总结分块、限流与断点 |

上表 api 相对 apps/api/reader_next_api，web 相对 apps/web。
前端仍仅通过HTTP/SSE访问后端；领域仓库共享数据库配置，通过Repository门面维持旧功能兼容。这里采用小规模门面/分领域混入组合，尚不是严格的独立服务/仓库接口体系。

## 生命周期

导入main模块只创建FastAPI路由定义，不创建数据库、不回填向量、不恢复任务。
应用lifespan启动Runtime，退出时停止任务线程；create_app可注入隔离Runtime用于测试，不修改模块全局变量。
MaintenanceMiddleware的访问租约覆盖整个响应，包括SSE和文件流。恢复请求取得独占租约后先停止后台工作，再创建安全快照、恢复并重建资源；正常请求活动时拒绝恢复，恢复期间拒绝新请求。
模型参数和API Key分别通过配置与CredentialStore访问。第二版凭据服务名为reader-next-v2。

## 章节身份与兼容

不再把目录下标作为新总结身份。范围键包含祖先标题、本节点及子树标题/页码/深度和下一同级边界页；相同内容范围在无关的前置章节插入后保持同一键，子树或范围变化则失效。
FNV-1a 64位用于本地内容身份，不是安全校验；归档文件仍使用SHA-256。标题、页码等身份信息变化时保留旧记录，但不自动重用到新范围。键有理论哈希碰撞风险，不应充当跨系统永久UUID。
第一版位置记录仅在标题、起始页、深度及可确定的结束页一致时迁移；目录替换前依据旧目录迁移，无法确认归属的旧位置记录以legacy前缀保留。

## 前端异步与加载边界

useDocumentScope按访问代次隔离结果；A→B→A也不能接受第一次A的结果。问答同时检查请求所有权和AbortSignal，取消/卸载中止调用，旧finally不能释放新请求的busy。每条回答使用内部Symbol身份，React批量提交的增量更新仍落到对应回答；发送历史时只包含role/content。
学习数据加载、笔记与卡片共享访问守卫。卡片生成接口暂不可取消，切书后忽略过期结果；这不保证已发送的模型请求停止计费。总览控制器对目录读取/导入竞争、文件读取、原文准备和溯源应用访问代次与请求代次；切书中止未提交准备，已排入后端的任务独立运行。

App通过React.lazy加载阅读器与模型设置；PDF目录、索引、章节文本工具使用动态import，类型引用使用import type。PDF阅读器CSS仍在原始顺序静态导入，避免改变既有全局级联。
Vite输出manifest，tests/build-budget.mjs遍历入口的静态依赖检查400,000字节预算及动态边界；懒加载资源不计入初始脚本，但仍属于完整应用体积。

## 样式与测试

历史phase文件已按foundation、workspace、library、learning、editorial、annotations归类并展开排版；顺序和规则不变，生产CSS构建哈希仍与基线一致。基础样式仍共享；任务、向量设置与导入样式使用data-feature与:where约束，保持选择器原优先级；清除7处冗余声明，通过归一化级联摘要验证，未采用CSS Modules。
后端测试覆盖数据兼容、连接关闭、路由、问答和任务；前端使用Node测试、jsdom和Testing Library，直接编译生产组件，验证任务操作、临时模型测试、跨书异步保护和章节身份。
后续事项见refactoring.md，不以目录拆分替代实际行为验证。

## 迁移与检索工作流

migrations.py在BEGIN IMMEDIATE事务中执行有序迁移，并记录schema_migrations；兼容无版本旧库，不修改用户正文。所有迁移失败一起回滚，未来或不连续版本拒绝启动。数据恢复后通过同一入口升级，备份直接保存整库版本记录。
RetrievalService负责模型管理、选择回滚和向量回填/重建；Repository保留兼容委托。服务与页面写入、查询共用RLock；SQL和向量写入校验仍在RetrievalRepository中。单服务进程支持这些互斥约束，不宣称多个进程共享模型配置已实现分布式锁。

验证环境与浏览器隔离命令见README；压力测试位于test_maintenance_stress.py，浏览器测试使用生成的PDF，不能读取正式.data。

后台调度：索引保留单工作线程，结构总结使用独立3线程池，不同教材并发、同教材互斥。共享SummaryPacer以线程锁原子分配请求起点及限流冷却，不跨await持锁；章节与分块仍按顺序处理。

单书备份见book_backup.py与backup路由：独立ZIP格式，白名单逐表导出该书数据；导入独占HTTP维护租约，拒绝同书在途后台任务，通过SQLite单事务重映射标识、恢复FTS及兼容向量，失败清理新PDF并回滚。相同PDF替换前保存单书快照，其他书不变。

旧版兼容由compatibility.py执行幂等章节关联转换；数据库初始化与备份预检接入，整库先在staging迁移校验并丢弃可重建FTS，运行库初始化补回。单书仅转换本书、补缺少的已知表和索引，不修改其他书。全库恢复在新仓库初始化失败时从安全快照回滚。


## 统一目录与校对（2026-11-02）

routes/outline.py与document_outline.py统一解析已保存document_outlines或原PDF书签。GET返回目录、来源、总页数与内容修订hash；POST generate仅在无目录时读取缓存OCR/原生文字，保留前20页及全书各页开头（最多3000页、有限字符），单次模型调用、180秒超时，返回校对草稿而不写库。PUT保存校验标题、实际页码、顺序、层级和expected_revision，复用import_learning_structure保留历史总结及范围键规则。BackgroundTaskManager.edit_book持有提交锁，目录保存/导入与同书在途任务互斥，避免暂停请求后仍写入的分块冲突。

features/outline/OutlineEditor提供模型选择、原文/OCR准备进度与取消、可编辑草稿及延迟加载PDF原文预览；已存在目录不触发生成。pdfOutline与PdfReader使用同一GET接口，无旧目录缓存；总览保存时递增请求代次避免迟到读取覆盖编辑结果。当前文档接入仍限PDF，不增加其他文件格式解析器。


## 便签附件与页边笔迹（2026-11-02）

迁移3增加note_images二进制附件，复合外键约束笔记/文档归属，POST sticky-notes通过multipart在一事务保存文字、保留附件清单和新图片；单张及每便签附件总量20MiB，Pillow校验实际格式，读取路由限定文档/笔记/图片并设置nosniff。列表只传附件元信息，图片按需GET。完整ZIP通过SQLite快照携带；单书无图仍格式1，有图使用格式2、note-images/N.bin条目并逐文件大小/hash/真实图片校验、重新关联note_id。

正文和左右留白复用AnnotationLayer，页边笔迹在现有highlights tags增加__margin_left__/__margin_right__，均保留__ink__。useAnnotations按surface隔离擦除并共享撤销队列，AnnotationDraft携带surface防止串区预览；留白宽度由阅读区域ResizeObserver测量，正文几何不变。浏览器兼容模块在main及独立PDF Worker入口执行，按能力补齐Map upsert等接口，Worker延迟加载原PDF.js模块。


## 区域标记与折叠工具栏（2026-11-02）

inkMarks.ts将显式__ink_region:标签笔迹按稳定身份分组，未命名的历史笔迹按同页同侧邻近边界计算区域，只读识别不改写历史；新笔画优先加入当前邻近区域，“新建标记”明确生成独立身份。区域名保存在组内highlight.text，原comment、颜色、几何及其他标签保留。PUT/DELETE ink-marks在事务内核验全部成员归属后命名或删除，防止跨书/跨页/跨侧和误操作文字高亮。useAnnotations共用笔迹队列，擦除替代片段、旧撤销条目与整组删除撤销均保留区域身份和名称，备份沿用highlights无需迁移表结构。

PdfReader记忆reader-next-toolbar-collapsed，隐藏主要工具组及标注浮栏而保留翻页/展开/结束绘制，工具状态保持；现有Toolbar ResizeObserver使侧栏和弹出面板随折叠高度同步定位。InkMarkPanel使用独立key避免与章节总结面板重名。
