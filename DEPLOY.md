# 部署指南

## 配置概述

| 层级 | 位置 | 内容 | 进 Git |
|------|------|------|--------|
| 服务配置 | `.env` | JWT_SECRET、域名、飞书凭证、端口 | ❌ |
| 租户数据 | `data/tenants.json` | API keys、storage_path、用户列表 | ❌ |
| 示例模板 | `tenants.example.json` | 结构示例，无真实数据 | ✅ |

---

## 1. 环境变量（必填）

```bash
cp .env.example .env
```

```bash
JWT_SECRET=your-random-jwt-secret-at-least-32-characters-long
PUBLIC_DOMAIN=your-domain.com
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxxx
```

| 环境变量 | 说明 | 必填 | 默认值 |
|----------|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥，至少 32 位 | 是 | - |
| `PUBLIC_DOMAIN` | 公网域名 | 是 | - |
| `FEISHU_APP_ID` | 飞书应用 ID | 是 | - |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 是 | - |
| `REDIRECT_URI` | OAuth 回调地址 | 否 | `https://${PUBLIC_DOMAIN}/oauth2/callback` |
| `PORT` | 服务端口 | 否 | 9080 |
| `STORAGE_BASE_PATH` | 文件存储基础路径 | 否 | `./storage` |

---

## 2. 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 配置：
   - 应用名称：网页分享服务
   - 桌面端访问 URL：`https://your-domain.com`
   - 开发配置 → 重定向 URL：`https://your-domain.com/oauth2/callback`
4. 将 App ID 和 App Secret 填入 `.env`

## 3. 租户数据

租户不需要手动配置。用户首次通过飞书 OAuth 登录时，服务会自动以其 open_id 作为 tenant_id 创建租户，自动生成 API_KEY 和 storage_path，并写入 `data/tenants.json`。

若需要人工创建租户，可参考 `tenants.example.json` 的格式：

```json
{
  "tenants": {
    "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": {
      "api_key": "sk_ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "storage_path": "./storage/tenant-ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

> `data/tenants.json` 已在 `.gitignore` 中，不会被提交。

---

## 4. 启动服务

### 方式一：直接运行

```bash
source .env
node services/auth-server.js
```

### 方式二：PM2

```bash
pm2 start ecosystem.config.js
```

### 方式三：systemd（推荐生产环境）

创建 `/etc/systemd/system/webpage-share.service`：

```ini
[Unit]
Description=Webpage Share Service
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/path/to/webpage-share-service
ExecStart=/usr/bin/node services/auth-server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/path/to/webpage-share-service/.env

[Install]
WantedBy=multi-user.target
```

启用并启动：
```bash
sudo systemctl daemon-reload
sudo systemctl enable webpage-share
sudo systemctl start webpage-share
```

---

## 5. 反向代理

**Caddy：**
```caddyfile
your-domain.com {
    reverse_proxy localhost:9080
}
```

**Nginx：**
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:9080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 运维管理

### 查看日志

```bash
# 应用日志
tail -f logs/out.log
tail -f logs/error.log

# systemd 日志
sudo journalctl -u webpage-share -f
```

### 管理命令（systemd）

```bash
sudo systemctl start webpage-share
sudo systemctl stop webpage-share
sudo systemctl restart webpage-share
sudo systemctl status webpage-share
```

### 管理命令（PM2）

```bash
pm2 start ecosystem.config.js
pm2 stop webpage-share
pm2 restart webpage-share
pm2 logs webpage-share
pm2 monit
```

---

## 故障排查

| 问题 | 解决 |
|------|------|
| 服务启动失败，提示 JWT_SECRET 未配置 | 检查 `.env` 文件是否存在且已 source |
| API_KEY 无效 | 检查 `data/tenants.json` 中的 `api_key` |
| 飞书登录失败 | 检查 `.env` 中的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，以及飞书后台的重定向 URL 配置 |
| 403 禁止访问 | 确认用户 open_id 在对应租户的 `members` 列表中 |
| 文件上传成功但链接打不开 | 检查 `PUBLIC_DOMAIN` 是否正确，以及反向代理是否配置 |

---

## 回滚

如果 systemd 方式有问题，回滚到 PM2：

```bash
sudo systemctl stop webpage-share
sudo systemctl disable webpage-share
sudo rm /etc/systemd/system/webpage-share.service
sudo systemctl daemon-reload

cd /path/to/webpage-share-service
pm2 start ecosystem.config.js
```

---

**版本**: 2.0.0
