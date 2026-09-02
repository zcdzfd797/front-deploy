let projects = [];
let servers = [];
let activeView = "projects";
let currentEditId = null;
let currentEditTargetIds = [];
let backupSelectorState = null;
let targetPickerState = null;
let targetPickerResolver = null;
let serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
let serverFormImportedPath = "";
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

function getTargetPack(project, targetId) {
  return (project?.packs && typeof project.packs === "object" && project.packs[targetId]) || null;
}

function isTargetPacked(project, targetId) {
  const pack = getTargetPack(project, targetId);
  return Boolean(pack?.zipExists && pack?.zipPath);
}

function getTargetBuildCmd(project, targetId) {
  const override = String(project?.buildCmds?.[targetId] || "").trim();
  if (override) return override;
  return String(project?.buildCmd || "").trim() || "npm run build";
}

function getBackupFolderBaseName(project, targetId) {
  const pack = getTargetPack(project, targetId);
  const packDirName = String(pack?.packDirName || "").trim();
  if (packDirName) return packDirName;

  const zipName = String(pack?.zipName || "").trim();
  if (zipName) {
    const fileName = zipName.split(/[\\/]/).pop() || zipName;
    return fileName.replace(/\.zip$/i, "");
  }

  const zipPath = String(pack?.zipPath || "").trim();
  const fileName = zipPath.split(/[\\/]/).pop() || "";
  return fileName.replace(/\.zip$/i, "");
}

function findPathById(pathId) {
  const normalized = String(pathId || "");
  if (!normalized) return null;
  for (const server of servers) {
    const pathEntry = (server.paths || []).find((item) => item.id === normalized);
    if (pathEntry) return { server, path: pathEntry };
  }
  return null;
}

function getProjectTargets(project) {
  const ids = Array.isArray(project?.targetIds) ? project.targetIds : [];
  const result = [];
  ids.forEach((pathId) => {
    const found = findPathById(pathId);
    if (found) result.push(found);
  });
  return result;
}

function getTargetLabel(server, pathEntry) {
  const label = String(pathEntry?.label || "").trim();
  return label ? `${safeText(server?.name)} · ${label}` : safeText(server?.name);
}

function getTargetDeployState(project, pathId) {
  const states = project?.deployStates;
  return (states && typeof states === "object" && states[pathId]) || null;
}

function isTargetDeployed(project, pathId) {
  const state = getTargetDeployState(project, pathId);
  if (!state) return false;
  if (state.lastDeployTime) return true;
  return typeof state.deployStatus === "string" && state.deployStatus.includes("已");
}

function getPathUsage(pathId) {
  return projects.filter((project) => (Array.isArray(project.targetIds) ? project.targetIds : []).includes(pathId));
}

function getProjectLinkedServers(project) {
  const seen = new Set();
  const result = [];
  getProjectTargets(project).forEach(({ server }) => {
    if (seen.has(server.id)) return;
    seen.add(server.id);
    result.push(server);
  });
  return result;
}

