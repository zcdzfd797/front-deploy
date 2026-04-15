let projects = [];
let currentEditId = null;
let parsedGitInfo = null;
let projectSearchKeyword = "";
let projectDeployFilter = "all";
let confirmResolver = null;
const RECENT_DIRS_KEY = "frontDeploy.recentDirs";
const MAX_RECENT_DIRS = 8;
const MANUAL_GROUPS_KEY = "frontDeploy.manualGroups";
const MAX_GROUP_NAME_LEN = 30;
const GROUP_ALL_KEY = "__all__";
const GROUP_UNKNOWN_NAME = "未知组";
let activeGroupKey = GROUP_ALL_KEY;
let groupFeedbackTimer = null;
let groupFeedbackToken = 0;
let lastOperationStatusSnapshot = "";

const terminal = document.getElementById("terminal");
const terminalTitle = document.getElementById("terminalTitle");
const toastRegion = document.getElementById("toastRegion");
const srAnnouncement = document.getElementById("srAnnouncement");

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

function ensureManualGroup(groupName) {
  const normalized = normalizeGroupInput(groupName);
  if (!normalized || normalized === GROUP_UNKNOWN_NAME || normalized === GROUP_ALL_KEY) return;
  const manual = getManualGroups();
  if (manual.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
  manual.push(normalized);
  saveManualGroups(manual);
}

function clearGroupFeedback() {
  const feedback = byId("groupFeedback");
  const input = byId("inputNewGroupName");

  if (groupFeedbackTimer) {
    window.clearTimeout(groupFeedbackTimer);
    groupFeedbackTimer = null;
  }
  groupFeedbackToken += 1;

  if (feedback) {
    feedback.hidden = true;
    feedback.textContent = "";
    feedback.className = "group-feedback";
  }
  if (input) {
    input.classList.remove("group-input-alert", "group-input-shake");
  }
}

function setGroupFeedback(message, type = "warn", { sticky = false } = {}) {
  const feedback = byId("groupFeedback");
  const input = byId("inputNewGroupName");
  if (!feedback) return;

  const resolvedType = ["error", "warn", "success", "info"].includes(type) ? type : "warn";
  const isErrorLike = resolvedType === "error" || resolvedType === "warn";

  if (groupFeedbackTimer) {
    window.clearTimeout(groupFeedbackTimer);
    groupFeedbackTimer = null;
  }

  groupFeedbackToken += 1;
  const token = groupFeedbackToken;

  feedback.hidden = false;
  feedback.className = `group-feedback ${resolvedType}`;
  feedback.textContent = String(message || "");

  if (input) {
    input.classList.toggle("group-input-alert", isErrorLike);
    input.classList.remove("group-input-shake");
    if (isErrorLike) {
      // Re-trigger shake animation each time we show a new group error.
      void input.offsetWidth;
      input.classList.add("group-input-shake");
      window.setTimeout(() => {
        if (groupFeedbackToken !== token) return;
        input.classList.remove("group-input-shake");
      }, 260);
    }
  }

  if (!sticky && (resolvedType === "success" || resolvedType === "info")) {
    groupFeedbackTimer = window.setTimeout(() => {
      if (groupFeedbackToken !== token) return;
      clearGroupFeedback();
    }, 2600);
  }
}

function createGroup(groupName) {
  const normalized = normalizeGroupInput(groupName);
  if (!normalized) {
    const message = "请输入分组名称后再创建。";
    setGroupFeedback(message, "error", { sticky: true });
    showToast(message, "warn");
    return false;
  }
  if (normalized === GROUP_UNKNOWN_NAME) {
    const message = "“未知组”为系统分组，不能新建同名分组。";
    setGroupFeedback(message, "error", { sticky: true });
    showToast(message, "warn");
    return false;
  }
  const existing = getCustomGroupNames();
  const matched = existing.find((item) => item.toLowerCase() === normalized.toLowerCase());
  if (matched) {
    activeGroupKey = matched;
    renderList();
    const message = `分组“${matched}”已存在，已自动切换。`;
    setGroupFeedback(message, "info");
    showToast(message, "info");
    return true;
  }

  const manual = getManualGroups();
  manual.push(normalized);
  saveManualGroups(manual);
  activeGroupKey = normalized;
  renderList();
  const message = `分组“${normalized}”已创建。`;
  setGroupFeedback(message, "success");
  showToast(message, "success");
  return true;
}

function deleteGroup(groupName) {
  const normalized = normalizeGroupInput(groupName);
  if (!normalized || normalized === GROUP_ALL_KEY || normalized === GROUP_UNKNOWN_NAME) {
    const message = "该分组不支持删除。";
    setGroupFeedback(message, "warn", { sticky: true });
    showToast(message, "warn");
    return false;
  }

  const groupKey = normalized.toLowerCase();
  const hasProjects = projects.some(
    (project) => normalizeGroupName(project.groupName).toLowerCase() === groupKey
  );
  if (hasProjects) {
    const message = `分组“${normalized}”内还有项目，无法删除。`;
    setGroupFeedback(message, "warn", { sticky: true });
    showToast(message, "warn");
    return false;
  }

  const manualGroups = getManualGroups();
  const nextManualGroups = manualGroups.filter((item) => item.toLowerCase() !== groupKey);
  if (nextManualGroups.length === manualGroups.length) {
    const message = `分组“${normalized}”不存在或不可删除。`;
    setGroupFeedback(message, "warn", { sticky: true });
    showToast(message, "warn");
    return false;
  }

  saveManualGroups(nextManualGroups);
  if (String(activeGroupKey || "").toLowerCase() === groupKey) {
    activeGroupKey = GROUP_ALL_KEY;
  }
  renderList();
  const message = `分组“${normalized}”已删除。`;
  setGroupFeedback(message, "success");
  showToast(message, "success");
  return true;
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
      <div class="group-row">
        <button
          class="group-item ${item.key === activeGroupKey ? "active" : ""}"
          type="button"
          data-group="${escapeHtml(item.key)}"
          aria-label="切换到 ${escapeHtml(item.label)}"
        >
          <span class="group-item-name">${escapeHtml(item.label)}</span>
          <span class="group-item-count">${item.count}</span>
        </button>
        ${item.key !== GROUP_ALL_KEY && item.key !== GROUP_UNKNOWN_NAME && item.count === 0
    ? `
          <button
            class="btn btn-xs btn-danger group-delete-btn"
            type="button"
            data-group-delete="${escapeHtml(item.key)}"
            aria-label="删除分组 ${escapeHtml(item.label)}"
            title="删除空分组"
          >删</button>
        `
    : ""}
      </div>
    `)
    .join("");

  groupList.innerHTML = html;
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

function hasDeployAuth(project) {
  const deploy = project?.deploy;
  if (!deploy) return false;
  return Boolean(
    String(deploy.password || "").trim() ||
    String(deploy.privateKey || "").trim()
  );
}

function announce(message) {
  if (!srAnnouncement || !message) return;
  srAnnouncement.textContent = "";
  window.setTimeout(() => {
    srAnnouncement.textContent = String(message);
  }, 16);
}

function getProjectRuntimeStatus(project) {
  const branchReady = Boolean(String(project?.branch || "").trim());
  const zipExists = Boolean(project?.zipExists && project?.zipPath);
  const deployConfigured = hasDeployConfig(project);
  const deployed = isDeployed(project);
  const deployReady = branchReady && zipExists && deployConfigured;
  const needsConfig = !branchReady || !deployConfigured;
  return {
    branchReady,
    zipExists,
    deployConfigured,
    deployed,
    deployReady,
    needsConfig
  };
}

function matchesProjectKeyword(project, keyword) {
  if (!keyword) return true;
  const normalizedKeyword = keyword.toLowerCase();
  const text = [
    safeText(project.projectName, ""),
    safeText(project.groupName, ""),
    safeText(project.branch, ""),
    safeText(project.commitHash, ""),
    safeText(project.commitMsg, ""),
    safeText(project.remark, ""),
    safeText(project.dirPath, "")
  ].join(" ").toLowerCase();
  return text.includes(normalizedKeyword);
}

function applyProjectViewFilters(projectItems) {
  return projectItems.filter((project) => {
    const runtime = getProjectRuntimeStatus(project);

    if (projectDeployFilter === "ready" && !runtime.deployReady) return false;
    if (projectDeployFilter === "deployed" && !runtime.deployed) return false;
    if (projectDeployFilter === "pending" && !runtime.needsConfig) return false;
    if (projectDeployFilter === "packed" && !runtime.zipExists) return false;

    return matchesProjectKeyword(project, projectSearchKeyword.trim());
  });
}

function syncProjectFilterControls() {
  const searchInput = byId("inputProjectSearch");
  const deploySelect = byId("filterDeployState");
  if (searchInput && searchInput.value !== projectSearchKeyword) {
    searchInput.value = projectSearchKeyword;
  }
  if (deploySelect && deploySelect.value !== projectDeployFilter) {
    deploySelect.value = projectDeployFilter;
  }
}

function updateProjectFilterResult(totalInGroup, visibleCount) {
  const result = byId("projectFilterResult");
  if (!result) return;

  const hasFilter = Boolean(projectSearchKeyword.trim()) || projectDeployFilter !== "all";
  if (!totalInGroup) {
    result.textContent = "当前分组暂无项目";
    return;
  }

  if (!hasFilter) {
    result.textContent = `共 ${visibleCount} 项`;
    return;
  }

  result.textContent = `显示 ${visibleCount} / ${totalInGroup} 项`;
}

function clearProjectFilters({ rerender = true } = {}) {
  projectSearchKeyword = "";
  projectDeployFilter = "all";
  syncProjectFilterControls();
  if (rerender) renderList();
}

function formatClockTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function setOperationStatus(type, label, detail = "") {
  const statusType = ["idle", "running", "success", "error", "warn"].includes(type) ? type : "idle";
  const statusLabel = String(label || "").trim() || "状态：空闲";
  const statusDetail = String(detail || "").trim() || (
    statusType === "idle" ? "最近动作：暂无" : `最近动作：${formatClockTime()} 更新`
  );
  const snapshot = `${statusType}|${statusLabel}|${statusDetail}`;
  if (snapshot === lastOperationStatusSnapshot) return;
  lastOperationStatusSnapshot = snapshot;

  const terminalMessage = `${statusLabel} | ${statusDetail}`;
  if (statusType === "success") {
    termSuccess(terminalMessage);
    return;
  }
  if (statusType === "error") {
    termError(terminalMessage);
    return;
  }
  if (statusType === "running") {
    termCmd(terminalMessage);
    return;
  }
  if (statusType === "warn") {
    appendTerminal(terminalMessage, "warn");
    return;
  }
  appendTerminal(terminalMessage, "hint");
}

function renderTodayInfo() {
  const todayInfo = byId("todayInfo");
  if (!todayInfo) return;
  todayInfo.textContent = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
}

function normalizeErrorMessage(message) {
  if (!message) return "操作失败，请稍后重试。";
  if (message.includes("Failed to fetch")) return "网络请求失败，请确认服务是否已启动。";
  if (message.includes("Unexpected token")) return "接口返回异常，请检查服务日志。";
  return message;
}

function showToast(message, type = "info", duration = 2600) {
  if (!toastRegion) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  const toasts = toastRegion.querySelectorAll(".toast");
  if (toasts.length >= 4) {
    toasts[0].remove();
  }
  toastRegion.appendChild(toast);
  announce(message);
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

function renderList() {
  const list = byId("projectList");
  const empty = byId("emptyState");
  if (!list || !empty) return;

  renderGroupList();
  renderGroupNameOptions();
  syncProjectFilterControls();

  const currentGroupLabel = activeGroupKey === GROUP_ALL_KEY ? "全部项目" : activeGroupKey;

  if (!projects.length) {
    updateProjectFilterResult(0, 0);
    empty.innerHTML = "<p>暂无项目，点击右上角“添加项目”开始。</p>";
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  const groupedProjects = getFilteredProjects();
  if (!groupedProjects.length) {
    updateProjectFilterResult(0, 0);
    empty.innerHTML = `<p>“${escapeHtml(currentGroupLabel)}”暂时没有项目，请切换分组或新增项目。</p>`;
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  const visibleProjects = applyProjectViewFilters(groupedProjects);
  updateProjectFilterResult(groupedProjects.length, visibleProjects.length);

  if (!visibleProjects.length) {
    const hasFilter = Boolean(projectSearchKeyword.trim()) || projectDeployFilter !== "all";
    empty.innerHTML = hasFilter
      ? `<p>当前筛选条件下没有匹配项目。</p><button class="btn btn-secondary btn-sm btn-reset-inline" type="button" data-action="reset-filters">清空筛选</button>`
      : "<p>暂无项目，点击右上角“添加项目”开始。</p>";
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  empty.style.display = "none";

  const html = visibleProjects
    .map((project) => {
      const projectId = escapeHtml(project.id);
      const projectName = escapeHtml(safeText(project.projectName));
      const groupName = escapeHtml(normalizeGroupName(project.groupName));
      const runtime = getProjectRuntimeStatus(project);
      const branch = escapeHtml(runtime.branchReady ? safeText(project.branch) : "未记录分支");
      const commitHash = escapeHtml(safeText(project.commitHash));
      const commitMsg = escapeHtml(safeText(project.commitMsg));
      const dirPath = safeText(project.dirPath);
      const remark = safeText(project.remark, "");
      const accessUrl = normalizeAccessUrl(project.accessUrl);
      const accessUrlHtml = accessUrl
        ? (isHttpAccessUrl(accessUrl)
          ? `<a class="card-link" href="${escapeHtml(accessUrl)}" target="_blank" rel="noopener noreferrer" translate="no">${escapeHtml(accessUrl)}</a>`
          : escapeHtml(accessUrl))
        : "未填写";
      const buildCmd = escapeHtml(safeText(project.buildCmd, "npm run build"));

      const packTip = runtime.branchReady ? "" : "请先在项目配置中填写记录分支";
      const deployTip = !runtime.branchReady
        ? "记录分支为空，请先编辑项目并填写分支"
        : (!runtime.deployConfigured
          ? "请先配置部署信息"
          : (!runtime.zipExists ? "请先打包项目" : ""));
      const gitRefreshReady = Boolean(String(project.dirPath || "").trim());
      const gitRefreshTip = gitRefreshReady ? "" : "项目路径为空，无法刷新 Git";
      const connAuthReady = hasDeployAuth(project);
      const connTestReady = runtime.deployConfigured && connAuthReady;
      const connTestTip = !runtime.deployConfigured
        ? "请先配置部署信息"
        : (!connAuthReady ? "请先配置密码或私钥" : "");

      const lifecycleClass = runtime.deployed
        ? "is-deployed"
        : (runtime.deployReady ? "is-ready" : (runtime.needsConfig ? "is-pending" : "is-waiting"));
      const lifecycleText = runtime.deployed
        ? "已部署"
        : (runtime.deployReady ? "可部署" : (runtime.needsConfig ? "待补配置" : "待打包"));

      const healthTips = [];
      if (!runtime.branchReady) healthTips.push("未记录分支");
      if (!runtime.deployConfigured) healthTips.push("缺少部署配置");
      if (!runtime.zipExists) healthTips.push("还未生成压缩包");
      const healthText = healthTips.length ? healthTips.join(" · ") : "配置完整，可直接执行部署";
      const healthClass = healthTips.length ? "warn" : "ok";

      const statusText = runtime.deployed ? "已部署" : "未部署";
      const statusClass = runtime.deployed ? "success" : "";

      return `
      <article class="project-card" data-id="${projectId}">
        <div class="project-card-head">
          <div class="card-title-row">
            <h3 class="project-name">${projectName}</h3>
            <span class="project-state-pill ${lifecycleClass}">${lifecycleText}</span>
          </div>
          <p class="card-health ${healthClass}">${escapeHtml(healthText)}</p>
        </div>

        <div class="card-main">
          <div class="card-info">
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
            ${runtime.zipExists ? `
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
            <div class="card-action-row card-action-row-basic">
              <button
                class="btn btn-sm btn-secondary btn-open-folder"
                type="button"
                data-path="${escapeHtml(dirPath)}"
                aria-label="在文件管理器中打开 ${projectName}"
              >打开文件夹</button>

              <button
                class="btn btn-sm btn-secondary btn-edit"
                type="button"
                data-id="${projectId}"
                aria-label="编辑 ${projectName}"
              >编辑项目</button>
            </div>

            <div class="card-action-row card-action-row-connect">
              <button
                class="btn btn-sm btn-secondary btn-refresh-git-row"
                type="button"
                data-id="${projectId}"
                data-name="${projectName}"
                ${gitRefreshReady ? "" : "disabled"}
                ${gitRefreshTip ? `title="${gitRefreshTip}"` : ""}
                aria-label="刷新 ${projectName} 的 Git 信息"
              >刷新Git</button>

              <button
                class="btn btn-sm btn-secondary btn-test-conn-row"
                type="button"
                data-id="${projectId}"
                data-name="${projectName}"
                ${connTestReady ? "" : "disabled"}
                ${connTestTip ? `title="${connTestTip}"` : ""}
                aria-label="测试 ${projectName} 的服务器连接"
              >测试连接</button>
            </div>

            <div class="card-action-row card-action-row-exec">
              <button
                class="btn btn-sm btn-warn btn-pack"
                type="button"
                data-id="${projectId}"
                data-name="${projectName}"
                ${runtime.branchReady ? "" : "disabled"}
                ${packTip ? `title="${packTip}"` : ""}
                aria-label="打包 ${projectName}"
              >打包</button>

              <button
                class="btn btn-sm btn-primary btn-deploy"
                type="button"
                data-id="${projectId}"
                data-name="${projectName}"
                ${runtime.deployReady ? "" : "disabled"}
                ${deployTip ? `title="${deployTip}"` : ""}
                aria-label="部署 ${projectName}"
              >部署</button>
            </div>
          </div>
        </div>

        ${runtime.deployConfigured ? `
        <div class="card-deploy-info">
          <span>服务器：${escapeHtml(safeText(project.deploy.host))}:${escapeHtml(safeText(project.deploy.port, 22))}</span>
          <span>部署路径：${escapeHtml(safeText(project.deploy.deployPath))}</span>
          <span>状态：<span class="status ${statusClass}">${statusText}</span></span>
        </div>
        ` : ""}
        <div class="card-danger-zone">
          <span class="card-danger-label">危险操作</span>
          <button
            class="btn btn-sm btn-danger btn-delete"
            type="button"
            data-id="${projectId}"
            data-name="${projectName}"
            aria-label="删除 ${projectName}"
          >删除项目</button>
        </div>
      </article>
      `;
    })
    .join("");

  list.innerHTML = html;
  updateEditingCardHighlight();
}

