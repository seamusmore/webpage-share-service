#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const TENANT_DIR = 'tenant-ou_1d5e4a5f7fc3a99fd3379271ec9294df';
const apiKey = process.env.TEST_API_KEY;

let passed = 0, failed = 0;
function check(name, cond) { cond ? console.log(`✓ ${name}`) : (console.log(`✗ ${name}`), failed++); if (cond) passed++; }

function req(path, method, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname:'localhost', port:9080, path, method, headers:{'Content-Type':'application/json','X-API-Key':apiKey} };
    const r = http.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){resolve(d)}}); });
    r.on('error', reject); if(body) r.write(JSON.stringify(body)); r.end();
  });
}

async function test() {
  console.log('=== 1. API认证检查 ===');
  const r1 = await new Promise(r => { http.get({hostname:'localhost',port:9080,path:'/api/list',headers:{'Content-Type':'application/json'}}, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>r(JSON.parse(d)));}); });
  check('无API_KEY被拒绝', r1.error === '缺少 API_KEY');
  
  console.log('\n=== 2. 文件列表 ===');
  const list = await req('/api/list', 'GET');
  check('列表返回正常', list.success === true && list.pages.length > 0);
  check('有display_name字段', list.pages[0].display_name !== undefined);
  
  const testFile = list.pages[0].filename;
  const ts = Date.now();
  const newFn = `test-self-${ts}.html`;
  
  console.log('\n=== 3. rename（改文件名+同步DB）===');
  const rename = await req('/api/rename', 'POST', { old_filename: testFile, new_filename: newFn });
  check('rename成功', rename.success === true);
  check('磁盘文件已改名', fs.existsSync(`/mnt/webpage-share-service/storage/${TENANT_DIR}/${newFn}`));
  
  const list2 = await req('/api/list', 'GET');
  const found = list2.pages.find(p => p.filename === newFn);
  check('新文件在列表中', found !== undefined);
  
  console.log('\n=== 4. rename-display ===');
  const rd = await req('/api/rename-display', 'POST', { filename: newFn, display_name: '测试显示名' });
  check('rename-display成功', rd.success === true);
  check('display_name已更新', rd.display_name === '测试显示名');
  
  const list3 = await req('/api/list', 'GET');
  const found3 = list3.pages.find(p => p.filename === newFn);
  check('列表中display_name已更新', found3 && found3.display_name === '测试显示名');
  
  console.log('\n=== 5. download ===');
  const dl = await new Promise(r => { http.get({hostname:'localhost',port:9080,path:`/api/download?filename=${newFn}`,headers:{'X-API-Key':apiKey}}, res=>r({status:res.statusCode})); });
  check('download返回200', dl.status === 200);
  
  console.log('\n=== 6. delete ===');
  const del = await req('/api/delete', 'POST', { filename: newFn });
  check('delete成功', del.success === true);
  check('磁盘文件已删除', !fs.existsSync(`/mnt/webpage-share-service/storage/${TENANT_DIR}/${newFn}`));
  
  const list4 = await req('/api/list', 'GET');
  const found4 = list4.pages.find(p => p.filename === newFn);
  check('DB记录已删除', found4 === undefined);
  
  console.log(`\n=== 结果: ${passed}通过 ${failed}失败 ===`);
  if (failed > 0) process.exit(1);
}

test().catch(e => { console.error(e); process.exit(1); });
