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

    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true; // Giữ message port mở cho async response
});