let lastOperationStatusSnapshot = "";

const terminal = document.getElementById("terminal");
const terminalTitle = document.getElementById("terminalTitle");
const terminalWorkbench = document.getElementById("terminalWorkbench");

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

function resetTerminal() {
  clearTerminalWorkbench();
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

function termClear({ preserveWorkbench = false } = {}) {
  terminal.innerHTML = "";
  if (!preserveWorkbench) {
    clearTerminalWorkbench();
  }
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