function updateEditingCardHighlight() {
  const editingId = String(currentEditId ?? "");
  $$(".project-card").forEach((card) => {
    const isEditing = Boolean(editingId) && String(card.dataset.id || "") === editingId;
    card.classList.toggle("is-editing-current", isEditing);
  });
}

function syncEditModalOverlayMetrics() {
  const overlay = byId("editModal");
  const rightPanel = byId("rightPanel");
  if (!overlay || !rightPanel) return;

  const rect = rightPanel.getBoundingClientRect();
  const width = Math.max(360, Math.round(rect.width));
  const height = Math.max(320, Math.round(rect.height));
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));

  overlay.style.setProperty("--edit-overlay-left", `${left}px`);
  overlay.style.setProperty("--edit-overlay-top", `${top}px`);
  overlay.style.setProperty("--edit-overlay-width", `${width}px`);
  overlay.style.setProperty("--edit-overlay-height", `${height}px`);
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
  if (id === "editModal") {
    currentEditId = null;
    updateEditingCardHighlight();
  }
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

function isModalOpen(id) {
  const modal = byId(id);
  return Boolean(modal && modal.classList.contains("active"));
}

function settleConfirm(result) {
  const resolver = confirmResolver;
  confirmResolver = null;
  closeModal("confirmModal");
  if (resolver) resolver(result);
}

