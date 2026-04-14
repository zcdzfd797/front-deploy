let projects = [];
let currentEditId = null;
let parsedGitInfo = null;
const RECENT_DIRS_KEY = "frontDeploy.recentDirs";
const MAX_RECENT_DIRS = 8;
const MANUAL_GROUPS_KEY = "frontDeploy.manualGroups";
const GROUP_META_KEY = "frontDeploy.groupMeta";
const MAX_GROUP_NAME_LEN = 30;
const GROUP_ALL_KEY = "__all__";
const GROUP_UNKNOWN_NAME = "未知组";
let activeGroupKey = GROUP_ALL_KEY;

const terminal = document.getElementById("terminal");
const terminalTitle = document.getElementById("terminalTitle");
const toastRegion = document.getElementById("toastRegion");

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
const byId = (id) => document.getElementById(id);

function normalizeGroupName(groupName) {
  const normalized = String(groupName ?? "").trim();
  return normalized || GROUP_UNKNOWN_NAME;
}

function normalizeGroupInput(groupName) {
  return String(groupName ?? "").trim().slice(0, MAX_GROUP_NAME_LEN);
}

function toStoredGroupName(rawGroupName) {
  const normalized = normalizeGroupInput(rawGroupName);
  if (!normalized) return "";
  if (normalized === GROUP_UNKNOWN_NAME) return "";
  return normalized;
}

