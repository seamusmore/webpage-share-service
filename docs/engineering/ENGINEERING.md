# webpage-share-service — 工程约定

## 维护责任
本文由项目 Bot 随开发持续维护。架构师统筹技术方案、当前版本、基线、分支和集成记录；开发成员更新实际技术栈、运行命令、接口和数据约定；项目负责人维护版本范围、远端及发布约束。每次版本切换、方案调整、合并和发布交接时，责任成员同步更新本文并提交，交接记录文档提交 ID。方案比较与设计依据放在 docs/design/，写作要求见 [项目协作约定](../../AGENTS.md)。

## 项目背景与保护边界
目标：多租户网页分享服务，Agent 上传 HTML 文件后可远程查看与分享。业务范围：飞书 OAuth 登录 + API_KEY 鉴权，多租户存储与数据完全隔离（每组独立 storage_path 与 API_KEY）。生产数据保护：SQLite 数据库 data/pages.db（租户、文件元数据）与 storage/ 多租户目录（文件物理隔离）；JWT_SECRET、FEISHU_APP_SECRET 经 .env 配置不入库不提交，租户 API_KEY 生成后存于 tenants.api_key（入库），data/ 目录经 .gitignore 不入 git。专用测试身份：test_bot / testbot123（主人指定，勿用个人账号）；测试使用隔离 DB 与存储目录，端口经 TEST_BASE / TEST_PORT 环境变量注入，不碰生产数据。

## 技术栈与运行
后端：Node.js（原生 http 服务），入口 services/auth-server.js，依赖 sqlite3 ^6.0.1。前端：原生 HTML/JS，web/index.html（登录页）、web/pages.html（管理页：上传/删除/列表/改名/共享）。数据库：SQLite，data/pages.db。运行：`node services/auth-server.js`；生产 systemd user service（start.sh 启动 / stop.sh 停止，开机自启）。环境变量：JWT_SECRET、PUBLIC_DOMAIN、FEISHU_APP_ID、FEISHU_APP_SECRET（见 .env.example）。

## UI 实现
前端视觉、组件状态和响应规则见 [UI 规范](../ui-spec/UI-SPEC.md)，由前端开发维护并随实现提交；工程文档登记组件库、样式入口及构建命令。

## 接口契约
逐字段记录类型、必填性、示例值、错误码及幂等键。先对齐契约再实现。

### 共享书签（需求 #160）

#### 记录机制（无显式接口，服务端自动）
登录用户访问 `/{source_tenant_id}/pages/{filename}` 且 source_tenant_id 非本人租户时，服务端自动 UPSERT 共享记录；重复打开不重复记录。

#### GET /api/shared — 获取共享列表
- 认证：X-API-Key（同 /api/list）
- 参数：无
- 返回：`{success: true, shares: [...]}`，shares 按 created_at 倒序
- 元素字段：
  - source_tenant_id: string，来源租户 ID
  - filename: string，来源文件名
  - display_name: string|null，来源显示名
  - source_name: string|null，来源用户名
  - source_exists: bool，来源文件是否存在（false=已失效）
  - created_at: string，首次打开时间

#### POST /api/shared/copy — 保存副本
- 认证：X-API-Key
- body：`{"source_tenant_id": "...", "filename": "..."}`
- 成功：`{success: true, filename: "<新文件名>", url: "<新页面链接>"}`
- 错误：400 缺参数；404 来源租户或文件不存在；403 无效 API_KEY

## 数据与事务
以下五张表均于服务启动时 `CREATE TABLE IF NOT EXISTS` 幂等建表，无数据迁移脚本。SQLite 单连接串行化执行；跨资源（文件系统 + DB）操作非原子，边界见各接口说明。

### 租户表 tenants
- 字段：tenant_id TEXT PRIMARY KEY；api_key TEXT NOT NULL；storage_path TEXT NOT NULL；name TEXT；created_at / updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
- 租户以飞书 open_id 作为 tenant_id，首次 OAuth 登录自动创建并生成 API_KEY 与 storage_path

### 文件显示名表 page_display_names
- 字段：id INTEGER PRIMARY KEY AUTOINCREMENT；tenant_id TEXT NOT NULL；filename TEXT NOT NULL；display_name TEXT NOT NULL；updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
- 约束：UNIQUE(tenant_id, filename)，即每个租户下文件名唯一

### 收藏表 page_favorites
- 字段：tenant_id TEXT NOT NULL；filename TEXT NOT NULL；created_at DATETIME DEFAULT CURRENT_TIMESTAMP
- 主键：(tenant_id, filename)

