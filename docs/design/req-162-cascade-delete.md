# 需求 #162 — /api/delete 级联清除下游共享记录 page_shares

## 问题定性

需求 #160（共享书签）已验收关闭，但契约与实现有缺口：`ENGINEERING.md`（3faace9）第 49 行约定「来源删除文件（/api/delete）时同步 DELETE 下游共享记录，避免同名重传被旧幂等记录挡住」；实际 `services/auth-server.js` `/api/delete`（约 1235–1263 行）在 `unlinkSync` 成功后只 `DELETE FROM page_display_names`，未删 `page_shares`。

后果：来源删除文件后，下游 `page_shares` 记录残留（前端以 `source_exists=false` 失效态兜底，不影响展示），但当来源租户**同名重传**新文件时，接收方再次打开页面会被旧的 `(owner_id, source_tenant_id, filename)` 幂等键挡住——`INSERT OR IGNORE` 不生效，`created_at` 陈旧，无法反映「重新分享」这一新事实。

主人（message_id=11701）拍板：补后端级联清除。

## 改动范围（单点，最小改动）

`/api/delete` 中，在 `fs.unlinkSync(filePath)` 成功后、响应 200 前，追加一条：

```js
// 级联清除下游共享记录（来源=当前租户，被删文件）
db.run('DELETE FROM page_shares WHERE source_tenant_id = ? AND filename = ?', [tenant.id, filename], function(err) {
  if (err) {
    console.error('❌ 清除下游共享记录失败:', err.message);
  }
});
```

## 事务边界与异常处理

1. **跨资源非原子**：`unlinkSync`（文件系统）与两条 `db.run`（SQLite）无法置于同一事务。执行顺序固定为：`unlinkSync` 删文件 → `DELETE page_display_names` → `DELETE page_shares` → 响应 200。
2. **DB 删除失败不阻断响应**：与现状一致——`page_display_names` 删除失败当前也只 `console.error`、不改变响应。级联清除同口径：失败仅记日志，不返回 500（否则文件已删但响应失败，客户端会误以为未删，比残留记录更糟）。残留的 `page_shares` 记录由 `source_exists=false` 兜底。
3. **串行保证**：SQLite 单连接（`sqlite3` 默认串行化）上两条 `db.run` 按提交顺序排队执行，无需额外事务包装。
4. **幂等**：`DELETE` 无匹配行也不报错，重复删除安全。
5. **不改动**：`page_display_names` 删除行为、`resolveStorageFile` 防穿越校验、响应结构均保持不变。

## 回归用例（scripts/test_shared.js 增补，不新建脚本）

现有第 14 步（274–279 行）用 `fs.unlinkSync` **直删文件**模拟来源删除，验证 `source_exists=false` 兜底——这条路径不变。新增「走 /api/delete 级联清除」用例：

1. **级联清除**：A 通过 `/api/delete` 删除文件后，B 的 `GET /api/shared` 不再返回该条目（page_shares 已清除），且 `page_shares` 表 `COUNT=0`。
2. **同名重传新记录生效**：A 重新上传同名文件，B 再次打开该页面后，`page_shares` 重新记录 1 条，`created_at` 为最新（区别于旧记录）。
3. 既有 23 项全部保持通过（尤其第 14 步 source_exists 兜底、第 15 步幂等键）。

注意区分：第 14 步的 `fs.unlinkSync` 直删是「绕过 API」的兜底验证，新增用例走真实 `/api/delete` API，两条路径语义不同、都要保留。

## 验收依据

1. 来源通过 `/api/delete` 删文件后，下游 `GET /api/shared` 不再返回该条目，`page_shares` 表对应记录清除。
2. 同名重传 + 接收方重新打开后，`page_shares` 新记录生效（`created_at` 最新）。
3. `test_shared.js` 既有 23 项 + 新增用例全绿。
4. `page_display_names` 删除行为不变。
5. `ENGINEERING.md` 第 49 行契约与实现已一致（无需改文档，实现对齐契约即可）。