function askConfirm({
  title = "请确认操作",
  message = "确认继续当前操作吗？",
  confirmText = "确认",
  tone = "primary"
} = {}) {
  const modal = byId("confirmModal");
  const titleEl = byId("confirmModalTitle");
  const messageEl = byId("confirmModalMessage");
  const confirmBtn = byId("btnConfirmOk");

  if (!modal || !titleEl || !messageEl || !confirmBtn) {
    return Promise.resolve(window.confirm(message));
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmBtn.textContent = confirmText;
  confirmBtn.classList.remove("btn-primary", "btn-danger", "btn-warn");
  if (tone === "danger") confirmBtn.classList.add("btn-danger");
  else if (tone === "warn") confirmBtn.classList.add("btn-warn");
  else confirmBtn.classList.add("btn-primary");

  openModal("confirmModal");

  return new Promise((resolve) => {
    confirmResolver = resolve;
    window.setTimeout(() => confirmBtn.focus(), 10);
  });
}

$$("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});

$$(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay) return;
    if (overlay.id === "confirmModal") {
      settleConfirm(false);
      return;
    }
    closeModal(overlay.id);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (isModalOpen("confirmModal")) {
    settleConfirm(false);
    return;
  }
  closeTopModal();
});

function isTypingTarget(node) {
  if (!node || !(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tagName = node.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "/") return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(document.activeElement)) return;
  const searchInput = byId("inputProjectSearch");
  if (!searchInput) return;
  event.preventDefault();
  searchInput.focus();
  searchInput.select();
});

