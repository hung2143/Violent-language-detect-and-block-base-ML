// ─── Giao tiếp với background ─────────────────────────────────────────────
function msg(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

// ─── Toast ─────────────────────────────────────────────────────────────────
function toast(text, ok = true) {
  const el = document.getElementById("saveToast");
  el.textContent = text;
  el.style.background   = ok ? "#166534" : "#7f1d1d";
  el.style.color        = ok ? "#4ade80"  : "#fca5a5";
  el.style.border       = ok ? "1px solid #22c55e55" : "1px solid #ef444455";
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1800);
}

// ─── Trạng thái enable ────────────────────────────────────────────────────
function applyEnabled(enabled) {
  const st   = document.getElementById("statusText");
  const bar  = document.getElementById("statusBar");
  const dot  = document.getElementById("statusDot");
  const btxt = document.getElementById("statusBarText");
  if (enabled) {
    st.textContent = "Bật"; st.className = "status-text on";
    bar.className = "status-bar active"; dot.className = "status-dot on";
    btxt.textContent = "Extension đang hoạt động";
  } else {
    st.textContent = "Tắt"; st.className = "status-text off";
    bar.className = "status-bar inactive"; dot.className = "status-dot";
    btxt.textContent = "Extension đã tắt";
  }
}

// ─── Kết quả phân tích ────────────────────────────────────────────────────
function applyResult(action, label, target) {
  const box     = document.getElementById("resultBox");
  const badge   = document.getElementById("resultBadge");
  const actEl   = document.getElementById("resultAction");
  const labelEl = document.getElementById("resultLabel");
  const tgtEl   = document.getElementById("resultTarget");
  const empty   = document.getElementById("resultEmpty");
  const content = document.getElementById("resultContent");

  box.className = "result-box";
  badge.className = "result-badge";

  const MAP = {
    "ALLOW":      { box: "result-allow",  badge: "badge-allow",       label: "AN TOÀN"  },
    "WARN":       { box: "result-warn",   badge: "badge-warn",        label: "CẢNH BÁO" },
    "BLOCK":      { box: "result-block",  badge: "badge-block",       label: "ĐỘC HẠI"  },
    "AUTO_BLOCK": { box: "result-block",  badge: "badge-auto-block",  label: "TỰ CHẶN"  },
    "ERROR":      { box: "result-error",  badge: "badge-error",       label: "LỖI"      },
  };
  const m = MAP[action] || { box: "", badge: "", label: action || "—" };

  if (m.box) box.classList.add(m.box);
  badge.classList.add(m.badge || "");
  badge.textContent  = m.label;
  actEl.textContent  = action || "—";
  labelEl.textContent = label  || "—";
  tgtEl.textContent  = target  || "—";

  empty.style.display   = "none";
  content.classList.remove("hidden");
}

// ─── Tab switching ────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("panel" + cap(tab.dataset.tab)).classList.add("active");
    });
  });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Main ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  initTabs();

  // Đọc tất cả settings một lần
  const s = await msg({ type: "GET_SETTINGS" });

  // --- Tab Chung ---
  const enabledToggle = document.getElementById("enabledToggle");
  const apiUrlInput   = document.getElementById("apiUrl");
  const apiUrlHint    = document.getElementById("apiUrlHint");
  const whitelistInput = document.getElementById("whitelist");

  enabledToggle.checked = s.enabled;
  applyEnabled(s.enabled);
  apiUrlInput.value = s.apiUrl || "http://127.0.0.1:8000/predict";
  whitelistInput.value = Array.isArray(s.whitelist) ? s.whitelist.join(", ") : "";

  // Toggle bật/tắt
  enabledToggle.addEventListener("change", async () => {
    const enabled = enabledToggle.checked;
    await msg({ type: "SET_SETTINGS", payload: { enabled } });
    applyEnabled(enabled);
  });

  // Lưu API URL với kiểm tra schema
  document.getElementById("saveApiBtn").addEventListener("click", async () => {
    const url = apiUrlInput.value.trim();
    if (!url) { apiUrlHint.textContent = "URL không được để trống."; apiUrlHint.className = "field-hint error"; return; }
    const res = await msg({ type: "SET_SETTINGS", payload: { apiUrl: url } });
    if (!res?.ok) {
      apiUrlHint.textContent = res?.error || "URL không hợp lệ.";
      apiUrlHint.className = "field-hint error";
    } else {
      apiUrlHint.textContent = "";
      apiUrlHint.className = "field-hint";
      toast("✓ Đã lưu API URL");
    }
  });

  // Lưu whitelist
  document.getElementById("saveWhitelistBtn").addEventListener("click", async () => {
    const raw = whitelistInput.value.trim();
    const whitelist = raw ? raw.split(",").map(x => x.trim()).filter(Boolean) : [];
    await msg({ type: "SET_SETTINGS", payload: { whitelist } });
    toast("✓ Đã lưu whitelist");
  });

  // --- Tab Phát hiện ---
  document.getElementById("realtimeScan").checked = s.realtimeScan ?? true;
  document.getElementById("submitScan").checked   = s.submitScan   ?? true;

  document.getElementById("saveDetectionBtn").addEventListener("click", async () => {
    const realtimeScan = document.getElementById("realtimeScan").checked;
    const submitScan   = document.getElementById("submitScan").checked;
    await msg({ type: "SET_SETTINGS", payload: { realtimeScan, submitScan } });
    toast("✓ Đã lưu cài đặt phát hiện");
  });

  // --- Tab Kiểm tra ---
  document.getElementById("checkBtn").addEventListener("click", async () => {
    const text = document.getElementById("quickText").value.trim();
    if (!text) return;

    const btn = document.getElementById("checkBtn");
    btn.classList.add("loading");
    btn.textContent = "Đang phân tích…";

    const res = await msg({ type: "CHECK_TEXT", text });

    btn.classList.remove("loading");
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
      <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg> Phân tích`;

    if (!res?.ok) {
      applyResult("ERROR", res?.error || "API lỗi", "—");
    } else {
      applyResult(res.result.action || "—", res.result.label_name || "—", res.result.target_name || "—");
    }
  });
});