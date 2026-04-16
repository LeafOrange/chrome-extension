/* service-worker.js — Background script with capture modes and history */

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const CAPTURE_RESULT_KEY = "latestCaptureResult";
const HISTORY_KEY = "ocrHistory";
const MAX_HISTORY = 30;
let offscreenInitPromise = null;
let processingLock = false;
let keepAlivePort = null;

/* ========== Lifecycle ========== */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ launcherVisible: true, autoCopy: true });
});

// Note: action.onClicked does not fire when default_popup is set.
// Launcher toggle is handled via popup or Alt+Shift+O shortcut.

/* ========== Commands ========== */

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;

    switch (command) {
      case "toggle-launcher":
        await toggleLauncher(tab.id);
        break;
      case "capture-visible":
        if (!processingLock) processCapture(tab.id, "visible").catch(() => {});
        break;
      case "capture-selection":
        if (!processingLock) await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" });
        break;
      case "capture-fullpage":
        if (!processingLock) processCapture(tab.id, "fullpage").catch(() => {});
        break;
      case "show-latest": {
        const data = await chrome.storage.local.get(CAPTURE_RESULT_KEY);
        if (data[CAPTURE_RESULT_KEY]) {
          await chrome.tabs.sendMessage(tab.id, {
            type: "OCR_RESULT",
            payload: data[CAPTURE_RESULT_KEY],
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error("[OCR] command failed:", error);
  }
});

/* ========== Message router ========== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "REQUEST_CAPTURE": {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error("No sender tab id.");
        if (processingLock) { sendResponse({ ok: false, error: "正在处理中，请等待完成" }); return; }
        // Respond immediately, result will be sent via OCR_RESULT message
        sendResponse({ ok: true });
        processCapture(tabId, message.mode || "visible").catch((e) =>
          console.error("[OCR] capture failed:", e)
        );
        return;
      }

      case "SELECTION_COMPLETE": {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error("No sender tab id.");
        if (processingLock) { sendResponse({ ok: false, error: "正在处理中，请等待完成" }); return; }
        sendResponse({ ok: true });
        processSelectionCapture(tabId, message.rect).catch((e) =>
          console.error("[OCR] selection capture failed:", e)
        );
        return;
      }

      case "GET_LATEST_RESULT": {
        const data = await chrome.storage.local.get(CAPTURE_RESULT_KEY);
        sendResponse({ ok: true, result: data[CAPTURE_RESULT_KEY] || null });
        return;
      }

      case "GET_HISTORY": {
        const data = await chrome.storage.local.get(HISTORY_KEY);
        sendResponse({ ok: true, history: data[HISTORY_KEY] || [] });
        return;
      }

      case "DELETE_HISTORY_ITEM": {
        await deleteHistoryItem(message.id);
        sendResponse({ ok: true });
        return;
      }

      case "CLEAR_HISTORY": {
        await chrome.storage.local.set({ [HISTORY_KEY]: [] });
        sendResponse({ ok: true });
        return;
      }

      case "GET_SETTINGS": {
        const keys = ["launcherVisible", "defaultCaptureMode", "autoCopy", HISTORY_KEY];
        const data = await chrome.storage.local.get(keys);
        sendResponse({
          ok: true,
          settings: {
            launcherVisible: data.launcherVisible ?? false,
            defaultCaptureMode: data.defaultCaptureMode ?? "visible",
            autoCopy: data.autoCopy ?? true,
            historyCount: (data[HISTORY_KEY] || []).length,
          },
        });
        return;
      }

      case "SAVE_SETTINGS": {
        const s = message.settings || {};
        const toSave = {};
        if (s.defaultCaptureMode !== undefined) toSave.defaultCaptureMode = s.defaultCaptureMode;
        if (s.autoCopy !== undefined) toSave.autoCopy = s.autoCopy;
        if (s.launcherVisible !== undefined) toSave.launcherVisible = s.launcherVisible;
        await chrome.storage.local.set(toSave);

        // If launcher visibility changed, notify active tab
        if (s.launcherVisible !== undefined) {
          const tab = await getActiveTab();
          if (tab?.id) {
            try {
              await chrome.tabs.sendMessage(tab.id, {
                type: "TOGGLE_LAUNCHER",
                visible: s.launcherVisible,
              });
            } catch (_) {}
          }
        }

        sendResponse({ ok: true });
        return;
      }

      case "CLEAR_CACHE": {
        // Terminate cached worker via offscreen if it exists
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  };

  run().catch((error) => {
    console.error("[OCR] message handler failed:", error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return true;
});

/* ========== Launcher toggle ========== */

async function toggleLauncher(tabId) {
  const state = await chrome.storage.local.get("launcherVisible");
  const nextVisible = !Boolean(state.launcherVisible);
  await chrome.storage.local.set({ launcherVisible: nextVisible });
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TOGGLE_LAUNCHER",
      visible: nextVisible,
    });
  } catch (e) {
    console.warn("[OCR] toggle launcher failed:", e);
  }
}