window.addEventListener("resize", () => {
  if (!isModalOpen("editModal")) return;
  syncEditModalOverlayMetrics();
});

const btnConfirmCancel = byId("btnConfirmCancel");
const btnConfirmOk = byId("btnConfirmOk");
if (btnConfirmCancel) {
  btnConfirmCancel.addEventListener("click", () => settleConfirm(false));
}
if (btnConfirmOk) {
  btnConfirmOk.addEventListener("click", () => settleConfirm(true));
}

function resetTerminal() {
  terminal.innerHTML = '<div class="terminal-line hint">等待操作...</div>';
  terminalTitle.textContent = "操作终端";
  setOperationStatus("idle", "状态：空闲");
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

function termWarn(text) {
  appendTerminal(text, "warn");
}

function termSeparator(label) {
  appendTerminal(`=== ${label} ===`, "separator");
}

byId("btnClearTerminal").addEventListener("click", resetTerminal);

function runSSE(url, label) {
  return new Promise((resolve, reject) => {
    terminalTitle.textContent = label;
    setOperationStatus("running", `状态：${label}进行中`, "最近动作：日志流已连接");
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
        setOperationStatus("success", `状态：${label}完成`);
        finish(() => resolve(data));
        return;
      }

      if (data.type === "error") {
        termError(data.text || "操作失败。");
        setOperationStatus("error", `状态：${label}失败`);
        finish(() => reject(new Error(data.text || "操作失败。")));
      }
    };

    source.onerror = () => {
      setOperationStatus("error", `状态：${label}中断`, "最近动作：日志连接中断");
      finish(() => reject(new Error("日志连接中断，请重试。")));
    };
  });
}