### 分类表 page_categories
- 字段：tenant_id TEXT NOT NULL；filename TEXT NOT NULL；category TEXT NOT NULL；updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
- 主键：(tenant_id, filename)

### 共享记录表 page_shares（需求 #160）
- 字段：owner_id TEXT NOT NULL（接收租户）；source_tenant_id TEXT NOT NULL（来源租户）；filename TEXT NOT NULL；created_at DATETIME DEFAULT CURRENT_TIMESTAMP
- 主键：(owner_id, source_tenant_id, filename)，即幂等键，重复打开不重复记录
- 副本命名：`{Date.now()}-{原filename}`；极端冲突（同毫秒同名）追加随机后缀，保证自动重命名可预期
- 迁移：启动时 `CREATE TABLE IF NOT EXISTS`，幂等，无需数据迁移
- 级联清除：来源删除文件（/api/delete）时同步 DELETE 下游共享记录（WHERE source_tenant_id=来源 AND filename=被删文件），避免同名重传被旧幂等记录挡住；source_exists 失效标记仅兜底「来源租户失效」场景

## 专业阅读入口
后端任务先读接口和数据章节；前端任务先读交互与接口章节；测试任务先读 [测试索引](../../scripts/TEST_INDEX.md)。新增专业文档后同步 [文档索引](../INDEX.md)。

## 方案与模块边界
由 架构师在开发前维护并提交方案，登记文档路径、提交 ID、模块负责人、输入输出、依赖、异常和验收依据。设计变更记录原因、影响范围和新的提交 ID。

### 需求 #160 共享书签与保存副本
- 认定机制：接收方打开他人分享链接时自动记录（分享发生在飞书/群聊，本服务无法感知发链接时刻，只能以「打开即记录」为准）
- 后端模块：page_shares 表 + 访问自动记录 + GET /api/shared + POST /api/shared/copy，负责人 be-dev-01
- 前端模块：「共享」标签 + 共享列表视图 + 保存副本交互 + 失效态展示，负责人 fe-dev-02，依赖后端模块
- 异常与边界：来源删除文件 → 级联清除下游共享记录（见数据与事务）；来源租户失效 → 列表标记 source_exists=false 前端显示失效并禁用保存副本；副本命名用时间戳前缀自动去重

### 需求 #161 路径穿越加固
- 方案：[req-161-path-traversal.md](../design/req-161-path-traversal.md)，提交 e342222
- 模块：后端 resolveStorageFile(storagePath, filename) 统一校验辅助函数（path.resolve + startsWith 白名单，越界返回 null）；页面路由与 9 处 API 直拼点统一加固；回归用例 test_traversal.js
- 负责人：be-dev-01；实现提交 cc37b91
- 异常与边界：越界 filename 返回 404，不泄露文件内容

### 需求 #162 级联清除
- 方案：[req-162-cascade-delete.md](../design/req-162-cascade-delete.md)，提交 9d5e526
- 模块：后端 /api/delete 在 unlinkSync 成功后补 DELETE page_shares（WHERE source_tenant_id=来源 AND filename=被删文件）；回归用例 test_shared.js 增补级联清除与同名重传
- 负责人：be-dev-01；开发提交 c006722（feature/306-cascade-delete，待审查合并）
- 异常与边界：跨资源非原子，DB 删除失败仅记日志不阻断响应；source_exists=false 兜底「来源租户失效」场景

## 分支、合并与发布
所选目录模式：`shared`。工作区约定、角色分工与交付顺序见 [项目协作约定](../../AGENTS.md)。需求、设计和技术文档在各自工作区随代码提交和合并；测试及技术调研报告在项目主目录 reports/ 中分类读写，项目主目录使用引擎注入的绝对路径，交接记录文档路径和提交 ID。

