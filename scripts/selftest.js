#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const DB_PATH = '/mnt/webpage-share-service/data/pages.db';
const TENANT_DIR = 'tenant-ou_1d5e4a5f7fc3a99fd3379271ec9294df';

const apiKey = execSync(`sqlite3 ${DB_PATH} "SELECT api_key FROM tenants WHERE tenant_id='ou_1d5e4a5f7fc3a99fd3379271ec9294df';"`).toString().trim();

function makeRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 9080, path, method, headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey } };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  // 用第一个文件测试
  const list = await makeRequest('/api/list', 'GET');
  const testFile = list.pages[0].filename;
  const newFilename = 'test-rd-' + Date.now() + '.html';
  
  console.log('=== Rename ===');
  const r = await makeRequest('/api/rename', 'POST', { old_filename: testFile, new_filename: newFilename });
  console.log(r.success ? '✓ rename OK' : '✗ rename FAIL: ' + JSON.stringify(r));
  
  console.log('\n=== Rename-Display ===');
  const rd = await makeRequest('/api/rename-display', 'POST', { filename: newFilename, display_name: '自测显示名' });
  console.log(rd.success ? '✓ rename-display OK' : '✗ rename-display FAIL: ' + JSON.stringify(rd));
  
  const dbDisplay = execSync(`sqlite3 ${DB_PATH} "SELECT display_name FROM page_display_names WHERE filename='${newFilename}';"`).toString().trim();
  console.log(`DB display_name: ${dbDisplay === '自测显示名' ? '✓ 正确' : '✗ 错误: ' + dbDisplay}`);
  
  console.log('\n=== Delete ===');
  const d = await makeRequest('/api/delete', 'POST', { filename: newFilename });
  console.log(d.success ? '✓ delete OK' : '✗ delete FAIL: ' + JSON.stringify(d));
  
  const diskExists = fs.existsSync(`/mnt/webpage-share-service/storage/${TENANT_DIR}/${newFilename}`);
  console.log(`磁盘文件: ${diskExists ? '✗ 还在!' : '✓ 已删除'}`);
  
  const dbCount = execSync(`sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM page_display_names WHERE filename='${newFilename}';"`).toString().trim();
  console.log(`DB记录: ${dbCount === '0' ? '✓ 已删除' : '✗ 还在!'}`);
  
  console.log('\n=== 验证列表接口返回 ===');
  const list2 = await makeRequest('/api/list', 'GET');
  const found = list2.pages.find(p => p.filename === newFilename);
  console.log(found ? '✗ 文件还在列表中!' : '✓ 文件不在列表中');
  
  console.log('\n=== 全部自测完成 ===');
}

test().catch(e => { console.error(e); process.exit(1); });