function withButtonLoading(button, loadingText, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;
  button.setAttribute("aria-busy", "true");
  return Promise.resolve(task()).finally(() => {
    button.disabled = false;
    button.textContent = original;
    button.removeAttribute("aria-busy");
  });
}

async function validateBranchBeforeAction(projectId, projectName, actionName, { resetTerminal = true } = {}) {
  try {
    const result = await api(`/api/branch-check/${projectId}`);
    if (result?.ok) {
      const branch = safeText(result.currentBranch || result.recordedBranch, "-");
      termLog(`分支校验通过：${branch}`);
      return true;
    }
    const message = result?.message || "分支校验失败，已禁止后续操作";
    if (resetTerminal) termClear();
    termSeparator(`${actionName} ${projectName}`);
    termError(message);
    setOperationStatus("warn", `状态：${actionName}已拦截`, "最近动作：分支校验未通过");
    showToast(message, "warn", 3600);
    return false;
  } catch (error) {
    const message = `分支校验失败：${normalizeErrorMessage(error.message)}`;
    if (resetTerminal) termClear();
    termSeparator(`${actionName} ${projectName}`);
    termError(message);
    setOperationStatus("error", `状态：${actionName}校验失败`);
    showToast(message, "error", 3600);
    return false;
  }
}

async function checkRemoteAndLocalGitBeforePack(projectId, projectName) {
  const safeProjectName = safeText(projectName, "当前项目");
  termClear();
  termSeparator(`打包前Git校验 ${safeProjectName}`);
  termCmd("开始读取远程与本地 Git 信息...");
  setOperationStatus("running", "状态：打包前Git校验中", "最近动作：正在读取远程与本地提交");

  try {
    const info = await api(`/api/git-sync-check/${projectId}`);

    const remoteBranch = safeText(info.remoteBranch, "-");
    const remoteHash = safeText(info.remoteHashShort || info.remoteHash, "-");
    const localBranch = safeText(info.localBranch, "-");
    const localHash = safeText(info.localHashShort || info.localHash, "-");
    const localCommitMsg = safeText(info.localCommitMsg, "-");
    const localCommitTime = safeText(info.localCommitTime, "-");

    termCmd(`远程最新：origin/${remoteBranch} ${remoteHash}`);
    termLog(`本地当前：${localBranch} ${localHash}`);
    termLog(`本地提交：${localCommitMsg}`);
    termLog(`提交时间：${localCommitTime}`);

    if (info.same) {
      termSuccess("远程与本地提交一致，继续打包。");
      setOperationStatus("success", "状态：打包前Git校验通过");
      return true;
    }

    termWarn("远程与本地提交不一致。");
    termWarn("已弹出确认框，请选择是否继续打包。");
    setOperationStatus(
      "warn",
      "状态：打包前Git校验告警",
      `最近动作：远程 ${remoteHash} / 本地 ${localHash}`
    );
    const confirmed = await askConfirm({
      title: "Git 提交不一致",
      message: `远程最新提交(${remoteHash})与本地提交(${localHash})不一致，是否继续打包？`,
      confirmText: "继续打包",
      tone: "warn"
    });

    if (!confirmed) {
      termWarn("用户选择：取消打包。");
      setOperationStatus("idle", "状态：已取消打包");
      showToast("已取消打包。", "info", 1800);
      return false;
    }

    termSuccess("用户选择：继续打包。");
    return true;
  } catch (error) {
    const message = normalizeErrorMessage(error.message);
    termError(`Git校验失败：${message}`);
    setOperationStatus("error", "状态：打包前Git校验失败");
    showToast(`打包前 Git 校验失败：${message}`, "error", 3600);
    return false;
  }
}

