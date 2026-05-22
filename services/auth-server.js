/**
 * 网页分享公共服务 - 多租户版
 * 支持飞书 OAuth 认证 + JWT Token + API_KEY 鉴权
 * 
 * 修复内容：
 * 1. 使用 JWT Token 替代内存 Session，解决服务重启后登录状态丢失问题
 * 2. 修复 multipart/form-data 解析逻辑，正确处理 boundary 提取
 * 3. 增强错误处理和日志记录
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

// 服务配置（全部从环境变量读取）
const PORT = process.env.PORT || 9080;
const CLIENT_ID = process.env.FEISHU_APP_ID;
const CLIENT_SECRET = process.env.FEISHU_APP_SECRET;
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || '';
const BASE_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : '';
const REDIRECT_URI = process.env.REDIRECT_URI || (BASE_URL ? `${BASE_URL}/oauth2/callback` : '');
const STORAGE_BASE_PATH = process.env.STORAGE_BASE_PATH || path.join(__dirname, '..', 'storage');

// SQLite 数据库路径
const DB_PATH = path.join(__dirname, '..', 'data', 'pages.db');

// 初始化数据库
let db;
try {
  console.log('🔧 正在初始化数据库:', DB_PATH);
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    console.log('📁 创建数据库目录:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  // 直接打开数据库，如果文件不存在 SQLite 会自动创建
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('❌ 数据库连接失败:', err.message);
      process.exit(1);
    }
    console.log('✅ 数据库连接成功');
    
    // 创建表
    db.run('CREATE TABLE IF NOT EXISTS page_display_names (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, filename TEXT NOT NULL, display_name TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id, filename))', function(err) {
      if (err) {
        console.error('❌ 创建表失败:', err.message);
        process.exit(1);
      }
    });
    
    // 创建租户表
    db.run('CREATE TABLE IF NOT EXISTS tenants (tenant_id TEXT PRIMARY KEY, api_key TEXT NOT NULL, storage_path TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)', function(err) {
      if (err) {
        console.error('❌ 创建租户表失败:', err.message);
        process.exit(1);
      }
      console.log('✅ SQLite 数据库已初始化');
    });
    
    // 查询并打印租户总数
    db.get('SELECT COUNT(*) as count FROM tenants', function(err, row) {
      if (err) {
        console.error('❌ 查询租户表失败:', err.message);
        return;
      }
      console.log(`📊 数据库租户总数：${row.count}`);
    });
  });
} catch (err) {
  console.error('❌ 数据库初始化失败:', err);
  process.exit(1);
}

// JWT 配置（必须从环境变量读取，禁止硬编码）
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d'; // JWT 有效期 7 天

// 必要配置校验
if (!JWT_SECRET) {
  console.error('❌ 错误：JWT_SECRET 未配置');
  console.error('   请设置环境变量 JWT_SECRET');
  process.exit(1);
}

if (!REDIRECT_URI) {
  console.error('❌ 错误：REDIRECT_URI 未配置');
  console.error('   请设置环境变量 REDIRECT_URI 或 PUBLIC_DOMAIN');
  process.exit(1);
}

console.log('🔐 网页分享公共服务（多租户版 - JWT 增强）');
console.log(`   Port: ${PORT}`);
console.log(`   Redirect URI: ${REDIRECT_URI}`);
console.log(`   存储路径：${STORAGE_BASE_PATH}`);
console.log(`   JWT 有效期：${JWT_EXPIRY}`);

// JWT 工具函数（使用 Node 内置 crypto 实现 HMAC-SHA256 签名）
function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // 7 天
  const fullPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };
  
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(fullPayload)));
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signature] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    
    // 验证签名
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    
    if (signature !== expectedSig) return null;
    
    // 验证过期时间
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.log('⚠️ JWT 已过期');
      return null;
    }
    
    return payload;
  } catch (err) {
    console.error('❌ JWT 验证失败:', err.message);
    return null;
  }
}

// Cookie 处理
function parseCookies(req) {
  const cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      if (k && v) cookies[k] = decodeURIComponent(v);
    });
  }
  return cookies;
}

function setCookie(name, value, maxAge = 604800) {
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Expires=${expires}; SameSite=Lax`;
}

// 获取租户配置（从数据库查询）
function getTenantByApiKey(apiKey) {
  return new Promise((resolve, reject) => {
    db.get('SELECT tenant_id, api_key, storage_path FROM tenants WHERE api_key = ?', [apiKey], function(err, row) {
      if (err) {
        reject(err);
        return;
      }
      if (row) {
        resolve({ id: row.tenant_id, api_key: row.api_key, storage_path: row.storage_path });
      } else {
        resolve(null);
      }
    });
  });
}

// 根据 open_id 获取租户（从数据库查询）
function getTenantByOpenId(openId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT tenant_id, api_key, storage_path FROM tenants WHERE tenant_id = ?', [openId], function(err, row) {
      if (err) {
        reject(err);
        return;
      }
      if (row) {
        resolve({ id: row.tenant_id, api_key: row.api_key, storage_path: row.storage_path });
      } else {
        resolve(null);
      }
    });
  });
}

// 正确提取 boundary（处理分号后的额外参数）
function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=([^;]+)/i);
  return match ? match[1].trim().replace(/['"]/g, '') : null;
}

// 获取 app_access_token
async function getAppAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: CLIENT_ID,
      app_secret: CLIENT_SECRET
    })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 app_access_token 失败：${data.msg}`);
  }
  return data.app_access_token;
}

// 用 code 换取 user_access_token
async function getUserAccessToken(code, appAccessToken) {
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${appAccessToken}`
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code
    })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 user_access_token 失败：${data.msg}`);
  }
  return data.data;
}

// 获取用户信息
async function getUserInfo(userAccessToken) {
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: {
      'Authorization': `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取用户信息失败：${data.msg}`);
  }
  return data.data;
}

// 读取 HTML 文件
function readHtml(filename) {
  const filepath = path.join(__dirname, '..', 'web', filename);
  if (fs.existsSync(filepath)) {
    return fs.readFileSync(filepath, 'utf-8');
  }
  return null;
}

// 设置安全响应头
function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req);
  
  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  
  setSecurityHeaders(res);
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  try {
    // 1. 首页
    if (url.pathname === '/') {
      const html = readHtml('index.html');
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      }
      return;
    }
    
    // 2. API - 检查登录状态（JWT Token 验证）
    if (url.pathname === '/api/check') {
      const jwtToken = cookies.jwt_token;
      if (jwtToken) {
        const payload = verifyJWT(jwtToken);
        if (payload) {
          const tenant = await getTenantByOpenId(payload.open_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            authenticated: true, 
            user: {
              open_id: payload.open_id,
              name: payload.name,
              tenant_id: payload.tenant_id
            },
            api_key: tenant?.api_key || null
          }));
          return;
        }
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    
    // 3. API - 获取登录 URL
    if (url.pathname === '/api/login-url') {
      const state = crypto.randomBytes(16).toString('hex');
      let redirectUrl = url.searchParams.get('redirect') || '/pages.html';
      
      // 将 redirectUrl 存入临时 state（用于 OAuth 回调后跳转）
      const tempState = {
        redirectUrl: redirectUrl,
        created: Date.now()
      };
      
      // 简单内存存储 state（仅用于 OAuth 流程，不存储用户会话）
      if (!global.oauthStates) global.oauthStates = new Map();
      global.oauthStates.set(`state:${state}`, tempState);
      
      const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
      authUrl.searchParams.set('app_id', CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('state', state);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        url: authUrl.toString(),
        state: state
      }));
      return;
    }
    
    // 4. API - 退出登录
    if (url.pathname === '/api/logout') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'jwt_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; HttpOnly'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    
    // 5. OAuth 回调
    if (url.pathname === '/oauth2/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>❌ 授权失败：缺少授权码</h1>');
        return;
      }
      
      try {
        const appAccessToken = await getAppAccessToken();
        const tokenData = await getUserAccessToken(code, appAccessToken);
        const userInfo = await getUserInfo(tokenData.access_token);
        
        console.log(`✅ 用户登录成功：${userInfo.name} (${userInfo.open_id})`);
        
        // 自动注册：首次登录自动创建租户
        const openId = userInfo.open_id;
        let tenant = await getTenantByOpenId(openId);
        if (!tenant) {
          const apiKey = 'sk_' + openId + '_' + crypto.randomBytes(16).toString('hex');
          const storagePath = path.join(STORAGE_BASE_PATH, `tenant-${openId}`);
          
          // 保存到数据库
          await new Promise((resolve, reject) => {
            db.run('INSERT OR REPLACE INTO tenants (tenant_id, api_key, storage_path) VALUES (?, ?, ?)', [openId, apiKey, storagePath], function(err) {
              if (err) {
                reject(err);
                return;
              }
              console.log(`✅ 租户已保存到数据库：${openId}`);
              resolve();
            });
          });
          
          // 创建存储目录
          if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
          }
          
          console.log(`✅ 自动创建租户：${openId}`);
          tenant = { id: openId, api_key: apiKey, storage_path: storagePath };
        }
        
        // 生成 JWT Token（包含用户信息和 API_KEY）
        const jwtToken = generateJWT({
          open_id: openId,
          name: userInfo.name,
          email: userInfo.email || '',
          avatar: userInfo.avatar || '',
          tenant_id: openId,
          api_key: tenant.api_key
        });
        
        // 获取跳转地址
        let redirectUrl = '/pages.html';
        if (global.oauthStates && global.oauthStates.has(`state:${state}`)) {
          const stateData = global.oauthStates.get(`state:${state}`);
          redirectUrl = stateData.redirectUrl || '/pages.html';
          global.oauthStates.delete(`state:${state}`);
        }
        
        res.writeHead(302, {
          'Location': redirectUrl,
          'Set-Cookie': setCookie('jwt_token', jwtToken)
        });
        res.end();
        
      } catch (err) {
        console.error('❌ OAuth 错误:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>❌ 授权失败</h1><p>${err.message}</p>`);
      }
      return;
    }
    
    // 6. API - 文件上传（需要 API_KEY）
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      const contentType = req.headers['content-type'] || '';
      console.log('📝 上传请求 content-type:', contentType);
      
      if (!contentType.includes('multipart/form-data')) {
        console.log('❌ 不是 multipart 格式');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid content type' }));
        return;
      }
      
      const boundary = extractBoundary(contentType);
      console.log('📝 boundary:', boundary);
      if (!boundary) {
        console.log('❌ boundary 提取失败');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid boundary' }));
        return;
      }
      
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          console.log('📝 请求体长度:', body.length);
          const boundaryStr = Buffer.from('--' + boundary);
          
          // 使用 Buffer 分割，保留原始字节
          const parts = [];
          let start = 0;
          let idx;
          while ((idx = body.indexOf(boundaryStr, start)) !== -1) {
            parts.push(body.slice(start, idx));
            start = idx + boundaryStr.length;
          }
          console.log('📝 parts 数量:', parts.length);
          
          let filename = null;
          let fileData = null;
          
          for (const part of parts) {
            if (part.length === 0) continue;
            
            // 将 header 部分转为 UTF-8 字符串来解析 filename
            const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
            if (headerEnd === -1) continue;
            
            const headerStr = part.slice(0, headerEnd).toString('utf8');
            console.log('📝 header:', headerStr.substring(0, 200));
            
            const filenameMatch = headerStr.match(/filename="([^"]+)"/);
            if (filenameMatch) {
              filename = filenameMatch[1];
              console.log('📝 解析出的文件名:', filename, '(长度:', filename.length, ')');
            }
            
            // 文件数据保留为 Buffer
            const dataStart = headerEnd + 4; // \r\n\r\n 长度
            fileData = part.slice(dataStart);
            
            // 移除末尾的 boundary 标记和换行
            const trailingBoundary = Buffer.from('\r\n--');
            const trailingNewline = Buffer.from('\r\n');
            if (fileData.slice(-trailingBoundary.length).equals(trailingBoundary)) {
              fileData = fileData.slice(0, -trailingBoundary.length);
            }
            if (fileData.slice(-trailingNewline.length).equals(trailingNewline)) {
              fileData = fileData.slice(0, -trailingNewline.length);
            }
          }
          
          console.log('📝 最终 filename:', filename, 'fileData 长度:', fileData ? fileData.length : 0);
          
          if (!filename || !fileData) {
            console.log('❌ 文件解析失败：filename=', filename, 'fileData=', fileData ? 'has data' : 'empty');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No file found' }));
            return;
          }
          
          // 文件名校验（添加调试日志）
          const filenameValid = /^[a-zA-Z0-9_\u4e00-\u9fa5\s-]+\.(html|htm)$/i.test(filename);
          console.log('📝 文件名验证:', filename, '有效=', filenameValid);
          if (!filenameValid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '文件名无效：' + filename }));
            return;
          }
          
          const timestamp = Date.now();
          const safeFilename = `${timestamp}-${filename}`;
          
          // 确保存储目录存在
          if (!fs.existsSync(tenant.storage_path)) {
            fs.mkdirSync(tenant.storage_path, { recursive: true });
          }
          
          const filePath = path.join(tenant.storage_path, safeFilename);
          fs.writeFileSync(filePath, fileData);  // fileData 已经是 Buffer
          
          console.log(`✅ 文件上传成功：${tenant.id}/${safeFilename}`);
          
          // 在数据库中创建记录（display_name 为空，后续通过 rename-display 设置）
          db.run('INSERT OR IGNORE INTO page_display_names (tenant_id, filename, display_name) VALUES (?, ?, ?)', [tenant.id, safeFilename, ''], function(err) {
            if (err) {
              console.error('❌ 数据库写入失败:', err.message);
            } else {
              console.log(`✅ 数据库记录已创建：${tenant.id}/${safeFilename}`);
            }
          });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            filename: safeFilename,
            url: BASE_URL ? `${BASE_URL}/${tenant.id}/pages/${safeFilename}` : `/${tenant.id}/pages/${safeFilename}`
          }));
        } catch (err) {
          console.error('❌ 上传错误:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文件解析失败：' + err.message }));
        }
      });
      return;
    }
    
    // 7. API - 文件列表（需要 API_KEY）
    if (url.pathname === '/api/list' && req.method === 'GET') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      if (!fs.existsSync(tenant.storage_path)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pages: [] }));
        return;
      }
      
      const files = fs.readdirSync(tenant.storage_path)
        .filter(f => /\.(html|htm)$/i.test(f))
        .map(f => {
          const stats = fs.statSync(path.join(tenant.storage_path, f));
          
          // 从数据库读取 display_name
          let displayName = null;
          return new Promise((resolve) => {
            db.get('SELECT display_name FROM page_display_names WHERE tenant_id = ? AND filename = ?', [tenant.id, f], (err, row) => {
              if (row) {
                displayName = row.display_name;
              }
              resolve({
                filename: f,
                display_name: displayName,
                url: BASE_URL ? `${BASE_URL}/${tenant.id}/pages/${f}` : `/${tenant.id}/pages/${f}`,
                size: stats.size,
                createdAt: stats.birthtime
              });
            });
          });
        });
      
      Promise.all(files).then(pages => {
        pages.sort((a, b) => b.createdAt - a.createdAt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pages: pages }));
      }).catch(err => {
        console.error('❌ 读取文件列表失败:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
    
    // 8. API - 文件下载（需要 API_KEY）
    if (url.pathname === '/api/download' && req.method === 'GET') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      const filename = url.searchParams.get('filename');
      if (!filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 filename 参数' }));
        return;
      }
      
      const filePath = path.join(tenant.storage_path, filename);
      
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      
      const fileData = fs.readFileSync(filePath);
      const downloadName = filename.replace(/^\d+-upload-/, '').replace(/^\d+-/, '');
      
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
        'Content-Length': fileData.length
      });
      res.end(fileData);
      return;
    }
    
    // 9. API - 文件重命名（需要 API_KEY）
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const { old_filename, new_filename } = JSON.parse(body);
          
          if (!old_filename || !new_filename) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 old_filename 或 new_filename' }));
            return;
          }
          
          // 文件名格式校验
          const filenameValid = /^[a-zA-Z0-9_\u4e00-\u9fa5\s-]+\.(html|htm)$/i.test(new_filename);
          if (!filenameValid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '新文件名无效，必须以 .html 或 .htm 结尾' }));
            return;
          }
          
          const oldPath = path.join(tenant.storage_path, old_filename);
          const newPath = path.join(tenant.storage_path, new_filename);
          
          if (!fs.existsSync(oldPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '原文件不存在' }));
            return;
          }
          
          if (fs.existsSync(newPath)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '目标文件名已存在' }));
            return;
          }
          
          fs.renameSync(oldPath, newPath);
          console.log(`✅ 文件重命名成功：${tenant.id}/${old_filename} -> ${new_filename}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, old_filename, new_filename }));
        } catch (err) {
          console.error('❌ 重命名错误:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    
    // 9.5 API - 更新显示名称（需要 API_KEY）
    if (url.pathname === '/api/rename-display' && req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const { filename, display_name } = JSON.parse(body);
          
          if (!filename || !display_name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 filename 或 display_name' }));
            return;
          }
          
          // 检查文件是否存在
          const filePath = path.join(tenant.storage_path, filename);
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '文件不存在' }));
            return;
          }
          
          // 更新或插入数据库记录
          db.run('INSERT OR REPLACE INTO page_display_names (tenant_id, filename, display_name, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [tenant.id, filename, display_name], function(err) {
            if (err) {
              console.error('❌ 数据库更新失败:', err.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
              return;
            }
            
            console.log(`✅ 显示名称已更新：${tenant.id}/${filename} -> ${display_name}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, filename, display_name }));
          });
        } catch (err) {
          console.error('❌ 更新显示名称错误:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    
    // 10. API - 文件删除（需要 API_KEY）
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 API_KEY' }));
        return;
      }
      
      const tenant = await getTenantByApiKey(apiKey);
      if (!tenant) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的 API_KEY' }));
        return;
      }
      
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const { filename } = JSON.parse(body);
          
          const filePath = path.join(tenant.storage_path, filename);
          
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
          }
          
          fs.unlinkSync(filePath);
          console.log(`✅ 文件删除成功：${tenant.id}/${filename}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          console.error('❌ 删除错误:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    
    // 9. 页面管理界面（JWT 验证）
    if (url.pathname === '/pages.html') {
      const jwtToken = cookies.jwt_token;
      if (!jwtToken) {
        res.writeHead(302, { 'Location': '/?redirect=/pages.html' });
        res.end();
        return;
      }
      
      const payload = verifyJWT(jwtToken);
      if (!payload) {
        res.writeHead(302, { 'Location': '/?redirect=/pages.html' });
        res.end();
        return;
      }
      
      const html = readHtml('pages.html');
      if (html) {
        // 注入租户信息
        const modifiedHtml = html.replace(
          '</head>',
          `<script>window.CURRENT_TENANT = ${JSON.stringify({id: payload.tenant_id, isAdmin: true})};</script></head>`
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(modifiedHtml);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      }
      return;
    }
    
    // 10. 租户页面文件（JWT 验证）
    if (url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/pages\//)) {
      const match = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/pages\/(.+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      
      const tenantId = match[1];
      const filename = decodeURIComponent(match[2]);
      const currentPath = url.pathname;
      
      // 检查 JWT 登录状态
      const jwtToken = cookies.jwt_token;
      if (!jwtToken) {
        res.writeHead(302, { 'Location': '/?redirect=' + encodeURIComponent(currentPath) });
        res.end();
        return;
      }
      
      const payload = verifyJWT(jwtToken);
      if (!payload) {
        res.writeHead(302, { 'Location': '/?redirect=' + encodeURIComponent(currentPath) });
        res.end();
        return;
      }
      
      const tenant = await getTenantByOpenId(tenantId);
      if (!tenant) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 租户不存在</h1>');
        return;
      }
      
      const filePath = path.join(tenant.storage_path, filename);
      
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 文件不存在</h1>');
        return;
      }
      
      // 根据文件扩展名设置 Content-Type
      const ext = path.extname(filename).toLowerCase();
      let contentType = 'text/html; charset=utf-8';
      if (ext === '.png') contentType = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.gif') contentType = 'image/gif';
      else if (ext === '.webp') contentType = 'image/webp';
      else if (ext === '.svg') contentType = 'image/svg+xml';
      else if (ext === '.css') contentType = 'text/css';
      else if (ext === '.js') contentType = 'application/javascript';
      
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return;
    }
    
    // 默认 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    
  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ 服务已启动');
  console.log(`📱 本地访问地址：http://localhost:${PORT}`);
  if (PUBLIC_DOMAIN) {
    console.log(`🌐 公网访问地址：https://${PUBLIC_DOMAIN}`);
  }
});

// 全局异常处理 - 防止进程意外退出
process.on('uncaughtException', (err) => {
  console.error('💥 [Uncaught Exception]', new Date().toISOString());
  console.error(err);
  // 不退出进程，继续服务
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [Unhandled Rejection]', new Date().toISOString());
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  // 不退出进程，继续服务
});

process.on('SIGINT', () => {
  console.log('\n✅ 服务已停止 (SIGINT)');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n✅ 服务已停止 (SIGTERM)');
  process.exit(0);
});
