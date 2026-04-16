/* popup.js — Settings & help popup */

const toggleLauncher = document.getElementById("toggleLauncher");
const toggleAutoCopy = document.getElementById("toggleAutoCopy");
const defaultMode = document.getElementById("defaultMode");
const historyCount = document.getElementById("historyCount");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const shortcutsList = document.getElementById("shortcutsList");
const openShortcutsBtn = document.getElementById("openShortcutsBtn");

/* Load current settings */
(async function init() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (!resp?.ok) return;
  const s = resp.settings;

  setToggle(toggleLauncher, s.launcherVisible);
  setToggle(toggleAutoCopy, s.autoCopy);
  defaultMode.value = s.defaultCaptureMode || "visible";
  historyCount.textContent = String(s.historyCount || 0);

  // Load actual shortcuts from Chrome
  loadShortcuts();
})();

/* Dynamically load and display keyboard shortcuts */
async function loadShortcuts() {
  const commands = await chrome.commands.getAll();
  shortcutsList.innerHTML = "";

  const nameMap = {
    "capture-visible": "可视区截图",
    "capture-selection": "选区截图",
    "capture-fullpage": "整页长图截图",
    "toggle-launcher": "显示/隐藏入口",
    "show-latest": "打开最近结果",
  };

  for (const cmd of commands) {
    // Skip the default _execute_action command
    if (cmd.name === "_execute_action") continue;

    const label = nameMap[cmd.name] || cmd.description || cmd.name;
    const shortcut = cmd.shortcut || "未设置";

    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `<span>${label}</span><span class="kbd">${shortcut}</span>`;
    shortcutsList.appendChild(row);
  }
}

/* Open Chrome shortcuts settings page */
openShortcutsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});

/* Toggle click handlers */
toggleLauncher.addEventListener("click", async () => {
  const on = !toggleLauncher.classList.contains("on");
  setToggle(toggleLauncher, on);
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { launcherVisible: on },
  });
});

toggleAutoCopy.addEventListener("click", async () => {
  const on = !toggleAutoCopy.classList.contains("on");
  setToggle(toggleAutoCopy, on);
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { autoCopy: on },
  });
});

defaultMode.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { defaultCaptureMode: defaultMode.value },
  });
});

clearHistoryBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
  historyCount.textContent = "0";
});

clearCacheBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  clearCacheBtn.textContent = "已清除";
  setTimeout(() => {
    clearCacheBtn.textContent = "清除OCR缓存";
  }, 1500);
});

function setToggle(el, on) {
  el.classList.toggle("on", on);
}
