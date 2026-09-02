# 前端部署管理器

[![Windows 云端构建](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-windows.yml/badge.svg?branch=tauri)](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-windows.yml)
[![macOS 云端构建](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-macos.yml/badge.svg?branch=tauri)](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-macos.yml)

一个本地运行的前端发布辅助工具，支持从 Git 项目读取信息、执行构建打包，并通过 SSH 上传到目标服务器完成部署。

## 云端下载（仓库首页）

- Windows 安装包下载入口：  
  [https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-windows.yml](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-windows.yml)
- macOS 安装包下载入口：  
  [https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-macos.yml](https://github.com/zcdzfd797/front-deploy/actions/workflows/tauri-macos.yml)
- 下载说明：进入最新一次成功运行，在 `Artifacts` 中下载：  
  `windows-bundle`（Windows）或 `macos-bundle`（macOS）

## 当前能力

### 1. 项目管理

- 添加项目：选择工作副本路径，自动解析 Git 信息（分支、提交哈希、提交信息、提交时间）
- 编辑项目：维护项目名称、路径、分组、构建命令，并关联/解除多个部署目标
- 编辑约束：`最新提交 Hash` 与 `提交信息` 在编辑页为只读，不允许手动修改
- 删除项目：二次确认，避免误删

### 2. 服务器与部署目标（多对多）

- 左下角“服务器管理”统一维护服务器（地址/端口/账号/密码或私钥）及其部署路径
- 服务器之间、同一服务器内的路径之间均支持“上移/下移”排序，顺序持久化并同步到目标选择器与“按目标”视图
- 一台服务器可维护多个部署路径（部署路径 + 可选备份路径），凭据只保存一份
- 一个项目可关联多个部署目标；一个部署目标可被多个项目复用
- 支持 FinalShell JSON 导入服务器配置；被项目引用的服务器/路径禁止删除
- 首次启动自动把旧版 `projects.json`（项目内嵌 deploy 字段）迁移为“服务器 + 多对多关联”格式，迁移前会备份为 `projects.json.v1.bak`

### 3. 分组与检索

- 左侧分组导航支持快速切组
- 分组支持输入框回车新建
- 支持删除空分组（组内存在项目时禁止删除）
- 支持关键词搜索（含服务器名/部署路径）与部署状态筛选（全部/可部署/已部署/待补配置/已打包）
- 中心区支持「按项目 / 按目标」双视图切换：按目标视图按“服务器·路径”分组列出部署到该目标的所有项目，支持单目标直发

### 4. 打包与部署

- 打包前执行 Git 一致性校验（远程/本地）与分支校验
- 执行构建命令并实时输出日志（SSE）
- 自动识别构建产物目录并压缩为 zip
- 部署时先弹出目标多选（默认全选，支持全选/反选），确认后按顺序逐个目标部署
- 单个目标失败不影响后续目标，结束汇总“成功/失败”数量
- 项目卡片上的目标标签可点击单发部署到该目标
- 每个目标独立记录部署时间与状态（支持“部分部署”状态）
- 部署时上传 zip 到目标服务器，自动备份同名目录（时间戳）并解压新包
- 备份管理支持按目标操作：查看备份列表、逐项一键回滚（当前线上目录先转存为新备份，所选备份保留可重复回滚）、勾选批量删除

### 4. 打包前 Git 一致性校验（新增）

点击“打包”后，先执行 Git 同步检查：

1. 查询远程 `origin/<当前分支>` 最新提交哈希
2. 读取本地当前提交哈希、提交信息、提交时间
3. 在操作终端输出远程与本地信息
4. 若远程与本地一致，继续执行打包
5. 若不一致，弹出确认框：  
   - 选择“继续打包”：继续执行  
   - 选择取消：立即结束本次操作

## 操作终端可见性

关键操作过程均在右侧“操作终端”输出，包含但不限于：

- 刷新 Git
- 测试连接（目标地址、认证方式、结果）
- 打包前 Git 校验（远程/本地对比、确认等待、用户选择）
- 分支校验结果
- 打包/部署实时日志与最终结果

## 界面结构

- 左侧：全局控制与项目工作区（分组、筛选、服务器管理入口、项目卡片）
- 中部：项目任务区，支持「按项目 / 按目标」视图切换
- 右侧：操作终端
- 顶部精简，仅保留日期信息
- `刷新` / `添加项目` 与“部署管理器”标题同级展示

## 运行方式

```bash
npm install
npm run dev
```

默认地址：`http://localhost:3000`

## Tauri 桌面版（Windows/macOS）

当前仓库已提供一版 Tauri 桌面壳（目录：`src-tauri`），运行方式：

```bash
npm run tauri:dev
```

构建安装包：

```bash
npm run tauri:build
```

说明：

- 开发模式通过 `beforeDevCommand` 先执行 `npm run dev` 启动本地服务
- 桌面壳启动时会检测 `3000` 端口；若服务未运行则自动拉起 `server.js`
- 若由桌面壳拉起服务，应用退出时会自动回收该子进程
- 该版本默认调用系统 `node` 启动服务，需本机已安装 Node.js
- 本机需安装 Rust 工具链后才能执行 Tauri 构建

## 主要接口

- `POST /api/parse-git`：解析本地 Git 信息
- `GET /api/branch-check/:id`：分支一致性校验
- `GET /api/git-sync-check/:id`：远程/本地提交一致性校验（打包前）
- `POST /api/pack/:id`：打包（SSE）
- `POST /api/deploy/:id`：部署（SSE，body 传 `targetIds` 数组，逐目标顺序执行）
- `GET/POST/PUT/DELETE /api/servers[/:id]`：服务器 CRUD（含使用统计与引用守卫）
- `POST/PUT/DELETE /api/servers/:id/paths[/:pathId]`：部署路径 CRUD
- `GET /api/list-backups/:id?targetId=` 与 `POST /api/delete-backups/:id`：按目标管理备份
- `POST /api/rollback/:id`：按目标回滚到指定备份（SSE）
- `POST /api/test-connection`：SSH 连接测试
- `POST /api/import-json`：导入 FinalShell JSON 配置

## 目录结构

```text
front-deploy/
├─ public/
│  ├─ index.html
│  ├─ style.css
│  └─ app.js
├─ docs/
│  └─ 需求梳理与优化方案.md
├─ server.js
├─ projects.json
└─ package.json
```
