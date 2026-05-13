# 网页分享公共服务

> 多租户网页分享服务，支持飞书 OAuth 认证和 API_KEY 鉴权

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
│   └── tenants.json         # 租户运行时数据（API_KEY、成员列表）
├── storage/                 # 文件存储（多租户隔离）
│   ├── tenant-group1/
│   ├── tenant-group2/
│   └── tenant-group3/
├── tenants.example.json     # 租户配置示例
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

### tenants.json

租户数据通常由服务自动管理。用户首次通过飞书 OAuth 登录时，服务会自动以其 open_id 作为 tenant_id 创建租户，生成 API_KEY 和 storage_path。

如需手动创建或修改租户，可参照以下格式：

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

### 上传文件
```
POST /api/upload
Headers: X-API-Key: ***
```

### 文件列表
```
GET /api/list?tenant=group1
Headers: X-API-Key: ***
```

### 删除文件
```
DELETE /api/delete
Headers: X-API-Key: ***
```

---

**版本**: 2.0.0 (多租户版)
**创建日期**: 2026-04-08
