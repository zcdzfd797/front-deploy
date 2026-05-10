const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
const byId = (id) => document.getElementById(id);

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
