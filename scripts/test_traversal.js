#!/usr/bin/env node
/**
 * 路径穿越加固回归自测（需求 #161 任务 #305）
 *
 * 验证 resolveStorageFile 辅助函数 + 各直拼点加固后：
 *  1) 穿越请求（含 %2e%2e%2f、..%5c、%2e%2e%5c 等 URL 编码变体）返回 404，不泄露 storage 之外文件；
 *  2) 合法文件名各接口行为不变。
 *
 * 隔离环境：TEST_BASE 注入独立 DB 与 storage，不触碰生产 data/ 与 storage/。
 *
 * 运行方式（示例）：
 *   TEST_BASE=<测试数据根目录> TEST_PORT=<端口> node scripts/test_traversal.js
 *
 * 环境变量（无写死本机路径）：
 *   TEST_BASE       必填，测试数据根目录
 *   TEST_PORT       可选，默认 18072
 *   TEST_JWT_SECRET 可选，默认测试密钥
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

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

const TENANT_A = 'ou_trav_a';
const API_KEY_A = 'sk_trav_a_000000000000000000000000';
const SECRET = 'TOP-SECRET-DO-NOT-LEAK-9f8e7d';
const NORMAL_CONTENT = 'NORMAL-CONTENT-123';

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

function mintJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const full = { ...payload, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
  const h = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const p = base64UrlEncode(Buffer.from(JSON.stringify(full)));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

// 用 http 模块发送「原始路径」请求（绕过 fetch/URL 的点段归一化），用于验证 raw ../ 变体
function rawGet(rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(DB_PATH, (err) => { if (err) return reject(err); });
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
    } catch (e) { /* 未就绪 */ }
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
  fs.rmSync(TEST_BASE, { recursive: true, force: true });
  fs.mkdirSync(STORAGE_PATH, { recursive: true });

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

  console.log(`\n=== 路径穿越加固回归自测 ===`);
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

  // 准备租户 A、一个合法文件、一个「storage 之外」的机密文件
  await dbRun('INSERT OR REPLACE INTO tenants (tenant_id, api_key, storage_path, name) VALUES (?, ?, ?, ?)',
    [TENANT_A, API_KEY_A, path.join(STORAGE_PATH, `tenant-${TENANT_A}`), '租户A']);
  const tenantADir = path.join(STORAGE_PATH, `tenant-${TENANT_A}`);
  fs.mkdirSync(tenantADir, { recursive: true });
  fs.writeFileSync(path.join(tenantADir, 'normal.html'), NORMAL_CONTENT);
  // 机密文件放在 storage 根目录（租户 A 目录的上一级），穿越 ../ 即可触达
  fs.writeFileSync(path.join(STORAGE_PATH, 'secret.txt'), SECRET);

  const jwtA = mintJwt({ open_id: TENANT_A, name: '租户A', tenant_id: TENANT_A, api_key: API_KEY_A });
  const cookie = `jwt_token=${jwtA}`;

  // ===== 1. 页面路由穿越（核心） =====
  // raw ../：http 模块发原始路径，服务端 new URL 归一化后不匹配 /pages/ 路由 → 404
  const rawDotDot = await rawGet(`/${TENANT_A}/pages/../secret.txt`, { Cookie: cookie });
  check('页面路由 raw ../ 返回 404 不泄露', rawDotDot.status === 404 && !rawDotDot.body.includes(SECRET), `status=${rawDotDot.status}`);

  const encVariants = [
    `/${TENANT_A}/pages/%2e%2e%2fsecret.txt`,   // ../secret.txt
    `/${TENANT_A}/pages/..%5csecret.txt`,        // ..\secret.txt
    `/${TENANT_A}/pages/%2e%2e%5csecret.txt`,    // ..\secret.txt
    `/${TENANT_A}/pages/%2e%2e%2f%2e%2e%2fsecret.txt` // ../../secret.txt
  ];
  for (const v of encVariants) {
    const r = await fetch(`${BASE_URL}${v}`, { headers: { Cookie: cookie } });
    const body = await r.text();
    check(`页面路由 ${v} 返回 404 不泄露`, r.status === 404 && !body.includes(SECRET), `status=${r.status}`);
  }

  // ===== 2. API 穿越（query / body 中的 filename 直拼点） =====
  const dl = await fetch(`${BASE_URL}/api/download?filename=${encodeURIComponent('../secret.txt')}`, { headers: { 'X-API-Key': API_KEY_A } });
  check('download ../ 返回 404', dl.status === 404, `status=${dl.status}`);

  const rp = await fetch(`${BASE_URL}/api/replace?filename=${encodeURIComponent('../secret.txt')}`, { headers: { 'X-API-Key': API_KEY_A } });
  check('replace ../ 返回 404', rp.status === 404, `status=${rp.status}`);

  const del = await fetch(`${BASE_URL}/api/delete`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: '../secret.txt' })
  });
  check('delete ../ 返回 404', del.status === 404, `status=${del.status}`);

  const rn = await fetch(`${BASE_URL}/api/rename`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_filename: '../secret.txt', new_filename: 'x.html' })
  });
  check('rename old_filename ../ 返回 404', rn.status === 404, `status=${rn.status}`);

  const rd = await fetch(`${BASE_URL}/api/rename-display`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: '../secret.txt', display_name: 'x' })
  });
  check('rename-display ../ 返回 404', rd.status === 404, `status=${rd.status}`);

  // copy 的 filename 已有正则校验（.html/.htm 白名单），../ 直接 400
  const cp = await fetch(`${BASE_URL}/api/shared/copy`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_tenant_id: TENANT_A, filename: '../secret.txt' })
  });
  check('copy ../ 返回 400（正则拦截）', cp.status === 400, `status=${cp.status}`);

  // ===== 3. 合法文件名回归 =====
  const pageOk = await fetch(`${BASE_URL}/${TENANT_A}/pages/normal.html`, { headers: { Cookie: cookie } });
  const pageOkBody = await pageOk.text();
  check('合法文件页面路由 200 且内容一致', pageOk.status === 200 && pageOkBody === NORMAL_CONTENT, `status=${pageOk.status}`);

  const dlOk = await fetch(`${BASE_URL}/api/download?filename=normal.html`, { headers: { 'X-API-Key': API_KEY_A } });
  const dlOkBody = await dlOk.text();
  check('合法文件 download 200 且内容一致', dlOk.status === 200 && dlOkBody === NORMAL_CONTENT, `status=${dlOk.status}`);

  const rnOk = await fetch(`${BASE_URL}/api/rename`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_filename: 'normal.html', new_filename: 'renamed.html' })
  });
  const rnOkJson = await rnOk.json();
  check('合法文件 rename 200', rnOk.status === 200 && rnOkJson.success === true, `status=${rnOk.status}`);

  const rdOk = await fetch(`${BASE_URL}/api/rename-display`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'renamed.html', display_name: '改名后' })
  });
  const rdOkJson = await rdOk.json();
  check('合法文件 rename-display 200', rdOk.status === 200 && rdOkJson.success === true, `status=${rdOk.status}`);

  const delOk = await fetch(`${BASE_URL}/api/delete`, {
    method: 'POST', headers: { 'X-API-Key': API_KEY_A, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'renamed.html' })
  });
  const delOkJson = await delOk.json();
  check('合法文件 delete 200', delOk.status === 200 && delOkJson.success === true, `status=${delOk.status}`);

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
