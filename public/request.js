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

async function runStreamingFetch(url, label, options = {}) {
  if (typeof ensureTerminalVisible === "function") ensureTerminalVisible();
  terminalTitle.textContent = label;
  setOperationStatus("running", `状态：${label}进行中`, "最近动作：日志流已连接");

  const init = {
    method: "POST",
    headers: { ...(options.headers || {}) },
    ...options
  };

  if (Object.prototype.hasOwnProperty.call(options, "body")) {
    const body = options.body;
    if (typeof body === "string") {
      init.body = body;
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
    } else {
      init.body = JSON.stringify(body ?? {});
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
    }
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        message = data?.error || message;
      } else {
        const text = await response.text();
        if (text.trim()) message = text.trim();
      }
    } catch {}
    setOperationStatus("error", `状态：${label}失败`);
    throw new Error(message);
  }

  if (!response.body) {
    setOperationStatus("error", `状态：${label}失败`);
    throw new Error("日志流不可用，请重试。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamResult = null;
  let streamError = null;

  const consumeEventBlock = (block) => {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (!dataLines.length) return;

    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
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
      if (Number(data.failedCount) > 0) {
        termWarn(`操作结束：成功 ${Number(data.successCount) || 0} 个 / 失败 ${Number(data.failedCount)} 个`);
        setOperationStatus("warn", `状态：${label}部分失败`);
      } else {
        termSuccess("操作完成。");
        setOperationStatus("success", `状态：${label}完成`);
      }
      streamResult = data;
      return;
    }

    if (data.type === "error") {
      termError(data.text || "操作失败。");
      setOperationStatus("error", `状态：${label}失败`);
      streamError = new Error(data.text || "操作失败。");
    }
  };

  try {
    while (!streamResult && !streamError) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let splitIndex = buffer.indexOf("\n\n");
      while (splitIndex !== -1) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        consumeEventBlock(block);
        if (streamResult || streamError) break;
        splitIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (!streamResult && !streamError && buffer.trim()) {
    consumeEventBlock(buffer);
  }

  if (streamError) throw streamError;
  if (streamResult) return streamResult;

  setOperationStatus("error", `状态：${label}中断`, "最近动作：日志连接中断");
  throw new Error("日志连接中断，请重试。");
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