function getProjectById(projectId) {
  return projects.find((item) => item.id === projectId) || null;
}

async function refreshProjectGit(projectId, triggerButton) {
  const project = getProjectById(projectId);
  if (!project) {
    showToast("未找到项目，无法刷新。", "warn");
    return;
  }

  const dirPath = normalizePath(project.dirPath);
  if (!dirPath) {
    showToast("项目路径为空，无法刷新 Git。", "warn");
    return;
  }

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "刷新中...", task)
    : (task) => Promise.resolve(task());

  await runner(async () => {
    try {
      const data = await api("/api/parse-git", {
        method: "POST",
        body: { dirPath }
      });

      const update = {
        projectName: String(data.projectName || project.projectName || "").trim() || project.projectName,
        dirPath,
        branch: String(data.branch || "").trim(),
        commitHash: String(data.commitHash || "").trim(),
        commitMsg: String(data.commitMsg || "").trim(),
        commitTime: String(data.commitTime || "").trim(),
        recentLogs: String(data.recentLogs || "")
      };

      const updated = await api(`/api/projects/${projectId}`, {
        method: "PUT",
        body: update
      });

      const index = projects.findIndex((item) => item.id === projectId);
      if (index !== -1) projects[index] = updated;
      renderList();
      setOperationStatus("success", "状态：Git已刷新");
      showToast(`项目 ${safeText(updated.projectName, project.projectName)} Git 已刷新。`, "success");
    } catch (error) {
      setOperationStatus("error", "状态：Git刷新失败");
      showToast(`刷新失败：${normalizeErrorMessage(error.message)}`, "error");
    }
  });
}