/* ========== Visible area capture ========== */

async function processCapture(tabId, mode) {
  if (processingLock) return;
  processingLock = true;

  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined) { processingLock = false; throw new Error("Unable to detect window."); }

  await ensureOffscreenDocument();
  startKeepAlive();
  await setBadge(tabId, "...", "#2563eb");

  try {
    let imageDataUrl;

    if (mode === "fullpage") {
      imageDataUrl = await captureFullPage(tabId, tab.windowId);
    } else {
      imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    }

    const result = await runOfflineOcr({
      imageDataUrl,
      mode,
      tabTitle: tab.title || "",
      pageUrl: tab.url || "",
    });

    const payload = {
      ...result,
      mode,
      capturedAt: Date.now(),
      tabTitle: tab.title || "",
      pageUrl: tab.url || "",
    };

    await chrome.storage.local.set({
      [CAPTURE_RESULT_KEY]: payload,
      launcherVisible: true,
    });

    // Auto-copy check
    const settings = await chrome.storage.local.get("autoCopy");
    if (settings.autoCopy && payload.text) {
      // Notify content script to copy
      payload.autoCopy = true;
    }

    await chrome.tabs.sendMessage(tabId, { type: "OCR_RESULT", payload });
    await setBadge(tabId, "OK", "#16a34a");
    await saveToHistory(payload);
    return payload;
  } catch (error) {
    await setBadge(tabId, "ERR", "#dc2626");
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OCR_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (_) {}
    throw error;
  } finally {
    processingLock = false;
    stopKeepAlive();
    setTimeout(() => setBadge(tabId, "", "").catch(() => {}), 1800);
  }
}

/* ========== Selection capture ========== */

async function processSelectionCapture(tabId, rect) {
  if (processingLock) return;
  processingLock = true;

  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined) { processingLock = false; throw new Error("Unable to detect window."); }

  await ensureOffscreenDocument();
  startKeepAlive();
  await setBadge(tabId, "...", "#2563eb");

  try {
    const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await ensureOffscreenDocument();

    // Crop the image to the selection rect
    const cropResult = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CROP_IMAGE",
      payload: {
        imageDataUrl,
        rect,
        dpr: rect.dpr || 1,
      },
    });

    if (!cropResult?.ok) {
      throw new Error(cropResult?.error || "Crop failed");
    }

    // OCR the cropped image
    const result = await runOfflineOcr({
      imageDataUrl: cropResult.croppedDataUrl,
      mode: "selection",
      tabTitle: tab.title || "",
      pageUrl: tab.url || "",
    });

    const payload = {
      ...result,
      mode: "selection",
      capturedAt: Date.now(),
      tabTitle: tab.title || "",
      pageUrl: tab.url || "",
    };

    await chrome.storage.local.set({
      [CAPTURE_RESULT_KEY]: payload,
      launcherVisible: true,
    });

    const settings = await chrome.storage.local.get("autoCopy");
    if (settings.autoCopy && payload.text) {
      payload.autoCopy = true;
    }

    await chrome.tabs.sendMessage(tabId, { type: "OCR_RESULT", payload });
    await setBadge(tabId, "OK", "#16a34a");
    await saveToHistory(payload);
    return payload;
  } catch (error) {
    await setBadge(tabId, "ERR", "#dc2626");
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OCR_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (_) {}
    throw error;
  } finally {
    processingLock = false;
    stopKeepAlive();
    setTimeout(() => setBadge(tabId, "", "").catch(() => {}), 1800);
  }
}

