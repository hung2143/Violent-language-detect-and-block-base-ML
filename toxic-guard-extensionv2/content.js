// Kiểm tra extension context còn hợp lệ không
function isChromeAlive() {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

function getStorage(keys) {
  return new Promise((resolve) => {
    if (!isChromeAlive()) { resolve({}); return; }
    try {
      chrome.storage.sync.get(keys, (data) => resolve(data || {}));
    } catch {
      resolve({});
    }
  });
}

const ToxicGuard = {
  observedInputs: new WeakSet(),
  debounceMap: new WeakMap(),
  overlayMap: new WeakMap(),
  pageOverlayMap: new Map(),
  _overlayRaf: null,
  _pageOverlayListenersAttached: false,
  _domScanTimer: null,
  _mutationDebounceTimer: null,   // debounce MutationObserver
  _apiUrl: "http://127.0.0.1:8000/predict",
  _enabled: true,
  _realtimeScan: true,
  _submitScan: true,
  _whitelist: [],

  async init() {
    // Load toàn bộ settings một lần duy nhất khi khởi động
    const data = await getStorage(["enabled", "apiUrl", "realtimeScan", "submitScan", "whitelist"]);
    this._enabled      = data.enabled      ?? true;
    this._apiUrl       = data.apiUrl       || "http://127.0.0.1:8000/predict";
    this._realtimeScan = data.realtimeScan ?? true;
    this._submitScan   = data.submitScan   ?? true;
    this._whitelist    = Array.isArray(data.whitelist) ? data.whitelist : [];

    // Whitelist: bỏ qua trang hiện tại nếu nằm trong whitelist
    if (this._whitelist.includes(location.hostname)) {
      console.log("[ToxicGuard] Whitelisted:", location.hostname);
      return;
    }

    // Lắng nghe thay đổi settings từ popup — không cần reload trang
    if (isChromeAlive()) {
      try {
        chrome.storage.onChanged.addListener((changes) => {
          if (changes.enabled)      this._enabled      = !!changes.enabled.newValue;
          if (changes.apiUrl)       this._apiUrl       = changes.apiUrl.newValue;
          if (changes.realtimeScan) this._realtimeScan = !!changes.realtimeScan.newValue;
          if (changes.submitScan)   this._submitScan   = !!changes.submitScan.newValue;
          if (changes.whitelist)    this._whitelist    = changes.whitelist.newValue || [];
        });
      } catch { /* ignore if context invalidated */ }
    }

    this.scanInputs();
    this.observeDOM();
    this.interceptForms();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.schedulePageScan(0));
    } else {
      this.schedulePageScan(0);
    }
    console.log("[ToxicGuard] Ready | enabled:", this._enabled, "| api:", this._apiUrl);
  },

  schedulePageScan(delay = 0) {
    clearTimeout(this._domScanTimer);
    this._domScanTimer = setTimeout(() => this.scanPageContent(), delay);
  },

  // ─── Gọi API trực tiếp, không qua service worker ───────────────────────────
  async callApi(text) {
    if (!this._enabled) return { ok: true, result: { action: "ALLOW", label_name: "DISABLED", target_name: "" } };

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000); // timeout 6s
    try {
      const response = await fetch(this._apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      return { ok: true, result };
    } catch (err) {
      clearTimeout(tid);
      return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
    }
  },

  // ─── Input field monitoring ────────────────────────────────────────────────
  scanInputs(root = document) {
    const sel = "textarea, input[type='text'], input[type='search'], [contenteditable='true'], [role='textbox']";
    root.querySelectorAll(sel).forEach((el) => this.attachToInput(el));
  },

  attachToInput(el) {
    if (this.observedInputs.has(el)) return;
    this.observedInputs.add(el);
    const handler = () => this.debounceCheck(el);
    el.addEventListener("input", handler);
    el.addEventListener("blur", handler);
    el.addEventListener("paste", () => setTimeout(() => this.debounceCheck(el), 50));
    this.ensureOverlay(el);
  },

  observeDOM() {
    const INPUT_SEL = "textarea, input[type='text'], input[type='search'], [contenteditable='true'], [role='textbox']";
    // Chỉ xử lý node thực sự mới — debounce 400ms để gộp nhiều mutation cùng lúc
    const pendingNodes = [];
    const observer = new MutationObserver((mutations) => {
      let hasPending = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          pendingNodes.push(node);
          hasPending = true;
        }
      }
      if (!hasPending) return;
      clearTimeout(this._mutationDebounceTimer);
      this._mutationDebounceTimer = setTimeout(() => {
        const nodes = pendingNodes.splice(0);
        for (const node of nodes) {
          try {
            if (node.matches(INPUT_SEL)) this.attachToInput(node);
            this.scanInputs(node);
          } catch { /* ignore detached nodes */ }
        }
        this.schedulePageScan(300);
      }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },

  interceptForms() {
    document.addEventListener("submit", async (e) => {
      // Bỏ qua nếu tắt scan khi submit
      if (!this._enabled || !this._submitScan) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const text = Array.from(
        form.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")
      ).map((el) => this.getElementText(el).trim()).filter(Boolean).join(" ");
      if (!text || text.length < 2) return;
      const r = await this.callApi(text);
      if (!r.ok) return;
      const action = r.result.action || "ALLOW";
      if (action === "BLOCK" || action === "AUTO_BLOCK") {
        e.preventDefault(); e.stopPropagation();
        this.showGlobalAlert(`Nội dung bị chặn (${action}). Vui lòng chỉnh sửa.`);
      } else if (action === "WARN") {
        if (!window.confirm("Nội dung có dấu hiệu xúc phạm. Tiếp tục gửi?")) {
          e.preventDefault(); e.stopPropagation();
        }
      }
    }, true);
  },

  getElementText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.innerText || el.textContent || "";
  },

  debounceCheck(el, delay = 400) {
    // Bỏ qua nếu tắt real-time scan
    if (!this._realtimeScan) return;
    const old = this.debounceMap.get(el);
    if (old) clearTimeout(old);
    this.debounceMap.set(el, setTimeout(async () => {
      const text = this.getElementText(el).trim();
      if (!text || text.length < 3) { this.updateOverlay(el, null); return; }
      const r = await this.callApi(text);
      this.updateOverlay(el, r.ok ? r.result : { action: "ERROR", label_name: "API_ERROR", target_name: "" });
    }, delay));
  },

  ensureOverlay(el) {
    if (this.overlayMap.has(el)) return;
    const div = document.createElement("div");
    div.className = "toxic-guard-badge hidden";
    div.innerHTML = `<div class="toxic-guard-badge-inner"><span class="tg-status"></span><span class="tg-meta"></span></div>`;
    document.body.appendChild(div);
    this.overlayMap.set(el, div);
    this.positionOverlay(el);
    window.addEventListener("scroll", () => this.positionOverlay(el), true);
    window.addEventListener("resize", () => this.positionOverlay(el));
  },

  positionOverlay(el) {
    const ov = this.overlayMap.get(el);
    if (!ov || !document.body.contains(el)) return;
    const r = el.getBoundingClientRect();
    ov.style.top = `${window.scrollY + r.top - 8}px`;
    ov.style.left = `${window.scrollX + r.right - 220}px`;
  },

  updateOverlay(el, result) {
    const ov = this.overlayMap.get(el);
    if (!ov) return;
    this.positionOverlay(el);
    if (!result) { ov.className = "toxic-guard-badge hidden"; return; }
    ov.className = "toxic-guard-badge";
    ov.classList.remove("allow", "warn", "block", "auto-block", "error");
    const action = result.action || "ALLOW";
    ov.classList.add({ ALLOW: "allow", WARN: "warn", BLOCK: "block", AUTO_BLOCK: "auto-block" }[action] || "error");
    ov.querySelector(".tg-status").textContent = action.replace("_", " ");
    ov.querySelector(".tg-meta").textContent = `${result.label_name || ""} | ${result.target_name || ""}`;
    el.classList.toggle("tg-input-blocked", action === "BLOCK" || action === "AUTO_BLOCK");
    el.classList.toggle("tg-input-warn", action === "WARN");
  },

  showGlobalAlert(msg) {
    let box = document.getElementById("toxic-guard-global-alert");
    if (!box) {
      box = document.createElement("div");
      box.id = "toxic-guard-global-alert";
      box.className = "toxic-guard-global-alert";
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add("show");
    setTimeout(() => box.classList.remove("show"), 3000);
  },

  ensurePageOverlayListeners() {
    if (this._pageOverlayListenersAttached) return;
    this._pageOverlayListenersAttached = true;
    const handler = () => this.schedulePageOverlayUpdate();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
  },

  schedulePageOverlayUpdate() {
    if (this._overlayRaf) return;
    this._overlayRaf = requestAnimationFrame(() => {
      this._overlayRaf = null;
      this.updatePageOverlays();
    });
  },

  updatePageOverlays() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const [el, entry] of this.pageOverlayMap.entries()) {
      if (!document.body.contains(el)) {
        entry.overlay.remove();
        entry.observer?.disconnect?.();
        this.pageOverlayMap.delete(el);
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        entry.overlay.style.display = "none";
        continue;
      }

      // Clamp overlay vào trong viewport để không tràn lên header hoặc ra ngoài màn hình
      const top    = Math.max(0, rect.top);
      const left   = Math.max(0, rect.left);
      const right  = Math.min(vw, rect.right);
      const bottom = Math.min(vh, rect.bottom);

      // Nếu phần visible quá nhỏ (< 10px) thì ẩn overlay
      if (right - left < 10 || bottom - top < 10) {
        entry.overlay.style.display = "none";
        continue;
      }

      entry.overlay.style.display = "flex";
      entry.overlay.style.top    = `${top}px`;
      entry.overlay.style.left   = `${left}px`;
      entry.overlay.style.width  = `${right - left}px`;
      entry.overlay.style.height = `${bottom - top}px`;
    }
  },

  // ─── Page content scan ────────────────────────────────────────────────────
  async scanPageContent(root = document.body) {
    if (!root || !this._enabled) return;

    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA",
      "BUTTON", "SELECT", "OPTION", "SVG", "HEAD", "META",
      "LINK", "CODE", "PRE", "IFRAME"
    ]);

    const candidates = [];
    const seen = new Set();

    // Tầng 1: Quét các container element phổ biến — lấy innerText đầy đủ
    // Ưu tiên các tag mang ý nghĩa (heading, paragraph, link, list item...)
    const CONTAINER_SEL = [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "li", "a", "td", "th", "blockquote",
      "[role='heading']", "[role='listitem']", "[role='link']",
      // Google Search specific
      ".VwiC3b", ".yXK7lf", ".MUxGbd", ".lyLwlc",
      "[data-snf]", "[data-ved] span", ".LC20lb",
      // Facebook, YouTube, Twitter comments/posts
      "[data-testid='tweetText']", "[data-testid='post-container']",
      ".comment-content", ".ytd-comment-renderer",
      // Spotify specific
      "[data-testid='track-item']",
      ".Track-container",
      ".track-item",
    ].join(",");

    try {
      root.querySelectorAll(CONTAINER_SEL).forEach((el) => {
        if (el.dataset.tgScanned || el.dataset.tgBlurred) return;
        // Skip if inside a blurred container
        if (el.closest("[data-tg-blurred='1']")) return;
        if (el.closest("#toxic-guard-global-alert, .toxic-guard-badge, .tg-page-badge, .tg-card-overlay, [data-tg-overlay], [data-tg-blur]")) return;
        if (SKIP_TAGS.has(el.tagName)) return;

        const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length < 4 || text.length > 400) return;
        if (!/[\p{L}]/u.test(text)) return;
        if (seen.has(text)) return;

        seen.add(text);
        el.dataset.tgScanned = "1";
        candidates.push({ el, text });
      });
    } catch { /* ignore selector errors */ }

    // Tầng 2: TreeWalker quét mọi text node còn sót (leaf nodes trong DOM)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (
          p.dataset.tgScanned ||
          p.dataset.tgBlurred ||
          p.closest("[data-tg-blurred='1']")
        ) return NodeFilter.FILTER_REJECT;
        if (p.closest("#toxic-guard-global-alert, .toxic-guard-badge, .tg-page-badge, .tg-card-overlay, [data-tg-overlay], [data-tg-blur]")) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = node.textContent.trim();
        if (text.length < 4 || text.length > 400) return NodeFilter.FILTER_REJECT;
        if (!/[\p{L}]/u.test(text)) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      // Skip if inside blurred container
      if (node.parentElement.closest("[data-tg-blurred='1']")) continue;
      
      const text = node.textContent.trim().replace(/\s+/g, " ");
      if (seen.has(text)) continue;
      seen.add(text);
      const el = node.parentElement;
      el.dataset.tgScanned = "1";
      candidates.push({ el, text });
    }

    console.log(`[ToxicGuard] ${candidates.length} candidates found`);
    // Sort candidates by size (larger first) to prioritize parent containers
    candidates.sort((a, b) => {
      const aSize = (a.el.offsetHeight || 0) * (a.el.offsetWidth || 0);
      const bSize = (b.el.offsetHeight || 0) * (b.el.offsetWidth || 0);
      return bSize - aSize;
    });
    // Chạy song song theo batch 8 requests
    const BATCH = 8;
    const items = candidates.slice(0, 100);
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      await Promise.all(batch.map(({ el, text }) => this.checkAndBlur(el, text)));
    }
  },

  async checkAndBlur(el, text) {
    // Skip nếu đã bị blur (check trước API call)
    if (el.closest("[data-tg-blurred='1']")) return;

    const r = await this.callApi(text);
    if (!r.ok) {
      console.warn(`[ToxicGuard] API error: "${text.slice(0, 40)}" | ${r.error}`);
      return;
    }
    const action = r.result?.action || "ALLOW";
    if (action !== "ALLOW") {
      // Re-check SAU API call — tránh race condition khi nhiều element cùng bài
      // được xử lý song song và cái kia đã blur container trước
      if (el.closest("[data-tg-blurred='1']")) return;

      const containerEl = this.findContainerToBlur(el);

      // Double-check container và ancestors của nó
      if (containerEl.dataset.tgBlurred || containerEl.closest("[data-tg-blurred='1']")) return;

      console.log(`[ToxicGuard] BLUR → "${text.slice(0, 50)}" | ${action}`);
      this.blurElement(containerEl, r.result);
      containerEl.dataset.tgScanned = "1";
    }
  },

  // Thu hẹp container về phần nội dung riêng của nó (không bao gồm replies/nested items)
  // Dùng khi container như shreddit-comment chứa nested shreddit-comment (replies)
  _narrowToOwnContent(container, targetEl) {
    const tag = (container.tagName || "").toLowerCase();
    // Kiểm tra xem container có chứa nested element cùng loại không (e.g., replies)
    const hasNestedSameType = !!container.querySelector(tag);
    if (!hasNestedSameType) return container; // Không có nested → dùng nguyên

    // Tìm direct child chứa targetEl NHƯNG không chứa nested cùng loại
    // → đây là phần "own content" (header + text + actions), không phải replies
    for (const child of Array.from(container.children)) {
      if (!child.contains(targetEl)) continue;
      if (child.querySelector(tag)) continue; // child này chứa nested → bỏ qua
      const r = child.getBoundingClientRect();
      if (r.width > 50 && r.height > 20) return child;
    }

    // Không tìm được child phù hợp → trả về container gốc
    // (an toàn hơn là pick child sai vị trí → gây overlay floating ở chỗ lạ)
    return container;
  },

  findContainerToBlur(el) {
    const CONTAINER_SELECTORS = [
      "shreddit-post",
      "shreddit-comment",
      // Reddit (old)
      "[data-testid='post-container']",
      // Twitter / X
      "[data-testid='tweet']",
      "[data-testid='cellInnerDiv']",
      // Spotify
      "[data-testid='track-item']",
      // YouTube
      "ytd-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-rich-item-renderer",
      "ytd-grid-video-renderer",
      "ytd-rich-grid-media",
      "ytd-playlist-renderer",
      "ytd-compact-playlist-renderer",
      // Generic
      "article",
      ".post",
      ".card",
      ".item",
      ".track-item",
      ".Track-container",
      "[role='article']",
      ".comment-container",
      ".comment",
      ".ytd-comment-renderer",
      "[data-ved]",
      ".MUxGbd",
      ".g",
    ];

    // Các selector dùng để nhận diện container là LIST/FEED chứa nhiều thẻ
    const LIST_SELECTORS = [
      "ul", "ol",
      "[role='feed']", "[role='list']", "[role='main']",
      "[data-testid='primaryColumn']",
      "#stream-items-id", ".stream",
      "ytd-section-list-renderer", "ytd-item-section-renderer",
      "ytd-rich-grid-renderer",
    ];

    const MAX_DEPTH = 10; // Giảm xuống để không leo quá cao

    const getParentForScan = (node) => {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode?.();
      if (root && root.host) return root.host;
      return null;
    };

    const isReasonableContainer = (node) => {
      const rect = node.getBoundingClientRect();
      const w = rect.width || 0;
      const h = rect.height || 0;
      if (w < 80 || h < 40) return false;
      const area = w * h;
      const viewportArea = window.innerWidth * window.innerHeight;
      // Không chọn container chiếm quá 60% viewport (có thể là feed)
      if (viewportArea > 0 && area > viewportArea * 0.6) return false;
      return true;
    };

    const isBlockContainer = (node) => {
      const tag = node.tagName || "";
      if (tag.includes("-")) return true; // custom elements (e.g., YTD-*)
      return ["DIV", "SECTION", "LI", "ARTICLE", "ASIDE"].includes(tag);
    };

    const hasMedia = (node) => !!node.querySelector(
      "img, video, picture, canvas, [role='img'], ytd-thumbnail, yt-img-shadow, yt-image, #thumbnail, [id='thumbnail']"
    );

    // Kiểm tra node có phải là list/feed chứa nhiều card không
    const isListContainer = (node) => {
      const tag = (node.tagName || "").toUpperCase();
      if (["UL", "OL"].includes(tag)) return true;
      for (const sel of LIST_SELECTORS) {
        try { if (node.matches && node.matches(sel)) return true; } catch { /* */ }
      }
      // Heuristic: tăng lên 6 vì card như shreddit-post có 5 block children
      // mà vẫn không phải list
      const blockChildren = Array.from(node.children || []).filter(c => {
        const t = (c.tagName || "").toUpperCase();
        return ["DIV", "LI", "ARTICLE", "SECTION"].includes(t);
      });
      return blockChildren.length >= 6;
    };

    const ancestors = [];
    let current = el;
    for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
      ancestors.push(current);
      if (current === document.body || current === document.documentElement) break;
      current = getParentForScan(current);
    }

    // Ưu tiên 1: explicit card/post selectors (closest match)
    // Với comment-type container (có nested cùng tag) → thu hẹp về phần content riêng
    for (const node of ancestors) {
      if (!node || node === document.body || node === document.documentElement) break;
      for (const sel of CONTAINER_SELECTORS) {
        try {
          if (node.matches && node.matches(sel)) {
            return this._narrowToOwnContent(node, el);
          }
        } catch { /* */ }
      }
    }

    // Ưu tiên 2: container nhỏ nhất (closest ancestor) có cả media lẫn text,
    // và KHÔNG phải là list/feed
    let candidateMedia = null;
    let candidateFallback = null;

    for (const node of ancestors) {
      if (!node || node === document.body || node === document.documentElement) break;

      // Dừng ngay nếu node này là list/feed container
      if (isListContainer(node)) break;

      if (!candidateMedia && isReasonableContainer(node) && hasMedia(node) && isBlockContainer(node)) {
        candidateMedia = node;
        // Lấy ngay closest — không leo thêm
        break;
      }
      if (!candidateFallback && isReasonableContainer(node) && isBlockContainer(node)) {
        candidateFallback = node;
      }
    }

    let found = candidateMedia || candidateFallback || el;

    // Bubble-up: nếu parent của found có 2-4 block children (dấu hiệu card: header+body+footer)
    // và không phải list → đây là container thực sự của card, dùng nó để đảm bảo
    // title và body text trong cùng bài luôn resolve về cùng một element
    if (found !== el) {
      const parent = found.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        const blockKids = Array.from(parent.children || []).filter(c => {
          const t = (c.tagName || "").toUpperCase();
          return ["DIV", "LI", "ARTICLE", "SECTION", "HEADER", "MAIN"].includes(t);
        });
        // 2-5 block children → có thể là card (header+body hoặc header+body+footer...)
        if (blockKids.length >= 2 && blockKids.length <= 5) {
          const pr = parent.getBoundingClientRect();
          const pa = (pr.width || 0) * (pr.height || 0);
          const va = window.innerWidth * window.innerHeight;
          // Parent không quá lớn và không phải list
          if (pa > 0 && pa <= va * 0.6 && !isListContainer(parent)) {
            found = parent;
          }
        }
      }
    }

    return found;
  },

  blurElement(el, result) {
    if (el.dataset.tgBlurred) return;
    el.dataset.tgBlurred = "1";

    // Mark all children and self as scanned to prevent re-scanning them
    el.dataset.tgScanned = "1";
    el.querySelectorAll("*").forEach(child => {
      child.dataset.tgScanned = "1";
      child.dataset.tgBlurred = "1";
    });

    const action = result.action || "BLOCK";
    const label = result.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    // Hard block for HATE (AUTO_BLOCK) or if label is HATE
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";

    // Đảm bảo container có position để overlay con có thể position: absolute theo nó
    // Nhưng ở đây overlay dùng fixed nên không cần thay đổi container
    // Apply blur + ẩn pointer events trên container (bao gồm ảnh, video bên trong)
    el.style.filter = "blur(8px)";
    el.style.pointerEvents = "none";
    el.style.userSelect = "none";
    el.style.transition = "filter 0.3s ease";
    el.style.cursor = "default";
    el.setAttribute("data-tg-blur", action);
    el.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");

    // Create overlay only once per container
    if (this.pageOverlayMap.has(el)) return;

    const overlay = document.createElement("div");
    overlay.className = `tg-card-overlay tg-card-overlay-${actionClass}`;
    overlay.setAttribute("data-tg-overlay", "1");

    const labelEl = document.createElement("span");
    labelEl.className = "tg-card-label";
    labelEl.textContent = isHardBlock ? `${label} (BLOCKED)` : label;
    overlay.appendChild(labelEl);

    // Hard block: overlay không cho click xuyên qua
    // Non-hard: overlay trong suốt để user có thể click hiện lại
    overlay.style.pointerEvents = isHardBlock ? "none" : "auto";

    // Append vào body — overlay dùng position: fixed
    document.body.appendChild(overlay);

    // Đặt vị trí ngay lập tức theo viewport rect
    const rect = el.getBoundingClientRect();
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.display = "flex";

    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => this.schedulePageOverlayUpdate());
      observer.observe(el);
    }

    this.pageOverlayMap.set(el, { overlay, observer });
    this.ensurePageOverlayListeners();
    this.schedulePageOverlayUpdate();

    // Only allow revealing for OFFENSIVE content, not for HATE
    if (!isHardBlock) {
      const unblur = (evt) => {
        try {
          if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
          }
          el.style.filter = "";
          el.style.pointerEvents = "";
          el.style.userSelect = "";
          el.style.cursor = "";
          el.removeAttribute("data-tg-blur");
          el.removeAttribute("data-tg-blurred");
          el.removeAttribute("data-tg-hard-block");
          const entry = this.pageOverlayMap.get(el);
          if (entry?.overlay) entry.overlay.remove();
          entry?.observer?.disconnect?.();
          this.pageOverlayMap.delete(el);
        } catch { /* ignore */ }
      };

      overlay.addEventListener("click", unblur, { once: true, capture: true });
    }
  }
};

ToxicGuard.init();