function buildConnPayloadFromProject(project) {
  const deploy = project?.deploy || {};
  const host = String(deploy.host || "").trim();
  const username = String(deploy.username || "").trim();
  if (!host || !username) {
    return { ok: false, message: "请先配置服务器地址和用户名。" };
  }

  const payload = {
    host,
    port: Number.parseInt(deploy.port, 10) || 22,
    username
  };

  const privateKey = String(deploy.privateKey || "").trim();
  const password = String(deploy.password || "");

  if (privateKey) {
    payload.privateKey = privateKey;
    return { ok: true, payload };
  }

  if (password.trim()) {
    payload.password = password;
    return { ok: true, payload };
  }

  return { ok: false, message: "请先在部署配置中填写密码或私钥。" };
}

async function testProjectConnection(projectId, triggerButton) {
  const project = getProjectById(projectId);
  if (!project) {
    termClear();
    termSeparator("测试连接");
    termError("未找到项目，无法测试连接。");
    setOperationStatus("warn", "状态：连接测试未开始", "最近动作：项目不存在");
    showToast("未找到项目，无法测试连接。", "warn");
    return;
  }

  const projectName = safeText(project.projectName, "当前项目");
  const parsed = buildConnPayloadFromProject(project);
  if (!parsed.ok) {
    termClear();
    termSeparator(`测试连接 ${projectName}`);
    termError(parsed.message);
    setOperationStatus("warn", "状态：连接测试未开始", "最近动作：连接配置不完整");
    showToast(parsed.message, "warn");
    return;
  }

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "测试中...", task)
    : (task) => Promise.resolve(task());

  await runner(async () => {
    const payload = parsed.payload;
    const target = `${payload.username}@${payload.host}:${payload.port}`;
    const authMode = payload.privateKey ? "私钥" : "密码";
    termClear();
    termSeparator(`测试连接 ${projectName}`);
    termCmd(`目标：${target}`);
    termLog(`认证方式：${authMode}`);
    setOperationStatus("running", "状态：连接测试中", `最近动作：正在连接 ${target}`);
    try {
      await api("/api/test-connection", { method: "POST", body: payload });
      termSuccess("连接测试通过。");
      setOperationStatus("success", "状态：连接测试通过", `最近动作：${target} 连接成功`);
      showToast(`项目 ${projectName} 连接成功。`, "success");
    } catch (error) {
      const message = normalizeErrorMessage(error.message);
      termError(`连接失败：${message}`);
      setOperationStatus("error", "状态：连接测试失败", `最近动作：${target} 连接失败`);
      showToast(`连接失败：${message}`, "error", 3400);
    }
  });
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
  setOperationStatus("success", "状态：列表已刷新");
  showToast("项目列表已刷新。", "info");
});

const inputProjectSearch = byId("inputProjectSearch");
if (inputProjectSearch) {
  inputProjectSearch.addEventListener("input", (event) => {
    projectSearchKeyword = String(event.target.value || "").trimStart();
    renderList();
  });
}

const filterDeployState = byId("filterDeployState");
if (filterDeployState) {
  filterDeployState.addEventListener("change", (event) => {
    projectDeployFilter = event.target.value || "all";
    renderList();
  });
}

const btnResetProjectFilters = byId("btnResetProjectFilters");
if (btnResetProjectFilters) {
  btnResetProjectFilters.addEventListener("click", () => {
    clearProjectFilters();
    showToast("筛选条件已重置。", "info", 1800);
  });
}

function tryCreateGroupFromInput() {
  const input = byId("inputNewGroupName");
  if (!input) return false;
  input.value = normalizeGroupInput(input.value);
  const ok = createGroup(input.value);
  if (!ok) return false;
  input.value = "";
  input.focus();
  return true;
}

