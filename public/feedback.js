const toastRegion = document.getElementById("toastRegion");
const srAnnouncement = document.getElementById("srAnnouncement");

function announce(message) {
  if (!srAnnouncement || !message) return;
  srAnnouncement.textContent = "";
  window.setTimeout(() => {
    srAnnouncement.textContent = String(message);
  }, 16);
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
