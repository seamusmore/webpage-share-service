# 网页分享公共服务

> 为Agent打造的多租户网页分享服务，支持飞书 OAuth 认证和 API_KEY 鉴权。
> 
> Agent喜欢写html来分享内容，需要手动下载下来用浏览器打开才能查看。本项目专为解决此问题而生。
> 
> 部署该服务后，可以让Agent直接把html上传到该服务，直接远程查看。

---

## 架构

- **单实例部署**：部署在公共服务器
- **多租户隔离**：每组独立存储和 API_KEY，租户之间数据完全隔离
- **统一认证**：飞书 OAuth 登录

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
│   └── pages.html          # 管理页面（上传/删除/列表）
├── data/
│   └── pages.db            # SQLite 数据库（租户、文件显示名称）
├── storage/                 # 文件存储（多租户隔离）
│   ├── tenant-group1/
│   ├── tenant-group2/
│   └── tenant-group3/
└── README.md
```

---

## 访问地址

| 页面 | 地址 | 说明 |
|------|------|------|
| 首页（登录） | `https://your-domain.com/` | 飞书 OAuth 登录入口 |
| 管理页面 | `https://your-domain.com/pages.html` | 上传、删除、查看文件列表 |

---

## 部署

```bash
cd /path/to/webpage-share-service
node services/auth-server.js
```

---

## 配置

### 1. 创建飞书网页应用
**注意：**这里配置的飞书应用必须添加为网页应用，而非机器人应用。

需要在该应用中进行以下配置：
1. 网页应用：
   - 网页应用配置 - 桌面端主页，设为：https://your-domain.com
   - 网页应用配置 - 移动端主页，设为：https://your-domain.com
2. 权限管理：
   需要添加以下权限：
   ```
   auth:user_access_token:read
   contact:user.base:readonly
   contact:user.basic_profile:readonly
   contact:user.employee_id:readonly
   offline_access
   ```
4. 安全设置：
   重定向URL，添加：
   ```
   https://your-domain.com/oauth2/callback
   https://open.feishu.cn/api-explorer/loading
   ```

   H5可信域名，添加：
   ```
   https://your-domain.com/oauth2/callback
   ```

### 2. 环境变量（必填）

项目根目录下有 `.env.example` 文件，复制为 `.env` 后填写：

```bash
cp .env.example .env
```

然后编辑 `.env`，填入以下必填项：

| 变量 | 说明 | 示例 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥，至少32位随机字符串 | `your-random-jwt-secret-xxx` |
| `PUBLIC_DOMAIN` | 公网域名，用于生成分享链接和 OAuth 回调 | `your-domain.com` |
| `FEISHU_APP_ID` | 飞书应用 ID | `cli_xxxxx` |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | `xxxxxxxxx` |

可选配置项见 `.env.example` 内注释。`.env` 已加入 `.gitignore`，不会被提交。

### 3. 租户数据

租户数据由 SQLite 数据库（`data/pages.db`）自动管理，无需手动配置。用户首次通过飞书 OAuth 登录时，服务会自动以其 open_id 作为 tenant_id 创建租户，生成 API_KEY 和 storage_path，并写入数据库。

如需手动创建或修改租户，可参照以下格式，但实际数据以数据库为准：

```json
{
  "tenants": {
    "ou_xxx": {
      "api_key": "sk_ou_xxx",
      "storage_path": "./storage/tenant-ou_xxx/"
    }
  }
}
```

---

## API

### 获取 API_KEY

1. 通过飞书 OAuth 登录管理页面 `https://your-domain.com/pages.html`
2. 登录后点击右上角 **🔑 API Key** 按钮
3. 在弹窗中查看自己的 API_KEY，点击 **拷贝** 按钮复制到剪贴板

> 提示：API_KEY 默认脱敏显示，点击旁边的 👁️ 按钮可切换显示/隐藏。

### 上传文件
```
POST /api/upload
Headers: X-API-Key: <你的_API_KEY>
```

### 文件列表
```
GET /api/list?tenant=group1
Headers: X-API-Key: <你的_API_KEY>
```

### 删除文件
```
DELETE /api/delete
Headers: X-API-Key: <你的_API_KEY>
```

---

**版本**: 2.0.0 (多租户版)
**创建日期**: 2026-04-08