function hasServerAuth(server) {
  return Boolean(
    server &&
    (String(server.password || "").trim() || String(server.privateKey || "").trim())
  );
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
    const baseOption = '<option value="">最近使用路径…</option>';
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

function hasDeployConfig(project) {
  return getProjectTargets(project).length > 0;
}

function getProjectRuntimeStatus(project) {
  const branchReady = Boolean(String(project?.branch || "").trim());
  const targets = getProjectTargets(project);
  const targetCount = targets.length;
  const packedCount = targets.filter((item) => isTargetPacked(project, item.path.id)).length;
  const zipExists = packedCount > 0;
  const deployConfigured = targetCount > 0;
  const deployedCount = targets.filter((item) => isTargetDeployed(project, item.path.id)).length;
  const deployed = deployedCount > 0;
  const fullyDeployed = targetCount > 0 && deployedCount === targetCount;
  const deployReady = branchReady && packedCount > 0 && deployConfigured;
  const needsConfig = !branchReady || !deployConfigured;
  return {
    branchReady,
    zipExists,
    packedCount,
    targets,
    targetCount,
    deployConfigured,
    deployed,
    fullyDeployed,
    deployedCount,
    deployReady,
    needsConfig
  };
}

function matchesProjectKeyword(project, keyword) {
  if (!keyword) return true;
  const normalizedKeyword = keyword.toLowerCase();
  const targetText = getProjectTargets(project).map(({ server, path }) => (
    [safeText(server?.name, ""), safeText(path?.label, ""), safeText(path?.deployPath, "")].join(" ")
  )).join(" ");
  const text = [
    safeText(project.projectName, ""),
    safeText(project.groupName, ""),
    safeText(project.branch, ""),
    safeText(project.commitHash, ""),
    safeText(project.commitMsg, ""),
    safeText(project.remark, ""),
    safeText(project.dirPath, ""),
    targetText
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

function updateConsoleSummary({ total, visible, groupName }) {
  const totalEl = byId("summaryProjectCount");
  const visibleEl = byId("summaryVisibleCount");
  const groupEl = byId("summaryGroupName");

  if (totalEl) totalEl.textContent = String(total);
  if (visibleEl) visibleEl.textContent = String(visible);
  if (groupEl) groupEl.textContent = groupName || "全部";
  updateConsoleSummaryScope();
}

function updateConsoleSummaryScope() {
  const kicker = byId("summaryScopeKicker");
  const label = byId("summaryScopeLabel");
  const groupEl = byId("summaryGroupName");
  if (!kicker || !label) return;

  if (activeView === "targets") {
    const pathCount = servers.reduce((sum, server) => sum + ((server.paths || []).length), 0);
    kicker.textContent = "PATHS";
    label.textContent = "部署路径总数";
    if (groupEl) groupEl.textContent = String(pathCount);
  } else {
    kicker.textContent = "GROUP";
    label.textContent = "当前分组";
  }
}

function clearProjectFilters({ rerender = true } = {}) {
  projectSearchKeyword = "";
  projectDeployFilter = "all";
  syncProjectFilterControls();
  if (rerender) renderList();
}

function renderTodayInfo() {
  const todayInfo = byId("todayInfo");
  if (!todayInfo) return;
  const dateText = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  todayInfo.textContent = `${dateText} · 端口 ${port}`;
}

/* ===== 悬浮操作终端：显示/隐藏、折叠、拖拽、位置持久化 ===== */

const TERMINAL_STATE_KEY = "frontDeploy.terminalState";
const TERMINAL_MIN_WIDTH = 320;
const TERMINAL_MIN_HEIGHT = 200;

function loadTerminalState() {
  const defaults = { visible: true, collapsed: false, left: null, top: null, width: null, height: null };
  try {
    const raw = window.localStorage.getItem(TERMINAL_STATE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      visible: typeof parsed.visible === "boolean" ? parsed.visible : defaults.visible,
      collapsed: typeof parsed.collapsed === "boolean" ? parsed.collapsed : defaults.collapsed,
      left: Number.isFinite(parsed.left) ? parsed.left : null,
      top: Number.isFinite(parsed.top) ? parsed.top : null,
      width: Number.isFinite(parsed.width) ? parsed.width : null,
      height: Number.isFinite(parsed.height) ? parsed.height : null
    };
  } catch {
    return defaults;
  }
}

let terminalState = loadTerminalState();

function clampTerminalCoord(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function saveTerminalState() {
  const deck = byId("rightPanel");
  if (deck && deck.offsetWidth) {
    terminalState.width = Math.round(deck.offsetWidth);
    if (!terminalState.collapsed) {
      terminalState.height = Math.round(deck.offsetHeight);
    }
  }
  try {
    window.localStorage.setItem(TERMINAL_STATE_KEY, JSON.stringify(terminalState));
  } catch {}
}

function applyTerminalState() {
  const deck = byId("rightPanel");
  if (!deck) return;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = clampTerminalCoord(
    terminalState.width || 540,
    TERMINAL_MIN_WIDTH,
    Math.max(TERMINAL_MIN_WIDTH, viewportWidth - 16)
  );
  const height = clampTerminalCoord(
    terminalState.height || Math.round(viewportHeight * 0.6),
    TERMINAL_MIN_HEIGHT,
    Math.max(TERMINAL_MIN_HEIGHT, viewportHeight - 16)
  );

  if (terminalState.left === null || terminalState.top === null) {
    terminalState.left = viewportWidth - width - 18;
    terminalState.top = viewportHeight - height - 18;
  }
  terminalState.left = clampTerminalCoord(terminalState.left, 8, Math.max(8, viewportWidth - 120));
  terminalState.top = clampTerminalCoord(terminalState.top, 8, Math.max(8, viewportHeight - 48));

  deck.style.left = `${Math.round(terminalState.left)}px`;
  deck.style.top = `${Math.round(terminalState.top)}px`;
  deck.style.width = `${Math.round(width)}px`;
  deck.style.height = `${Math.round(height)}px`;

  deck.classList.toggle("is-hidden", !terminalState.visible);
  deck.classList.toggle("is-collapsed", terminalState.collapsed);

  const toggleBtn = byId("btnToggleTerminal");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", String(terminalState.visible));
  }
  const collapseBtn = byId("btnCollapseTerminal");
  if (collapseBtn) {
    collapseBtn.textContent = terminalState.collapsed ? "展开" : "折叠";
    collapseBtn.setAttribute("aria-expanded", String(!terminalState.collapsed));
  }
}

function setTerminalVisible(visible) {
  terminalState.visible = visible;
  applyTerminalState();
  saveTerminalState();
}

function ensureTerminalVisible() {
  if (!terminalState.visible) setTerminalVisible(true);
}

function initTerminalFloating() {
  const deck = byId("rightPanel");
  const handle = byId("terminalDragHandle");
  if (!deck || !handle) return;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;

    const rect = deck.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    deck.classList.add("is-dragging");

    const onMove = (moveEvent) => {
      terminalState.left = clampTerminalCoord(
        moveEvent.clientX - offsetX,
        8,
        Math.max(8, window.innerWidth - 120)
      );
      terminalState.top = clampTerminalCoord(
        moveEvent.clientY - offsetY,
        8,
        Math.max(8, window.innerHeight - 48)
      );
      deck.style.left = `${Math.round(terminalState.left)}px`;
      deck.style.top = `${Math.round(terminalState.top)}px`;
    };
    const onUp = () => {
      deck.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onMove);
      saveTerminalState();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    event.preventDefault();
  });

  byId("btnToggleTerminal").addEventListener("click", () => {
    setTerminalVisible(!terminalState.visible);
    if (terminalState.visible) {
      showToast("操作终端已显示。", "info", 1600);
    }
  });

  byId("btnHideTerminal").addEventListener("click", () => {
    setTerminalVisible(false);
    showToast("操作终端已隐藏，可从顶部“操作终端”按钮再次打开。", "info", 2400);
  });

  byId("btnCollapseTerminal").addEventListener("click", () => {
    terminalState.collapsed = !terminalState.collapsed;
    applyTerminalState();
    saveTerminalState();
  });

  window.addEventListener("resize", () => {
    applyTerminalState();
  });
  window.addEventListener("beforeunload", saveTerminalState);
  applyTerminalState();
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

async function openAccessUrlExternally(rawUrl) {
  const accessUrl = normalizeAccessUrl(rawUrl);
  if (!accessUrl) {
    showToast("访问地址为空，无法打开。", "warn");
    return false;
  }
  if (!isHttpAccessUrl(accessUrl)) {
    showToast("仅支持打开 http 或 https 访问地址。", "warn");
    return false;
  }

  try {
    await api("/api/open-access-url", {
      method: "POST",
      body: { accessUrl }
    });
    return true;
  } catch (error) {
    showToast(`打开失败：${normalizeErrorMessage(error.message)}`, "error");
    return false;
  }
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

  if (activeView === "targets") {
    renderTargetView();
    return;
  }

  const currentGroupLabel = activeGroupKey === GROUP_ALL_KEY ? "全部项目" : activeGroupKey;

  if (!projects.length) {
    updateProjectFilterResult(0, 0);
    updateConsoleSummary({ total: 0, visible: 0, groupName: currentGroupLabel });
    empty.innerHTML = "<p>暂无项目，点击“添加项目”开始。</p>";
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  const groupedProjects = getFilteredProjects();
  if (!groupedProjects.length) {
    updateProjectFilterResult(0, 0);
    updateConsoleSummary({ total: projects.length, visible: 0, groupName: currentGroupLabel });
    empty.innerHTML = `<p>“${escapeHtml(currentGroupLabel)}”暂时没有项目，请切换分组或新增项目。</p>`;
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  const visibleProjects = applyProjectViewFilters(groupedProjects);
  updateProjectFilterResult(groupedProjects.length, visibleProjects.length);
  updateConsoleSummary({
    total: projects.length,
    visible: visibleProjects.length,
    groupName: currentGroupLabel
  });

  if (!visibleProjects.length) {
    const hasFilter = Boolean(projectSearchKeyword.trim()) || projectDeployFilter !== "all";
    empty.innerHTML = hasFilter
      ? `<p>当前筛选条件下没有匹配项目。</p><button class="btn btn-secondary btn-sm btn-reset-inline" type="button" data-action="reset-filters">清空筛选</button>`
      : "<p>暂无项目，点击“添加项目”开始。</p>";
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
          ? `<button class="card-link card-link-button btn-open-access-url" type="button" data-url="${escapeHtml(accessUrl)}" title="点击用默认浏览器打开" aria-label="在默认浏览器中打开 ${projectName} 的访问地址" translate="no">${escapeHtml(accessUrl)}</button>`
          : escapeHtml(accessUrl))
        : "未填写";
      const buildCmd = escapeHtml(safeText(project.buildCmd, "npm run build"));

      const packTip = !runtime.branchReady
        ? "请先在项目配置中填写记录分支"
        : (!runtime.deployConfigured ? "请先关联部署目标" : "");
      const deployTip = !runtime.branchReady
        ? "记录分支为空，请先编辑项目并填写分支"
        : (!runtime.deployConfigured
          ? "请先关联部署目标"
          : (!runtime.packedCount ? "请先打包项目（按目标打包）" : ""));
      const gitRefreshReady = Boolean(String(project.dirPath || "").trim());
      const gitRefreshTip = gitRefreshReady ? "" : "项目路径为空，无法刷新 Git";
      const linkedServers = getProjectLinkedServers(project);
      const connAuthReady = linkedServers.length > 0 && linkedServers.every(hasServerAuth);
      const connTestReady = linkedServers.length > 0 && connAuthReady;
      const connTestTip = !linkedServers.length
        ? "请先关联部署目标"
        : (!connAuthReady ? "关联的服务器缺少密码或私钥，请在服务器管理中补全" : "");

      const lifecycleClass = !runtime.deployConfigured || runtime.needsConfig
        ? "is-pending"
        : (runtime.fullyDeployed
          ? "is-deployed"
          : (runtime.deployed ? "is-partial" : (runtime.deployReady ? "is-ready" : "is-waiting")));
      const lifecycleText = !runtime.deployConfigured || runtime.needsConfig
        ? "待补配置"
        : (runtime.fullyDeployed
          ? "已部署"
          : (runtime.deployed ? "部分部署" : (runtime.deployReady ? "可部署" : "待打包")));

      const healthTips = [];
      if (!runtime.branchReady) healthTips.push("未记录分支");
      if (!runtime.deployConfigured) healthTips.push("未关联部署目标");
      if (runtime.deployConfigured && !runtime.packedCount) healthTips.push("还未按目标打包");
      const healthText = healthTips.length ? healthTips.join(" · ") : `已关联 ${runtime.targetCount} 个目标（${runtime.packedCount} 个已打包）`;
      const healthClass = healthTips.length ? "warn" : "ok";

      const backupDeleteTip = !runtime.deployConfigured
        ? "请先关联部署目标"
        : (!runtime.packedCount ? "请先打包项目（按目标打包）" : "");
      const backupDeleteReady = runtime.deployConfigured && runtime.packedCount > 0;
      const overrideCmdCount = Object.keys(project.buildCmds || {}).filter((id) =>
        String(project.buildCmds[id] || "").trim() && runtime.targets.some((item) => item.path.id === id)
      ).length;

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
            ${remark ? `<div class="card-meta secondary"><span class="card-remark">备注：${escapeHtml(remark)}</span></div>` : ""}
            <div class="card-meta secondary"><span>构建命令：${buildCmd}${overrideCmdCount ? `（${overrideCmdCount} 个目标单独配置）` : ""}</span></div>
            ${runtime.packedCount ? `
              <div class="card-meta secondary">
                <span class="zip-info">打包：${runtime.packedCount}/${runtime.targetCount} 个目标就绪${project.packTime ? `（最近 ${escapeHtml(safeText(project.packTime, "-"))}）` : ""}</span>
                <button
                  class="btn btn-xs btn-secondary btn-open-zip"
                  type="button"
                  data-path="${escapeHtml(safeText(project.zipPath, ""))}"
                  aria-label="打开 ${projectName} 最近一次打包的压缩包位置"
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

        ${(() => {
          const targets = getProjectTargets(project);
          if (!targets.length) {
            return `
        <div class="card-targets">
          <span class="card-targets-empty">未关联部署目标，点击“编辑项目”进行关联</span>
        </div>
            `;
          }
          const chips = targets.map(({ server, path: pathEntry }) => {
            const deployedFlag = isTargetDeployed(project, pathEntry.id);
            const state = getTargetDeployState(project, pathEntry.id);
            const packedFlag = isTargetPacked(project, pathEntry.id);
            const chipReady = runtime.branchReady && packedFlag;
            const chipTitle = packedFlag
              ? (deployedFlag
                ? `已部署 ${safeText(state?.lastDeployTime, "")}，点击再次部署到该目标`
                : "该目标尚未部署，点击部署到该目标")
              : "该目标尚未打包，请先在“打包”中选择此目标";
            return `
            <button
              class="target-chip"
              type="button"
              data-target-deploy="${escapeHtml(pathEntry.id)}"
              data-id="${projectId}"
              data-name="${projectName}"
              title="${escapeHtml(`${getTargetLabel(server, pathEntry)} ${pathEntry.deployPath} · ${chipTitle}`)}"
              aria-label="部署 ${projectName} 到 ${escapeHtml(getTargetLabel(server, pathEntry))}"
              ${chipReady ? "" : "disabled"}
            >
              <span class="target-chip-status ${deployedFlag ? "deployed" : ""}" aria-hidden="true"></span>
              <span class="target-chip-name">${escapeHtml(safeText(server.name))}</span>
              <span class="target-chip-path">${escapeHtml(safeText(pathEntry.deployPath))}</span>
            </button>
            `;
          }).join("");
          return `
        <div class="card-targets">
          <span class="card-targets-label">部署目标（${runtime.deployedCount}/${runtime.targetCount} 已部署）</span>
          <div class="card-target-chips">${chips}</div>
        </div>
          `;
        })()}
        <div class="card-danger-zone">
          <span class="card-danger-label">危险操作</span>
          <div class="card-danger-actions">
            <button
              class="btn btn-sm btn-danger btn-delete-backups"
              type="button"
              data-id="${projectId}"
              data-name="${projectName}"
              ${backupDeleteReady ? "" : "disabled"}
              ${backupDeleteTip ? `title="${backupDeleteTip}"` : ""}
              aria-label="管理 ${projectName} 的备份（回滚 / 删除）"
            >备份管理</button>
            <button
              class="btn btn-sm btn-danger btn-delete"
              type="button"
              data-id="${projectId}"
              data-name="${projectName}"
              aria-label="删除 ${projectName}"
            >删除项目</button>
          </div>
        </div>
      </article>
      `;
    })
    .join("");

  list.innerHTML = html;
  updateEditingCardHighlight();
}

function renderTargetView() {
  const list = byId("projectList");
  const empty = byId("emptyState");

  const visibleProjects = applyProjectViewFilters(getFilteredProjects());
  updateProjectFilterResult(getFilteredProjects().length, visibleProjects.length);
  updateConsoleSummary({
    total: projects.length,
    visible: visibleProjects.length,
    groupName: ""
  });

  const groupsHtml = [];
  servers.forEach((server) => {
    (server.paths || []).forEach((pathEntry) => {
      const rows = visibleProjects.filter((project) =>
        (Array.isArray(project.targetIds) ? project.targetIds : []).includes(pathEntry.id)
      );
      if (!rows.length) return;

      const rowHtml = rows.map((project) => {
        const runtime = getProjectRuntimeStatus(project);
        const deployedFlag = isTargetDeployed(project, pathEntry.id);
        const state = getTargetDeployState(project, pathEntry.id);
        const packedFlag = isTargetPacked(project, pathEntry.id);
        const deployTitle = !runtime.branchReady
          ? "记录分支为空，请先编辑项目并填写分支"
          : (!packedFlag ? "该目标尚未打包，请先打包" : `部署 ${safeText(project.projectName)} 到该目标`);
        return `
          <div class="target-project-row">
            <span class="target-project-name">${escapeHtml(safeText(project.projectName))}</span>
            <span class="target-project-meta">
              <span class="badge group">${escapeHtml(normalizeGroupName(project.groupName))}</span>
              <span class="badge">${escapeHtml(runtime.branchReady ? safeText(project.branch) : "未记录分支")}</span>
              ${packedFlag ? `<span>已打包</span>` : `<span>未打包</span>`}
            </span>
            <span class="target-project-status">
              <span class="status ${deployedFlag ? "success" : ""}">${deployedFlag ? "已部署" : "未部署"}</span>
              ${deployedFlag && state?.lastDeployTime ? `<span>${escapeHtml(safeText(state.lastDeployTime))}</span>` : ""}
              <button
                class="btn btn-xs btn-primary btn-deploy-target"
                type="button"
                data-target-deploy="${escapeHtml(pathEntry.id)}"
                data-id="${escapeHtml(project.id)}"
                data-name="${escapeHtml(safeText(project.projectName))}"
                ${runtime.branchReady && packedFlag ? "" : "disabled"}
                ${deployTitle ? `title="${escapeHtml(deployTitle)}"` : ""}
                aria-label="部署 ${escapeHtml(safeText(project.projectName))} 到 ${escapeHtml(getTargetLabel(server, pathEntry))}"
              >部署到此</button>
            </span>
          </div>
        `;
      }).join("");

      groupsHtml.push(`
        <section class="target-group" data-server-id="${escapeHtml(server.id)}" data-path-id="${escapeHtml(pathEntry.id)}">
          <header class="target-group-head">
            <span class="target-group-title">${escapeHtml(safeText(server.name))}</span>
            <span class="target-group-path" title="${escapeHtml(safeText(server.host))}:${escapeHtml(safeText(server.port, 22))} ${escapeHtml(safeText(pathEntry.deployPath))}">${escapeHtml(safeText(server.host))}:${escapeHtml(safeText(server.port, 22))} · ${escapeHtml(safeText(pathEntry.deployPath))}</span>
            ${String(pathEntry.label || "").trim() ? `<span class="badge">${escapeHtml(safeText(pathEntry.label))}</span>` : ""}
            <span class="target-group-count">${rows.length} 个项目</span>
            <div class="target-group-actions">
              <button
                class="btn btn-xs btn-secondary btn-test-server-conn"
                type="button"
                data-server-id="${escapeHtml(server.id)}"
                data-server-name="${escapeHtml(safeText(server.name))}"
                aria-label="测试 ${escapeHtml(safeText(server.name))} 的连接"
              >测试连接</button>
            </div>
          </header>
          ${rowHtml}
        </section>
      `);
    });
  });

  if (!groupsHtml.length) {
    const hasServers = servers.some((server) => (server.paths || []).length);
    empty.innerHTML = !hasServers
      ? `<p>暂无服务器与部署路径，请先在左下角“服务器管理”中创建，并在项目中关联目标。</p>`
      : `<p>当前筛选条件下没有项目与目标关联。</p>`;
    empty.style.display = "";
    list.innerHTML = "";
    return;
  }

  empty.style.display = "none";
  list.innerHTML = groupsHtml.join("");
  updateEditingCardHighlight();
}

function updateEditingCardHighlight() {
  const editingId = String(currentEditId ?? "");
  $$(".project-card").forEach((card) => {
    const isEditing = Boolean(editingId) && String(card.dataset.id || "") === editingId;
    card.classList.toggle("is-editing-current", isEditing);
  });
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
  extraText = "",
  extraValue = "extra",
  tone = "primary"
} = {}) {
  const modal = byId("confirmModal");
  const titleEl = byId("confirmModalTitle");
  const messageEl = byId("confirmModalMessage");
  const confirmBtn = byId("btnConfirmOk");
  const extraBtn = byId("btnConfirmExtra");

  if (!modal || !titleEl || !messageEl || !confirmBtn) {
    return Promise.resolve(window.confirm(message));
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmBtn.textContent = confirmText;
  if (extraBtn) {
    extraBtn.textContent = extraText || "";
    extraBtn.hidden = !extraText;
    extraBtn.dataset.confirmValue = String(extraValue);
  }
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
    if (overlay.id === "targetPickerModal") {
      settleTargetPicker(null);
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
  const opened = $$(".modal-overlay.active");
  if (opened.length && opened[opened.length - 1].id === "targetPickerModal") {
    settleTargetPicker(null);
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

const btnConfirmCancel = byId("btnConfirmCancel");
const btnConfirmOk = byId("btnConfirmOk");
const btnConfirmExtra = byId("btnConfirmExtra");
if (btnConfirmCancel) {
  btnConfirmCancel.addEventListener("click", () => settleConfirm(false));
}
if (btnConfirmOk) {
  btnConfirmOk.addEventListener("click", () => settleConfirm(true));
}
if (btnConfirmExtra) {
  btnConfirmExtra.addEventListener("click", () => settleConfirm(btnConfirmExtra.dataset.confirmValue || "extra"));
}

function clearTerminalWorkbench() {
  backupSelectorState = null;
  if (!terminalWorkbench) return;
  terminalWorkbench.hidden = true;
  terminalWorkbench.innerHTML = "";
}

function renderBackupSelectorWorkbench() {
  if (!terminalWorkbench) return;

  const state = backupSelectorState;
  if (!state || !Array.isArray(state.items) || !state.items.length) {
    terminalWorkbench.hidden = true;
    terminalWorkbench.innerHTML = "";
    return;
  }

  const totalCount = state.items.length;
  const selectedCount = state.items.filter((item) => item.selected).length;
  const selectedLabel = `已选 ${selectedCount} / ${totalCount}`;

  terminalWorkbench.hidden = false;
  terminalWorkbench.innerHTML = `
    <div class="terminal-workbench-head">
      <div class="terminal-workbench-copy">
        <div class="terminal-workbench-title">备份列表（可回滚 / 可删除）</div>
        <div class="terminal-workbench-meta">项目：${escapeHtml(state.projectName)}</div>
        <div class="terminal-workbench-meta">目标：${escapeHtml(safeText(state.targetLabel, "-"))}</div>
        <div class="terminal-workbench-meta">目录：${escapeHtml(state.backupRootPath)}</div>
        <div class="terminal-workbench-meta">规则：${escapeHtml(state.backupFolderBaseName)}_YYYYMMDD_HHmmss</div>
      </div>
      <div class="terminal-workbench-count">${selectedLabel}</div>
    </div>
    <div class="terminal-workbench-actions">
      <button class="btn btn-xs btn-secondary" type="button" data-terminal-action="select-all" ${state.pending ? "disabled" : ""}>全选</button>
      <button class="btn btn-xs btn-secondary" type="button" data-terminal-action="invert-selection" ${state.pending ? "disabled" : ""}>反选</button>
      <button class="btn btn-xs btn-secondary" type="button" data-terminal-action="clear-selector" ${state.pending ? "disabled" : ""}>关闭列表</button>
      <button class="btn btn-xs btn-danger" type="button" data-terminal-action="delete-selected" ${(state.pending || selectedCount === 0) ? "disabled" : ""}>下一步删除选中项</button>
    </div>
    <div class="backup-selector-list" role="group" aria-label="备份目录选择列表">
      ${state.items.map((item, index) => `
        <div class="backup-selector-item">
          <label class="backup-selector-item-check">
            <input
              type="checkbox"
              data-terminal-backup-index="${index}"
              ${item.selected ? "checked" : ""}
              ${state.pending ? "disabled" : ""}
              aria-label="选择备份 ${escapeHtml(item.name)}"
            >
          </label>
          <span class="backup-selector-name">${escapeHtml(item.name)}</span>
          <button
            class="btn btn-xs btn-warn"
            type="button"
            data-terminal-rollback-index="${index}"
            ${state.pending ? "disabled" : ""}
            aria-label="回滚到备份 ${escapeHtml(item.name)}"
            title="将该目标回滚到此备份（当前线上目录会先保存为新备份）"
          >回滚</button>
        </div>
      `).join("")}
    </div>
  `;
}

byId("btnClearTerminal").addEventListener("click", resetTerminal);

if (terminalWorkbench) {
  terminalWorkbench.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-terminal-backup-index]");
    if (!checkbox || !backupSelectorState || backupSelectorState.pending) return;

    const index = Number.parseInt(checkbox.dataset.terminalBackupIndex, 10);
    if (!Number.isInteger(index) || index < 0 || index >= backupSelectorState.items.length) return;

    backupSelectorState.items[index].selected = Boolean(checkbox.checked);
    renderBackupSelectorWorkbench();
  });

  terminalWorkbench.addEventListener("click", async (event) => {
    const rollbackButton = event.target.closest("button[data-terminal-rollback-index]");
    if (rollbackButton) {
      if (!backupSelectorState || backupSelectorState.pending) return;
      const index = Number.parseInt(rollbackButton.dataset.terminalRollbackIndex, 10);
      await rollbackBackupFromWorkbench(index);
      return;
    }

    const actionButton = event.target.closest("button[data-terminal-action]");
    if (!actionButton || !backupSelectorState || backupSelectorState.pending) return;

    const action = actionButton.dataset.terminalAction;
    if (action === "select-all") {
      backupSelectorState.items.forEach((item) => { item.selected = true; });
      renderBackupSelectorWorkbench();
      return;
    }

    if (action === "invert-selection") {
      backupSelectorState.items.forEach((item) => { item.selected = !item.selected; });
      renderBackupSelectorWorkbench();
      return;
    }

    if (action === "clear-selector") {
      clearTerminalWorkbench();
      showToast("备份选择列表已关闭。", "info", 1800);
      return;
    }

    if (action === "delete-selected") {
      await deleteSelectedBackupsFromWorkbench();
    }
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
  termCmd("开始读取远程与本地 Git 信息…");
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

function formatGitChangeSummary(entries = []) {
  const items = Array.isArray(entries) ? entries : [];
  return items
    .slice(0, 6)
    .map((item) => `${safeText(item.code, "??")} ${safeText(item.path || item.raw, "")}`.trim())
    .filter(Boolean)
    .join("；");
}

async function choosePackGitDirtyStrategy(projectId, projectName) {
  const safeProjectName = safeText(projectName, "当前项目");
  termCmd("开始检查工作区未提交代码…");
  setOperationStatus("running", "状态：打包前工作区检查中", "最近动作：正在检查未提交代码");

  try {
    const status = await api(`/api/git-worktree-status/${projectId}`);
    const count = Number(status.count || 0);
    const entries = Array.isArray(status.entries) ? status.entries : [];

    if (!status.hasChanges) {
      termSuccess("工作区干净，继续打包。");
      setOperationStatus("success", "状态：工作区检查通过");
      return { proceed: true, autoStash: false };
    }

    const summary = formatGitChangeSummary(entries);
    termWarn(`检测到 ${count} 项未提交代码。`);
    if (summary) termWarn(`变更摘要：${summary}${count > 6 ? "；…" : ""}`);
    termWarn("可选择先添加储藏，打包完成后自动还原。");
    setOperationStatus("warn", "状态：存在未提交代码", `最近动作：检测到 ${count} 项变更`);

    const choice = await askConfirm({
      title: "存在未提交代码",
      message: `项目“${safeProjectName}”存在 ${count} 项未提交代码。建议先添加储藏，打包完成后自动还原，避免未提交内容进入构建产物。`,
      confirmText: "继续打包",
      extraText: "储藏后打包",
      extraValue: "stash",
      tone: "warn"
    });

    if (choice === "stash") {
      termSuccess("用户选择：添加储藏，打包完成后还原。");
      return { proceed: true, autoStash: true };
    }

    if (choice) {
      termWarn("用户选择：继续打包，未提交代码会参与本次构建。");
      return { proceed: true, autoStash: false };
    }

    termWarn("用户选择：取消打包。");
    setOperationStatus("idle", "状态：已取消打包");
    showToast("已取消打包。", "info", 1800);
    return { proceed: false, autoStash: false };
  } catch (error) {
    const message = normalizeErrorMessage(error.message);
    termError(`工作区检查失败：${message}`);
    setOperationStatus("error", "状态：工作区检查失败");
    showToast(`打包前工作区检查失败：${message}`, "error", 3600);
    return { proceed: false, autoStash: false };
  }
}

function getProjectById(projectId) {
  return projects.find((item) => item.id === projectId) || null;
}

function getServerById(serverId) {
  return servers.find((item) => item.id === serverId) || null;
}

/* ===== 目标选择弹窗（deploy 多选 / link 全量多选 / backup 单选） ===== */

function settleTargetPicker(result) {
  const resolver = targetPickerResolver;
  targetPickerResolver = null;
  targetPickerState = null;
  closeModal("targetPickerModal");
  if (resolver) resolver(result);
}

function getTargetPickerItems() {
  const state = targetPickerState;
  if (!state) return [];
  if (state.mode === "link") {
    const items = [];
    servers.forEach((server) => {
      (server.paths || []).forEach((pathEntry) => {
        items.push({ server, path: pathEntry });
      });
    });
    return items;
  }
  return getProjectTargets(getProjectById(state.projectId));
}

// deploy 模式下未打包的目标不可选择
function isTargetPickerItemSelectable(item) {
  if (!targetPickerState || targetPickerState.mode !== "deploy") return true;
  const project = getProjectById(targetPickerState.projectId);
  return project ? isTargetPacked(project, item.path.id) : false;
}

function renderTargetPicker() {
  const state = targetPickerState;
  const listEl = byId("targetPickerList");
  const emptyEl = byId("targetPickerEmpty");
  const actionsEl = byId("targetPickerActions");
  const countEl = byId("targetPickerCount");
  const confirmBtn = byId("btnTargetPickerConfirm");
  if (!state || !listEl || !emptyEl || !countEl || !confirmBtn) return;

  const items = getTargetPickerItems();
  const single = state.mode === "backup";

  if (!items.length) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = state.mode === "link"
      ? "暂无服务器与部署路径，请先在“服务器管理”中创建。"
      : "该项目尚未关联部署目标，请先编辑项目进行关联。";
    actionsEl.style.display = "none";
    countEl.textContent = "";
    confirmBtn.disabled = true;
    confirmBtn.textContent = "确认";
    return;
  }

  emptyEl.hidden = true;
  actionsEl.style.display = single ? "none" : "";

  const groups = new Map();
  items.forEach((item) => {
    if (!groups.has(item.server.id)) groups.set(item.server.id, { server: item.server, items: [] });
    groups.get(item.server.id).items.push(item);
  });

  listEl.innerHTML = Array.from(groups.values()).map(({ server, items: groupItems }) => `
    <div class="target-picker-group">
      <div class="target-picker-group-title">${escapeHtml(safeText(server.name))} · ${escapeHtml(safeText(server.host))}:${escapeHtml(safeText(server.port, 22))}</div>
      ${groupItems.map(({ path: pathEntry }) => {
        const project = getProjectById(state.projectId);
        const selected = state.selectedIds.includes(pathEntry.id);
        const selectable = isTargetPickerItemSelectable({ server, path: pathEntry });
        const packedFlag = project ? isTargetPacked(project, pathEntry.id) : false;
        const pack = project ? getTargetPack(project, pathEntry.id) : null;

        let meta = "";
        if (state.mode === "link" && Number(pathEntry.usedCount) > 0) {
          meta = `${pathEntry.usedCount} 个项目在用`;
        } else if (state.mode === "deploy") {
          meta = packedFlag ? (pack?.packTime ? `已打包 ${safeText(pack.packTime)}` : "已打包") : "未打包";
        } else if (state.mode === "pack") {
          const buildCmd = project ? getTargetBuildCmd(project, pathEntry.id) : "";
          meta = `${buildCmd}${packedFlag ? ` · 已打包${pack?.packTime ? ` ${safeText(pack.packTime)}` : ""}` : " · 未打包"}`;
        }

        const input = single
          ? `<input type="radio" name="targetPickerChoice" value="${escapeHtml(pathEntry.id)}" ${selected ? "checked" : ""}>`
          : `<input type="checkbox" data-picker-path-id="${escapeHtml(pathEntry.id)}" ${selected ? "checked" : ""} ${selectable ? "" : "disabled title=\"该目标尚未打包，无法部署\""}>`;
        return `
        <label class="target-picker-item ${selectable ? "" : "is-disabled"}">
          ${input}
          <span class="target-picker-item-body">
            <span class="target-picker-item-name">${escapeHtml(String(pathEntry.label || "").trim() || "部署路径")}</span>
            <span class="target-picker-item-path" title="${escapeHtml(safeText(pathEntry.deployPath))}">${escapeHtml(safeText(pathEntry.deployPath))}</span>
            ${meta ? `<span class="target-picker-item-meta">${escapeHtml(meta)}</span>` : ""}
          </span>
        </label>
        `;
      }).join("")}
    </div>
  `).join("");

  syncTargetPickerControls();
}

function syncTargetPickerControls() {
  const state = targetPickerState;
  const countEl = byId("targetPickerCount");
  const confirmBtn = byId("btnTargetPickerConfirm");
  if (!state) return;

  const items = getTargetPickerItems();
  const selectedCount = state.selectedIds.filter((id) => items.some((item) => item.path.id === id)).length;
  const single = state.mode === "backup";

  if (countEl) {
    countEl.textContent = single ? `共 ${items.length} 个目标` : `已选 ${selectedCount} / ${items.length}`;
  }
  if (confirmBtn) {
    confirmBtn.disabled = selectedCount === 0;
    if (single) confirmBtn.textContent = "查看备份";
    else if (state.mode === "deploy") confirmBtn.textContent = `部署 ${selectedCount} 个目标`;
    else if (state.mode === "pack") confirmBtn.textContent = `打包 ${selectedCount} 个目标`;
    else confirmBtn.textContent = `关联 ${selectedCount} 个目标`;
  }
}

function openTargetPicker({ mode, projectId = null }) {
  const items = mode === "link"
    ? servers.flatMap((server) => (server.paths || []).map((pathEntry) => ({ server, path: pathEntry })))
    : getProjectTargets(getProjectById(projectId));

  let selectedIds;
  if (mode === "deploy") {
    // 部署只默认勾选已打包的目标
    const project = getProjectById(projectId);
    selectedIds = items
      .filter((item) => !project || isTargetPacked(project, item.path.id))
      .map((item) => item.path.id);
  } else if (mode === "backup") {
    selectedIds = items.length ? [items[0].path.id] : [];
  } else {
    selectedIds = mode === "link" ? [...currentEditTargetIds] : items.map((item) => item.path.id);
  }

  const titles = {
    deploy: "选择部署目标",
    backup: "选择备份目标",
    link: "关联部署目标",
    pack: "选择打包目标"
  };
  byId("targetPickerTitle").textContent = titles[mode] || "选择部署目标";

  targetPickerState = { mode, projectId, selectedIds };
  renderTargetPicker();
  openModal("targetPickerModal");

  return new Promise((resolve) => {
    targetPickerResolver = resolve;
  });
}

byId("targetPickerList").addEventListener("change", (event) => {
  const state = targetPickerState;
  if (!state) return;
  const input = event.target.closest("input[data-picker-path-id], input[name='targetPickerChoice']");
  if (!input) return;

  // checkbox 未设 value 属性（默认 "on"），路径 id 一律从 dataset 取
  const pathId = input.type === "radio" ? input.value : input.dataset.pickerPathId;
  if (!pathId) return;

  if (input.type === "radio") {
    state.selectedIds = [pathId];
  } else if (input.checked) {
    if (!state.selectedIds.includes(pathId)) state.selectedIds.push(pathId);
  } else {
    state.selectedIds = state.selectedIds.filter((id) => id !== pathId);
  }
  syncTargetPickerControls();
});

byId("targetPickerActions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-picker-action]");
  const state = targetPickerState;
  if (!button || !state) return;

  const items = getTargetPickerItems();
  if (button.dataset.pickerAction === "select-all") {
    state.selectedIds = items.filter(isTargetPickerItemSelectable).map((item) => item.path.id);
  } else if (button.dataset.pickerAction === "invert-selection") {
    const current = new Set(state.selectedIds);
    state.selectedIds = items
      .filter(isTargetPickerItemSelectable)
      .map((item) => item.path.id)
      .filter((id) => !current.has(id));
  }
  renderTargetPicker();
});

byId("btnTargetPickerCancel").addEventListener("click", () => settleTargetPicker(null));

byId("btnTargetPickerConfirm").addEventListener("click", () => {
  const state = targetPickerState;
  if (!state || !state.selectedIds.length) return;
  settleTargetPicker(state.mode === "backup" ? state.selectedIds[0] : [...state.selectedIds]);
});

/* ===== 部署流程 ===== */

async function startPackFlow(projectId, triggerButton) {
  const project = getProjectById(projectId);
  if (!project) {
    showToast("未找到项目，无法打包。", "warn");
    return;
  }
  const projectName = safeText(project.projectName, "当前项目");
  if (!getProjectTargets(project).length) {
    showToast("该项目尚未关联部署目标，请先编辑项目进行关联。", "warn");
    return;
  }

  const selectedIds = await openTargetPicker({ mode: "pack", projectId });
  if (!selectedIds) return;
  if (!selectedIds.length) {
    showToast("请至少选择一个打包目标。", "warn");
    return;
  }

  await withButtonLoading(triggerButton, "打包中…", async () => {
    termClear();
    termSeparator(`打包前刷新 Git ${projectName}`);
    termCmd("开始刷新本地 Git 信息…");
    setOperationStatus("running", "状态：打包前Git刷新中", "最近动作：正在读取本地 Git 信息");
    try {
      const updated = await syncProjectGitInfo(projectId);
      termSuccess(`Git 信息已刷新：${safeText(updated.branch, "-")} ${safeText(updated.commitHash, "-")}`);
      setOperationStatus("success", "状态：打包前Git已刷新");
    } catch (error) {
      const message = normalizeErrorMessage(error.message);
      termError(`Git 刷新失败：${message}`);
      setOperationStatus("error", "状态：打包前Git刷新失败");
      showToast(`打包前 Git 刷新失败：${message}`, "error", 3600);
      return;
    }

    const gitReady = await checkRemoteAndLocalGitBeforePack(projectId, projectName);
    if (!gitReady) return;

    const dirtyStrategy = await choosePackGitDirtyStrategy(projectId, projectName);
    if (!dirtyStrategy.proceed) return;

    termCmd("开始执行分支校验…");
    const allowed = await validateBranchBeforeAction(projectId, projectName, "打包", { resetTerminal: false });
    if (!allowed) return;

    termLog("分支校验通过，进入构建与打包阶段。");
    termSeparator(`开始打包 ${projectName}（${selectedIds.length} 个目标）`);
    try {
      const result = await runStreamingFetch(`/api/pack/${projectId}`, `打包 ${projectName}`, {
        body: { targetIds: selectedIds, autoStash: dirtyStrategy.autoStash }
      });
      await loadProjects({ silent: true });
      const successCount = Number(result?.successCount) || 0;
      const failedCount = Number(result?.failedCount) || 0;
      if (failedCount > 0) {
        showToast(`打包结束：成功 ${successCount} 个 / 失败 ${failedCount} 个目标。`, "warn", 3600);
      } else {
        showToast(`项目 ${projectName} 已完成 ${successCount} 个目标的打包。`, "success");
      }
    } catch (error) {
      showToast(`打包失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  });
}

async function startDeployFlow(projectId, triggerButton, presetTargetIds = null) {
  const project = getProjectById(projectId);
  if (!project) {
    showToast("未找到项目，无法部署。", "warn");
    return;
  }
  const projectName = safeText(project.projectName, "当前项目");
  const targets = getProjectTargets(project);
  if (!targets.length) {
    showToast("该项目尚未关联部署目标，请先编辑项目进行关联。", "warn");
    return;
  }

  let selectedIds;
  if (Array.isArray(presetTargetIds) && presetTargetIds.length) {
    selectedIds = presetTargetIds.filter((id) => targets.some((item) => item.path.id === id));
  } else {
    selectedIds = await openTargetPicker({ mode: "deploy", projectId });
    if (!selectedIds) return;
  }
  if (!selectedIds.length) {
    showToast("请至少选择一个部署目标。", "warn");
    return;
  }

  const allowed = await validateBranchBeforeAction(projectId, projectName, "部署");
  if (!allowed) return;

  const selectedLabels = selectedIds.map((id) => {
    const found = findPathById(id);
    return found ? `${safeText(found.server.name)} ${safeText(found.path.deployPath)}` : id;
  });
  const confirmed = await askConfirm({
    title: "确认部署",
    message: `将部署 “${projectName}” 到 ${selectedIds.length} 个目标（${selectedLabels.join("； ")}）。请确认分支和配置都已核对无误。`,
    confirmText: "确认部署",
    tone: "warn"
  });
  if (!confirmed) return;

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "部署中…", task)
    : (task) => Promise.resolve(task());

  await runner(async () => {
    termClear();
    termSeparator(`部署 ${projectName}（${selectedIds.length} 个目标）`);
    try {
      const result = await runStreamingFetch(`/api/deploy/${projectId}`, `部署 ${projectName}`, {
        body: { targetIds: selectedIds }
      });
      await loadProjects({ silent: true });
      const successCount = Number(result?.successCount) || 0;
      const failedCount = Number(result?.failedCount) || 0;
      if (failedCount > 0) {
        setOperationStatus("warn", "状态：部署部分失败");
        showToast(`部署结束：成功 ${successCount} 个 / 失败 ${failedCount} 个目标。`, "warn", 3600);
      } else {
        showToast(`项目 ${projectName} 已成功部署到 ${successCount} 个目标。`, "success");
      }
    } catch (error) {
      showToast(`部署失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  });
}

/* ===== 服务器管理弹窗 ===== */

function updateServerCountBadge() {
  const badge = byId("serverCountBadge");
  if (badge) badge.textContent = String(servers.length);
}

function switchServerAuthTab(type) {
  const tabs = $$(".server-auth-tabs .tab-btn");
  tabs.forEach((tab) => {
    const isActive = tab.dataset.auth === type;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  $(".server-auth-password").hidden = type !== "password";
  $(".server-auth-key").hidden = type !== "key";
}

function renderServerManager() {
  const listPanel = byId("serverManagerList");
  const serverForm = byId("serverFormPanel");
  const pathForm = byId("pathFormPanel");
  if (!listPanel || !serverForm || !pathForm) return;

  listPanel.hidden = serverModalState.mode !== "list";
  serverForm.hidden = serverModalState.mode !== "server-form";
  pathForm.hidden = serverModalState.mode !== "path-form";

  if (serverModalState.mode !== "list") return;
  renderServerList();
}

function renderServerList() {
  const container = byId("serverList");
  if (!container) return;

  if (!servers.length) {
    container.innerHTML = `<div class="server-empty">暂无服务器。点击“新建服务器”添加第一台服务器，再为其维护部署路径。</div>`;
    return;
  }

  container.innerHTML = servers.map((server, serverIndex) => {
    const authMode = String(server.privateKey || "").trim() ? "私钥" : "密码";
    const paths = server.paths || [];
    const pathRows = paths.length ? paths.map((pathEntry, pathIndex) => `
      <div class="server-path-row" data-path-id="${escapeHtml(pathEntry.id)}">
        <span class="server-path-label" title="${escapeHtml(safeText(pathEntry.label, ""))}">${escapeHtml(safeText(pathEntry.label, ""))}</span>
        <span class="server-path-deploy" title="${escapeHtml(safeText(pathEntry.deployPath))}">${escapeHtml(safeText(pathEntry.deployPath))}</span>
        <span class="server-path-used">${Number(pathEntry.usedCount) || 0} 个项目</span>
        <div class="server-path-actions">
          <button
            class="btn btn-xs btn-secondary"
            type="button"
            data-server-action="move-path"
            data-server-id="${escapeHtml(server.id)}"
            data-path-id="${escapeHtml(pathEntry.id)}"
            data-direction="up"
            ${pathIndex === 0 ? "disabled title=\"已在最顶部\"" : `aria-label="上移路径 ${escapeHtml(safeText(pathEntry.deployPath))}"`}
          >上移</button>
          <button
            class="btn btn-xs btn-secondary"
            type="button"
            data-server-action="move-path"
            data-server-id="${escapeHtml(server.id)}"
            data-path-id="${escapeHtml(pathEntry.id)}"
            data-direction="down"
            ${pathIndex === paths.length - 1 ? "disabled title=\"已在最底部\"" : `aria-label="下移路径 ${escapeHtml(safeText(pathEntry.deployPath))}"`}
          >下移</button>
          <button
            class="btn btn-xs btn-secondary"
            type="button"
            data-server-action="edit-path"
            data-server-id="${escapeHtml(server.id)}"
            data-path-id="${escapeHtml(pathEntry.id)}"
            aria-label="编辑路径 ${escapeHtml(safeText(pathEntry.deployPath))}"
          >编辑</button>
          <button
            class="btn btn-xs btn-danger"
            type="button"
            data-server-action="delete-path"
            data-server-id="${escapeHtml(server.id)}"
            data-path-id="${escapeHtml(pathEntry.id)}"
            aria-label="删除路径 ${escapeHtml(safeText(pathEntry.deployPath))}"
          >删除</button>
        </div>
      </div>
    `).join("") : `<div class="server-empty">暂无部署路径，点击“新增路径”创建。</div>`;

    return `
      <div class="server-card" data-server-id="${escapeHtml(server.id)}">
        <div class="server-card-head">
          <span class="server-card-name">${escapeHtml(safeText(server.name))}</span>
          <span class="server-card-endpoint" title="${escapeHtml(safeText(server.host))}:${escapeHtml(safeText(server.port, 22))}">${escapeHtml(safeText(server.host))}:${escapeHtml(safeText(server.port, 22))}</span>
          <span class="server-card-auth">${escapeHtml(safeText(server.username))} · ${authMode}</span>
          <div class="server-card-actions">
            <button
              class="btn btn-xs btn-secondary"
              type="button"
              data-server-action="move-server"
              data-server-id="${escapeHtml(server.id)}"
              data-direction="up"
              ${serverIndex === 0 ? "disabled title=\"已在最顶部\"" : `aria-label="上移服务器 ${escapeHtml(safeText(server.name))}"`}
            >上移</button>
            <button
              class="btn btn-xs btn-secondary"
              type="button"
              data-server-action="move-server"
              data-server-id="${escapeHtml(server.id)}"
              data-direction="down"
              ${serverIndex === servers.length - 1 ? "disabled title=\"已在最底部\"" : `aria-label="下移服务器 ${escapeHtml(safeText(server.name))}"`}
            >下移</button>
            <button class="btn btn-xs btn-secondary" type="button" data-server-action="edit-server" data-server-id="${escapeHtml(server.id)}">编辑</button>
            <button class="btn btn-xs btn-secondary" type="button" data-server-action="add-path" data-server-id="${escapeHtml(server.id)}">新增路径</button>
            <button class="btn btn-xs btn-secondary" type="button" data-server-action="test-conn" data-server-id="${escapeHtml(server.id)}" data-server-name="${escapeHtml(safeText(server.name))}">测试连接</button>
            <button class="btn btn-xs btn-danger" type="button" data-server-action="delete-server" data-server-id="${escapeHtml(server.id)}" data-server-name="${escapeHtml(safeText(server.name))}">删除</button>
          </div>
        </div>
        <div class="server-path-list">${pathRows}</div>
      </div>
    `;
  }).join("");
}

function openServerManager() {
  serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
  serverFormImportedPath = "";
  renderServerManager();
  openModal("serverModal");
}

function openServerForm(serverId = null) {
  const server = serverId ? getServerById(serverId) : null;
  serverModalState = { mode: "server-form", editingServerId: serverId, editingPathId: null };

  byId("serverFormTitle").textContent = server ? "编辑服务器" : "新建服务器";
  byId("serverFormName").value = safeText(server?.name, "");
  byId("serverFormHost").value = safeText(server?.host, "");
  byId("serverFormPort").value = safeText(server?.port, "22");
  byId("serverFormUsername").value = safeText(server?.username, "");
  byId("serverFormPassword").value = safeText(server?.password, "");
  byId("serverFormPrivateKey").value = safeText(server?.privateKey, "");
  const hint = byId("serverFormJsonHint");
  if (hint) hint.textContent = "";
  switchServerAuthTab(String(server?.privateKey || "").trim() ? "key" : "password");
  renderServerManager();
}

function openPathForm(serverId, pathId = null) {
  const server = getServerById(serverId);
  if (!server) return;
  const pathEntry = pathId ? (server.paths || []).find((item) => item.id === pathId) : null;
  serverModalState = { mode: "path-form", editingServerId: serverId, editingPathId: pathId };

  byId("pathFormTitle").textContent = pathEntry ? "编辑部署路径" : "新增部署路径";
  byId("pathFormServerLabel").textContent = `所属服务器：${safeText(server.name)}（${safeText(server.host)}）`;
  byId("pathFormLabel").value = safeText(pathEntry?.label, "");
  byId("pathFormDeployPath").value = safeText(pathEntry?.deployPath, !pathEntry ? serverFormImportedPath : "");
  byId("pathFormBackupPath").value = safeText(pathEntry?.backupPath, "");
  renderServerManager();
}

async function saveServerForm() {
  const { editingServerId } = serverModalState;
  const authType = $(".server-auth-tabs .tab-btn.active")?.dataset.auth || "password";
  const body = {
    name: byId("serverFormName").value.trim(),
    host: byId("serverFormHost").value.trim(),
    port: Number.parseInt(byId("serverFormPort").value, 10) || 22,
    username: byId("serverFormUsername").value.trim()
  };
  if (authType === "password") body.password = byId("serverFormPassword").value;
  else body.privateKey = byId("serverFormPrivateKey").value;

  if (!body.name || !body.host || !body.username) {
    showToast("服务器名称、地址和用户名不能为空。", "warn");
    return;
  }
  if (authType === "password" && !body.password && !editingServerId) {
    showToast("请填写服务器密码。", "warn");
    return;
  }
  if (authType === "key" && !body.privateKey && !editingServerId) {
    showToast("请填写服务器私钥。", "warn");
    return;
  }

  try {
    if (editingServerId) {
      await api(`/api/servers/${editingServerId}`, { method: "PUT", body: body });
      showToast("服务器信息已更新。", "success");
    } else {
      const created = await api("/api/servers", { method: "POST", body: body });
      showToast("服务器已创建。", "success");
      if (serverFormImportedPath) {
        const imported = serverFormImportedPath;
        serverFormImportedPath = "";
        await loadServers({ silent: true });
        openPathForm(created.id);
        return;
      }
    }
    serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
    serverFormImportedPath = "";
    await loadServers({ silent: true });
    renderServerManager();
  } catch (error) {
    showToast(`保存失败：${normalizeErrorMessage(error.message)}`, "error");
  }
}

async function savePathForm() {
  const { editingServerId, editingPathId } = serverModalState;
  if (!editingServerId) return;

  const body = {
    label: byId("pathFormLabel").value.trim(),
    deployPath: byId("pathFormDeployPath").value.trim(),
    backupPath: byId("pathFormBackupPath").value.trim()
  };
  if (!body.deployPath) {
    showToast("请填写部署路径。", "warn");
    return;
  }

  try {
    if (editingPathId) {
      await api(`/api/servers/${editingServerId}/paths/${editingPathId}`, { method: "PUT", body: body });
      showToast("部署路径已更新。", "success");
    } else {
      await api(`/api/servers/${editingServerId}/paths`, { method: "POST", body: body });
      showToast("部署路径已创建。", "success");
    }
    serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
    await loadServers({ silent: true });
    renderServerManager();
  } catch (error) {
    showToast(`保存失败：${normalizeErrorMessage(error.message)}`, "error");
  }
}

byId("serverList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-server-action]");
  if (!button || button.disabled) return;

  const action = button.dataset.serverAction;
  const serverId = button.dataset.serverId;
  const pathId = button.dataset.pathId;
  const serverName = button.dataset.serverName || "该服务器";

  if (action === "move-server" || action === "move-path") {
    const url = action === "move-server"
      ? `/api/servers/${serverId}/move`
      : `/api/servers/${serverId}/paths/${pathId}/move`;
    try {
      await api(url, { method: "POST", body: { direction: button.dataset.direction } });
      await loadServers({ silent: true });
      renderServerManager();
      renderList();
    } catch (error) {
      showToast(`调整顺序失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
    return;
  }

  if (action === "edit-server") {
    openServerForm(serverId);
    return;
  }

  if (action === "add-path") {
    openPathForm(serverId);
    return;
  }

  if (action === "test-conn") {
    await testServerConnection(serverId, button);
    return;
  }

  if (action === "delete-server") {
    const confirmed = await askConfirm({
      title: "确认删除服务器",
      message: `将删除服务器“${serverName}”及其全部部署路径配置（不影响项目记录）。被项目引用时无法删除。`,
      confirmText: "删除服务器",
      tone: "danger"
    });
    if (!confirmed) return;

    try {
      await api(`/api/servers/${serverId}`, { method: "DELETE" });
      await loadServers({ silent: true });
      renderServerManager();
      renderList();
      showToast("服务器已删除。", "success");
    } catch (error) {
      showToast(`删除失败：${normalizeErrorMessage(error.message)}`, "error", 3600);
    }
    return;
  }

  if (action === "edit-path") {
    openPathForm(serverId, pathId);
    return;
  }

  if (action === "delete-path") {
    const confirmed = await askConfirm({
      title: "确认删除部署路径",
      message: `将删除该部署路径。仍被项目引用时无法删除。`,
      confirmText: "删除路径",
      tone: "danger"
    });
    if (!confirmed) return;

    try {
      await api(`/api/servers/${serverId}/paths/${pathId}`, { method: "DELETE" });
      await loadServers({ silent: true });
      renderServerManager();
      renderList();
      showToast("部署路径已删除。", "success");
    } catch (error) {
      showToast(`删除失败：${normalizeErrorMessage(error.message)}`, "error", 3600);
    }
  }
});

byId("btnAddServer").addEventListener("click", () => openServerForm(null));
byId("btnCancelServerForm").addEventListener("click", () => {
  serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
  serverFormImportedPath = "";
  renderServerManager();
});
byId("btnSaveServerForm").addEventListener("click", saveServerForm);
byId("btnCancelPathForm").addEventListener("click", () => {
  serverModalState = { mode: "list", editingServerId: null, editingPathId: null };
  serverFormImportedPath = "";
  renderServerManager();
});
byId("btnSavePathForm").addEventListener("click", savePathForm);
byId("btnManageServers").addEventListener("click", openServerManager);
byId("btnManageServersFromEdit").addEventListener("click", openServerManager);

$$(".server-auth-tabs .tab-btn").forEach((tab) => {
  tab.addEventListener("click", () => switchServerAuthTab(tab.dataset.auth));
});

byId("btnImportServerJson").addEventListener("click", () => {
  byId("serverFormJsonFile").click();
});

byId("serverFormJsonFile").addEventListener("change", async () => {
  const file = byId("serverFormJsonFile").files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const data = await api("/api/import-json", { method: "POST", body: formData });
    const connName = safeText(data.connectionName, file.name.replace(/\.json$/i, ""));
    const hint = byId("serverFormJsonHint");

    if (data.host) byId("serverFormHost").value = data.host;
    if (data.port) byId("serverFormPort").value = data.port;
    if (data.username) byId("serverFormUsername").value = data.username;
    if (!byId("serverFormName").value.trim() && data.host) {
      byId("serverFormName").value = connName || data.host;
    }

    if (data.privateKey) {
      byId("serverFormPrivateKey").value = data.privateKey;
      switchServerAuthTab("key");
    }
    if (data.password) {
      if (data.encryptedPassword) {
        byId("serverFormPassword").value = "";
        if (hint) hint.textContent = "密码为加密存储，请手动填写明文密码";
        showToast("JSON 中密码为加密值，请手动输入服务器明文密码。", "warn", 3600);
      } else {
        byId("serverFormPassword").value = data.password;
      }
      switchServerAuthTab("password");
    }

    if (data.deployPath) {
      serverFormImportedPath = String(data.deployPath).trim();
      if (hint) hint.textContent = `${hint.textContent ? hint.textContent + "；" : ""}已读取部署路径，保存服务器后将自动带入新增路径表单`;
    }

    showToast("JSON 配置导入成功。", "success");
  } catch (error) {
    showToast(`导入失败：${normalizeErrorMessage(error.message)}`, "error");
  } finally {
    byId("serverFormJsonFile").value = "";
  }
});

async function refreshProjectGit(projectId, triggerButton) {
  const project = getProjectById(projectId);
  if (!project) {
    showToast("未找到项目，无法刷新。", "warn");
    return false;
  }

  const dirPath = normalizePath(project.dirPath);
  if (!dirPath) {
    showToast("项目路径为空，无法刷新 Git。", "warn");
    return false;
  }

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "刷新中…", task)
    : (task) => Promise.resolve(task());

  return runner(async () => {
    try {
      const updated = await syncProjectGitInfo(projectId, { render: true });
      setOperationStatus("success", "状态：Git已刷新");
      showToast(`项目 ${safeText(updated.projectName, project.projectName)} Git 已刷新。`, "success");
      return true;
    } catch (error) {
      setOperationStatus("error", "状态：Git刷新失败");
      showToast(`刷新失败：${normalizeErrorMessage(error.message)}`, "error");
      return false;
    }
  });
}

async function syncProjectGitInfo(projectId, { render = false } = {}) {
  const project = getProjectById(projectId);
  if (!project) throw new Error("未找到项目，无法刷新 Git。");

  const dirPath = normalizePath(project.dirPath);
  if (!dirPath) throw new Error("项目路径为空，无法刷新 Git。");

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
  if (render) renderList();
  return updated;
}

function buildConnPayloadFromServer(server) {
  const host = String(server?.host || "").trim();
  const username = String(server?.username || "").trim();
  if (!host || !username) {
    return { ok: false, message: "服务器配置缺少地址或用户名。" };
  }

  const payload = {
    host,
    port: Number.parseInt(server.port, 10) || 22,
    username
  };

  const privateKey = String(server.privateKey || "").trim();
  const password = String(server.password || "");

  if (privateKey) {
    payload.privateKey = privateKey;
    return { ok: true, payload };
  }

  if (password.trim()) {
    payload.password = password;
    return { ok: true, payload };
  }

  return { ok: false, message: "该服务器缺少密码或私钥，请在服务器管理中补全。" };
}

async function runConnectionTest(payload, label) {
  const target = `${payload.username}@${payload.host}:${payload.port}`;
  termCmd(`目标：${target}`);
  termLog(`认证方式：${payload.privateKey ? "私钥" : "密码"}`);
  setOperationStatus("running", "状态：连接测试中", `最近动作：正在连接 ${target}`);
  try {
    await api("/api/test-connection", { method: "POST", body: payload });
    termSuccess(`${label} 连接测试通过。`);
    return { ok: true, target };
  } catch (error) {
    termError(`${label} 连接失败：${normalizeErrorMessage(error.message)}`);
    return { ok: false, target };
  }
}

async function testServerConnection(serverId, triggerButton) {
  const server = getServerById(serverId);
  if (!server) {
    showToast("未找到服务器，无法测试连接。", "warn");
    return;
  }
  const parsed = buildConnPayloadFromServer(server);
  if (!parsed.ok) {
    termClear();
    termSeparator(`测试连接 ${safeText(server.name)}`);
    termError(parsed.message);
    showToast(parsed.message, "warn");
    return;
  }

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "测试中…", task)
    : (task) => Promise.resolve(task());
  await runner(async () => {
    termClear();
    termSeparator(`测试连接 ${safeText(server.name)}`);
    const result = await runConnectionTest(parsed.payload, safeText(server.name));
    if (result.ok) {
      setOperationStatus("success", "状态：连接测试通过", `最近动作：${result.target} 连接成功`);
      showToast(`服务器 ${safeText(server.name)} 连接成功。`, "success");
    } else {
      setOperationStatus("error", "状态：连接测试失败", `最近动作：${result.target} 连接失败`);
      showToast(`连接失败：${safeText(server.name)}`, "error", 3400);
    }
  });
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
  const linkedServers = getProjectLinkedServers(project);
  if (!linkedServers.length) {
    termClear();
    termSeparator(`测试连接 ${projectName}`);
    termError("该项目尚未关联部署目标，请先编辑项目进行关联。");
    setOperationStatus("warn", "状态：连接测试未开始", "最近动作：未关联部署目标");
    showToast("该项目尚未关联部署目标。", "warn");
    return;
  }

  const invalidServer = linkedServers.find((server) => !buildConnPayloadFromServer(server).ok);
  if (invalidServer) {
    const message = buildConnPayloadFromServer(invalidServer).message;
    termClear();
    termSeparator(`测试连接 ${projectName}`);
    termError(message);
    setOperationStatus("warn", "状态：连接测试未开始", "最近动作：服务器配置不完整");
    showToast(message, "warn");
    return;
  }

  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "测试中…", task)
    : (task) => Promise.resolve(task());
  await runner(async () => {
    termClear();
    termSeparator(`测试连接 ${projectName}（${linkedServers.length} 台服务器）`);
    let okCount = 0;
    for (const server of linkedServers) {
      const parsed = buildConnPayloadFromServer(server);
      const result = await runConnectionTest(parsed.payload, `[${safeText(server.name)}]`);
      if (result.ok) okCount += 1;
    }
    if (okCount === linkedServers.length) {
      setOperationStatus("success", "状态：连接测试通过", `最近动作：${okCount} 台服务器全部连接成功`);
      showToast(`项目 ${projectName} 的 ${okCount} 台服务器全部连接成功。`, "success");
    } else {
      setOperationStatus("error", "状态：连接测试失败", `最近动作：${okCount}/${linkedServers.length} 台连接成功`);
      showToast(`连接测试结束：${okCount}/${linkedServers.length} 台服务器连接成功。`, "error", 3400);
    }
  });
}

async function openBackupSelector(projectId, targetId, triggerButton) {
  const project = getProjectById(projectId);
  if (!project) {
    showToast("未找到项目，无法读取备份列表。", "warn");
    return;
  }
  const target = findPathById(targetId);
  if (!target) {
    showToast("部署目标无效，无法读取备份列表。", "warn");
    return;
  }

  const backupFolderBaseName = getBackupFolderBaseName(project, targetId);
  if (!backupFolderBaseName) {
    showToast("缺少备份目录名称，请先至少打包一次项目。", "warn");
    return;
  }

  const projectName = safeText(project.projectName, "当前项目");
  const targetLabel = getTargetLabel(target.server, target.path);
  const runner = triggerButton
    ? (task) => withButtonLoading(triggerButton, "读取中…", task)
    : (task) => Promise.resolve(task());

  await runner(async () => {
    termClear();
    terminalTitle.textContent = `备份选择 ${projectName}`;
    termSeparator(`读取备份 ${projectName}`);
    termCmd(`目标：${targetLabel} ${safeText(target.path.deployPath)}`);
    termLog(`匹配规则：${backupFolderBaseName}_YYYYMMDD_HHmmss`);
    setOperationStatus("running", "状态：备份列表读取中", `最近动作：正在扫描 ${targetLabel} 的备份目录`);

    try {
      const result = await api(`/api/list-backups/${projectId}?targetId=${encodeURIComponent(targetId)}`);
      const items = Array.isArray(result?.items) ? result.items : [];

      if (!items.length) {
        termLog("未发现可删除的备份目录。");
        setOperationStatus("success", "状态：未发现备份目录");
        showToast("未发现可删除的备份目录。", "info", 2200);
        return;
      }

      backupSelectorState = {
        projectId,
        projectName,
        targetId,
        targetLabel,
        backupRootPath: safeText(result.backupRootPath, safeText(target.path.deployPath)),
        backupFolderBaseName: safeText(result.backupFolderName, backupFolderBaseName),
        items: items.map((name) => ({ name: String(name), selected: true })),
        pending: false
      };
      renderBackupSelectorWorkbench();
      termSuccess(`已加载 ${items.length} 个备份目录，请在上方勾选后继续删除。`);
      setOperationStatus("success", "状态：备份列表已就绪", `最近动作：已加载 ${items.length} 个备份目录`);
      showToast(`已读取 ${items.length} 个备份目录。`, "success");
    } catch (error) {
      termError(`读取失败：${normalizeErrorMessage(error.message)}`);
      setOperationStatus("error", "状态：备份列表读取失败");
      showToast(`读取备份失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
  });
}

async function rollbackBackupFromWorkbench(index) {
  const state = backupSelectorState;
  if (!state || state.pending) return;
  if (!Number.isInteger(index) || index < 0 || index >= state.items.length) return;
  const item = state.items[index];

  const confirmed = await askConfirm({
    title: "确认回滚",
    message: `将把 ${state.projectName} 的目标「${state.targetLabel}」回滚到备份 ${item.name}。当前线上目录会先保存为新备份，所选备份会保留。`,
    confirmText: "确认回滚",
    tone: "warn"
  });
  if (!confirmed) return;

  state.pending = true;
  renderBackupSelectorWorkbench();

  try {
    termClear({ preserveWorkbench: true });
    termSeparator(`回滚 ${state.projectName}`);
    termCmd(`目标：${state.targetLabel}`);
    termCmd(`回滚到备份：${item.name}`);

    const result = await runStreamingFetch(
      `/api/rollback/${state.projectId}`,
      `回滚 ${state.projectName}`,
      {
        method: "POST",
        body: { targetId: state.targetId, directory: item.name }
      }
    );

    await loadProjects({ silent: true });
    if (result?.rollbackTime) {
      termSuccess(`回滚时间：${result.rollbackTime}`);
    }
    showToast(`已回滚到 ${item.name}。`, "success");
    // 回滚后备份列表会新增“当前线上版本”的备份，静默刷新列表（不清空终端日志）
    try {
      const refreshed = await api(`/api/list-backups/${state.projectId}?targetId=${encodeURIComponent(state.targetId)}`);
      const items = Array.isArray(refreshed?.items) ? refreshed.items : [];
      state.items = items.map((name) => ({ name: String(name), selected: true }));
      state.pending = false;
      if (state.items.length) {
        renderBackupSelectorWorkbench();
        termLog(`备份列表已刷新，共 ${state.items.length} 个目录。`);
      } else {
        clearTerminalWorkbench();
        termLog("备份目录已处理完毕，选择列表已清空。");
      }
    } catch (error) {
      state.pending = false;
      renderBackupSelectorWorkbench();
      termWarn(`刷新备份列表失败：${normalizeErrorMessage(error.message)}`);
    }
  } catch (error) {
    state.pending = false;
    renderBackupSelectorWorkbench();
    showToast(`回滚失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
  }
}

async function deleteSelectedBackupsFromWorkbench() {
  if (!backupSelectorState || backupSelectorState.pending) return;

  const selectedDirectories = backupSelectorState.items
    .filter((item) => item.selected)
    .map((item) => item.name);

  if (!selectedDirectories.length) {
    showToast("请先勾选要删除的备份目录。", "warn");
    return;
  }

  const confirmed = await askConfirm({
    title: "确认删除已选备份",
    message: `将删除已选中的 ${selectedDirectories.length} 个备份目录，操作不可恢复。是否继续？`,
    confirmText: "确认删除",
    tone: "danger"
  });
  if (!confirmed) return;

  backupSelectorState.pending = true;
  renderBackupSelectorWorkbench();

  try {
    termClear({ preserveWorkbench: true });
    termSeparator(`删除备份 ${backupSelectorState.projectName}`);
    termCmd(`目标：${backupSelectorState.targetLabel}`);
    termCmd(`准备删除 ${selectedDirectories.length} 个备份目录…`);

    const result = await runStreamingFetch(
      `/api/delete-backups/${backupSelectorState.projectId}`,
      `删除备份 ${backupSelectorState.projectName}`,
      {
        method: "POST",
        body: {
          targetId: backupSelectorState.targetId,
          directories: selectedDirectories
        }
      }
    );

    const deletedDirectories = Array.isArray(result?.deletedDirectories) ? result.deletedDirectories : [];
    const missingDirectories = Array.isArray(result?.missingDirectories) ? result.missingDirectories : [];
    const removedSet = new Set([...deletedDirectories, ...missingDirectories]);

    if (missingDirectories.length) {
      termWarn(`有 ${missingDirectories.length} 个目录已不存在，已自动跳过。`);
    }

    backupSelectorState.items = backupSelectorState.items.filter((item) => !removedSet.has(item.name));
    backupSelectorState.pending = false;

    if (!backupSelectorState.items.length) {
      clearTerminalWorkbench();
      termLog("备份目录已处理完毕，选择列表已清空。");
    } else {
      renderBackupSelectorWorkbench();
    }

    if (deletedDirectories.length) {
      showToast(`已删除 ${deletedDirectories.length} 个备份目录。`, "success");
    } else {
      showToast("没有删除任何备份目录。", "info", 2200);
    }
  } catch (error) {
    backupSelectorState.pending = false;
    renderBackupSelectorWorkbench();
    showToast(`删除备份失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
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

  if (button.classList.contains("btn-test-server-conn")) {
    await testServerConnection(button.dataset.serverId, button);
    return;
  }

  const projectId = button.dataset.id;
  const projectName = button.dataset.name || "";

  if (button.classList.contains("btn-open-access-url")) {
    await openAccessUrlExternally(button.dataset.url);
    return;
  }

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
    await startPackFlow(projectId, button);
    return;
  }

  if (button.classList.contains("btn-edit")) {
    openEditModal(projectId);
    return;
  }

  if (button.classList.contains("btn-deploy")) {
    await startDeployFlow(projectId, button);
    return;
  }

  if (button.hasAttribute("data-target-deploy")) {
    await startDeployFlow(projectId, button, [button.dataset.targetDeploy]);
    return;
  }

  if (button.classList.contains("btn-delete-backups")) {
    const targetId = await openTargetPicker({ mode: "backup", projectId });
    if (!targetId) return;
    await openBackupSelector(projectId, targetId, button);
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

function collectEditBuildCmds() {
  const result = {};
  $$("#editBuildCmdList input[data-buildcmd-target]").forEach((input) => {
    result[input.dataset.buildcmdTarget] = input.value.trim();
  });
  return result;
}

function renderEditBuildCmdList() {
  const container = byId("editBuildCmdList");
  if (!container) return;

  if (!currentEditTargetIds.length) {
    container.innerHTML = `<div class="edit-buildcmd-empty">尚未关联部署目标，关联后可为每个目标单独配置构建命令。</div>`;
    return;
  }

  // 保留输入框中未保存的编辑，仅新关联的目标回落到已存值
  const draft = collectEditBuildCmds();
  const project = getProjectById(currentEditId);
  container.innerHTML = currentEditTargetIds.map((pathId) => {
    const found = findPathById(pathId);
    if (!found) return "";
    const stored = String(project?.buildCmds?.[pathId] || "").trim();
    const value = Object.prototype.hasOwnProperty.call(draft, pathId) ? draft[pathId] : stored;
    return `
      <div class="edit-buildcmd-row">
        <div class="edit-buildcmd-target">
          <span class="edit-buildcmd-name">${escapeHtml(getTargetLabel(found.server, found.path))}</span>
          <span class="edit-buildcmd-path" title="${escapeHtml(safeText(found.path.deployPath))}">${escapeHtml(safeText(found.path.deployPath))}</span>
        </div>
        <input type="text" data-buildcmd-target="${escapeHtml(pathId)}" value="${escapeHtml(value)}" placeholder="留空使用默认构建命令" autocomplete="off" spellcheck="false">
      </div>
    `;
  }).join("");
}

function renderEditTargetList() {
  const container = byId("editTargetList");
  const hint = byId("editTargetHint");
  if (!container) return;

  if (!currentEditTargetIds.length) {
    container.innerHTML = `<div class="edit-target-empty">尚未关联部署目标，点击“关联部署目标…”选择。</div>`;
  } else {
    container.innerHTML = currentEditTargetIds.map((pathId) => {
      const found = findPathById(pathId);
      if (!found) return "";
      const label = getTargetLabel(found.server, found.path);
      return `
        <div class="edit-target-item" role="listitem">
          <span class="target-chip-status ${isTargetDeployed(getProjectById(currentEditId), pathId) ? "deployed" : ""}" aria-hidden="true"></span>
          <span class="edit-target-item-name">${escapeHtml(label)}</span>
          <span class="edit-target-item-path" title="${escapeHtml(safeText(found.path.deployPath))}">${escapeHtml(safeText(found.path.deployPath))}</span>
          <button
            class="btn btn-xs btn-secondary"
            type="button"
            data-remove-target="${escapeHtml(pathId)}"
            aria-label="解除关联 ${escapeHtml(label)}"
          >解除</button>
        </div>
      `;
    }).join("");
  }

  if (hint) {
    hint.textContent = currentEditTargetIds.length
      ? `已关联 ${currentEditTargetIds.length} 个部署目标，保存后生效。`
      : "部署目标可多选，保存后即可一键部署到多个服务器/路径。";
  }
}

byId("editTargetList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove-target]");
  if (!button) return;
  currentEditTargetIds = currentEditTargetIds.filter((id) => id !== button.dataset.removeTarget);
  renderEditTargetList();
  renderEditBuildCmdList();
});

byId("btnPickTargets").addEventListener("click", async () => {
  const selected = await openTargetPicker({ mode: "link" });
  if (!selected) return;
  currentEditTargetIds = selected;
  renderEditTargetList();
  renderEditBuildCmdList();
  showToast(`已选择 ${selected.length} 个部署目标。`, "success", 1800);
});

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

  currentEditTargetIds = getProjectTargets(project).map(({ path }) => path.id);
  renderEditTargetList();
  renderEditBuildCmdList();
  byId("editRecentDir").value = "";
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

byId("btnSaveEdit").addEventListener("click", async () => {
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
    buildCmd: byId("editBuildCmd").value.trim() || "npm run build",
    buildCmds: collectEditBuildCmds(),
    targetIds: [...currentEditTargetIds]
  };

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

async function loadServers({ silent } = { silent: false }) {
  try {
    servers = await api("/api/servers");
    updateServerCountBadge();
    if (!silent) return true;
    return true;
  } catch (error) {
    setOperationStatus("error", "状态：服务器数据加载失败");
    if (!silent) {
      showToast(`加载服务器失败：${normalizeErrorMessage(error.message)}`, "error", 3400);
    }
    return false;
  }
}

async function loadProjects({ silent } = { silent: false }) {
  try {
    const [projectData] = await Promise.all([
      api("/api/projects"),
      loadServers({ silent: true })
    ]);
    projects = projectData;
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

$$(".view-toggle .tab-btn").forEach((tab) => {
  tab.addEventListener("click", () => {
    const nextView = tab.dataset.view;
    if (!nextView || nextView === activeView) return;
    activeView = nextView;
    $$(".view-toggle .tab-btn").forEach((item) => {
      const isActive = item.dataset.view === nextView;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });
    renderList();
    const viewLabel = nextView === "targets" ? "按目标" : "按项目";
    showToast(`已切换到${viewLabel}视图。`, "info", 1600);
  });
});

resetTerminal();
renderTodayInfo();
renderRecentDirOptions();
updateServerCountBadge();
initTerminalFloating();
loadProjects();
