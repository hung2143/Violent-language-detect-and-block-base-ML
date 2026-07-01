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
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      resolve({ ok: false, error: "Không nhận được phản hồi kịp thời." });
    }, 5000);

    chrome.runtime.sendMessage(payload, (response) => {
      window.clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
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
    source: "popup-dom",
    enabled: true
  };
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

async function getStatsFromActiveTabDom() {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: "Thiếu quyền scripting để đọc thống kê trên tab hiện tại." };
  }

  const tab = await queryActiveTab();
  if (!tab?.id) return { ok: false, error: "Không tìm thấy tab hiện tại." };

  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, func: collectPageStatsFromDom },
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
}

function formatItemCount(value) {
  return `${value} mục`;
}

function updateCurrentPageStats(stats) {
  const badge = $("pageStatsBadge");
  const title = $("pageStatsTitle");
  const copy = $("pageStatsCopy");
  const blocked = $("blockedCommentCount");
  const warned = $("warnedCommentCount");
  const hardBlocked = $("hardBlockedCommentCount");

  if (!stats?.ok) {
    badge.textContent = "Chưa có dữ liệu";
    badge.classList.add("invalid");
    title.textContent = "Trang hiện tại";
    copy.textContent = stats?.error
      ? `Không đọc được thống kê: ${stats.error}`
      : "Mở một website có content script của Toxic Guard để xem số nội dung đã được chặn hoặc cảnh báo.";
    blocked.textContent = "0";
    warned.textContent = "0";
    hardBlocked.textContent = "0";
    return;
  }

  const commentStats = stats.commentStats || {};
  const cardStats = stats.cardStats || {};
  const pageBadgeStats = stats.pageBadgeStats || {};
  const blockedCount = (commentStats.blocked || 0) + (cardStats.blocked || 0) + (pageBadgeStats.blocked || 0);
  const warnCount = (commentStats.warn || 0) + (cardStats.warn || 0) + (pageBadgeStats.warn || 0);
  const hardCount = (commentStats.hardBlocked || 0) + (cardStats.hardBlocked || 0) + (pageBadgeStats.hardBlocked || 0);
  const totalCount = (commentStats.total || 0) + (cardStats.total || 0) + (pageBadgeStats.total || 0);

  badge.textContent = stats.enabled ? "Đang theo dõi" : "Đang tắt";
  badge.classList.toggle("invalid", !stats.enabled);
  title.textContent = stats.hostname || "Trang hiện tại";
  copy.textContent = totalCount > 0
    ? `Toxic Guard đã xử lý ${formatItemCount(totalCount)} trên trang này.`
    : "Chưa có nội dung nào bị chặn hoặc cảnh báo trên trang hiện tại.";
  blocked.textContent = String(blockedCount);
  warned.textContent = String(warnCount);
  hardBlocked.textContent = String(hardCount);
}

async function refreshCurrentPageStats() {
  const directStats = await getStatsFromActiveTabDom();
  if (directStats?.ok) {
    updateCurrentPageStats(directStats);
    return;
  }
  const backgroundStats = await msg({ type: "GET_ACTIVE_TAB_STATS" });
  updateCurrentPageStats(backgroundStats?.ok ? backgroundStats : directStats);
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
      if (tab.dataset.tab === "general") refreshCurrentPageStats();
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
  await refreshCurrentPageStats();
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