/* ========== Full-page capture ========== */

async function captureFullPage(tabId, windowId) {
  // Get page dimensions
  const [dimResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
    }),
  });

  const dims = dimResult.result;
  const steps = Math.ceil(dims.scrollHeight / dims.viewportHeight);
  const segments = [];

  // Notify content script about progress
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "FULLPAGE_PROGRESS",
      current: 0,
      total: steps,
    });
  } catch (_) {}

  // Hide fixed/sticky elements during capture
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const fixed = document.querySelectorAll("*");
      const hidden = [];
      fixed.forEach((el) => {
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.position === "sticky") {
          hidden.push({ el, display: el.style.display });
          el.style.display = "none";
        }
      });
      window.__ocrHiddenFixed = hidden;
    },
  });

  try {
    for (let i = 0; i < steps; i++) {
      const scrollY = i * dims.viewportHeight;

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => window.scrollTo(0, y),
        args: [scrollY],
      });

      // Small delay for rendering
      await delay(150);

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });

      // Calculate actual captured height for last segment
      const actualHeight =
        i === steps - 1
          ? dims.scrollHeight - scrollY
          : dims.viewportHeight;

      segments.push({
        dataUrl,
        yOffset: Math.round(scrollY * dims.dpr),
        capturedHeight: Math.round(actualHeight * dims.dpr),
      });

      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "FULLPAGE_PROGRESS",
          current: i + 1,
          total: steps,
        });
      } catch (_) {}
    }
  } finally {
    // Restore fixed elements and scroll position
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ox, oy) => {
        if (window.__ocrHiddenFixed) {
          window.__ocrHiddenFixed.forEach(({ el, display }) => {
            el.style.display = display;
          });
          delete window.__ocrHiddenFixed;
        }
        window.scrollTo(ox, oy);
      },
      args: [dims.originalScrollX, dims.originalScrollY],
    });
  }

  // Stitch in offscreen
  await ensureOffscreenDocument();
  const stitchResult = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "STITCH_IMAGES",
    payload: {
      segments,
      totalWidth: Math.round(dims.scrollWidth * dims.dpr),
      totalHeight: Math.round(dims.scrollHeight * dims.dpr),
    },
  });

  if (!stitchResult?.ok) {
    throw new Error(stitchResult?.error || "Stitch failed");
  }

  return stitchResult.stitchedDataUrl;
}

/* ========== History management ========== */

async function saveToHistory(payload) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = data[HISTORY_KEY] || [];

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    mode: payload.mode || "visible",
    text: (payload.text || "").slice(0, 2000),
    elapsedMs: payload.meta?.elapsedMs || 0,
    pageUrl: payload.pageUrl || "",
    tabTitle: payload.tabTitle || "",
  };

  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

async function deleteHistoryItem(id) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = (data[HISTORY_KEY] || []).filter((h) => h.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

/* ========== Offscreen & OCR ========== */

async function runOfflineOcr(payload) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "PROCESS_OCR",
    payload,
  });
}

async function ensureOffscreenDocument() {
  if (offscreenInitPromise) {
    await offscreenInitPromise;
    return;
  }

  offscreenInitPromise = (async () => {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) return;

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_SCRAPING"],
        justification: "Use canvas and Tesseract.js for offline OCR processing.",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("single offscreen document")) throw error;
    }
  })();

  await offscreenInitPromise;
}

/* ========== Utilities ========== */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function setBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ tabId, text });
  if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========== Service Worker keepalive ========== */
// MV3 service workers are terminated after ~30s idle. Opening a port to the
// offscreen document keeps the service worker alive for the duration of
// long-running OCR operations.

function startKeepAlive() {
  if (keepAlivePort) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: "keepalive" });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
      // If still processing, reconnect immediately
      if (processingLock) {
        setTimeout(startKeepAlive, 0);
      }
    });
  } catch (e) {
    console.warn("[OCR] keepalive port failed:", e);
    keepAlivePort = null;
  }
}

function stopKeepAlive() {
  if (keepAlivePort) {
    try { keepAlivePort.disconnect(); } catch (_) {}
    keepAlivePort = null;
  }
}
