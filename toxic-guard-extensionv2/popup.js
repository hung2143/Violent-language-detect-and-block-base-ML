const CHECK_BUTTON_HTML = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7.5" stroke="currentColor" stroke-width="2"></circle>
    <path d="M20 20L16.8 16.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
  </svg>
  <span>Phân tích</span>
`;

const ACTION_META = {
  ALLOW: { box: "result-allow", badge: "badge-allow", badgeText: "An toàn", title: "Có thể tiếp tục sử dụng nội dung này." },
  WARN: { box: "result-warn", badge: "badge-warn", badgeText: "Cảnh báo", title: "Nội dung có dấu hiệu nhạy cảm, nên xem lại trước khi dùng." },
  BLOCK: { box: "result-block", badge: "badge-block", badgeText: "Độc hại", title: "Nội dung bị xem là độc hại và nên được chỉnh sửa." },
  AUTO_BLOCK: { box: "result-block", badge: "badge-auto-block", badgeText: "Tự chặn", title: "Nội dung vượt ngưỡng và sẽ bị chặn tự động." },
  ERROR: { box: "result-error", badge: "badge-error", badgeText: "Lỗi", title: "Không thể lấy kết quả từ API ở thời điểm hiện tại." }
};

function msg(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

function $(id) {
  return document.getElementById(id);
}

function toast(text, ok = true) {
  const el = $("saveToast");
  el.textContent = text;
  el.style.background = ok ? "#166534" : "#b91c1c";
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 1800);
}

function cap(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseWhitelist(rawValue) {
  return rawValue
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatWhitelistCount(value) {
  return `${value} website`;
}

function formatApiHost(url) {
  if (!url) return "Chưa cấu hình";
  try {
    new URL(url);
    return "Sẵn sàng";
  } catch {
    return "Cần kiểm tra";
  }
}

function updateApiSummary(url) {
  const status = formatApiHost(url);
  const isValid = status === "Sẵn sàng";
  const stateCard = $("apiStateText").closest(".overview-card");
  const stateDot = $("apiStateDot");
  const stateLabel = $("apiStateLabel");

  stateLabel.textContent = status;
  stateCard.classList.toggle("api-ready", isValid);
  stateCard.classList.toggle("api-warning", !isValid);
  stateDot.classList.toggle("live", isValid);
  stateDot.classList.toggle("warn", !isValid);
  $("apiHealthBadge").textContent = status;
  $("apiHealthBadge").classList.toggle("invalid", !isValid);
}

function updateWhitelistSummary(rawValue) {
  const whitelist = parseWhitelist(rawValue);
  const label = formatWhitelistCount(whitelist.length);
  $("whitelistCountText").textContent = label;
  $("whitelistCountInline").textContent = label;
}

function updateDetectionSummary(realtimeScan, submitScan) {
  const enabledCount = [realtimeScan, submitScan].filter(Boolean).length;
  $("modeCountText").textContent = `${enabledCount}/2 bật`;

  let text = "Chưa bật lớp bảo vệ nào.";
  if (realtimeScan && submitScan) {
    text = "Đang dùng đầy đủ cả hai lớp bảo vệ.";
  } else if (realtimeScan) {
    text = "Đang chỉ quét trong lúc nhập nội dung.";
  } else if (submitScan) {
    text = "Đang chỉ kiểm tra trước khi gửi form.";
  }

  $("detectionSummaryText").textContent = text;
}

function applyEnabled(enabled) {
  const statusText = $("statusText");
  const statusBarText = $("statusBarText");

  statusText.textContent = enabled ? "Đang bật" : "Đang tắt";
  statusText.className = enabled ? "status-pill" : "status-pill off";
  statusBarText.textContent = enabled
    ? "Extension đang hoạt động và sẽ quét nội dung theo cấu hình hiện tại."
    : "Extension đang tắt. Mọi thao tác quét và chặn sẽ tạm dừng.";
}

function applyResult(action, label, target) {
  const box = $("resultBox");
  const badge = $("resultBadge");
  const actionEl = $("resultAction");
  const labelEl = $("resultLabel");
  const targetEl = $("resultTarget");
  const empty = $("resultEmpty");
  const content = $("resultContent");

  const meta = ACTION_META[action] || ACTION_META.ERROR;

  box.className = "result-box";
  badge.className = "result-badge";
  box.classList.add(meta.box);
  badge.classList.add(meta.badge);

  badge.textContent = meta.badgeText;
  actionEl.textContent = meta.title;
  labelEl.textContent = label || "-";
  targetEl.textContent = target || "-";

  empty.style.display = "none";
  content.classList.remove("hidden");
}

function fillWhitelist(whitelist) {
  $("whitelist").value = Array.isArray(whitelist) ? whitelist.join("\n") : "";
  updateWhitelistSummary($("whitelist").value);
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.remove("active");
        button.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      $(`panel${cap(tab.dataset.tab)}`).classList.add("active");
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  initTabs();

  const settings = await msg({ type: "GET_SETTINGS" });

  const enabledToggle = $("enabledToggle");
  const realtimeScanInput = $("realtimeScan");
  const submitScanInput = $("submitScan");
  const whitelistInput = $("whitelist");
  const quickTextInput = $("quickText");
  const checkBtn = $("checkBtn");

  enabledToggle.checked = settings.enabled;
  realtimeScanInput.checked = settings.realtimeScan ?? true;
  submitScanInput.checked = settings.submitScan ?? true;
  fillWhitelist(settings.whitelist);

  applyEnabled(settings.enabled);
  updateApiSummary(settings.apiUrl || "");
  updateDetectionSummary(realtimeScanInput.checked, submitScanInput.checked);
  $("quickTextCount").textContent = `${quickTextInput.value.length} ký tự`;

  enabledToggle.addEventListener("change", async () => {
    const enabled = enabledToggle.checked;
    await msg({ type: "SET_SETTINGS", payload: { enabled } });
    applyEnabled(enabled);
    toast(enabled ? "Đã bật bảo vệ" : "Đã tắt bảo vệ");
  });

  realtimeScanInput.addEventListener("change", () => {
    updateDetectionSummary(realtimeScanInput.checked, submitScanInput.checked);
  });

  submitScanInput.addEventListener("change", () => {
    updateDetectionSummary(realtimeScanInput.checked, submitScanInput.checked);
  });

  whitelistInput.addEventListener("input", () => {
    updateWhitelistSummary(whitelistInput.value);
  });

  quickTextInput.addEventListener("input", () => {
    $("quickTextCount").textContent = `${quickTextInput.value.length} ký tự`;
  });

  $("resetWhitelistBtn").addEventListener("click", async () => {
    const currentSettings = await msg({ type: "GET_SETTINGS" });
    fillWhitelist(currentSettings.whitelist);
    toast("Đã khôi phục nội dung đang lưu");
  });

  $("saveWhitelistBtn").addEventListener("click", async () => {
    const whitelist = parseWhitelist(whitelistInput.value);
    await msg({ type: "SET_SETTINGS", payload: { whitelist } });
    fillWhitelist(whitelist);
    toast("Đã cập nhật whitelist");
  });

  $("saveDetectionBtn").addEventListener("click", async () => {
    const realtimeScan = realtimeScanInput.checked;
    const submitScan = submitScanInput.checked;
    await msg({ type: "SET_SETTINGS", payload: { realtimeScan, submitScan } });
    updateDetectionSummary(realtimeScan, submitScan);
    toast("Đã lưu cấu hình phát hiện");
  });

  checkBtn.addEventListener("click", async () => {
    const text = quickTextInput.value.trim();
    if (!text) {
      toast("Nhập nội dung trước khi phân tích", false);
      return;
    }

    checkBtn.classList.add("loading");
    checkBtn.innerHTML = "<span>Đang phân tích...</span>";

    const result = await msg({ type: "CHECK_TEXT", text });

    checkBtn.classList.remove("loading");
    checkBtn.innerHTML = CHECK_BUTTON_HTML;

    if (!result?.ok) {
      applyResult("ERROR", result?.error || "API lỗi", "-");
      return;
    }

    applyResult(
      result.result.action || "ERROR",
      result.result.label_name || "-",
      result.result.target_name || "-"
    );
  });
});
