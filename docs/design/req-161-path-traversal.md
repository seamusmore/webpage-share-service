# 需求 #161 — 租户页面路由 filename 路径穿越加固

## 问题定性

auth-server.js 多处把外部输入的 `filename` 直接 `path.join(storage_path, filename)` 拼接后读写文件，未做路径穿越校验。核心高危点在租户页面路由（当前 `services/auth-server.js:1492`）：`filename = decodeURIComponent(match[2])` 后直接拼接，已登录用户可用 `../`（含 `%2e%2e%2f`、`..%5c` 等 URL 编码变体）和反斜杠 `..\` 读取 `storage_path` 之外任意服务器文件。

同文件 `themes` 分支（1444–1447 行）已有 `path.resolve` + `startsWith` 白名单校验，租户页面分支缺失同等防护。本方案沿用该既有模式，统一抽辅助函数，对所有「filename 来自外部输入」的直拼点加固。

## 排查清单（逐点结论）

| 行号 | 接口/函数 | filename 来源 | 现状 | 处置 |
|---|---|---|---|---|
| 318 | `readHtml(filename)` | 硬编码 `'index.html'` / `'pages.html'` | 无外部输入 | 无需加固 |
| 625 | upload | multipart 解析，已过正则校验（609 行）+ 时间戳前缀 | 已防穿越 | 无需加固 |
| 680 | `/api/replace` | query `filename` | 未校验 | **加固** |
| 1045 | `/api/download` | query `filename` | 未校验 | **加固** |
| 1102 | `/api/rename` old_filename | body | 未校验 | **加固** |
| 1103 | `/api/rename` new_filename | body | 已正则校验（1095 行，仅 `.html/.htm` 白名单） | 保留，走统一函数双保险 |
| 1171 | `/api/rename-display` | body `filename` | 未校验 | **加固** |
| 1223 | `/api/delete` | body `filename` | 未校验 | **加固** |
| 1285 | `/api/shared` source_exists | DB `page_shares` 记录 | 间接（1492 落库） | 防御性加固 |
| 1353 | `/api/shared/copy` | body `filename` | 已正则校验（1340 行） | 保留，走统一函数双保险 |
| 1492 | 页面路由 `/{tenant}/pages/{file}` | URL 解码 | **未校验（核心）** | **加固** |

## 统一辅助函数（接口契约）

在 auth-server.js 顶部（`readHtml` 附近）新增：

```js
// 解析租户存储内的文件绝对路径，防路径穿越；越界返回 null
function resolveStorageFile(storagePath, filename) {
  if (!filename || typeof filename !== 'string') return null;
  const root = path.resolve(storagePath);
  const target = path.resolve(storagePath, filename);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null; // 穿越 storage_path 之外
  }
  return target;
}
```

说明：
- `path.resolve` 会把 `../` 与 `..\`（Windows 反斜杠）都归一化，`startsWith(root + path.sep)` 白名单同时拦住两种分隔符变体。
- 校验置于 `fs.existsSync` 之前，越界即返回 404/400，不触碰文件系统。
- 各 API 点调用后判空：`null` → 404（文件不存在）或 400（参数非法），错误码与各接口现状保持一致。

## 各点改造方式

1. **页面路由（1492）**：`const filePath = resolveStorageFile(tenant.storage_path, filename);`，`filePath === null` → 404「文件不存在」。该路由需支持多扩展名（图片/css/js 等，见 contentType 分支），因此只做 resolve 白名单，不加 `.html/.htm` 正则。
2. **download(1045) / replace(680) / rename-display(1171) / delete(1223) / rename old_filename(1102)**：这些接口 filename 语义是「纯文件名」，改为 `resolveStorageFile(tenant.storage_path, filename)`，判空 → 404（其中 replace/delete 现状是 404「文件不存在」、download 404「File not found」、rename 404「原文件不存在」，保持各自文案）。
3. **rename new_filename(1103)**：保留 1095 行正则校验，`newPath` 改用 `resolveStorageFile`，双保险。
4. **shared/copy(1353)**：保留 1340 行正则校验，`srcPath` 改用 `resolveStorageFile(src.storage_path, filename)`。
5. **shared source_exists(1285)**：`resolveStorageFile(src.storage_path, row.filename)`，null 视为 `source_exists=false`（防历史脏数据）。
6. **readHtml(318)**：不改造（硬编码入参）。

## 回归用例

新增独立脚本 `scripts/test_traversal.js`（不污染 #160 的 `test_shared.js` 基线），隔离环境（`TEST_BASE` + `TEST_PORT` 注入，复用现有测试基建模式）。用例覆盖：

1. 页面路由穿越（核心）：`/{tenant}/pages/../secret.txt`、`%2e%2e%2f`、`..%5c`、`%2e%2e%5c` 变体 → 404，且不泄露 secret 内容。
2. API 穿越：`/api/download?filename=../secret`、`/api/replace?filename=../secret`、`/api/delete` body `../secret`、`/api/rename` old_filename `../secret`、`/api/rename-display` filename `../secret` → 404/400，不读写越界文件。
3. 正常访问回归：合法文件名页面路由 200、download 200、rename/delete/rename-display 正常行为不变。
4. 既有回归：`scripts/test_shared.js` 23 项保持全绿（#160 共享记录机制不受影响）。

测试索引 `scripts/TEST_INDEX.md` 同步新增 `test_traversal.js` 的用途、运行命令、环境与前置条件。

## 验收依据

1. 穿越请求（含 URL 编码、反斜杠变体）返回 404，不泄露 `storage_path` 之外内容；逐一验证上述穿越用例。
2. 正常访问租户页面及 `test_shared.js` 23 项回归全绿。
3. 排查清单每个直拼点均有结论（已加固 / 已防穿越 / 无需加固），结论落在代码注释或方案文档。
4. `scripts/TEST_INDEX.md` 已同步。
