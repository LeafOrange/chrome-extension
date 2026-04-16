/* content.js — Floating launcher, result panel, selection overlay, history */
(function bootstrapOcrLauncher() {
  if (window.__ocrLauncherLoaded__) return;
  window.__ocrLauncherLoaded__ = true;

  const state = {
    launcherVisible: false,
    panelVisible: false,
    busy: false,
    lastResult: null,
    selectionMode: false,
    historyView: false,
  };

  /* ========== Shadow DOM setup ========== */
  const root = document.createElement("div");
  root.id = "ocr-extension-root";
  document.documentElement.appendChild(root);
  const shadow = root.attachShadow({ mode: "open" });

  shadow.innerHTML = buildStyles() + buildHTML();

  /* ========== Element refs ========== */
  const launcher = shadow.getElementById("launcher");
  const panel = shadow.getElementById("panel");
  const panelHeader = shadow.getElementById("panelHeader");
  const resultText = shadow.getElementById("resultText");
  const statusText = shadow.getElementById("statusText");
  const panelMeta = shadow.getElementById("panelMeta");
  const captureBtn = shadow.getElementById("captureBtn");
  const selectionBtn = shadow.getElementById("selectionBtn");
  const fullpageBtn = shadow.getElementById("fullpageBtn");
  const copyBtn = shadow.getElementById("copyBtn");
  const latestBtn = shadow.getElementById("latestBtn");
  const historyBtn = shadow.getElementById("historyBtn");
  const closePanelBtn = shadow.getElementById("closePanelBtn");
  const hideLauncherBtn = shadow.getElementById("hideLauncherBtn");
  const historyContainer = shadow.getElementById("historyContainer");
  const historyList = shadow.getElementById("historyList");
  const backFromHistory = shadow.getElementById("backFromHistory");
  const clearHistoryBtn = shadow.getElementById("clearHistoryBtn");
  const resultView = shadow.getElementById("resultView");
  const selectionOverlay = shadow.getElementById("selectionOverlay");
  const selectionRect = shadow.getElementById("selectionRect");
  const selectionInfo = shadow.getElementById("selectionInfo");

  /* ========== Event listeners ========== */
  launcher.addEventListener("click", () => {
    if (state.panelVisible) {
      hidePanel();
    } else {
      showPanel();
    }
  });

  captureBtn.addEventListener("click", () => startCapture("visible"));
  selectionBtn.addEventListener("click", () => { if (!state.busy) enterSelectionMode(); });
  fullpageBtn.addEventListener("click", () => startCapture("fullpage"));
  copyBtn.addEventListener("click", () => copyCurrentText(true));
  latestBtn.addEventListener("click", async () => {
    const r = await safeSendMessage({ type: "GET_LATEST_RESULT" });
    if (r?.ok && r.result) renderResult(r.result);
  });
  historyBtn.addEventListener("click", () => showHistory());
  backFromHistory.addEventListener("click", () => hideHistory());
  clearHistoryBtn.addEventListener("click", async () => {
    await safeSendMessage({ type: "CLEAR_HISTORY" });
    await loadHistoryList();
  });
  closePanelBtn.addEventListener("click", () => hidePanel());
  hideLauncherBtn.addEventListener("click", () => setLauncherVisible(false));

  /* ========== Keyboard ========== */
  window.addEventListener("keydown", async (event) => {
    if (state.selectionMode) {
      if (event.key === "Escape") {
        cancelSelection();
        return;
      }
      return;
    }
    if (event.key === "Escape" && state.panelVisible) {
      hidePanel();
    }
    if (event.key === "Enter" && event.ctrlKey && state.panelVisible) {
      event.preventDefault();
      await copyCurrentText(true);
    }
  });

  /* ========== Selection overlay logic ========== */
  let selStartX = 0, selStartY = 0, selDragging = false;

  function enterSelectionMode() {
    if (state.busy) return;
    state.selectionMode = true;
    hidePanel();
    selectionOverlay.classList.add("active");
    selectionRect.style.display = "none";
    selectionInfo.textContent = "拖拽选择区域 | Esc 取消";
  }

  function cancelSelection() {
    state.selectionMode = false;
    selectionOverlay.classList.remove("active");
    selectionRect.style.display = "none";
    selDragging = false;
  }

  selectionOverlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    selDragging = true;
    selStartX = e.clientX;
    selStartY = e.clientY;
    selectionRect.style.left = e.clientX + "px";
    selectionRect.style.top = e.clientY + "px";
    selectionRect.style.width = "0px";
    selectionRect.style.height = "0px";
    selectionRect.style.display = "block";
  });

  selectionOverlay.addEventListener("mousemove", (e) => {
    if (!selDragging) return;
    const x = Math.min(e.clientX, selStartX);
    const y = Math.min(e.clientY, selStartY);
    const w = Math.abs(e.clientX - selStartX);
    const h = Math.abs(e.clientY - selStartY);
    selectionRect.style.left = x + "px";
    selectionRect.style.top = y + "px";
    selectionRect.style.width = w + "px";
    selectionRect.style.height = h + "px";
    selectionInfo.textContent = `${w} x ${h} | 松开确认 | Esc 取消`;
  });

  selectionOverlay.addEventListener("mouseup", async (e) => {
    if (!selDragging) return;
    selDragging = false;
    const x = Math.min(e.clientX, selStartX);
    const y = Math.min(e.clientY, selStartY);
    const w = Math.abs(e.clientX - selStartX);
    const h = Math.abs(e.clientY - selStartY);

    cancelSelection();

    if (w < 10 || h < 10) {
      return; // Too small, ignore
    }

    setBusy(true);
    showPanel();
    statusText.textContent = "正在处理选区截图...";
    panelMeta.textContent = "处理中";

    try {
      const resp = await safeSendMessage({
        type: "SELECTION_COMPLETE",
        rect: { x, y, width: w, height: h, dpr: window.devicePixelRatio || 1 },
      });
      if (!resp?.ok) {
        throw new Error(resp?.error || "选区截图失败");
      }
    } catch (err) {
      setBusy(false);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("invalidated") || errMsg.includes("扩展已更新") || errMsg.includes("Extension context")) {
        statusText.textContent = "扩展已更新，请刷新此页面后重试。";
      } else {
        statusText.textContent = `失败: ${errMsg}`;
      }
    }
  });

  /* ========== History UI ========== */
  function showHistory() {
    state.historyView = true;
    resultView.style.display = "none";
    historyContainer.style.display = "flex";
    showPanel();
    loadHistoryList();
  }

  function hideHistory() {
    state.historyView = false;
    historyContainer.style.display = "none";
    resultView.style.display = "flex";
  }

  async function loadHistoryList() {
    const resp = await safeSendMessage({ type: "GET_HISTORY" });
    const history = resp?.history || [];
    historyList.innerHTML = "";

    if (history.length === 0) {
      historyList.innerHTML = '<div class="history-empty">暂无历史记录</div>';
      return;
    }

    for (const entry of history) {
      const item = document.createElement("div");
      item.className = "history-item";

      const modeLabel = { visible: "可视区", selection: "选区", fullpage: "整页" }[entry.mode] || entry.mode;
      const time = new Date(entry.timestamp).toLocaleString("zh-CN");
      const preview = (entry.text || "").slice(0, 80).replace(/\n/g, " ");

      item.innerHTML = `
        <div class="history-meta">
          <span class="history-mode">${modeLabel}</span>
          <span class="history-time">${time}</span>
          <span class="history-ms">${entry.elapsedMs}ms</span>
        </div>
        <div class="history-preview">${escapeHtml(preview)}...</div>
        <div class="history-actions">
          <button class="history-copy-btn" type="button">复制</button>
          <button class="history-del-btn" type="button">删除</button>
        </div>
      `;

      item.querySelector(".history-copy-btn").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(entry.text || "");
          statusText.textContent = "已复制到剪贴板";
        } catch (e) {
          statusText.textContent = "复制失败";
        }
      });

      item.querySelector(".history-del-btn").addEventListener("click", async () => {
        await safeSendMessage({ type: "DELETE_HISTORY_ITEM", id: entry.id });
        await loadHistoryList();
      });

      historyList.appendChild(item);
    }
  }

  /* ========== Message listener ========== */
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    // Ignore messages intended for offscreen document
    if (message?.target === "offscreen") return false;

    try {
      if (message?.type === "TOGGLE_LAUNCHER") {
        setLauncherVisible(Boolean(message.visible));
      }
      if (message?.type === "OCR_RESULT") {
        renderResult(message.payload);
      }
      if (message?.type === "OCR_ERROR") {
        showPanel();
        setBusy(false);
        statusText.textContent = `处理失败: ${message.error || "未知错误"}`;
      }
      if (message?.type === "START_SELECTION") {
        enterSelectionMode();
      }
      if (message?.type === "FULLPAGE_PROGRESS") {
        showPanel();
        statusText.textContent = `整页截图中... ${message.current}/${message.total}`;
      }
    } catch (err) {
      console.warn("[OCR] message handler error:", err);
    }
    return false;
  });

  /* ========== Context validity check ========== */
  function isContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) {
      return Promise.reject(new Error("扩展已更新，请刷新此页面后重试。"));
    }
    return chrome.runtime.sendMessage(msg).catch((err) => {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("invalidated") || errMsg.includes("Extension context")) {
        throw new Error("扩展已更新，请刷新此页面后重试。");
      }
      throw err;
    });
  }

  /* ========== Helper functions ========== */
  async function startCapture(mode) {
    if (state.busy) return;
    try {
      if (mode === "selection") {
        enterSelectionMode();
        return;
      }
      setBusy(true);
      showPanel();
      statusText.textContent = mode === "fullpage" ? "正在进行整页截图..." : "正在准备截图与本地处理...";
      panelMeta.textContent = "处理中";
      const response = await safeSendMessage({ type: "REQUEST_CAPTURE", mode });
      if (!response?.ok) throw new Error(response?.error || "截图请求失败");
    } catch (error) {
      setBusy(false);
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("invalidated") || msg.includes("扩展已更新")) {
        statusText.textContent = "扩展已更新，请刷新此页面后重试。";
      } else {
        statusText.textContent = `失败: ${msg}`;
      }
    }
  }

  function renderResult(payload) {
    state.lastResult = payload;
    hideHistory();
    showPanel();
    setBusy(false);
    resultText.value = payload.text || "";
    statusText.textContent = payload.ok
      ? "本地处理完成，可继续编辑或复制。"
      : `处理失败: ${payload.error || "未知错误"}`;

    const modeLabels = { visible: "可视区截图", selection: "选区截图", fullpage: "整页截图" };
    panelMeta.textContent = [
      modeLabels[payload.mode] || "截图",
      payload.meta?.elapsedMs ? `${payload.meta.elapsedMs}ms` : "",
      payload.engine || "",
    ].filter(Boolean).join(" · ");

    if (payload.autoCopy && payload.text) {
      navigator.clipboard.writeText(payload.text).catch(() => {});
      statusText.textContent += " (已自动复制)";
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    launcher.classList.toggle("busy", busy);
    // Disable/enable capture buttons during processing
    captureBtn.disabled = busy;
    selectionBtn.disabled = busy;
    fullpageBtn.disabled = busy;
    captureBtn.style.opacity = busy ? "0.4" : "";
    selectionBtn.style.opacity = busy ? "0.4" : "";
    fullpageBtn.style.opacity = busy ? "0.4" : "";
    captureBtn.style.pointerEvents = busy ? "none" : "";
    selectionBtn.style.pointerEvents = busy ? "none" : "";
    fullpageBtn.style.pointerEvents = busy ? "none" : "";
  }

  function setLauncherVisible(visible) {
    state.launcherVisible = visible;
    launcher.classList.toggle("visible", visible);
    if (!visible) hidePanel();
  }

  function showPanel() {
    state.panelVisible = true;
    panel.classList.add("visible");
    setLauncherVisible(true);
  }

  function hidePanel() {
    state.panelVisible = false;
    panel.classList.remove("visible");
  }

  async function copyCurrentText(shouldClose) {
    const text = resultText.value.trim();
    if (!text) { statusText.textContent = "当前没有可复制的内容。"; return; }
    try {
      await navigator.clipboard.writeText(text);
      statusText.textContent = "已复制到剪贴板。";
      if (shouldClose) hidePanel();
    } catch (e) {
      statusText.textContent = `复制失败: ${e.message || e}`;
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  enableDrag(launcher);
  enableDrag(panel, panelHeader);

  /* ========== Init: read stored launcher visibility ========== */
  try {
    chrome.storage.local.get("launcherVisible", (data) => {
      if (chrome.runtime.lastError) return;
      if (data.launcherVisible) {
        setLauncherVisible(true);
      }
    });
  } catch (_) {}

  /* Listen for storage changes from popup */
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.launcherVisible) {
        setLauncherVisible(Boolean(changes.launcherVisible.newValue));
      }
    });
  } catch (_) {}

  function enableDrag(target, handle) {
    handle = handle || target;
    let dragging = false, moved = false, startX = 0, startY = 0, originLeft = 0, originTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      // Don't start drag if the click is on a button or interactive element
      if (e.target.closest("button, input, select, textarea, a")) return;
      dragging = true;
      moved = false;
      handle.setPointerCapture(e.pointerId);
      const rect = target.getBoundingClientRect();
      originLeft = rect.left; originTop = rect.top;
      startX = e.clientX; startY = e.clientY;
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      // Only reposition on first actual move
      if (!moved) {
        moved = true;
        target.style.left = originLeft + "px";
        target.style.top = originTop + "px";
        target.style.right = "auto";
        target.style.bottom = "auto";
      }
      target.style.left = Math.max(8, originLeft + e.clientX - startX) + "px";
      target.style.top = Math.max(8, originTop + e.clientY - startY) + "px";
    });

    handle.addEventListener("pointerup", (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }

  /* ========== Build styles ========== */
  function buildStyles() {
    return `<style>
      :host { all: initial; }
      .launcher {
        position: fixed; right: 24px; bottom: 24px;
        width: 58px; height: 58px; border-radius: 18px;
        display: none; align-items: center; justify-content: center;
        cursor: grab; user-select: none;
        background: linear-gradient(135deg, rgba(37,99,235,0.96), rgba(99,102,241,0.96));
        color: #fff; border: 1px solid rgba(255,255,255,0.28);
        box-shadow: 0 18px 48px rgba(15,23,42,0.35);
        backdrop-filter: blur(18px);
        z-index: 2147483646;
        transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
        font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }
      .launcher.visible { display: flex; }
      .launcher:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 24px 52px rgba(37,99,235,0.35); }
      .launcher.busy { cursor: progress; opacity: 0.86; }
      .launcher-inner { text-align: center; line-height: 1; }
      .launcher-icon { display: block; font-size: 22px; margin-bottom: 4px; }
      .launcher-text { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }

      .panel {
        position: fixed; right: 24px; bottom: 96px;
        width: min(420px, calc(100vw - 24px));
        max-height: min(70vh, 680px);
        display: none; flex-direction: column;
        background: rgba(10,16,30,0.9); color: #eef3ff;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 22px;
        box-shadow: 0 24px 70px rgba(15,23,42,0.45);
        backdrop-filter: blur(18px);
        z-index: 2147483647; overflow: hidden;
        font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }
      .panel.visible { display: flex; }

      .panel-header {
        display: flex; justify-content: space-between; align-items: center;
        gap: 12px; padding: 16px 16px 12px; cursor: grab;
        background: linear-gradient(180deg, rgba(255,255,255,0.05), transparent);
      }
      .panel-title { display: grid; gap: 4px; }
      .panel-title strong { font-size: 15px; }
      .panel-title span { font-size: 12px; color: #9fb1d1; }
      .panel-actions { display: flex; gap: 8px; }

      button {
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06); color: #eef3ff;
        border-radius: 12px; padding: 10px 12px; cursor: pointer; font: inherit;
        font-size: 13px;
      }
      button:hover { border-color: rgba(96,165,250,0.45); }

      .panel-toolbar { display: flex; gap: 8px; padding: 0 16px 12px; flex-wrap: wrap; }
      .status { padding: 0 16px 12px; font-size: 12px; color: #9fb1d1; }
      .textarea {
        margin: 0 16px 16px; min-height: 200px; resize: vertical;
        border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04); color: #eef3ff;
        padding: 14px; line-height: 1.65; outline: none; font: inherit;
      }
      .hint { padding: 0 16px 14px; color: #9fb1d1; font-size: 12px; }

      /* Selection overlay */
      .selection-overlay {
        display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        z-index: 2147483647; cursor: crosshair;
        background: rgba(0,0,0,0.3);
      }
      .selection-overlay.active { display: block; }
      .selection-rect {
        position: fixed; border: 2px dashed #60a5fa;
        background: rgba(96,165,250,0.12); display: none;
        z-index: 2147483647; pointer-events: none;
      }
      .selection-info {
        position: fixed; bottom: 20px; left: 50%;
        transform: translateX(-50%);
        background: rgba(10,16,30,0.85); color: #eef3ff;
        padding: 8px 18px; border-radius: 10px;
        font-size: 13px; z-index: 2147483647;
        font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }

      /* History */
      .history-container {
        display: none; flex-direction: column; flex: 1;
        overflow-y: auto; max-height: 400px;
      }
      .history-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 16px;
      }
      .history-header button { padding: 6px 10px; font-size: 12px; }
      .history-list { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 8px; }
      .history-item {
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px; padding: 10px 12px;
      }
      .history-meta { display: flex; gap: 8px; font-size: 11px; color: #9fb1d1; margin-bottom: 4px; }
      .history-mode {
        background: rgba(96,165,250,0.18); color: #93c5fd; padding: 1px 6px;
        border-radius: 4px; font-size: 10px;
      }
      .history-preview { font-size: 13px; color: #c8d6e5; margin-bottom: 6px; word-break: break-all; }
      .history-actions { display: flex; gap: 6px; }
      .history-actions button { padding: 4px 10px; font-size: 11px; border-radius: 8px; }
      .history-empty { text-align: center; color: #9fb1d1; padding: 24px; font-size: 13px; }
    </style>`;
  }

  /* ========== Build HTML ========== */
  function buildHTML() {
    return `
    <div class="launcher" id="launcher" title="图转文字">
      <div class="launcher-inner">
        <span class="launcher-icon">OCR</span>
        <span class="launcher-text">图转字</span>
      </div>
    </div>
    <section class="panel" id="panel" aria-label="OCR 结果面板">
      <div class="panel-header" id="panelHeader">
        <div class="panel-title">
          <strong>图转文字结果</strong>
          <span id="panelMeta">等待截图</span>
        </div>
        <div class="panel-actions">
          <button id="hideLauncherBtn" type="button">隐藏入口</button>
          <button id="closePanelBtn" type="button">关闭</button>
        </div>
      </div>
      <div class="panel-toolbar">
        <button id="captureBtn" type="button">可视区截图</button>
        <button id="selectionBtn" type="button">选区截图</button>
        <button id="fullpageBtn" type="button">整页截图</button>
        <button id="copyBtn" type="button">复制全部</button>
        <button id="latestBtn" type="button">最近结果</button>
        <button id="historyBtn" type="button">历史记录</button>
      </div>
      <div id="resultView" style="display:flex;flex-direction:column;">
        <div class="status" id="statusText">点击悬浮图标即可开始截图。</div>
        <textarea class="textarea" id="resultText" spellcheck="false"
          placeholder="截图完成后，这里会显示识别结果。"></textarea>
        <div class="hint">Esc 关闭 | Ctrl+Enter 复制并关闭</div>
      </div>
      <div class="history-container" id="historyContainer">
        <div class="history-header">
          <button id="backFromHistory" type="button">返回结果</button>
          <button id="clearHistoryBtn" type="button">清空历史</button>
        </div>
        <div class="history-list" id="historyList"></div>
      </div>
    </section>
    <div class="selection-overlay" id="selectionOverlay">
      <div class="selection-info" id="selectionInfo">拖拽选择区域 | Esc 取消</div>
    </div>
    <div class="selection-rect" id="selectionRect"></div>`;
  }

})();

