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
- 编辑项目：维护项目名称、路径、分组、构建命令与部署配置
- 编辑约束：`最新提交 Hash` 与 `提交信息` 在编辑页为只读，不允许手动修改
- 删除项目：二次确认，避免误删

### 2. 分组与检索

- 左侧分组导航支持快速切组
- 分组支持输入框回车新建
- 支持删除空分组（组内存在项目时禁止删除）
- 支持关键词搜索与部署状态筛选（全部/可部署/已部署/待补配置/已打包）

### 3. 打包与部署

- 打包前执行 Git 一致性校验（远程/本地）与分支校验
- 执行构建命令并实时输出日志（SSE）
- 自动识别构建产物目录并压缩为 zip
- 部署时上传 zip 到目标服务器
- 自动备份同名目录（时间戳）并解压新包
- 记录最近打包时间、部署时间和部署状态

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

- 左侧：全局控制与项目工作区（分组、筛选、项目卡片）
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
- `POST /api/deploy/:id`：部署（SSE）
- `POST /api/test-connection`：SSH 连接测试

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