byId("inputNewGroupName").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    tryCreateGroupFromInput();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.currentTarget.value = "";
    clearGroupFeedback();
  }
});

byId("inputNewGroupName").addEventListener("input", () => {
  clearGroupFeedback();
});

byId("inputNewGroupName").addEventListener("change", (event) => {
  event.currentTarget.value = normalizeGroupInput(event.currentTarget.value);
});

byId("groupList").addEventListener("click", async (event) => {
  const deleteBtn = event.target.closest(".group-delete-btn");
  if (deleteBtn) {
    const groupName = normalizeGroupInput(deleteBtn.dataset.groupDelete || "");
    if (!groupName) return;

    const confirmed = await askConfirm({
      title: "确认删除分组",
      message: `仅空分组可删除。确认删除分组“${groupName}”吗？`,
      confirmText: "删除分组",
      tone: "danger"
    });
    if (!confirmed) return;

    deleteGroup(groupName);
    return;
  }

  const target = event.target.closest(".group-item");
  if (!target) return;
  const nextGroup = target.dataset.group || GROUP_ALL_KEY;
  if (nextGroup === activeGroupKey) return;
  activeGroupKey = nextGroup;
  renderList();
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

  if (button.dataset.action === "reset-filters") {
    clearProjectFilters();
    return;
  }

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

  if (button.classList.contains("btn-refresh-git-row")) {
    await refreshProjectGit(projectId, button);
    return;
  }

  if (button.classList.contains("btn-test-conn-row")) {
    await testProjectConnection(projectId, button);
    return;
  }

  if (button.classList.contains("btn-pack")) {
    await withButtonLoading(button, "打包中...", async () => {
      const gitReady = await checkRemoteAndLocalGitBeforePack(projectId, projectName);
      if (!gitReady) return;

      termCmd("开始执行分支校验...");
      const allowed = await validateBranchBeforeAction(projectId, projectName, "打包", { resetTerminal: false });
      if (!allowed) return;

      termLog("分支校验通过，进入构建与打包阶段。");
      termSeparator(`开始打包 ${projectName}`);
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

    const confirmed = await askConfirm({
      title: "确认部署",
      message: `将开始部署 “${project.projectName}”。请确认分支和配置都已核对无误。`,
      confirmText: "确认部署",
      tone: "warn"
    });
    if (!confirmed) return;

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
    const confirmed = await askConfirm({
      title: "确认删除项目",
      message: `删除 “${targetName}” 后不可撤销，仅删除面板记录，不会删除本地代码目录。`,
      confirmText: "确认删除",
      tone: "danger"
    });
    if (!confirmed) return;

    try {
      await api(`/api/projects/${projectId}`, { method: "DELETE" });
      projects = projects.filter((item) => item.id !== projectId);
      renderList();
      setOperationStatus("success", "状态：项目已删除");
      showToast("项目已删除。", "success");
    } catch (error) {
      setOperationStatus("error", "状态：删除失败");
      showToast(`删除失败：${normalizeErrorMessage(error.message)}`, "error");
    }
  }
});

const emptyState = byId("emptyState");
if (emptyState) {
  emptyState.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-action='reset-filters']");
    if (!target) return;
    clearProjectFilters();
    showToast("筛选条件已重置。", "info", 1800);
  });
}

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
  syncEditModalOverlayMetrics();
  updateEditingCardHighlight();
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

byId("btnSaveEdit").addEventListener("click", async () => {
  const activeAuth = $(".edit-auth-tabs .tab-btn.active").dataset.auth;
  const projectName = byId("editProjectName").value.trim();
  const dirPath = normalizePath(byId("editDirPath").value);
  const currentProject = projects.find((item) => item.id === currentEditId) || null;
  byId("editDirPath").value = dirPath;

  if (!projectName || !dirPath) {
    showToast("项目名称和工作副本路径不能为空。", "warn");
    return;
  }

  const update = {
    projectName,
    dirPath,
    branch: byId("editBranch").value.trim(),
    // Commit hash/message are read-only in edit modal; always persist existing recorded values.
    commitHash: safeText(currentProject?.commitHash, "").trim(),
    commitMsg: safeText(currentProject?.commitMsg, "").trim(),
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
    if (!silent) {
      setOperationStatus("success", "状态：项目数据已同步");
    }
  } catch (error) {
    setOperationStatus("error", "状态：项目加载失败");
    if (!silent) {
      showToast(`加载项目失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  }
}

resetTerminal();
renderTodayInfo();
renderRecentDirOptions();
loadProjects();
