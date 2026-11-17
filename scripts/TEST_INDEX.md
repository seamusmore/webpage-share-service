# webpage-share-service — 测试索引

状态：已登记共享记录与共享接口自测（#160/#303）、路径穿越加固回归自测（#161/#305）。

| 用途/覆盖风险 | 脚本位置 | 运行命令 | 环境与前置条件 |
|---|---|---|---|
| 共享记录与共享接口自测（page_shares 建表幂等、访问他人页面自动记录去重、GET /api/shared、POST /api/shared/copy、来源失效、错误码） | scripts/test_shared.js | `TEST_BASE=<隔离测试数据根目录> TEST_PORT=<端口> node scripts/test_shared.js` | 隔离 DB 与存储（脚本通过 env 注入 DB_PATH/STORAGE_BASE_PATH）；Node ≥ 18（原生 fetch/FormData）；端口空闲；sqlite3 依赖已安装 |
| 路径穿越加固回归自测（页面路由与各 API 的 `../`、`%2e%2e%2f`、`..%5c`、`%2e%2e%5c` 变体返回 404 不泄露 + 合法文件名回归） | scripts/test_traversal.js | `TEST_BASE=<隔离测试数据根目录> TEST_PORT=<端口> node scripts/test_traversal.js` | 隔离 DB 与存储；Node ≥ 18（原生 fetch）；端口空闲；sqlite3 依赖已安装 |

新增、修改、执行测试前先读本索引及 [用例说明模板](TEST_CASE.md)。必要的可复用脚本存入 scripts；新增或调整脚本同步用途、命令、环境、前置条件与覆盖风险。缺陷修复补对应回归验证，测试规模与变更风险匹配。

本索引随源码纳入 Git，维护可复用用例的执行方法。实际执行的提交 ID、环境、命令、结果和证据记录到项目主目录 reports/tests/，并在报告索引及任务记录交付；分别标记通过、失败、受阻、未验证。项目主目录使用引擎注入的绝对路径。

工作区端口及数据目录由引擎配置并注入当前项目 JSON。测试前按 [工程约定](../docs/engineering/ENGINEERING.md)核对测试身份和环境，测试后记录验证结果、数据归属与风险。
