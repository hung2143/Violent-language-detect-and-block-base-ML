// ─── Default settings ──────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled:      true,
  apiUrl:       "http://127.0.0.1:8000/predict",
  realtimeScan: true,   // Bật/tắt scan real-time khi nhập
  submitScan:   true,   // Bật/tắt scan khi submit form
  whitelist:    [],     // Danh sách hostname bị bỏ qua
};

const ALL_KEYS = Object.keys(DEFAULT_SETTINGS);

// ─── Helpers ───────────────────────────────────────────────────────────────
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "Không có phản hồi từ trang hiện tại." });
    });
  });
}

function collectPageStatsFromDom() {
  const makeStats = () => ({ total: 0, blocked: 0, warn: 0, hardBlocked: 0 });
  const addAction = (stats, action, hardBlock = false) => {
    stats.total += 1;
    if (action === "WARN") stats.warn += 1;
    if (action === "BLOCK" || action === "AUTO_BLOCK" || hardBlock) stats.blocked += 1;
    if (action === "AUTO_BLOCK" || hardBlock) stats.hardBlocked += 1;
    return stats;
  };
  const readAction = (el) => {
    const text = (el.innerText || el.textContent || "").toUpperCase();
    if (el.dataset.tgAction) return el.dataset.tgAction;
    if (el.getAttribute("data-tg-blur")) return el.getAttribute("data-tg-blur");
    if (el.classList.contains("tg-card-overlay-warn") || el.classList.contains("tg-blur-warn") || text.includes("OFFENSIVE")) return "WARN";
    if (el.classList.contains("tg-card-overlay-auto-block") || el.classList.contains("tg-blur-auto-block") || text.includes("HATE") || text.includes("BLOCKED")) return "AUTO_BLOCK";
    if (el.classList.contains("tg-card-overlay-block") || el.classList.contains("tg-blur-block")) return "BLOCK";
    return "";
  };
  const isHardBlock = (el, action) => {
    const text = (el.innerText || el.textContent || "").toUpperCase();
    return el.dataset.tgHardBlock === "1" || el.getAttribute("data-tg-hard-block") === "1" || action === "AUTO_BLOCK" || text.includes("HATE") || text.includes("BLOCKED");
  };

  const wrappers = Array.from(document.querySelectorAll(".tg-reddit-comment-block, .tg-comment-block"));
  const cards = Array.from(document.querySelectorAll(".tg-card-overlay"));
  const pageBadges = Array.from(document.querySelectorAll(".tg-page-badge, .tg-blur-overlay"));
  const topBlurredRoots = Array.from(document.querySelectorAll("[data-tg-blur]")).filter((el) => {
    if (el.closest(".tg-reddit-comment-block, .tg-comment-block")) return false;
    if (el.closest(".tg-card-overlay, .tg-page-badge, .tg-blur-overlay, .toxic-guard-badge, [data-tg-overlay]")) return false;
    return !el.parentElement?.closest?.("[data-tg-blur]");
  });

  const buildStats = (elements) => elements.reduce((stats, el) => {
    const action = readAction(el);
    if (!action) return stats;
    return addAction(stats, action, isHardBlock(el, action));
  }, makeStats());

  const commentStats = buildStats(wrappers);
  const cardStats = buildStats(cards);
  const blurStats = buildStats(topBlurredRoots);
  const pageBadgeStats = buildStats(pageBadges);
  const visualStats = blurStats.total > cardStats.total ? blurStats : cardStats;

  return {
    ok: true,
    hostname: location.hostname || "Trang hiện tại",
    commentStats,
    cardStats: visualStats,
    pageBadgeStats,
    debugCounts: {
      wrappers: wrappers.length,
      cards: cards.length,
      topBlurredRoots: topBlurredRoots.length,
      pageBadges: pageBadges.length
    },
    source: "background-dom",
    enabled: true
  };
}

function executeStatsScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, func: collectPageStatsFromDom },
      (results) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(results?.[0]?.result || { ok: false, error: "Không đọc được DOM trang hiện tại." });
      }
    );
  });
}

/** Kiểm tra URL hợp lệ: phải là http hoặc https */
function isValidApiUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Khởi tạo defaults khi install ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const data = await storageGet(ALL_KEYS);
  const updates = {};
  for (const key of ALL_KEYS) {
    if (data[key] === undefined || data[key] === null) {
      updates[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (Object.keys(updates).length > 0) await storageSet(updates);
});

// ─── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      // ── Đọc toàn bộ settings ──────────────────────────────────────────────
      if (message.type === "GET_SETTINGS") {
        const data = await storageGet(ALL_KEYS);
        const settings = {};
        for (const key of ALL_KEYS) {
          settings[key] = data[key] !== undefined ? data[key] : DEFAULT_SETTINGS[key];
        }
        sendResponse(settings);
        return;
      }

      // ── Ghi một nhóm settings cùng lúc ────────────────────────────────────
      if (message.type === "SET_SETTINGS") {
        const allowed = {};
        for (const key of ALL_KEYS) {
          if (message.payload && key in message.payload) {
            // Validate URL riêng
            if (key === "apiUrl") {
              if (!isValidApiUrl(message.payload[key])) {
                sendResponse({ ok: false, error: "URL không hợp lệ. Phải bắt đầu bằng http:// hoặc https://" });
                return;
              }
            }
            allowed[key] = message.payload[key];
          }
        }
        await storageSet(allowed);
        sendResponse({ ok: true });
        return;
      }

      // ── Tương thích ngược: SET_ENABLED / SET_API_URL ──────────────────────
      if (message.type === "SET_ENABLED") {
        await storageSet({ enabled: !!message.enabled });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "SET_API_URL") {
        if (!isValidApiUrl(message.apiUrl)) {
          sendResponse({ ok: false, error: "URL không hợp lệ. Phải bắt đầu bằng http:// hoặc https://" });
          return;
        }
        await storageSet({ apiUrl: message.apiUrl });
        sendResponse({ ok: true });
        return;
      }

      // ── Kiểm tra text từ popup ─────────────────────────────────────────────
      if (message.type === "CHECK_TEXT") {
        const data = await storageGet(["enabled", "apiUrl"]);
        const enabled = data.enabled ?? DEFAULT_SETTINGS.enabled;
        const apiUrl  = data.apiUrl  ?? DEFAULT_SETTINGS.apiUrl;

        if (!enabled) {
          sendResponse({ ok: true, result: { action: "ALLOW", label_name: "DISABLED", target_name: "DISABLED" } });
          return;
        }

        // Timeout 8 giây để popup không bị treo
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 8000);

        try {
          const response = await fetch(apiUrl, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ text: message.text || "" }),
            signal:  controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json();
          sendResponse({ ok: true, result });
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          const isTimeout = fetchErr.name === "AbortError";
          sendResponse({ ok: false, error: isTimeout ? "API timeout (>8s)" : fetchErr.message });
        }
        return;
      }

      if (message.type === "GET_ACTIVE_TAB_STATS") {
        const tab = await queryActiveTab();
        if (!tab?.id) {
          sendResponse({ ok: false, error: "Không tìm thấy tab hiện tại." });
          return;
        }
        const domStats = await executeStatsScript(tab.id);
        sendResponse(domStats?.ok ? domStats : await sendTabMessage(tab.id, { type: "GET_PAGE_STATS" }));
        return;
      }

    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true; // Giữ message port mở cho async response
});