| 项目 | 默认约定与实际值 | 维护责任及更新时机 |
|---|---|---|
| 当前版本与基线 | 当前版本 2.2.0（README 版本历史 2026-06-15）；发布主分支 master（导入沿用）；基线提交=24fc48f（导入 bot-group 软件模板基线文档 AGENTS.md、docs/、scripts/TEST_*） | 架构师提出版本建议，用户确认后登记版本、实际分支和基线提交；每次换版更新 |
| 任务分支命名 | worktree 使用 feature/<任务ID>-<模块>-<功能简述>、fix/<任务ID>-<问题简述>；共享目录按串行写入约定协调分支 | 开发成员创建任务分支并在交付中登记，架构师维护命名约定 |
| 集成与发布分支 | worktree 的当前 release 持续集成，main 承接授权发布；导入项目保留确认的主分支；共享目录由架构师按实际模式登记 | 架构师维护集成分支及当前提交，发布执行者登记发布提交或标签 |
| 远端 | origin = https://github.com/seamusmore/webpage-share-service.git；同步方向：本地 master → origin/master；权威分支 master；分叉处理：fetch 后核对提交关系，fast-forward 优先，分叉时保留引用交架构师协调 | 架构师记录实际远端名称与地址、同步方向、权威分支及本地/远端分叉处理方式，凭据使用安全存储引用 |
| 合并与发布负责人 | 合并由架构师承接；发布由项目负责人依据用户授权选定执行者 | 对应责任成员按当前花名册登记具体 profile，成员或授权变化时更新 |
| Git 异常处理 | 切换和合并前检查遗留改动、未完成操作及分支占用；归属确认后处理；合并对象绑定审查通过的准确提交 | 改动负责成员处理遗留状态，架构师协调同名分支、占用移交和远端分叉；新增提交及冲突解决变更补充审查，处理结果登记在任务记录 |
| 验证、冲突及清理记录 | 开发交付记录保存在对应任务日志；版本测试报告位于项目主目录 reports/tests/<release版本>/<日期>-req-<测试需求ID>/REPORT.md | 执行者在报告索引和任务记录登记报告绝对路径、结果与被测提交 ID；项目负责人关联需求和报告 |

版本切换时由架构师更新当前值，历史版本保留在 Git 历史及相关需求、任务记录中。技术信息缺失时由责任成员检查实际工程后补齐；需要用户决定的版本范围和发布事项，由项目负责人汇总明确问题，在用户确认后更新记录。

## 开发与版本测试
本节维护测试流程约定。每轮实际测试的指令来源、需求 ID、范围、结果和报告路径统一登记在测试报告及任务记录中。
开发任务经自测、独立审查、合并及验收后关闭。整个 release 开发合并完成后，由用户发出测试指令，项目负责人创建独立测试需求，架构师拆解，测试员执行版本测试。登记测试指令来源、测试需求 ID、release 分支和被测提交、测试范围、报告路径及遗留问题。测试流程以报告交付为止，发现问题只记录报告；修复及复测等待用户后续明确指令，再创建相应需求。测试任务及需求按报告交付验收关闭，版本质量结论单独标注。版本测试结果作为发布依据。

开发与测试按轮次交替。用户依据测试报告发出修复指令后，新建开发需求并经过拆解、开发自测、审查、合并验收；下一轮测试由用户单独发令并新建测试需求。各轮需求关联上一轮报告及对应提交，保留完整追溯关系。

## 测试环境与资源清单
工作区服务端口、监听地址、浏览器调试端口及数据目录由引擎维护，通过项目成员的“工作区”入口配置，每次唤醒随“当前项目”JSON 注入。以下清单记录项目测试环境及身份权限；账号凭据使用安全存储引用。

测试环境、账号用途及凭据引用可由用户手动编辑，也可由用户通过项目对话指示 Bot 更新；Bot 根据授权同步文档与交接记录。

| 测试环境 | 账号用途/权限/凭据引用 | 占用人/时段 | 数据保留与交接说明 |
|---|---|---|---|
| 本地开发自测 | 专用测试身份 test_bot / testbot123（主人指定，勿用个人账号）；隔离 DB 与存储目录经 TEST_BASE 注入，端口经 TEST_PORT 注入 | 按任务分时占用 | 验证数据隔离，交接记录验证结果、数据归属与仍保留的测试状态 |

## codegraph 配置
建议用户启用代码索引和工程知识图谱，供符号定位、调用关系与变更影响分析使用。安装与启用由用户选择，命令按实际工具版本核对后填写。

| 启用状态 | 工具版本 | 初始化命令 | 更新命令 | 查询命令 | 最近索引提交/时间/结果 |
|---|---|---|---|---|---|
| 待用户选择 | 待配置 | 待配置 | 待配置 | 待配置 | 待建立 |

## 交付检查
维护当前设计与 [踩坑记录](../PITFALLS.md)，Git 保存需求、设计、技术文档与可复用测试索引的变更历史。测试及技术调研报告、被测提交 ID、实际验证条件和未覆盖风险记录到主目录 reports 相应分类及任务记录。
