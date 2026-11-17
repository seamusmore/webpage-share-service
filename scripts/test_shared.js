#!/usr/bin/env node
/**
 * 共享记录机制与共享接口自测（需求 #160 任务 #303）
 *
 * 隔离环境：通过环境变量注入独立的测试数据库与存储目录，不触碰生产 data/ 与 storage/。
 * 被测对象：services/auth-server.js（启动时建 page_shares 表；访问他人页面自动记录；
 *          GET /api/shared 列表；POST /api/shared/copy 保存副本）。
 *
 * 运行方式（示例）：
 *   TEST_BASE=<测试数据根目录> TEST_PORT=<端口> node scripts/test_shared.js
 *
 * 环境变量（无写死本机路径）：
 *   TEST_BASE       必填，测试数据根目录（DB 与 storage 都放在其下）
 *   TEST_PORT       可选，默认 18072
 *   TEST_JWT_SECRET 可选，默认测试密钥（与生产无关）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_JS = path.join(__dirname, '..', 'services', 'auth-server.js');
const TEST_BASE = process.env.TEST_BASE;
if (!TEST_BASE) {
  console.error('❌ 缺少 TEST_BASE 环境变量（测试数据根目录）');
  process.exit(2);
}
const PORT = parseInt(process.env.TEST_PORT || '18072', 10);
const JWT_SECRET = process.env.TEST_JWT_SECRET || 'self-test-jwt-secret-at-least-32-chars-long!!';
const DB_PATH = path.join(TEST_BASE, 'pages.db');
const STORAGE_PATH = path.join(TEST_BASE, 'storage');
const BASE_URL = `http://127.0.0.1:${PORT}`;

const TENANT_A = 'ou_self_test_a';
const TENANT_B = 'ou_self_test_b';
const API_KEY_A = 'sk_test_a_000000000000000000000000';
const API_KEY_B = 'sk_test_b_000000000000000000000000';

let passCount = 0;
let failCount = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// 复刻服务端 JWT 签名逻辑，为租户 B 铸造测试令牌
function mintJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const full = { ...payload, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
  const h = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const p = base64UrlEncode(Buffer.from(JSON.stringify(full)));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
    });
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
    });
    db.run(sql, params, (err) => {
      db.close();
      if (err) return reject(err);
      resolve();
    });
  });
}

async function waitReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/login-url`);
      if (r.status === 200) return true;
    } catch (e) {
      // 未就绪，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// 等服务端异步建表完成（server.listen 早于建表回调，直接 INSERT 可能撞「no such table」）
async function waitForTable(tableName, timeoutMs = 10000) {
  const sqlite3 = require('sqlite3').verbose();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = await new Promise((resolve) => {
      const db = new sqlite3.Database(DB_PATH, (err) => { if (err) return resolve(false); });
      db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', tableName], (err, row) => {
        db.close();
        resolve(!!row);
      });
    });
    if (exists) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  // 清空测试数据，保证幂等重跑
  fs.rmSync(TEST_BASE, { recursive: true, force: true });
  fs.mkdirSync(STORAGE_PATH, { recursive: true });

  // 启动被测服务（隔离 DB 与 storage）
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      STORAGE_BASE_PATH: STORAGE_PATH,
      JWT_SECRET,
      REDIRECT_URI: `${BASE_URL}/oauth2/callback`,
      PUBLIC_DOMAIN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  console.log(`\n=== 共享记录机制与共享接口自测 ===`);
  console.log(`被测：${SERVER_JS}`);
  console.log(`DB：${DB_PATH}`);
  console.log(`Storage：${STORAGE_PATH}`);
  console.log(`端口：${PORT}\n`);

  if (!(await waitReady())) {
    console.error('❌ 服务启动超时');
    console.error(serverLog);
    child.kill();
    process.exit(1);
  }
  console.log('✅ 服务已就绪\n');

  // 等服务端建表完成，避免 INSERT 撞「no such table」
  if (!(await waitForTable('tenants'))) {
    console.error('❌ 等待 tenants 表创建超时');
    child.kill();
    process.exit(1);
  }

  // 1. 准备两个租户（直接写入隔离测试库）
  await dbRun('INSERT OR REPLACE INTO tenants (tenant_id, api_key, storage_path, name) VALUES (?, ?, ?, ?)',
    [TENANT_A, API_KEY_A, path.join(STORAGE_PATH, `tenant-${TENANT_A}`), '租户A']);
  await dbRun('INSERT OR REPLACE INTO tenants (tenant_id, api_key, storage_path, name) VALUES (?, ?, ?, ?)',
    [TENANT_B, API_KEY_B, path.join(STORAGE_PATH, `tenant-${TENANT_B}`), '租户B']);
  fs.mkdirSync(path.join(STORAGE_PATH, `tenant-${TENANT_A}`), { recursive: true });
  fs.mkdirSync(path.join(STORAGE_PATH, `tenant-${TENANT_B}`), { recursive: true });

  // 2. 租户 A 上传一个页面文件
  const htmlContent = '<!DOCTYPE html><html><body><h1>共享测试页面</h1></body></html>';
  const form = new FormData();
  form.append('file', new Blob([htmlContent], { type: 'text/html' }), 'test-share.html');
  const upResp = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY_A },
    body: form
  });
  const up = await upResp.json();
  check('A 上传文件成功', upResp.status === 200 && up.success === true, JSON.stringify(up));
  const srcFilename = up.filename;
  check('上传返回文件名（带时间戳前缀）', typeof srcFilename === 'string' && srcFilename.endsWith('-test-share.html'), srcFilename);

  // 3. 租户 B 首次访问他人页面：B 打开前共享列表应为空
  const emptyResp = await fetch(`${BASE_URL}/api/shared`, { headers: { 'X-API-Key': API_KEY_B } });
  const emptyList = await emptyResp.json();
  check('访问前 B 共享列表为空', emptyResp.status === 200 && Array.isArray(emptyList.shares) && emptyList.shares.length === 0, JSON.stringify(emptyList));

  // 4. 租户 B 打开 A 的页面（JWT 登录态）
  const jwtB = mintJwt({ open_id: TENANT_B, name: '租户B', tenant_id: TENANT_B, api_key: API_KEY_B });
  const pageUrl = `${BASE_URL}/${TENANT_A}/pages/${srcFilename}`;
  const pageResp = await fetch(pageUrl, { headers: { Cookie: `jwt_token=${jwtB}` } });
  const pageBody = await pageResp.text();
  check('B 打开 A 的页面返回 200 且内容一致', pageResp.status === 200 && pageBody.includes('共享测试页面'), `status=${pageResp.status}`);

  // 5. 访问后共享列表应有一条
  const listResp = await fetch(`${BASE_URL}/api/shared`, { headers: { 'X-API-Key': API_KEY_B } });
  const list = await listResp.json();
  check('访问后 B 共享列表有 1 条', listResp.status === 200 && Array.isArray(list.shares) && list.shares.length === 1, JSON.stringify(list));
  const share = list.shares && list.shares[0];
  check('共享条目 source_tenant_id = A', share && share.source_tenant_id === TENANT_A, JSON.stringify(share));
  check('共享条目 filename 正确', share && share.filename === srcFilename, JSON.stringify(share));
  check('共享条目 source_name = 租户A', share && share.source_name === '租户A', JSON.stringify(share));
  check('共享条目 source_exists = true', share && share.source_exists === true, JSON.stringify(share));
  check('共享条目 display_name = test-share.html', share && share.display_name === 'test-share.html', JSON.stringify(share));

  // 6. 重复访问不重复记录
  await fetch(pageUrl, { headers: { Cookie: `jwt_token=${jwtB}` } });
  const listResp2 = await fetch(`${BASE_URL}/api/shared`, { headers: { 'X-API-Key': API_KEY_B } });
  const list2 = await listResp2.json();
  check('重复访问后仍只有 1 条（幂等）', Array.isArray(list2.shares) && list2.shares.length === 1, JSON.stringify(list2));

  // 7. 保存副本
  const copyResp = await fetch(`${BASE_URL}/api/shared/copy`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY_B, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_tenant_id: TENANT_A, filename: srcFilename })
  });
  const copy = await copyResp.json();
  check('保存副本返回 success', copyResp.status === 200 && copy.success === true, JSON.stringify(copy));
  check('副本新文件名 = {timestamp}-{原filename}', typeof copy.filename === 'string' && copy.filename.endsWith(`-${srcFilename}`) && copy.filename !== srcFilename, copy.filename);
  check('副本 url 指向 B 租户', typeof copy.url === 'string' && copy.url.includes(`/${TENANT_B}/pages/`), copy.url);
  const copyFilename = copy.filename;

  // 8. 副本出现在 B 的「全部」列表，显示名与来源一致
  const listBRaw = await fetch(`${BASE_URL}/api/list`, { headers: { 'X-API-Key': API_KEY_B } });
  const listB = await listBRaw.json();
  const copiedPage = (listB.pages || []).find((p) => p.filename === copyFilename);
  check('副本出现在 B 的 /api/list', !!copiedPage, JSON.stringify(listB));
  check('副本显示名 = test-share.html', copiedPage && copiedPage.display_name === 'test-share.html', copiedPage && JSON.stringify(copiedPage));

  // 9. 副本内容与来源一致
  const copiedContent = fs.readFileSync(path.join(STORAGE_PATH, `tenant-${TENANT_B}`, copyFilename), 'utf-8');
  check('副本文件内容与来源一致', copiedContent === htmlContent);

  // 10. 来源不存在：租户不存在 → 404
  const copyMissingTenant = await fetch(`${BASE_URL}/api/shared/copy`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY_B, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_tenant_id: 'ou_not_exist', filename: srcFilename })
  });
  check('复制来源租户不存在返回 404', copyMissingTenant.status === 404, `status=${copyMissingTenant.status}`);

  // 11. 来源不存在：文件不存在 → 404
  const copyMissingFile = await fetch(`${BASE_URL}/api/shared/copy`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY_B, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_tenant_id: TENANT_A, filename: '1780000000000-not-exist.html' })
  });
  check('复制来源文件不存在返回 404', copyMissingFile.status === 404, `status=${copyMissingFile.status}`);

  // 12. 缺参数 → 400
  const copyMissingParam = await fetch(`${BASE_URL}/api/shared/copy`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY_B, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_tenant_id: TENANT_A })
  });
  check('复制缺少 filename 返回 400', copyMissingParam.status === 400, `status=${copyMissingParam.status}`);

  // 13. 无效 API_KEY → 403
  const badKeyResp = await fetch(`${BASE_URL}/api/shared`, { headers: { 'X-API-Key': 'sk_invalid' } });
  check('无效 API_KEY 返回 403', badKeyResp.status === 403, `status=${badKeyResp.status}`);

  // 14. 来源文件删除后 source_exists=false
  fs.unlinkSync(path.join(STORAGE_PATH, `tenant-${TENANT_A}`, srcFilename));
  const listResp3 = await fetch(`${BASE_URL}/api/shared`, { headers: { 'X-API-Key': API_KEY_B } });
  const list3 = await listResp3.json();
  const shareAfterDelete = (list3.shares || []).find((s) => s.filename === srcFilename);
  check('来源文件删除后 source_exists=false', shareAfterDelete && shareAfterDelete.source_exists === false, JSON.stringify(shareAfterDelete));

  // 15. 数据库层复核：page_shares 幂等主键只留 1 条
  const rows = await dbQuery('SELECT COUNT(*) AS c FROM page_shares WHERE owner_id = ? AND source_tenant_id = ? AND filename = ?', [TENANT_B, TENANT_A, srcFilename]);
  check('page_shares 中仅 1 条（幂等键）', rows[0].c === 1, `count=${rows[0].c}`);

  // 汇总
  child.kill();
  console.log(`\n=== 结果：通过 ${passCount} 项，失败 ${failCount} 项 ===`);
  if (failCount > 0) {
    console.log('失败项：', failures.join('；'));
    console.log('\n--- 服务日志尾部 ---\n' + serverLog.slice(-2000));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 自测异常:', err);
  process.exit(1);
});
