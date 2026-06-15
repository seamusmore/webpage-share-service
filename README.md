# 网页分享公共服务

> 为Agent打造的多租户网页分享服务，支持飞书 OAuth 认证和 API_KEY 鉴权。
> 
> Agent喜欢写html来分享内容，需要手动下载下来用浏览器打开才能查看。本项目专为解决此问题而生。
> 
> 部署该服务后，可以让Agent直接把html上传到该服务，直接远程查看。

---

## 架构

- **systemd 部署**：通过 systemd user service 管理，开机自启
- **多租户隔离**：每组独立存储和 API_KEY，租户之间数据完全隔离
- **统一认证**：飞书 OAuth 登录 + JWT Token + API_KEY 鉴权
- **SQLite 数据库**：存储租户信息和文件元数据（文件名、显示名映射）

### 多租户隔离机制

| 隔离维度 | 说明 |
|---------|------|
| 存储隔离 | 每个租户拥有独立的 `storage_path` 目录，文件物理隔离 |
| API_KEY 隔离 | 每个租户拥有独立的 API_KEY，调用 API 时严格校验 |
| 访问隔离 | JWT Token 绑定租户，用户只能访问自己租户的文件 |

---

## 目录结构

```
webpage-share-service/
├── services/
│   └── auth-server.js      # 主服务（OAuth + API）
├── web/
│   ├── index.html          # 首页（登录页）
│   └── pages.html          # 管理页面（上传/删除/列表/改名）
├── data/
│   └── pages.db            # SQLite 数据库（租户、文件显示名称）
├── storage/                 # 文件存储（多租户隔离）
│   ├── tenant-ou_xxx/
│   └── tenant-ou_yyy/
├── scripts/
│   ├── migrate-files.js     # 数据迁移脚本
│   └── selftest.js          # 自测脚本
├── .env                     # 环境变量（不提交）
├── ecosystem.config.js      # PM2 配置（已废弃，保留兼容）
└── README.md
```

---

## 访问地址

| 页面 | 地址 | 说明 |
|------|------|------|
| 首页（登录） | `https://your-domain.com/` | 飞书 OAuth 登录入口 |
| 管理页面 | `https://your-domain.com/pages.html` | 上传、删除、查看文件列表、改名 |

---

## 部署

### systemd 方式（推荐）

```bash
# 1. 复制 service 文件
cp webpage-share.service ~/.config/systemd/user/

# 2. 重载 systemd
systemctl --user daemon-reload

# 3. 启动并启用开机自启
systemctl --user enable --now webpage-share.service

# 4. 查看状态
systemctl --user status webpage-share.service
```

### 直接运行

```bash
cd /path/to/webpage-share-service
node services/auth-server.js
```

---

## 配置

### 1. 创建飞书网页应用

需要在该应用中进行以下配置：

1. **网页应用配置**：
   - 桌面端主页：`https://your-domain.com`
   - 移动端主页：`https://your-domain.com`

2. **权限管理**：
   ```
   auth:user_access_token:read
   contact:user.base:readonly
   contact:user.basic_profile:readonly
   contact:user.employee_id:readonly
   offline_access
   ```

3. **安全设置**：
   - 重定向URL：`https://your-domain.com/oauth2/callback`
   - H5可信域名：`https://your-domain.com`

### 2. 环境变量

项目根目录下有 `.env.example` 文件，复制为 `.env` 后填写：

```bash
cp .env.example .env
```

| 变量 | 说明 | 示例 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥，至少32位随机字符串 | `your-random-jwt-secret-xxx` |
| `PUBLIC_DOMAIN` | 公网域名，用于生成分享链接和 OAuth 回调 | `your-domain.com` |
| `FEISHU_APP_ID` | 飞书应用 ID | `cli_xxxxx` |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | `xxxxxxxxx` |

`.env` 已加入 `.gitignore`，不会被提交。

### 3. 租户数据

租户数据由 SQLite 数据库（`data/pages.db`）自动管理。用户首次通过飞书 OAuth 登录时，服务会自动以其 `open_id` 作为 `tenant_id` 创建租户，生成 `API_KEY` 和 `storage_path`，并写入数据库。

---

## API

### 获取 API_KEY

1. 通过飞书 OAuth 登录管理页面 `https://your-domain.com/pages.html`
2. 登录后点击右上角 **🔑 API Key** 按钮
3. 在弹窗中查看自己的 API_KEY

> 提示：API_KEY 默认脱敏显示，点击旁边的 👁️ 按钮可切换显示/隐藏。

### 所有 API 均需认证

| 接口 | 方法 | 认证方式 | 说明 |
|------|------|---------|------|
| `/api/upload` | POST | API_KEY | 上传 HTML 文件 |
| `/api/list` | GET | API_KEY | 获取文件列表 |
| `/api/download` | GET | API_KEY | 下载 HTML 文件 |
| `/api/rename` | POST | API_KEY | 重命名文件（改文件名+同步DB） |
| `/api/rename-display` | POST | API_KEY | 更新显示名称（不改文件名） |
| `/api/delete` | POST | API_KEY | 删除文件（同步删DB记录） |
| `/api/check` | GET | JWT Token | 检查登录状态 |
| `/api/login-url` | GET | 无 | 获取飞书登录URL |
| `/api/logout` | POST | 无 | 退出登录 |
| `/oauth2/callback` | GET | 无 | 飞书 OAuth 回调 |
| `/:tenantId/pages/:file` | GET | JWT Token | 访问租户页面文件 |

### 上传文件

```
POST /api/upload
Headers: X-API-Key: <你的_API_KEY>
Body: multipart/form-data (file)
```

### 文件列表

```
GET /api/list
Headers: X-API-Key: <你的_API_KEY>
```

### 下载文件

```
GET /api/download?filename=<文件名>
Headers: X-API-Key: <你的_API_KEY>
```

### 重命名文件

```
POST /api/rename
Headers: X-API-Key: <你的_API_KEY>
Body: {"old_filename": "原文件名", "new_filename": "新文件名"}
```

同时修改磁盘文件名和数据库记录。

### 更新显示名称

```
POST /api/rename-display
Headers: X-API-Key: <你的_API_KEY>
Body: {"filename": "文件名", "display_name": "显示名称"}
```

仅修改数据库中的显示名称，不改文件名。

### 删除文件

```
POST /api/delete
Headers: X-API-Key: <你的_API_KEY>
Body: {"filename": "文件名"}
```

同时删除磁盘文件和数据库记录。

---

## 数据管理

### 数据迁移

扫描磁盘文件，补录到数据库：

```bash
cd /mnt/webpage-share-service
node scripts/migrate-files.js
```

### 自测

```bash
cd /mnt/webpage-share-service
TEST_API_KEY=<你的API_KEY> node scripts/selftest.js
```

覆盖 rename、rename-display、download、delete 全流程测试。

---

## 版本历史

- **2.1.0** (2026-06-15) — rename同步DB、upload直接存display_name、delete同步删DB记录、systemd部署、数据迁移
- **2.0.0** (2026-05-22) — 多租户版，SQLite数据库，飞书OAuth认证

**创建日期**: 2026-04-08