function getManualGroups() {
  try {
    const raw = window.localStorage.getItem(MANUAL_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const names = [];
    const seen = new Set();
    parsed.forEach((item) => {
      const normalized = normalizeGroupInput(item);
      const key = normalized.toLowerCase();
      if (!normalized || normalized === GROUP_UNKNOWN_NAME || seen.has(key)) return;
      seen.add(key);
      names.push(normalized);
    });
    return names;
  } catch {
    return [];
  }
}

function saveManualGroups(groups) {
  const names = [];
  const seen = new Set();
  groups.forEach((item) => {
    const normalized = normalizeGroupInput(item);
    const key = normalized.toLowerCase();
    if (!normalized || normalized === GROUP_UNKNOWN_NAME || seen.has(key)) return;
    seen.add(key);
    names.push(normalized);
  });
  window.localStorage.setItem(MANUAL_GROUPS_KEY, JSON.stringify(names));
}

function getGroupMetaMap() {
  try {
    const raw = window.localStorage.getItem(GROUP_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    Object.keys(parsed).forEach((key) => {
      const name = normalizeGroupInput(key);
      if (!name || name === GROUP_UNKNOWN_NAME || name === GROUP_ALL_KEY) return;
      const meta = parsed[key] || {};
      result[name] = {
        accessUrl: normalizeAccessUrl(meta.accessUrl)
      };
    });
    return result;
  } catch {
    return {};
  }
}

function saveGroupMetaMap(metaMap) {
  const result = {};
  Object.keys(metaMap || {}).forEach((key) => {
    const name = normalizeGroupInput(key);
    if (!name || name === GROUP_UNKNOWN_NAME || name === GROUP_ALL_KEY) return;
    const accessUrl = normalizeAccessUrl(metaMap[key]?.accessUrl);
    if (!accessUrl) return;
    result[name] = { accessUrl };
  });
  window.localStorage.setItem(GROUP_META_KEY, JSON.stringify(result));
}

function getGroupMeta(groupName) {
  const name = normalizeGroupInput(groupName);
  if (!name || name === GROUP_UNKNOWN_NAME || name === GROUP_ALL_KEY) {
    return { accessUrl: "" };
  }
  const map = getGroupMetaMap();
  return map[name] || { accessUrl: "" };
}

function upsertGroupMeta(groupName, patch = {}) {
  const name = normalizeGroupInput(groupName);
  if (!name || name === GROUP_UNKNOWN_NAME || name === GROUP_ALL_KEY) return;
  const map = getGroupMetaMap();
  const current = map[name] || {};
  const next = {
    ...current,
    ...patch,
    accessUrl: normalizeAccessUrl(patch.accessUrl ?? current.accessUrl)
  };
  if (!next.accessUrl) {
    delete map[name];
  } else {
    map[name] = next;
  }
  saveGroupMetaMap(map);
}

function renameGroupMeta(oldName, newName) {
  const from = normalizeGroupInput(oldName);
  const to = normalizeGroupInput(newName);
  if (!from || !to || from === to) return;
  const map = getGroupMetaMap();
  const foundKey = Object.keys(map).find((key) => key.toLowerCase() === from.toLowerCase());
  if (!foundKey) return;
  const meta = map[foundKey];
  delete map[foundKey];
  map[to] = meta;
  saveGroupMetaMap(map);
}

function renameManualGroup(oldName, newName) {
  const from = normalizeGroupInput(oldName).toLowerCase();
  const to = normalizeGroupInput(newName);
  const manual = getManualGroups();
  const next = manual.filter((item) => item.toLowerCase() !== from && item.toLowerCase() !== to.toLowerCase());
  next.push(to);
  saveManualGroups(next);
}

function ensureManualGroup(groupName) {
  const normalized = normalizeGroupInput(groupName);
  if (!normalized || normalized === GROUP_UNKNOWN_NAME || normalized === GROUP_ALL_KEY) return;
  const manual = getManualGroups();
  if (manual.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
  manual.push(normalized);
  saveManualGroups(manual);
}

function createGroup(groupName) {
  const normalized = normalizeGroupInput(groupName);
  if (!normalized) {
    showToast("请输入分组名称。", "warn");
    return false;
  }
  if (normalized === GROUP_UNKNOWN_NAME) {
    showToast("“未知组”为系统分组，不能新建同名分组。", "warn");
    return false;
  }
  const existing = getCustomGroupNames();
  if (existing.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
    showToast(`分组“${normalized}”已存在。`, "warn");
    return false;
  }

  const manual = getManualGroups();
  manual.push(normalized);
  saveManualGroups(manual);
  activeGroupKey = normalized;
  renderList();
  showToast(`分组“${normalized}”已创建。`, "success");
  return true;
}

async function renameGroupInProjects(oldName, newName) {
  const from = normalizeGroupInput(oldName).toLowerCase();
  const toStored = toStoredGroupName(newName);
  const targets = projects.filter((project) => normalizeGroupName(project.groupName).toLowerCase() === from);
  for (const project of targets) {
    const updated = await api(`/api/projects/${project.id}`, {
      method: "PUT",
      body: { groupName: toStored }
    });
    const idx = projects.findIndex((item) => item.id === project.id);
    if (idx !== -1) projects[idx] = updated;
  }
}

function getCustomGroupNames() {
  const set = new Set();
  getManualGroups().forEach((groupName) => {
    if (groupName && groupName !== GROUP_UNKNOWN_NAME) {
      set.add(groupName);
    }
  });
  projects.forEach((project) => {
    const normalized = toStoredGroupName(project.groupName);
    if (normalized) set.add(normalized);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function getFilteredProjects() {
  if (activeGroupKey === GROUP_ALL_KEY) return projects;
  return projects.filter((project) => normalizeGroupName(project.groupName) === activeGroupKey);
}

function renderGroupNameOptions() {
  const datalist = byId("groupNameList");
  if (!datalist) return;

  const options = [GROUP_UNKNOWN_NAME, ...getCustomGroupNames()];
  datalist.innerHTML = options
    .map((groupName) => `<option value="${escapeHtml(groupName)}"></option>`)
    .join("");
}

function getGroupItems() {
  const counts = new Map();
  counts.set(GROUP_UNKNOWN_NAME, 0);
  getCustomGroupNames().forEach((groupName) => {
    counts.set(groupName, 0);
  });

  projects.forEach((project) => {
    const groupName = normalizeGroupName(project.groupName);
    counts.set(groupName, (counts.get(groupName) || 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => {
      if (a.key === GROUP_UNKNOWN_NAME) return 1;
      if (b.key === GROUP_UNKNOWN_NAME) return -1;
      return a.key.localeCompare(b.key, "zh-Hans-CN");
    });
}

function renderGroupList() {
  const groupList = byId("groupList");
  if (!groupList) return;

  const customGroups = getGroupItems();
  const validKeys = new Set(customGroups.map((item) => item.key));
  if (activeGroupKey !== GROUP_ALL_KEY && !validKeys.has(activeGroupKey)) {
    activeGroupKey = GROUP_ALL_KEY;
  }

  const allItem = {
    key: GROUP_ALL_KEY,
    label: "全部项目",
    count: projects.length
  };

  const html = [allItem, ...customGroups]
    .map((item) => `
      <button
        class="group-item ${item.key === activeGroupKey ? "active" : ""}"
        type="button"
        data-group="${escapeHtml(item.key)}"
        aria-label="切换到 ${escapeHtml(item.label)}"
      >
        <span class="group-item-name">${escapeHtml(item.label)}</span>
        <span class="group-item-count">${item.count}</span>
      </button>
    `)
    .join("");

  groupList.innerHTML = html;
}

function renderGroupInfo(projectItems, groupLabel) {
  const panel = byId("groupInfo");
  const title = byId("groupInfoTitle");
  const count = byId("groupInfoCount");
  const list = byId("groupInfoList");
  const editor = byId("groupMetaEditor");
  if (!panel || !title || !count || !list || !editor) return;

  panel.hidden = false;
  title.textContent = activeGroupKey === GROUP_ALL_KEY ? "全部项目信息" : `分组信息：${groupLabel}`;
  count.textContent = `${projectItems.length} 项`;

  syncGroupMetaEditor();

  if (!projectItems.length) {
    list.innerHTML = '<div class="group-info-item"><span class="group-info-name">当前分组暂无项目</span><span class="group-info-url empty">请切换分组或添加项目</span></div>';
    return;
  }

  const maxPreview = 8;
  const groupMeta = getGroupMeta(activeGroupKey);
  const groupAccessUrl = normalizeAccessUrl(groupMeta.accessUrl);
  const groupUrlHtml = groupAccessUrl
    ? (isHttpAccessUrl(groupAccessUrl)
      ? `<a class="group-info-url" href="${escapeHtml(groupAccessUrl)}" target="_blank" rel="noopener noreferrer" translate="no">${escapeHtml(groupAccessUrl)}</a>`
      : `<span class="group-info-url">${escapeHtml(groupAccessUrl)}</span>`)
    : '<span class="group-info-url empty">未填写分组访问地址</span>';

  const groupHeaderItem = activeGroupKey === GROUP_ALL_KEY
    ? ""
    : `<div class="group-info-item"><span class="group-info-name">分组访问地址</span>${groupUrlHtml}</div>`;

  const html = projectItems
    .slice(0, maxPreview)
    .map((project) => {
      const projectName = escapeHtml(safeText(project.projectName));
      const accessUrl = normalizeAccessUrl(project.accessUrl);
      const urlHtml = accessUrl
        ? (isHttpAccessUrl(accessUrl)
          ? `<a class="group-info-url" href="${escapeHtml(accessUrl)}" target="_blank" rel="noopener noreferrer" translate="no">${escapeHtml(accessUrl)}</a>`
          : `<span class="group-info-url">${escapeHtml(accessUrl)}</span>`)
        : '<span class="group-info-url empty">未填写访问地址</span>';

      return `<div class="group-info-item"><span class="group-info-name">${projectName}</span>${urlHtml}</div>`;
    })
    .join("");

  const more = projectItems.length > maxPreview
    ? `<div class="group-info-item"><span class="group-info-name">还有 ${projectItems.length - maxPreview} 个项目</span><span class="group-info-url empty">请在下方列表查看全部</span></div>`
    : "";

  list.innerHTML = groupHeaderItem + html + more;
}

function updateGroupOpenLink(url) {
  const link = byId("groupOpenLink");
  if (!link) return;
  const normalized = normalizeAccessUrl(url);
  if (!normalized || !isHttpAccessUrl(normalized)) {
    link.href = "#";
    link.classList.add("disabled");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = normalized;
  link.classList.remove("disabled");
  link.setAttribute("aria-disabled", "false");
}

function syncGroupMetaEditor() {
  const editor = byId("groupMetaEditor");
  const nameInput = byId("groupEditName");
  const urlInput = byId("groupEditAccessUrl");
  const saveBtn = byId("btnSaveGroupMeta");
  if (!editor || !nameInput || !urlInput || !saveBtn) return;

  const editable = activeGroupKey !== GROUP_ALL_KEY && activeGroupKey !== GROUP_UNKNOWN_NAME;
  editor.hidden = !editable;
  if (!editable) {
    nameInput.value = "";
    urlInput.value = "";
    updateGroupOpenLink("");
    return;
  }

  const meta = getGroupMeta(activeGroupKey);
  nameInput.value = activeGroupKey;
  urlInput.value = meta.accessUrl || "";
  updateGroupOpenLink(urlInput.value);
}

async function saveActiveGroupMeta() {
  if (activeGroupKey === GROUP_ALL_KEY || activeGroupKey === GROUP_UNKNOWN_NAME) {
    showToast("当前分组不支持编辑。", "warn");
    return;
  }

  const nameInput = byId("groupEditName");
  const urlInput = byId("groupEditAccessUrl");
  if (!nameInput || !urlInput) return;

  const oldName = activeGroupKey;
  const newName = normalizeGroupInput(nameInput.value);
  const accessUrl = normalizeAccessUrl(urlInput.value);

  if (!newName) {
    showToast("分组名称不能为空。", "warn");
    return;
  }
  if (newName === GROUP_UNKNOWN_NAME) {
    showToast("不能修改为系统分组“未知组”。", "warn");
    return;
  }

  const allGroups = getCustomGroupNames();
  const duplicate = allGroups.some((groupName) =>
    groupName.toLowerCase() === newName.toLowerCase() && groupName.toLowerCase() !== oldName.toLowerCase()
  );
  if (duplicate) {
    showToast(`分组“${newName}”已存在。`, "warn");
    return;
  }

  const needRename = newName.toLowerCase() !== oldName.toLowerCase();
  if (needRename) {
    await renameGroupInProjects(oldName, newName);
    renameManualGroup(oldName, newName);
    renameGroupMeta(oldName, newName);
    activeGroupKey = newName;
  } else {
    ensureManualGroup(oldName);
  }

  upsertGroupMeta(activeGroupKey, { accessUrl });
  renderList();
  showToast("分组信息已更新。", "success");
}

function normalizePath(dirPath) {
  if (dirPath === null || dirPath === undefined) return "";
  let normalized = String(dirPath).trim().replace(/\//g, "\\");
  if (!normalized) return "";
  if (/^[a-zA-Z]:\\?$/.test(normalized)) {
    return normalized.endsWith("\\") ? normalized : `${normalized}\\`;
  }
  return normalized.replace(/[\\]+$/, "");
}

function normalizeAccessUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,})(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value}`;
  }
  return value;
}

function isHttpAccessUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function getRecentDirs() {
  try {
    const value = window.localStorage.getItem(RECENT_DIRS_KEY);
    if (!value) return [];
    const data = JSON.parse(value);
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => normalizePath(item))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveRecentDirs(dirs) {
  window.localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, MAX_RECENT_DIRS)));
}

function renderRecentDirOptions() {
  const dirs = getRecentDirs();
  const datalist = byId("recentDirList");
  const selectIds = ["addRecentDir", "editRecentDir"];

  if (datalist) {
    datalist.innerHTML = dirs
      .map((dir) => `<option value="${escapeHtml(dir)}"></option>`)
      .join("");
  }

  selectIds.forEach((id) => {
    const select = byId(id);
    if (!select) return;
    const current = select.value;
    const baseOption = '<option value="">最近使用路径...</option>';
    const options = dirs
      .map((dir) => `<option value="${escapeHtml(dir)}">${escapeHtml(dir)}</option>`)
      .join("");
    select.innerHTML = `${baseOption}${options}`;
    if (current && dirs.includes(current)) {
      select.value = current;
    }
  });
}

function rememberDir(dirPath) {
  const normalized = normalizePath(dirPath);
  if (!normalized) return;
  const dirs = getRecentDirs();
  const next = [normalized, ...dirs.filter((item) => item.toLowerCase() !== normalized.toLowerCase())];
  saveRecentDirs(next);
  renderRecentDirOptions();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeText(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function isDeployed(project) {
  if (!project) return false;
  if (project.lastDeployTime) return true;
  return typeof project.deployStatus === "string" && project.deployStatus.includes("已");
}

function hasDeployConfig(project) {
  const deploy = project?.deploy;
  if (!deploy) return false;
  return Boolean(deploy.host && deploy.username && deploy.deployPath);
}

function normalizeErrorMessage(message) {
  if (!message) return "操作失败，请稍后重试。";
  if (message.includes("Failed to fetch")) return "网络请求失败，请确认服务是否已启动。";
  if (message.includes("Unexpected token")) return "接口返回异常，请检查服务日志。";
  return message;
}

function showToast(message, type = "info", duration = 2600) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), duration);
}

async function openFolderByPath(rawPath) {
  const dirPath = normalizePath(rawPath);
  if (!dirPath) {
    showToast("路径为空，无法打开。", "warn");
    return false;
  }
  try {
    await api("/api/open-folder", { method: "POST", body: { dirPath } });
    rememberDir(dirPath);
    return true;
  } catch (error) {
    showToast(`打开失败：${normalizeErrorMessage(error.message)}`, "error");
    return false;
  }
}

async function api(url, options = {}) {
  const init = {
    method: "GET",
    ...options,
    headers: { ...(options.headers || {}) }
  };

  if (Object.prototype.hasOwnProperty.call(options, "body")) {
    const body = options.body;
    if (body instanceof FormData) {
      init.body = body;
      delete init.headers["Content-Type"];
    } else if (typeof body === "string") {
      init.body = body;
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
    } else {
      init.body = JSON.stringify(body ?? {});
      init.headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(url, init);
  const raw = await res.text();
  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw };
    }
  }

  if (!res.ok) {
    throw new Error(normalizeErrorMessage(data.error || `请求失败（${res.status}）`));
  }
  return data;
}

async function pickFolder(startDir = "") {
  const normalizedStartDir = normalizePath(startDir);
  const query = normalizedStartDir ? `?startDir=${encodeURIComponent(normalizedStartDir)}` : "";
  const data = await api(`/api/pick-folder${query}`);
  if (data.canceled) return null;
  const selected = normalizePath(data.path);
  if (selected) rememberDir(selected);
  return selected;
}

function updateSummary() {
  const total = projects.length;
  const ready = projects.filter((item) => item.zipExists && hasDeployConfig(item) && String(item.branch || "").trim()).length;
  const deployed = projects.filter((item) => isDeployed(item)).length;
  byId("summaryTotal").textContent = String(total);
  byId("summaryReady").textContent = String(ready);
  byId("summaryDeployed").textContent = String(deployed);
}

function renderList() {
  const list = byId("projectList");
  const empty = byId("emptyState");
  const groupHint = byId("groupHint");
  updateSummary();
  renderGroupList();
  renderGroupNameOptions();

  const currentGroupLabel = activeGroupKey === GROUP_ALL_KEY ? "全部项目" : activeGroupKey;
  if (groupHint) {
    groupHint.textContent = `当前分组：${currentGroupLabel}`;
  }

  if (!projects.length) {
    renderGroupInfo([], currentGroupLabel);
    empty.innerHTML = "<p>暂无项目，点击右上角“添加项目”开始。</p>";
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  const filteredProjects = getFilteredProjects();
  renderGroupInfo(filteredProjects, currentGroupLabel);
  if (!filteredProjects.length) {
    empty.innerHTML = `<p>“${escapeHtml(currentGroupLabel)}”暂时没有项目，请切换分组或新增项目。</p>`;
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  empty.style.display = "none";

  const html = filteredProjects
    .map((project) => {
      const projectId = escapeHtml(project.id);
      const projectName = escapeHtml(safeText(project.projectName));
      const groupName = escapeHtml(normalizeGroupName(project.groupName));
      const branch = escapeHtml(safeText(project.branch));
      const commitHash = escapeHtml(safeText(project.commitHash));
      const commitMsg = escapeHtml(safeText(project.commitMsg));
      const dirPath = safeText(project.dirPath);
      const remark = safeText(project.remark, "");
      const recordedBranch = String(project.branch || "").trim();
      const branchReady = Boolean(recordedBranch);
      const accessUrl = normalizeAccessUrl(project.accessUrl);
      const accessUrlHtml = accessUrl
        ? (isHttpAccessUrl(accessUrl)
          ? `<a class="card-link" href="${escapeHtml(accessUrl)}" target="_blank" rel="noopener noreferrer" translate="no">${escapeHtml(accessUrl)}</a>`
          : escapeHtml(accessUrl))
        : "未填写";
      const buildCmd = escapeHtml(safeText(project.buildCmd, "npm run build"));

      const zipExists = Boolean(project.zipExists && project.zipPath);
      const deployConfigured = hasDeployConfig(project);
      const packTip = branchReady ? "" : "请先在项目配置中填写记录分支";
      const deployReady = zipExists && deployConfigured && branchReady;
      const deployTip = !branchReady
        ? "记录分支为空，请先编辑项目并填写分支"
        : (!deployConfigured
          ? "请先配置部署信息"
          : (!zipExists ? "请先打包项目" : ""));

      const statusText = isDeployed(project) ? "已部署" : "未部署";
      const statusClass = isDeployed(project) ? "success" : "";

      return `
      <article class="project-card" data-id="${projectId}">
        <div class="card-main">
          <div class="card-info">
            <h3 class="project-name">${projectName}</h3>
            <div class="card-meta">
              <span class="badge group">${groupName}</span>
              <span class="badge">${branch}</span>
              <span class="commit-hash">${commitHash}</span>
              <span class="commit-msg" title="${commitMsg}">${commitMsg}</span>
            </div>
            <div class="card-meta secondary">
              <span title="${escapeHtml(dirPath)}">路径：${escapeHtml(dirPath)}</span>
            </div>
            <div class="card-meta secondary">
              <span>访问地址：${accessUrlHtml}</span>
            </div>
            ${remark ? `<div class="card-meta secondary"><span>备注：${escapeHtml(remark)}</span></div>` : ""}
            <div class="card-meta secondary"><span>构建命令：${buildCmd}</span></div>
            ${zipExists ? `
              <div class="card-meta secondary">
                <span class="zip-info">压缩包：${escapeHtml(safeText(project.zipSize, "-"))} (${escapeHtml(safeText(project.packTime, "-"))})</span>
                <button
                  class="btn btn-xs btn-secondary btn-open-zip"
                  type="button"
                  data-path="${escapeHtml(safeText(project.zipPath, ""))}"
                  aria-label="打开 ${projectName} 的压缩包位置"
                >打开</button>
              </div>
            ` : ""}
            ${project.lastDeployTime ? `<div class="card-meta secondary"><span class="deploy-time">最近部署：${escapeHtml(project.lastDeployTime)}</span></div>` : ""}
          </div>

          <div class="card-actions">
            <button
              class="btn btn-sm btn-secondary btn-open-folder"
              type="button"
              data-path="${escapeHtml(dirPath)}"
              aria-label="在文件管理器中打开 ${projectName}"
            >打开</button>

            <button
              class="btn btn-sm btn-secondary btn-edit"
              type="button"
              data-id="${projectId}"
              aria-label="编辑 ${projectName}"
            >编辑</button>

            <button
              class="btn btn-sm btn-warn btn-pack"
              type="button"
              data-id="${projectId}"
              data-name="${projectName}"
              ${branchReady ? "" : "disabled"}
              ${packTip ? `title="${packTip}"` : ""}
              aria-label="打包 ${projectName}"
            >打包</button>

            <button
              class="btn btn-sm btn-primary btn-deploy"
              type="button"
              data-id="${projectId}"
              data-name="${projectName}"
              ${deployReady ? "" : "disabled"}
              ${deployTip ? `title="${deployTip}"` : ""}
              aria-label="部署 ${projectName}"
            >部署</button>

            <button
              class="btn btn-sm btn-danger btn-delete"
              type="button"
              data-id="${projectId}"
              data-name="${projectName}"
              aria-label="删除 ${projectName}"
            >删除</button>
          </div>
        </div>

        ${deployConfigured ? `
        <div class="card-deploy-info">
          <span>服务器：${escapeHtml(safeText(project.deploy.host))}:${escapeHtml(safeText(project.deploy.port, 22))}</span>
          <span>部署路径：${escapeHtml(safeText(project.deploy.deployPath))}</span>
          <span>状态：<span class="status ${statusClass}">${statusText}</span></span>
        </div>
        ` : ""}
      </article>
      `;
    })
    .join("");

  list.innerHTML = html;
}

function openModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  if (!$(".modal-overlay.active")) {
    document.body.classList.remove("modal-open");
  }
}

function closeTopModal() {
  const opened = $$(".modal-overlay.active");
  if (!opened.length) return;
  const top = opened[opened.length - 1];
  closeModal(top.id);
}

$$("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});

$$(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(overlay.id);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTopModal();
});

function resetTerminal() {
  terminal.innerHTML = '<div class="terminal-line hint">等待操作...</div>';
  terminalTitle.textContent = "操作终端";
}

function appendTerminal(text, type = "") {
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`.trim();
  line.textContent = text;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function termClear() {
  terminal.innerHTML = "";
}

function termLog(text) {
  appendTerminal(text);
}

function termCmd(text) {
  appendTerminal(text, "cmd");
}

function termSuccess(text) {
  appendTerminal(text, "success");
}

function termError(text) {
  appendTerminal(text, "error");
}

function termSeparator(label) {
  appendTerminal(`=== ${label} ===`, "separator");
}

byId("btnClearTerminal").addEventListener("click", resetTerminal);

function runSSE(url, label) {
  return new Promise((resolve, reject) => {
    terminalTitle.textContent = label;
    const source = new EventSource(url);
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      source.close();
      callback();
    };

    source.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        termError("日志解析失败。");
        return;
      }

      if (data.type === "log") {
        if (String(data.text || "").startsWith("$ ")) termCmd(data.text);
        else termLog(data.text);
        return;
      }

      if (data.type === "done") {
        termSuccess("操作完成。");
        finish(() => resolve(data));
        return;
      }

      if (data.type === "error") {
        termError(data.text || "操作失败。");
        finish(() => reject(new Error(data.text || "操作失败。")));
      }
    };

    source.onerror = () => {
      finish(() => reject(new Error("日志连接中断，请重试。")));
    };
  });
}

function withButtonLoading(button, loadingText, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;
  return Promise.resolve(task()).finally(() => {
    button.disabled = false;
    button.textContent = original;
  });
}

async function validateBranchBeforeAction(projectId, projectName, actionName) {
  try {
    const result = await api(`/api/branch-check/${projectId}`);
    if (result?.ok) return true;
    const message = result?.message || "分支校验失败，已禁止后续操作";
    termClear();
    termSeparator(`${actionName} ${projectName}`);
    termError(message);
    showToast(message, "warn", 3600);
    return false;
  } catch (error) {
    const message = `分支校验失败：${normalizeErrorMessage(error.message)}`;
    termClear();
    termSeparator(`${actionName} ${projectName}`);
    termError(message);
    showToast(message, "error", 3600);
    return false;
  }
}

function clearAddModal() {
  parsedGitInfo = null;
  byId("inputDirPath").value = "";
  byId("addRecentDir").value = "";
  byId("inputRemark").value = "";
  byId("inputAccessUrl").value = "";
  byId("inputGroupName").value = "";
  byId("gitInfo").hidden = true;
  byId("infoProjectName").textContent = "-";
  byId("infoBranch").textContent = "-";
  byId("infoCommit").textContent = "-";
  byId("infoCommitMsg").textContent = "-";
  byId("infoCommitTime").textContent = "-";
  byId("infoRecentLogs").textContent = "";
}

function fillGitInfo(data) {
  byId("infoProjectName").textContent = safeText(data.projectName);
  byId("infoBranch").textContent = safeText(data.branch);
  byId("infoCommit").textContent = safeText(data.commitHash);
  byId("infoCommitMsg").textContent = safeText(data.commitMsg);
  byId("infoCommitTime").textContent = safeText(data.commitTime);
  byId("infoRecentLogs").textContent = safeText(data.recentLogs, "");
}

async function parseGitForAdd(dirPath) {
  const normalizedDir = normalizePath(dirPath);
  if (!normalizedDir) {
    parsedGitInfo = null;
    byId("gitInfo").hidden = true;
    return;
  }
  try {
    const data = await api("/api/parse-git", {
      method: "POST",
      body: { dirPath: normalizedDir }
    });
    parsedGitInfo = data;
    fillGitInfo(data);
    byId("gitInfo").hidden = false;
    rememberDir(normalizedDir);
    showToast("Git 信息解析成功。", "success");
  } catch (error) {
    parsedGitInfo = null;
    byId("gitInfo").hidden = true;
    showToast(`Git 信息解析失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
  }
}

byId("btnAddProject").addEventListener("click", () => {
  clearAddModal();
  if (activeGroupKey !== GROUP_ALL_KEY) {
    byId("inputGroupName").value = activeGroupKey;
  }
  renderRecentDirOptions();
  renderGroupNameOptions();
  openModal("addModal");
});

byId("btnRefreshProjects").addEventListener("click", async () => {
  await loadProjects({ silent: false });
  showToast("项目列表已刷新。", "info");
});

byId("btnCreateGroup").addEventListener("click", () => {
  const input = byId("inputNewGroupName");
  const ok = createGroup(input.value);
  if (ok) input.value = "";
});

byId("inputNewGroupName").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  byId("btnCreateGroup").click();
});

byId("groupList").addEventListener("click", (event) => {
  const target = event.target.closest(".group-item");
  if (!target) return;
  const nextGroup = target.dataset.group || GROUP_ALL_KEY;
  if (nextGroup === activeGroupKey) return;
  activeGroupKey = nextGroup;
  renderList();
});

byId("groupEditAccessUrl").addEventListener("input", () => {
  updateGroupOpenLink(byId("groupEditAccessUrl").value);
});

byId("groupEditAccessUrl").addEventListener("change", () => {
  const normalized = normalizeAccessUrl(byId("groupEditAccessUrl").value);
  byId("groupEditAccessUrl").value = normalized;
  updateGroupOpenLink(normalized);
});

byId("groupEditName").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  byId("btnSaveGroupMeta").click();
});

byId("groupEditAccessUrl").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  byId("btnSaveGroupMeta").click();
});

byId("btnSaveGroupMeta").addEventListener("click", async () => {
  await withButtonLoading(byId("btnSaveGroupMeta"), "保存中...", async () => {
    try {
      await saveActiveGroupMeta();
    } catch (error) {
      showToast(`分组信息保存失败：${normalizeErrorMessage(error.message)}`, "error");
    }
  });
});

byId("inputDirPath").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.currentTarget.blur();
});

byId("inputDirPath").addEventListener("change", async () => {
  const dirPath = normalizePath(byId("inputDirPath").value);
  byId("inputDirPath").value = dirPath;
  await parseGitForAdd(dirPath);
});

byId("btnOpenAddDir").addEventListener("click", async () => {
  await openFolderByPath(byId("inputDirPath").value);
});

byId("btnApplyAddRecent").addEventListener("click", async () => {
  const selected = normalizePath(byId("addRecentDir").value);
  if (!selected) {
    showToast("请先选择最近路径。", "warn");
    return;
  }
  byId("inputDirPath").value = selected;
  await parseGitForAdd(selected);
});

byId("addRecentDir").addEventListener("change", async () => {
  const selected = normalizePath(byId("addRecentDir").value);
  if (!selected) return;
  byId("inputDirPath").value = selected;
  await parseGitForAdd(selected);
});

byId("inputAccessUrl").addEventListener("change", () => {
  byId("inputAccessUrl").value = normalizeAccessUrl(byId("inputAccessUrl").value);
});

byId("btnBrowseFolder").addEventListener("click", async () => {
  try {
    const selectedPath = await pickFolder(byId("inputDirPath").value);
    if (!selectedPath) return;
    byId("inputDirPath").value = selectedPath;
    await parseGitForAdd(selectedPath);
  } catch (error) {
    showToast(normalizeErrorMessage(error.message), "error");
  }
});

byId("btnSaveProject").addEventListener("click", async () => {
  if (!parsedGitInfo) {
    showToast("请先选择项目文件夹并完成 Git 信息解析。", "warn");
    return;
  }

  try {
    const project = await api("/api/projects", {
      method: "POST",
      body: {
        ...parsedGitInfo,
        remark: byId("inputRemark").value.trim(),
        accessUrl: normalizeAccessUrl(byId("inputAccessUrl").value),
        groupName: toStoredGroupName(byId("inputGroupName").value)
      }
    });
    rememberDir(parsedGitInfo?.dirPath);
    projects.push(project);
    renderList();
    closeModal("addModal");
    showToast("项目添加成功。", "success");
  } catch (error) {
    showToast(`保存失败：${normalizeErrorMessage(error.message)}`, "error");
  }
});

byId("projectList").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const projectId = button.dataset.id;
  const projectName = button.dataset.name || "";

  if (button.classList.contains("btn-open-folder")) {
    const dirPath = button.dataset.path;
    await openFolderByPath(dirPath);
    return;
  }

  if (button.classList.contains("btn-open-zip")) {
    const zipPath = button.dataset.path;
    if (!zipPath) {
      showToast("压缩包路径为空，无法打开。", "warn");
      return;
    }
    try {
      await api("/api/open-zip-folder", { method: "POST", body: { zipPath } });
    } catch (error) {
      showToast(`打开失败：${normalizeErrorMessage(error.message)}`, "error");
    }
    return;
  }

  if (button.classList.contains("btn-pack")) {
    const allowed = await validateBranchBeforeAction(projectId, projectName, "打包");
    if (!allowed) return;

    await withButtonLoading(button, "打包中...", async () => {
      termClear();
      termSeparator(`打包 ${projectName}`);
      try {
        await runSSE(`/api/pack/${projectId}`, `打包 ${projectName}`);
        await loadProjects({ silent: true });
        showToast(`项目 ${projectName} 打包完成。`, "success");
      } catch (error) {
        showToast(`打包失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
      }
    });
    return;
  }

  if (button.classList.contains("btn-edit")) {
    openEditModal(projectId);
    return;
  }

  if (button.classList.contains("btn-deploy")) {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !hasDeployConfig(project)) {
      showToast("请先完善部署信息。", "warn");
      return;
    }
    const allowed = await validateBranchBeforeAction(projectId, projectName, "部署");
    if (!allowed) return;

    if (!window.confirm(`确认开始部署项目 “${project.projectName}” 吗？`)) return;

    await withButtonLoading(button, "部署中...", async () => {
      termClear();
      termSeparator(`部署 ${projectName}`);
      try {
        const result = await runSSE(`/api/deploy/${projectId}`, `部署 ${projectName}`);
        if (result?.deployTime) {
          termSuccess(`部署时间：${result.deployTime}`);
        }
        await loadProjects({ silent: true });
        showToast(`项目 ${projectName} 部署成功。`, "success");
      } catch (error) {
        showToast(`部署失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
      }
    });
    return;
  }

  if (button.classList.contains("btn-delete")) {
    const targetName = button.dataset.name || "当前项目";
    if (!window.confirm(`确认删除 “${targetName}” 吗？此操作不可撤销。`)) return;

    try {
      await api(`/api/projects/${projectId}`, { method: "DELETE" });
      projects = projects.filter((item) => item.id !== projectId);
      renderList();
      showToast("项目已删除。", "success");
    } catch (error) {
      showToast(`删除失败：${normalizeErrorMessage(error.message)}`, "error");
    }
  }
});

function switchEditAuthTab(type) {
  const tabs = $$(".edit-auth-tabs .tab-btn");
  tabs.forEach((tab) => {
    const isActive = tab.dataset.auth === type;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  $(".edit-auth-password").hidden = type !== "password";
  $(".edit-auth-key").hidden = type !== "key";
}

function openEditModal(id) {
  currentEditId = id;
  const project = projects.find((item) => item.id === id);
  if (!project) return;

  const normalizedDirPath = normalizePath(safeText(project.dirPath, ""));
  if (normalizedDirPath) rememberDir(normalizedDirPath);
  renderRecentDirOptions();
  renderGroupNameOptions();

  byId("editProjectName").value = safeText(project.projectName, "");
  byId("editDirPath").value = normalizedDirPath;
  byId("editBranch").value = safeText(project.branch, "");
  byId("editCommitHash").value = safeText(project.commitHash, "");
  byId("editCommitMsg").value = safeText(project.commitMsg, "");
  byId("editRemark").value = safeText(project.remark, "");
  byId("editAccessUrl").value = normalizeAccessUrl(safeText(project.accessUrl, ""));
  byId("editGroupName").value = normalizeGroupName(project.groupName);
  byId("editBuildCmd").value = safeText(project.buildCmd, "npm run build");

  const deploy = project.deploy || {};
  byId("editHost").value = safeText(deploy.host, "");
  byId("editPort").value = safeText(deploy.port, "22");
  byId("editUsername").value = safeText(deploy.username, "");
  byId("editPassword").value = safeText(deploy.password, "");
  byId("editPrivateKey").value = safeText(deploy.privateKey, "");
  byId("editDeployPath").value = safeText(deploy.deployPath, "");

  switchEditAuthTab(deploy.privateKey ? "key" : "password");
  $(".edit-json-hint").textContent = "";
  $(".edit-json-hint").style.color = "";
  byId("editRecentDir").value = "";
  openModal("editModal");
}

$(".btn-browse-edit").addEventListener("click", async () => {
  try {
    const selectedPath = await pickFolder(byId("editDirPath").value);
    if (selectedPath) {
      byId("editDirPath").value = selectedPath;
      rememberDir(selectedPath);
    }
  } catch (error) {
    showToast(normalizeErrorMessage(error.message), "error");
  }
});

byId("editDirPath").addEventListener("change", () => {
  const normalized = normalizePath(byId("editDirPath").value);
  byId("editDirPath").value = normalized;
  if (normalized) rememberDir(normalized);
});

byId("btnOpenEditDir").addEventListener("click", async () => {
  await openFolderByPath(byId("editDirPath").value);
});

byId("btnApplyEditRecent").addEventListener("click", () => {
  const selected = normalizePath(byId("editRecentDir").value);
  if (!selected) {
    showToast("请先选择最近路径。", "warn");
    return;
  }
  byId("editDirPath").value = selected;
  rememberDir(selected);
});

byId("editRecentDir").addEventListener("change", () => {
  const selected = normalizePath(byId("editRecentDir").value);
  if (!selected) return;
  byId("editDirPath").value = selected;
  rememberDir(selected);
});

byId("editAccessUrl").addEventListener("change", () => {
  byId("editAccessUrl").value = normalizeAccessUrl(byId("editAccessUrl").value);
});

$$(".edit-auth-tabs .tab-btn").forEach((tab) => {
  tab.addEventListener("click", () => switchEditAuthTab(tab.dataset.auth));
});

$(".btn-import-json-edit").addEventListener("click", () => {
  byId("editInputJsonFile").click();
});

byId("editInputJsonFile").addEventListener("change", async () => {
  const file = byId("editInputJsonFile").files[0];
  if (!file) return;

  const hint = $(".edit-json-hint");
  const formData = new FormData();
  formData.append("file", file);

  try {
    const data = await api("/api/import-json", { method: "POST", body: formData });
    const connName = safeText(data.connectionName, file.name.replace(/\.json$/i, ""));

    hint.textContent = `已导入：${connName}`;
    hint.style.color = "";

    if (data.host) byId("editHost").value = data.host;
    if (data.port) byId("editPort").value = data.port;
    if (data.username) byId("editUsername").value = data.username;
    if (data.deployPath) byId("editDeployPath").value = data.deployPath;

    if (data.privateKey) {
      byId("editPrivateKey").value = data.privateKey;
      switchEditAuthTab("key");
    }

    if (data.password) {
      if (data.encryptedPassword) {
        byId("editPassword").value = "";
        hint.textContent = `已导入：${connName}（密码为加密存储，请手动填写明文密码）`;
        hint.style.color = "#e65d5d";
        showToast("JSON 中密码为加密值，请手动输入服务器明文密码。", "warn", 3600);
      } else {
        byId("editPassword").value = data.password;
      }
      switchEditAuthTab("password");
    }

    showToast("JSON 配置导入成功。", "success");
  } catch (error) {
    showToast(`导入失败：${normalizeErrorMessage(error.message)}`, "error");
  } finally {
    byId("editInputJsonFile").value = "";
  }
});

byId("btnRefreshGit").addEventListener("click", async () => {
  const dirPath = normalizePath(byId("editDirPath").value);
  byId("editDirPath").value = dirPath;
  if (!dirPath) {
    showToast("请先填写项目路径。", "warn");
    return;
  }

  try {
    const data = await api("/api/parse-git", {
      method: "POST",
      body: { dirPath }
    });
    byId("editProjectName").value = safeText(data.projectName, "");
    byId("editBranch").value = safeText(data.branch, "");
    byId("editCommitHash").value = safeText(data.commitHash, "");
    byId("editCommitMsg").value = safeText(data.commitMsg, "");
    showToast("Git 信息已刷新。", "success");
  } catch (error) {
    showToast(`刷新失败：${normalizeErrorMessage(error.message)}`, "error");
  }
});

byId("btnTestConn").addEventListener("click", async () => {
  const activeAuth = $(".edit-auth-tabs .tab-btn.active").dataset.auth;
  const host = byId("editHost").value.trim();
  const username = byId("editUsername").value.trim();

  if (!host || !username) {
    showToast("请先填写服务器地址和用户名。", "warn");
    return;
  }

  const payload = {
    host,
    port: Number.parseInt(byId("editPort").value, 10) || 22,
    username
  };

  if (activeAuth === "password") {
    payload.password = byId("editPassword").value;
    if (!payload.password) {
      showToast("请填写密码。", "warn");
      return;
    }
  } else {
    payload.privateKey = byId("editPrivateKey").value.trim();
    if (!payload.privateKey) {
      showToast("请填写私钥内容。", "warn");
      return;
    }
  }

  await withButtonLoading(byId("btnTestConn"), "测试中...", async () => {
    try {
      await api("/api/test-connection", { method: "POST", body: payload });
      showToast("连接成功。", "success");
    } catch (error) {
      showToast(`连接失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  });
});

byId("btnSaveEdit").addEventListener("click", async () => {
  const activeAuth = $(".edit-auth-tabs .tab-btn.active").dataset.auth;
  const projectName = byId("editProjectName").value.trim();
  const dirPath = normalizePath(byId("editDirPath").value);
  byId("editDirPath").value = dirPath;

  if (!projectName || !dirPath) {
    showToast("项目名称和工作副本路径不能为空。", "warn");
    return;
  }

  const update = {
    projectName,
    dirPath,
    branch: byId("editBranch").value.trim(),
    commitHash: byId("editCommitHash").value.trim(),
    commitMsg: byId("editCommitMsg").value.trim(),
    remark: byId("editRemark").value.trim(),
    accessUrl: normalizeAccessUrl(byId("editAccessUrl").value),
    groupName: toStoredGroupName(byId("editGroupName").value),
    buildCmd: byId("editBuildCmd").value.trim() || "npm run build"
  };

  const host = byId("editHost").value.trim();
  const username = byId("editUsername").value.trim();
  const deployPath = byId("editDeployPath").value.trim();

  if (host || username || deployPath) {
    update.deploy = {
      host,
      port: Number.parseInt(byId("editPort").value, 10) || 22,
      username,
      deployPath
    };

    if (activeAuth === "password") {
      update.deploy.password = byId("editPassword").value;
    } else {
      update.deploy.privateKey = byId("editPrivateKey").value;
    }
  }

  try {
    const updated = await api(`/api/projects/${currentEditId}`, {
      method: "PUT",
      body: update
    });

    const index = projects.findIndex((item) => item.id === currentEditId);
    if (index !== -1) projects[index] = updated;
    rememberDir(dirPath);
    renderList();
    closeModal("editModal");
    showToast("项目信息已保存。", "success");
  } catch (error) {
    showToast(`保存失败：${normalizeErrorMessage(error.message)}`, "error");
  }
});

async function loadProjects({ silent } = { silent: false }) {
  try {
    projects = await api("/api/projects");
    projects.sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
    renderList();
  } catch (error) {
    if (!silent) {
      showToast(`加载项目失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  }
}

resetTerminal();
renderRecentDirOptions();
loadProjects();




