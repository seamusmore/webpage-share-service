# 需求 #164 — 共享视图主题适配（状态图标 emoji 改 SVG + 主题变量排查）

## 问题定性

主人 11772（带截图）指出共享板块未适配主题：`web/pages.html` 共享视图三处状态图标用 emoji，颜色由平台渲染、不随主题变量变化（light 主题下黑乎乎突兀），dark/arknights/endfield/genshin 下同样不协调。同文件其他图标（下载、星标、上传等）均走 Feather SVG 线条 + `stroke="currentColor"` + CSS 变量体系。

具体三处（需求点名）：
- 加载态：`renderSharedLoading` 1743 行 `⏳`
- 失败态：`renderSharedError` 1753 行 `⚠️`
- 空态：`renderShared` 1812 行 `🔍`（搜索无结果）/ `🔗`（空列表）

排查另发现两处同类问题：
- 共享卡片来源前缀 1873 行 `👤`（emoji 文本，同属「禁 emoji」违规）
- 失效徽标 `.shared-status`（441–447 行）硬编码 `#B91C1C`/`#ffffff`，未走主题变量

## 改动范围

### 1. 三处状态图标 emoji → SVG 线条图标（核心）

沿用项目现有 Feather 线条规格：`fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`，`width/height=56`，`viewBox="0 0 24 24"`。

| 位置 | 原 emoji | 改 SVG | path（项目内已复用同一 Feather 图形） |
|---|---|---|---|
| 1743 加载态 | ⏳ | clock | `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>` |
| 1753 失败态 | ⚠️ | alert-circle | `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>` |
| 1812 空态·搜索无结果 | 🔍 | search | `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>` |
| 1812 空态·空列表 | 🔗 | link | `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>` |

颜色：`.empty-state .icon` 由 `font-size: 64px` 改为 `color: var(--fg-text-muted)`，SVG 以 `stroke="currentColor"` 继承（与空态描述文字 `--fg-text-muted` 一致，六主题均已定义该变量）。

### 2. 来源前缀 emoji → user SVG（1873 行）

`'👤 来源：'` 改为 Feather user 图标 + `来源：` 文本：`<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`（项目 678 行已复用），`width/height=14`，`stroke="currentColor"`，随该行 `color: var(--meta-filename)`。

### 3. 失效徽标主题变量化（441–447 行）

引入危险语义变量并替换硬编码：
- 六主题 css（light/dark/arknights/endfield/genshin/classic）`:root` 各加 `--danger-bg: #B91C1C; --danger-fg: #ffffff;`（失效=危险语义色，跨主题统一）
- `.shared-status`：`background: var(--danger-bg); color: var(--danger-fg);`

## 排查结论（scope ②）

共享视图其余元素已走主题变量，无需改动：卡片 `.shared-card` 继承 `.page-card`（bg-card/border-card/shadow-card）、标题/元信息用 `--fg-text-strong`/`--meta-filename`/`--meta-time`、按钮 `.shared-copy-btn`/`.open-btn` 用 `--btn-*`/`--accent` 变量。唯一未走变量的是失效徽标（已列入改动 3）与三处 + 👤 emoji（改动 1、2）。

## 五主题验证（验收）

`web/themes/` 现有 light/dark/arknights/endfield/genshin/classic 六主题。验收对 light/dark/arknights/endfield/genshin 五主题，分别截图共享视图各状态：
- 空态（无共享）、空态（搜索无结果）、列表态（含失效徽标卡片）、加载态、失败态

判据：图标为 SVG 线条、颜色随主题变量变化、无 emoji、五主题下可读且风格一致。

## 回归

不改共享视图交互与数据逻辑（loadShared/renderShared/buildSharedCard/saveSharedCopy 逻辑不动），仅替换图标渲染与徽标变量。回归：共享视图功能（打开记录、列表、保存副本、失效禁用）与既有测试（test_shared.js 31 项、test_traversal.js 16 项）不受影响。

## 验收依据

1. 三处状态图标 + 👤 改为 SVG 线条图标，颜色走主题变量，无 emoji。
2. light/dark/arknights/endfield/genshin 五主题下共享视图各状态截图可读且风格一致。
3. `.shared-status` 徽标走 `--danger-bg/--danger-fg` 变量。
4. 回归不受影响。
