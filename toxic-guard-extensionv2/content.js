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
  _instanceId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  observedInputs: new WeakSet(),
  debounceMap: new WeakMap(),
  overlayMap: new WeakMap(),
  pageOverlayMap: new Map(),
  pageOverlayRootMap: new WeakMap(),
  pageOverlayElementMap: new WeakMap(),
  apiCache: new Map(),
  _apiCacheTtlMs: 30000,
  // Track các "semantic root" container (shreddit-comment, article, tweet...)
  // đã được blur để tránh tạo nhiều overlay cho cùng một comment
  blurredRoots: new WeakSet(),
  // Track các root đã được scan (bất kể kết quả ALLOW/BLOCK) — để ngăn
  // các text fragment từ cùng comment gửi API riêng lẻ ở batch sau
  scannedRoots: new WeakSet(),
  // Track các root đang được xử lý async (chưa có kết quả API) — để block các request
  // song song khác trong cùng comment khỏi gửi API dư thừa
  processingRoots: new Set(),
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
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.tgActiveInstance = this._instanceId;
    }
    this.cleanupStalePageState();

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
          if (changes.apiUrl) {
            this._apiUrl = changes.apiUrl.newValue;
            this.apiCache.clear();
          }
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

  cleanupStalePageState() {
    document.querySelectorAll(".tg-card-overlay, .tg-page-badge, .tg-blur-overlay, .toxic-guard-badge, .tg-reddit-comment-card, .tg-reddit-comment-badge-row, .tg-comment-badge-row").forEach((el) => {
      el.remove();
    });

    // Xóa wrapper divs do extension TẠO RA — chỉ unwrap DIV có data-tg-overlay
    // Với native elements (details, summary v.v.), chỉ xóa class, không unwrap
    document.querySelectorAll(".tg-reddit-comment-block, .tg-comment-block").forEach((el) => {
      const isExtensionDiv = el.tagName === "DIV" && el.dataset.tgOverlay;
      if (isExtensionDiv) {
        const parent = el.parentElement;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
      } else {
        // Native element: chỉ xóa class
        el.classList.remove(
          "tg-reddit-comment-block", "tg-reddit-comment-block-block",
          "tg-reddit-comment-block-auto-block", "tg-reddit-comment-block-warn",
          "tg-reddit-comment-hard-block",
          "tg-comment-block", "tg-comment-block-block",
          "tg-comment-block-auto-block", "tg-comment-block-warn",
          "tg-comment-hard-block"
        );
        delete el.dataset.tgOverlay;
      }
    });


    document.querySelectorAll("[data-tg-blur], [data-tg-blurred], [data-tg-hard-block]").forEach((el) => {
      el.style.filter = "";
      el.style.pointerEvents = "";
      el.style.userSelect = "";
      el.style.cursor = "";
      el.removeAttribute("data-tg-blur");
      el.removeAttribute("data-tg-blurred");
      el.removeAttribute("data-tg-hard-block");
      el.classList.remove("tg-reddit-identity-blur");
    });
  },

  schedulePageScan(delay = 0) {
    clearTimeout(this._domScanTimer);
    this._domScanTimer = setTimeout(() => this.scanPageContent(), delay);
  },

  // ─── Gọi API trực tiếp, không qua service worker ───────────────────────────
  _normalizeContentText(text) {
    return String(text || "").trim().replace(/\s+/g, " ");
  },

  _isCurrentInstance() {
    const activeId = document.documentElement?.dataset?.tgActiveInstance;
    return !activeId || activeId === this._instanceId;
  },

  async callApi(text, { bypassCache = false } = {}) {
    if (!this._enabled) return { ok: true, result: { action: "ALLOW", label_name: "DISABLED", target_name: "" } };

    const cacheKey = this._normalizeContentText(text).slice(0, 500);
    const cached = this.apiCache.get(cacheKey);
    if (!bypassCache && cached?.expiresAt > Date.now()) {
      return { ...cached.value, fromCache: true };
    }
    if (cached) this.apiCache.delete(cacheKey);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000); // timeout 6s
    try {
      const response = await fetch(this._apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const value = { ok: true, result, fromCache: false };
      this.apiCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + this._apiCacheTtlMs
      });
      if (this.apiCache.size > 300) this.apiCache.delete(this.apiCache.keys().next().value);
      return value;
    } catch (err) {
      clearTimeout(tid);
      return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message, fromCache: false };
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
      if (!this._isCurrentInstance()) return;
      let hasPending = false;
      for (const m of mutations) {
        if (m.type === "characterData" || m.type === "attributes") {
          hasPending = true;
        }
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
        this.reconcileBlurState();
        this.reanchorGenericCommentBlocks();
        this.schedulePageScan(300);
      }, 400);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "href", "src", "aria-label", "datetime"]
    });
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
    if (this._pageOverlayListenersAttached || typeof window === "undefined") return;
    this._pageOverlayListenersAttached = true;
    const scrollHandler = () => this.schedulePageOverlayUpdate("scroll");
    const layoutHandler = () => this.schedulePageOverlayUpdate("layout");
    window.addEventListener("scroll", scrollHandler, true);
    window.addEventListener("resize", layoutHandler);
  },

  schedulePageOverlayUpdate(reason = "layout") {
    if (reason !== "scroll" || !this._overlayUpdateReason) {
      this._overlayUpdateReason = reason;
    }
    if (this._overlayRaf || typeof requestAnimationFrame === "undefined") return;
    this._overlayRaf = requestAnimationFrame(() => {
      const updateReason = this._overlayUpdateReason || "layout";
      this._overlayUpdateReason = null;
      this._overlayRaf = null;
      this.updatePageOverlays(updateReason);
    });
  },

  updatePageOverlays(reason = "layout") {
    const isScrollUpdate = reason === "scroll";
    this._reconcilePageOverlaySources();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrollX = window.scrollX ?? window.pageXOffset ?? document.documentElement?.scrollLeft ?? document.body?.scrollLeft ?? 0;
    const scrollY = window.scrollY ?? window.pageYOffset ?? document.documentElement?.scrollTop ?? document.body?.scrollTop ?? 0;

    // Detect chiều cao header cố định (sticky/fixed) — tránh overlay đè lên header
    // Tìm header/nav có position fixed hoặc sticky ở đầu trang
    let headerHeight = 0;
    try {
      const headerCandidates = document.querySelectorAll("header, nav, [role='banner']");
      for (const hdr of headerCandidates) {
        const cs = getComputedStyle(hdr);
        if (cs.position === "fixed" || cs.position === "sticky") {
          const hRect = hdr.getBoundingClientRect();
          // Chỉ tính header ở TOP (top gần 0)
          if (hRect.top >= -5 && hRect.top <= 10) {
            headerHeight = Math.max(headerHeight, hRect.bottom);
          }
        }
      }
    } catch { /* ignore */ }
    // Fallback: nếu không detect được, dùng 56px (Reddit default header)
    if (headerHeight <= 0) headerHeight = 56;

    for (const [el, entry] of this.pageOverlayMap.entries()) {
      const isDocumentPositioned = entry.positionMode === "document";
      if (!document.body.contains(el)) {
        this._removePageOverlayEntry(entry, true);
        if (entry.rootEl?.matches?.("shreddit-comment")) {
          this._resetRedditRootScan(entry.rootEl, this._findRedditCommentBody(entry.rootEl));
        }
        continue;
      }

      if (
        entry.rootEl?.matches?.("shreddit-comment") &&
        !this._isRedditCommentPainted(entry.rootEl, el)
      ) {
        this._removePageOverlayEntry(entry, true);
        this._resetRedditRootScan(entry.rootEl, this._findRedditCommentBody(entry.rootEl));
        continue;
      }

      let rect;
      if (isDocumentPositioned && isScrollUpdate && entry.documentRect) {
        const docRect = entry.documentRect;
        rect = {
          top: docRect.top - scrollY,
          left: docRect.left - scrollX,
          right: docRect.right - scrollX,
          bottom: docRect.bottom - scrollY,
          width: docRect.width,
          height: docRect.height
        };
      } else {
        rect = el.getBoundingClientRect();
        if (Array.isArray(entry.anchorEls) && entry.anchorEls.length) {
          const anchorRects = entry.anchorEls
            .filter((anchor) => document.body.contains(anchor))
            .map((anchor) => anchor.getBoundingClientRect())
            .filter((anchorRect) => anchorRect.width > 0 && anchorRect.height > 0);
          if (!anchorRects.length) {
            entry.overlay.style.display = "none";
            continue;
          }
          const padding = Number(entry.overlayPadding) || 0;
          const top = Math.min(...anchorRects.map((anchorRect) => anchorRect.top)) - padding;
          const left = Math.min(...anchorRects.map((anchorRect) => anchorRect.left)) - padding;
          const right = Math.max(...anchorRects.map((anchorRect) => anchorRect.right)) + padding;
          const bottom = Math.max(...anchorRects.map((anchorRect) => anchorRect.bottom)) + padding;
          rect = { top, left, right, bottom, width: right - left, height: bottom - top };
        }
        if (isDocumentPositioned && rect.width > 0 && rect.height > 0) {
          const docTop = rect.top + scrollY;
          const docLeft = rect.left + scrollX;
          entry.documentRect = {
            top: docTop,
            left: docLeft,
            right: docLeft + rect.width,
            bottom: docTop + rect.height,
            width: rect.width,
            height: rect.height
          };
        }
      }
      if (rect.width === 0 || rect.height === 0) {
        entry.overlay.style.display = "none";
        continue;
      }

      // Nếu element nằm HOÀN TOÀN ngoài viewport → ẩn overlay
      if (rect.bottom <= headerHeight || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
        entry.overlay.style.display = "none";
        continue;
      }

      // Clamp overlay: top không nhỏ hơn headerHeight để tránh đè lên header
      const visibleTop = Math.max(headerHeight, rect.top);
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(vw, rect.right);
      const visibleBottom = Math.min(vh, rect.bottom);

      // Nếu phần visible quá nhỏ (< 10px) thì ẩn overlay
      if (visibleRight - visibleLeft < 10 || visibleBottom - visibleTop < 10) {
        entry.overlay.style.display = "none";
        continue;
      }

      entry.overlay.style.display = "flex";
      if (isDocumentPositioned) {
        const docRect = entry.documentRect || {
          top: rect.top + scrollY,
          left: rect.left + scrollX,
          width: rect.width,
          height: rect.height
        };
        entry.overlay.style.top = `${docRect.top}px`;
        entry.overlay.style.left = `${docRect.left}px`;
        entry.overlay.style.width = `${docRect.width}px`;
        entry.overlay.style.height = `${docRect.height}px`;

        const clipTop = Math.max(0, visibleTop - rect.top);
        const clipRight = Math.max(0, rect.right - visibleRight);
        const clipBottom = Math.max(0, rect.bottom - visibleBottom);
        const clipLeft = Math.max(0, visibleLeft - rect.left);
        entry.overlay.style.clipPath =
          clipTop || clipRight || clipBottom || clipLeft
            ? `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`
            : "";
        continue;
      }

      // Clamp fixed overlays under sticky headers and within the viewport.
      entry.overlay.style.clipPath = "";
      entry.overlay.style.top    = `${visibleTop}px`;
      entry.overlay.style.left   = `${visibleLeft}px`;
      entry.overlay.style.width  = `${visibleRight - visibleLeft}px`;
      entry.overlay.style.height = `${visibleBottom - visibleTop}px`;
    }
  },

  // ─── Page content scan ────────────────────────────────────────────────────
  async scanPageContent(root = document.body) {
    if (!root || !this._enabled) return;
    this.reconcileBlurState();

    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA",
      "BUTTON", "SELECT", "OPTION", "SVG", "HEAD", "META",
      "LINK", "CODE", "PRE", "IFRAME"
    ]);

    // Selector để loại trừ vùng navigation/sidebar/header — không quét các vùng này
    // Việc blur sidebar gây ra badge hiển thị sai vị trí (góc trái màn hình)
    const EXCLUDED_ZONE_SELECTORS = [
      // Reddit specific (standard DOM)
      "#left-sidebar", "[data-scroller-first]", "aside",
      // Reddit Web Components (có thể là shadow host)
      "left-sidebar", "faceplate-screen-reader-content",
      "screen-reader-alert-outlet", "shreddit-async-loader:not(shreddit-comment shreddit-async-loader)",
      // HTML semantics
      "header", "nav", "footer",
      "[role='navigation']", "[role='banner']", "[role='complementary']",
      "[aria-live]", // Screen reader live regions
      // Reddit sidebar/subreddit info
      ".sidebar", "#right-sidebar-container", "#secondary-content",
      // Reddit comment/post metadata and flair, not user-generated body text
      "[slot='commentMeta']", "[slot='commentAuthor']", "[slot='commentAvatar']",
      "[slot='authorFlair']", "[slot='postMeta']", "[slot='credit-bar']",
      "[slot='actionRow']", "[slot='comment-actions']",
      "shreddit-comment-action-row", "faceplate-tracker[noun='comment_author']",
      "[data-testid='comment_author_link']", "[data-testid='user-flair']",
      // Extension own elements
      "#toxic-guard-global-alert", ".toxic-guard-badge", ".tg-page-badge",
      ".tg-card-overlay", "[data-tg-overlay]",
    ].join(",");

    // Traverse DOM bao gồm cả Shadow DOM boundary để kiểm tra ancestors
    const isInExcludedZone = (el) => {
      // Bước 1: Selector-based (standard DOM)
      try {
        if (el.closest(EXCLUDED_ZONE_SELECTORS)) return true;
      } catch { /* ignore */ }

      // Bước 2: Shadow DOM traversal — leo qua shadow boundary bằng getRootNode().host
      let node = el;
      for (let depth = 0; depth < 20 && node; depth++) {
        const root = node.getRootNode?.();
        if (root && root !== document && root.host) {
          // node nằm trong shadow DOM → kiểm tra host
          const host = root.host;
          const hostTag = (host.tagName || "").toLowerCase();
          // Các custom element Reddit là phần sidebar/screen-reader
          if (
            hostTag === "left-sidebar" ||
            hostTag === "faceplate-screen-reader-content" ||
            hostTag === "screen-reader-alert-outlet" ||
            host.getAttribute("aria-live") !== null ||
            host.matches?.("[role='navigation'],[role='banner'],[role='complementary']")
          ) return true;
          node = host; // Leo lên tiếp
        } else {
          break;
        }
      }

      // Bước 3: Position-based heuristic
      // Element có bounding rect nằm hoàn toàn trong vùng sidebar trái (left < 270px)
      // VÀ không nằm trong shreddit-comment/shreddit-post → khả năng là sidebar
      try {
        const rect = el.getBoundingClientRect();
        const isInLeftSidebar = rect.right <= 270 && rect.width > 0;
        const isInComment = !!el.closest?.("shreddit-comment, shreddit-post, [data-testid='post-container']");
        if (isInLeftSidebar && !isInComment) return true;

        // Phần tử có kích thước cực nhỏ (dùng cho screen reader) — visually hidden
        const isVisuallyHidden =
          (rect.width === 0 || rect.height === 0) ||
          (rect.width <= 1 || rect.height <= 1);
        if (isVisuallyHidden) return true;
      } catch { /* ignore */ }

      return false;
    };

    const candidates = [];
    const seen = new Set();
    const seenSemanticRoots = new WeakSet();

    try {
      root.querySelectorAll("shreddit-comment").forEach((commentEl) => {
        if (commentEl.dataset.tgScanned || commentEl.dataset.tgBlurred) return;
        if (commentEl.closest("[data-tg-blurred='1'], [data-tg-blur]")) return;
        if (isInExcludedZone(commentEl)) return;

        const bodyEl = this._findRedditCommentBody(commentEl);
        if (!bodyEl || bodyEl.dataset.tgScanned || bodyEl.dataset.tgBlurred) return;
        if (!this._isRedditCommentPainted(commentEl, bodyEl)) return;

        const text = (bodyEl.innerText || bodyEl.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length < 4 || text.length > 400) return;
        if (!/[\p{L}]/u.test(text)) return;
        if (seen.has(text) || seenSemanticRoots.has(commentEl)) return;

        seen.add(text);
        seenSemanticRoots.add(commentEl);
        bodyEl.dataset.tgScanned = "1";
        bodyEl.querySelectorAll("*").forEach(child => { child.dataset.tgScanned = "1"; });
        candidates.push({ el: bodyEl, text });
      });
    } catch { /* ignore reddit selector errors */ }

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
        if (this._findComposedAncestor(el, "shreddit-comment")) return;
        // Skip if inside a blurred container
        if (el.closest("[data-tg-blurred='1']")) return;
        if (el.closest("[data-tg-blur]")) return;
        if (SKIP_TAGS.has(el.tagName)) return;
        // === FIX: Bỏ qua vùng navigation/sidebar/header ===
        if (isInExcludedZone(el)) return;

        const rawText = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        const normalized = this._normalizePageCandidate(el, rawText);
        if (!normalized) return;
        const { el: scanEl, text, semanticRoot } = normalized;

        if (text.length < 4 || text.length > 400) return;
        if (!/[\p{L}]/u.test(text)) return;
        if (semanticRoot && seenSemanticRoots.has(semanticRoot)) return;
        if (seen.has(text)) return;

        seen.add(text);
        if (semanticRoot) seenSemanticRoots.add(semanticRoot);
        scanEl.dataset.tgScanned = "1";
        // Mark tất cả descendant elements là đã scan để sub-elements
        // (e.g., <a> inside <p>) không bị scan riêng lẻ với text fragment.
        // Fragment thiếu ngữ cảnh dễ bị API phân loại sai (false positive).
        scanEl.querySelectorAll("*").forEach(child => { child.dataset.tgScanned = "1"; });
        candidates.push({ el: scanEl, text });
      });
    } catch { /* ignore selector errors */ }

    // Tầng 2: TreeWalker quét mọi text node còn sót (leaf nodes trong DOM)
    const guard = this;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (guard._findComposedAncestor(p, "shreddit-comment")) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (
          p.dataset.tgScanned ||
          p.dataset.tgBlurred ||
          p.closest("[data-tg-blurred='1']")
        ) return NodeFilter.FILTER_REJECT;
        if (p.closest("[data-tg-blur]")) return NodeFilter.FILTER_REJECT;
        // === FIX: Bỏ qua vùng navigation/sidebar/header ===
        if (isInExcludedZone(p)) return NodeFilter.FILTER_REJECT;

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
      // Skip if inside excluded zone
      if (isInExcludedZone(node.parentElement)) continue;

      const rawText = node.textContent.trim().replace(/\s+/g, " ");
      const normalized = this._normalizePageCandidate(node.parentElement, rawText);
      if (!normalized) continue;
      const { el, text, semanticRoot } = normalized;

      if (seen.has(text)) continue;
      if (semanticRoot && seenSemanticRoots.has(semanticRoot)) continue;
      seen.add(text);
      if (semanticRoot) seenSemanticRoots.add(semanticRoot);
      el.dataset.tgScanned = "1";
      candidates.push({ el, text });
    }

    console.log(`[ToxicGuard] ${candidates.length} candidates found`);
    // Prioritize visible content first, then larger containers.
    candidates.sort((a, b) => {
      const ar = a.el.getBoundingClientRect();
      const br = b.el.getBoundingClientRect();
      const aVisible = ar.bottom > 0 && ar.top < window.innerHeight && ar.right > 0 && ar.left < window.innerWidth;
      const bVisible = br.bottom > 0 && br.top < window.innerHeight && br.right > 0 && br.left < window.innerWidth;
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      if (aVisible && bVisible) return ar.top - br.top;
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

  // Tìm "semantic root" của một element: ancestor gần nhất khớp với
  // các selector là comment/post container cấp cao nhất.
  // Dùng để nhận biết 2 element khác nhau nhưng cùng thuộc 1 comment.
  _findComposedAncestor(el, selector) {
    let node = el;
    const visited = new Set();
    while (node && !visited.has(node)) {
      visited.add(node);
      try {
        if (node.matches?.(selector)) return node;
      } catch { /* ignore selector issues */ }
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      const root = node.getRootNode?.();
      node = root?.host || null;
    }
    return null;
  },

  _isRedditPage() {
    const hostname = typeof location !== "undefined" ? location.hostname : "";
    return /(^|\.)reddit\.com$/i.test(hostname);
  },

  _findSemanticRoot(el) {
    if (!el) return null;

    // Reddit comments can live under a post/article tree. Always bind to the
    // nearest comment first; otherwise overlays from a reply can be keyed to a
    // higher post/root and appear on a different comment.
    try {
      const redditComment = this._findComposedAncestor(el, "shreddit-comment");
      if (redditComment) return redditComment;
    } catch { /* ignore */ }

    const SEMANTIC_ROOT_SELECTOR = [
      "shreddit-post",
      "[data-testid='post-container']",
      "[data-testid='tweet']",
      "[data-testid='cellInnerDiv']",
      "ytd-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-rich-item-renderer",
      "ytd-grid-video-renderer",
      "article",
    ].join(",");

    try {
      return this._findComposedAncestor(el, SEMANTIC_ROOT_SELECTOR);
    } catch {
      return null;
    }
  },

  _isRedditCommentPainted(commentEl, bodyEl) {
    if (!commentEl?.matches?.("shreddit-comment") || !bodyEl) return false;
    if (this._findComposedAncestor(bodyEl, "shreddit-comment") !== commentEl) return false;
    if (typeof document.elementsFromPoint !== "function" || typeof window === "undefined") return true;

    try {
      const rect = bodyEl.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;

      const visibleLeft = Math.max(0, rect.left);
      const visibleTop = Math.max(0, rect.top);
      const visibleRight = Math.min(window.innerWidth, rect.right);
      const visibleBottom = Math.min(window.innerHeight, rect.bottom);

      // Off-screen comments cannot be hit-tested yet. They will be checked
      // again by updatePageOverlays as soon as they enter the viewport.
      if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return true;

      const insetX = Math.min(24, (visibleRight - visibleLeft) / 4);
      const y = visibleTop + (visibleBottom - visibleTop) / 2;
      const points = [
        [visibleLeft + insetX, y],
        [visibleLeft + (visibleRight - visibleLeft) / 2, y],
        [visibleRight - insetX, y]
      ];

      return points.some(([x, pointY]) => {
        return document.elementsFromPoint(x, pointY).some((node) => {
          if (node?.closest?.("[data-tg-overlay]")) return false;
          return this._findComposedAncestor(node, "shreddit-comment") === commentEl;
        });
      });
    } catch {
      return true;
    }
  },

  _findRedditCommentBody(commentEl, targetEl = null) {
    if (!commentEl?.matches?.("shreddit-comment")) return null;

    const selectors = [
      "[id$='-comment-rtjson-content']",
      "[id*='comment-rtjson-content']",
      "[data-testid='comment']",
      ".md",
      "[slot='comment']"
    ];
    const candidates = [];
    const seen = new Set();

    for (const sel of selectors) {
      try {
        const matches = [
          ...(commentEl.matches?.(sel) ? [commentEl] : []),
          ...Array.from(commentEl.querySelectorAll(sel))
        ];
        matches.forEach((node) => {
          if (!node || seen.has(node)) return;
          seen.add(node);
          if (this._findComposedAncestor(node, "shreddit-comment") !== commentEl) return;
          if (node.querySelector?.("shreddit-comment")) return;
          if (targetEl && !node.contains(targetEl) && !targetEl.contains?.(node)) return;
          const r = node.getBoundingClientRect();
          if (r.width > 50 && r.height > 12) candidates.push(node);
        });
      } catch { /* ignore selector issues */ }
    }

    candidates.sort((a, b) => {
      if (a.contains(b)) return 1;
      if (b.contains(a)) return -1;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
    return candidates[0] || null;
  },

  _normalizePageCandidate(el, text) {
    const semanticRoot = this._findSemanticRoot(el);
    if (semanticRoot?.matches?.("shreddit-comment")) {
      const bodyEl = this._findRedditCommentBody(semanticRoot, el);
      if (!bodyEl) return null;
      const bodyText = (bodyEl.innerText || bodyEl.textContent || "").trim().replace(/\s+/g, " ");
      if (!bodyText) return null;
      return { el: bodyEl, text: bodyText, semanticRoot };
    }

    return { el, text, semanticRoot };
  },

  async checkAndBlur(el, text) {
    if (!this._isCurrentInstance()) return;
    // Skip nếu đã bị blur (check trước API call)
    if (el.closest("[data-tg-blurred='1']")) return;

    // === FIX RACE CONDITION: Claim semantic root ĐỒNG BỘ trước lần await đầu tiên ===
    // Do JavaScript single-threaded: code trước await chạy tuần tự, nên add vào Set sẽ
    // được thấy bởi các checkAndBlur() khác bắt đầu tiếp theo trong Promise.all
    const semanticRoot = this._findSemanticRoot(el);
    if (semanticRoot) {
      if (this.blurredRoots.has(semanticRoot)) return;   // Đã blur rồi
      if (this.scannedRoots.has(semanticRoot)) return;   // Đã scan (ALLOW) rồi — skip fragment
      if (this.processingRoots.has(semanticRoot)) return; // Đang xử lý bởi sibling
      this.processingRoots.add(semanticRoot);             // Claim root này
    }

    try {
      console.log(`[ToxicGuard] API request → tag=${el.tagName} text="${text.slice(0, 80)}" hasRoot=${!!semanticRoot}`);
      let r = await this.callApi(text);
      if (!this._isCurrentInstance()) return;
      if (!r.ok) {
        console.warn(`[ToxicGuard] API error: "${text.slice(0, 40)}" | ${r.error}`);
        return;
      }
      let action = r.result?.action || "ALLOW";
      console.log(`[ToxicGuard] API response → "${text.slice(0, 50)}" → ${action} (${r.result?.label_name || 'N/A'})`);

      // A blocking result must be confirmed without cache. This keeps the page
      // scan consistent with the popup's fresh CHECK_TEXT request and prevents
      // an old model result from leaving a false badge behind.
      if (action !== "ALLOW") {
        const confirmation = await this.callApi(text, { bypassCache: true });
        if (!this._isCurrentInstance()) return;
        if (!confirmation.ok) return;
        r = confirmation;
        action = r.result?.action || "ALLOW";
        if (action === "ALLOW") {
          console.log(`[ToxicGuard] Block result rejected by fresh confirmation → "${text.slice(0, 50)}"`);
        }
      }

      // Đánh dấu root đã được scan — bất kể ALLOW hay BLOCK.
      // Đảm bảo các fragment text từ cùng comment ở batch sau sẽ bị skip,
      // tránh false positive do fragment thiếu ngữ cảnh.
      if (semanticRoot) this.scannedRoots.add(semanticRoot);

      if (action !== "ALLOW") {
        // Re-check SAU API call — tránh race condition khi nhiều element cùng bài
        // được xử lý song song và cái kia đã blur container trước
        if (el.closest("[data-tg-blurred='1']")) return;

        const containerEl = this.findContainerToBlur(el);

        // Double-check container và ancestors của nó
        if (containerEl.dataset.tgBlurred || containerEl.closest("[data-tg-blurred='1']")) return;

        // Đăng ký vĩnh viễn trước khi blur
        if (semanticRoot) this.blurredRoots.add(semanticRoot);

        console.log(`[ToxicGuard] BLUR → "${text.slice(0, 50)}" | ${action}`);
        this.blurElement(containerEl, r.result, semanticRoot, text);
        containerEl.dataset.tgScanned = "1";
      }
    } finally {
      // Release processing claim (dù ALLOW hay BLOCK hay lỗi)
      if (semanticRoot) this.processingRoots.delete(semanticRoot);
    }
  },

  // Thu hẹp container về phần nội dung riêng của nó (không bao gồm replies/nested items)
  // Dùng khi container như shreddit-comment chứa nested shreddit-comment (replies)
  _narrowToOwnContent(container, targetEl) {
    const tag = (container.tagName || "").toLowerCase();

    if (tag === "shreddit-comment") {
      const ownContent = this._findRedditCommentBody(container, targetEl);
      if (ownContent) return ownContent;
    }
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
    const semanticRoot = this._findSemanticRoot(el);

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
      // Threads (threads.com / threads.net)
      "[data-pressable-container='true']",
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
      if (semanticRoot && current === semanticRoot) break;
      if (current === document.body || current === document.documentElement) break;
      current = getParentForScan(current);
    }

    const keepInsideSemanticRoot = (node) => {
      if (!semanticRoot || !node) return node;
      if (node === semanticRoot || semanticRoot.contains(node)) return node;
      return this._narrowToOwnContent(semanticRoot, el);
    };

    // Ưu tiên 1: explicit card/post selectors (closest match)
    // Với comment-type container (có nested cùng tag) → thu hẹp về phần content riêng
    for (const node of ancestors) {
      if (!node || node === document.body || node === document.documentElement) break;
      for (const sel of CONTAINER_SELECTORS) {
        try {
          if (node.matches && node.matches(sel)) {
            return keepInsideSemanticRoot(this._narrowToOwnContent(node, el));
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
      const parentIsInsideSemanticRoot = parent && (!semanticRoot || parent === semanticRoot || semanticRoot.contains(parent));
      if (parentIsInsideSemanticRoot && parent && parent !== document.body && parent !== document.documentElement) {
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

    return keepInsideSemanticRoot(found);
  },

  _getOverlaySeverity(result) {
    const action = result?.action || "ALLOW";
    const label = result?.label_name || "";
    if (action === "AUTO_BLOCK" || label === "HATE") return 4;
    if (action === "BLOCK") return 3;
    if (action === "WARN") return 2;
    return 1;
  },

  _clearBlurState(el, scopeRoot = null) {
    if (!el) return;
    if (scopeRoot?.matches?.("shreddit-comment") && el.closest?.("shreddit-comment") !== scopeRoot) return;
    el.style.filter = "";
    el.style.pointerEvents = "";
    el.style.userSelect = "";
    el.style.cursor = "";
    el.removeAttribute("data-tg-blur");
    el.removeAttribute("data-tg-blurred");
    el.removeAttribute("data-tg-hard-block");
    el.classList.remove(
      "tg-reddit-identity-blur",
      "tg-reddit-comment-block",
      "tg-reddit-comment-block-block",
      "tg-reddit-comment-block-auto-block",
      "tg-reddit-comment-block-warn",
      "tg-comment-block",
      "tg-comment-block-block",
      "tg-comment-block-auto-block",
      "tg-comment-block-warn"
    );
    if (el.parentElement?.classList?.contains("tg-reddit-comment-block") || el.parentElement?.classList?.contains("tg-comment-block")) {
      const wrapper = el.parentElement;
      const parent = wrapper.parentElement;
      if (parent) {
        while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
        wrapper.remove();
      }
    }
    el.querySelectorAll?.("[data-tg-blurred], [data-tg-blur], [data-tg-hard-block]").forEach((child) => {
      if (scopeRoot?.matches?.("shreddit-comment") && child.closest?.("shreddit-comment") !== scopeRoot) return;
      child.removeAttribute("data-tg-blur");
      child.removeAttribute("data-tg-blurred");
      child.removeAttribute("data-tg-hard-block");
    });
  },

  _removePageOverlayEntry(entry, restoreElement = false) {
    if (!entry) return;
    if (entry.revalidateTimer && typeof clearTimeout !== "undefined") {
      clearTimeout(entry.revalidateTimer);
      entry.revalidateTimer = null;
    }
    this._untrackPageOverlayElements(entry);
    if (entry.overlay) entry.overlay.remove();
    if (restoreElement && Array.isArray(entry.metaEls)) {
      entry.metaEls.forEach((metaEl) => this._clearBlurState(metaEl, entry.rootEl));
    }
    if (restoreElement && Array.isArray(entry.wrapper?.__tgIdentityEls)) {
      entry.wrapper.__tgIdentityEls.forEach((identityEl) => {
        if (identityEl.__tgOwnerWrapper === entry.wrapper) {
          delete identityEl.__tgOwnerWrapper;
          this._clearBlurState(identityEl);
        }
      });
    }
    // Chỉ unwrap nếu wrapper là element do extension TẠO RA (có classList tg-reddit-comment-block hoặc tg-comment-block)
    // KHÔNG unwrap native elements như <details> của Reddit
    if (entry.wrapper) {
      const isExtensionWrapper =
        entry.wrapper.tagName === "DIV" &&
        entry.wrapper.dataset.tgOverlay &&
        (
          entry.wrapper.classList?.contains("tg-reddit-comment-block") ||
          entry.wrapper.classList?.contains("tg-comment-block")
        );
      if (isExtensionWrapper) {
        this._unwrapInlineEntry(entry);
      } else {
        // Native element: chỉ xóa class đánh dấu, không thay đổi cấu trúc
        const actionClass = (entry.rootEl?.getAttribute?.("data-tg-blur") || "block").toLowerCase().replace("_", "-");
        entry.wrapper.classList.remove(
          "tg-reddit-comment-block",
          `tg-reddit-comment-block-${actionClass}`,
          "tg-reddit-comment-hard-block",
          "tg-comment-block",
          `tg-comment-block-${actionClass}`,
          "tg-comment-hard-block"
        );
        delete entry.wrapper.dataset.tgOverlay;
      }
    }
    entry.observer?.disconnect?.();
    if (entry.el) this.pageOverlayMap.delete(entry.el);
    if (entry.rootEl) this.pageOverlayRootMap.delete(entry.rootEl);
    if (restoreElement) this._clearBlurState(entry.el, entry.rootEl);
  },

  _unwrapInlineEntry(entry) {
    if (!entry?.wrapper) return;
    const parent = entry.wrapper.parentElement;
    if (parent) {
      while (entry.wrapper.firstChild) parent.insertBefore(entry.wrapper.firstChild, entry.wrapper);
    }
    entry.wrapper.remove();
  },

  _trackPageOverlayElements(entry, elements) {
    if (!entry) return;
    if (!Array.isArray(entry.trackedEls)) entry.trackedEls = [];
    (elements || []).filter(Boolean).forEach((el) => {
      if (!entry.trackedEls.includes(el)) entry.trackedEls.push(el);
      this.pageOverlayElementMap.set(el, entry);
    });
  },

  _untrackPageOverlayElements(entry, elements = entry?.trackedEls || []) {
    if (!entry) return;
    (elements || []).filter(Boolean).forEach((el) => {
      if (this.pageOverlayElementMap.get(el) === entry) this.pageOverlayElementMap.delete(el);
    });
    if (!elements || elements === entry.trackedEls) entry.trackedEls = [];
  },


  _buildBadgeText(result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    return isHardBlock ? `${label} (BLOCKED)` : label;
  },

  _setInlineWrapperState(wrapper, variant, result) {
    if (!wrapper) return;
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    wrapper.dataset.tgInlineVariant = variant;
    wrapper.dataset.tgAction = action;
    wrapper.dataset.tgActionClass = actionClass;
    wrapper.dataset.tgBadgeText = this._buildBadgeText(result);
    wrapper.dataset.tgHardBlock = isHardBlock ? "1" : "0";
  },

  getPageStats() {
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

    const wrappers = Array.from(document.querySelectorAll(".tg-reddit-comment-card, .tg-comment-block"));
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
      source: "content-message",
      enabled: this._enabled
    };
  },

  _ensureInlineBadgeRow(wrapper) {
    if (!wrapper?.isConnected) return;

    const variant = wrapper.dataset.tgInlineVariant || (
      wrapper.classList.contains("tg-reddit-comment-block") ? "reddit" : "generic"
    );
    const rowClass = variant === "reddit" ? "tg-reddit-comment-badge-row" : "tg-comment-badge-row";
    const badgeClass = variant === "reddit" ? "tg-reddit-comment-badge" : "tg-comment-badge";

    // Xóa badge row thừa nếu có (do race condition tạo ra duplicate)
    // Chỉ giữ lại direct child đầu tiên, xóa các direct child dư thừa
    const directRows = Array.from(wrapper.children).filter(c => c.classList.contains(rowClass));
    if (directRows.length > 1) {
      directRows.slice(1).forEach(r => r.remove());
    }
    if (directRows.length >= 1) return;

    const actionClass = wrapper.dataset.tgActionClass || "block";
    const badgeText = wrapper.dataset.tgBadgeText || this._buildBadgeText({
      action: wrapper.dataset.tgAction || "BLOCK",
      label_name: wrapper.dataset.tgHardBlock === "1" ? "HATE" : "TOXIC"
    });

    const row = document.createElement("div");
    row.className = `${rowClass} ${rowClass}-${actionClass}`;
    row.setAttribute("data-tg-overlay", "1");
    if (wrapper.dataset.tgSourceText) row.dataset.tgSourceText = wrapper.dataset.tgSourceText;
    if (wrapper.dataset.tgRootTag) row.dataset.tgRootTag = wrapper.dataset.tgRootTag;
    if (wrapper.dataset.tgRootId) row.dataset.tgRootId = wrapper.dataset.tgRootId;

    const badge = document.createElement("span");
    badge.className = badgeClass;
    badge.textContent = badgeText;
    row.appendChild(badge);

    wrapper.insertBefore(row, wrapper.firstChild);
  },

  _hasLiveCardOverlay(el) {
    const entry = this.pageOverlayMap.get(el);
    return !!(entry?.overlay?.isConnected && document.body.contains(el));
  },

  _hasLiveTrackedOverlay(el) {
    const entry = this.pageOverlayElementMap.get(el);
    return !!(entry?.overlay?.isConnected && document.body.contains(el));
  },

  _resetRedditRootScan(rootEl, bodyEl) {
    if (rootEl) {
      this.blurredRoots.delete(rootEl);
      this.scannedRoots.delete(rootEl);
      this.processingRoots.delete(rootEl);
      delete rootEl.dataset.tgScanned;
      delete rootEl.dataset.tgBlurred;
    }
    if (bodyEl) {
      delete bodyEl.dataset.tgScanned;
      delete bodyEl.dataset.tgBlurred;
      bodyEl.querySelectorAll?.("[data-tg-scanned], [data-tg-blurred]").forEach((child) => {
        delete child.dataset.tgScanned;
        delete child.dataset.tgBlurred;
      });
    }
  },

  _reconcilePageOverlaySources() {
    for (const [, entry] of Array.from(this.pageOverlayMap.entries())) {
      if (!entry?.sourceText || !entry.rootEl?.matches?.("shreddit-comment")) continue;
      const currentBody = document.body.contains(entry.el)
        ? (this._findRedditCommentBody(entry.rootEl, entry.el) || entry.el)
        : this._findRedditCommentBody(entry.rootEl);
      const currentText = this._normalizeContentText(currentBody?.innerText || currentBody?.textContent || "");
      if (currentText === entry.sourceText) continue;

      this._removePageOverlayEntry(entry, true);
      this._resetRedditRootScan(entry.rootEl, currentBody);
      if (typeof setTimeout !== "undefined") this.schedulePageScan(0);
    }
  },

  _removeOrphanPageCards() {
    const ownedCards = new Set(
      Array.from(this.pageOverlayMap.values())
        .map((entry) => entry?.overlay)
        .filter(Boolean)
    );
    document.querySelectorAll(".tg-reddit-comment-card, .tg-card-overlay").forEach((card) => {
      if (!ownedCards.has(card)) card.remove();
    });
  },

  async _revalidateRedditEntry(entry) {
    if (!entry?.sourceText || !this._isCurrentInstance()) return;
    if (this.pageOverlayRootMap.get(entry.rootEl) !== entry) return;

    const currentBody = this._findRedditCommentBody(entry.rootEl, entry.el) || entry.el;
    const currentText = this._normalizeContentText(currentBody?.innerText || currentBody?.textContent || "");
    if (currentText !== entry.sourceText) {
      this._reconcilePageOverlaySources();
      return;
    }

    const fresh = await this.callApi(entry.sourceText, { bypassCache: true });
    if (!fresh.ok || !this._isCurrentInstance()) return;
    if (this.pageOverlayRootMap.get(entry.rootEl) !== entry) return;
    if ((fresh.result?.action || "ALLOW") !== "ALLOW") return;

    this._removePageOverlayEntry(entry, true);
    this.blurredRoots.delete(entry.rootEl);
    this.scannedRoots.add(entry.rootEl);
    console.log(`[ToxicGuard] Removed false Reddit badge after live revalidation → "${entry.sourceText.slice(0, 50)}"`);
  },

  reconcileBlurState() {
    if (!this._isCurrentInstance()) return;
    this._removeOrphanPageCards();
    this._reconcilePageOverlaySources();
    document.querySelectorAll(".tg-reddit-comment-block, .tg-comment-block").forEach((wrapper) => {
      this._ensureInlineBadgeRow(wrapper);
    });

    document.querySelectorAll("[data-tg-blur]").forEach((el) => {
      const hasBlurredAncestor = !!el.parentElement?.closest?.("[data-tg-blur]");
      if (hasBlurredAncestor) return;

      const inlineWrapper = el.closest(".tg-reddit-comment-block, .tg-comment-block");
      if (inlineWrapper) {
        this._ensureInlineBadgeRow(inlineWrapper);
        return;
      }

      if (el.__tgOwnerWrapper?.isConnected) return;
      if (this._hasLiveTrackedOverlay(el)) return;
      if (this._hasLiveCardOverlay(el)) return;

      const scopeRoot = el.closest?.("shreddit-comment") || null;
      this._clearBlurState(el, scopeRoot);
    });
  },

  _applyBlurState(el, result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";

    el.dataset.tgBlurred = "1";
    el.dataset.tgScanned = "1";
    el.querySelectorAll("*").forEach(child => {
      child.dataset.tgScanned = "1";
      child.dataset.tgBlurred = "1";
    });

    el.style.filter = "blur(8px)";
    el.style.pointerEvents = "none";
    el.style.userSelect = "none";
    el.style.transition = "filter 0.3s ease";
    el.style.cursor = "default";
    el.setAttribute("data-tg-blur", action);
    el.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");
  },

  _findRedditCommentMetaElements(commentEl) {
    if (!commentEl?.matches?.("shreddit-comment")) return [];

    const selectors = [
      "[slot='commentMeta']",
      "[slot='commentAuthor']",
      "[slot='commentAvatar']",
      "[slot='authorFlair']",
      "[data-testid='comment_author_link']",
      "[data-testid='user-flair']",
      "faceplate-tracker[noun='comment_author']"
    ].join(",");

    try {
      const candidates = Array.from(commentEl.querySelectorAll(selectors)).filter((el) => {
        return el.closest?.("shreddit-comment") === commentEl &&
          !el.querySelector?.("shreddit-comment");
      });
      return candidates.filter((el, index) => {
        if (candidates.indexOf(el) !== index) return false;
        return !candidates.some((other) => other !== el && other.contains?.(el));
      });
    } catch {
      return [];
    }
  },

  _applyRedditCommentMetaBlur(commentEl, result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";

    const metaEls = this._findRedditCommentMetaElements(commentEl);
    metaEls.forEach((metaEl) => {
      metaEl.classList.add("tg-reddit-identity-blur");
      metaEl.dataset.tgBlurred = "1";
      metaEl.style.filter = "blur(8px)";
      metaEl.style.pointerEvents = "none";
      metaEl.style.userSelect = "none";
      metaEl.style.transition = "filter 0.3s ease";
      metaEl.setAttribute("data-tg-blur", action);
      metaEl.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");
    });
    return metaEls;
  },

  _wrapRedditCommentParts(wrapper, bodyEl, commentEl) {
    const parent = bodyEl.parentElement;
    if (!parent) return false;

    const parts = [
      ...this._findRedditCommentMetaElements(commentEl),
      bodyEl
    ].filter((part, index, arr) => {
      return part?.parentElement === parent && arr.indexOf(part) === index;
    });

    if (!parts.length) return false;

    const orderedParts = Array.from(parent.children).filter((child) => parts.includes(child));
    const firstPart = orderedParts[0] || bodyEl;
    parent.insertBefore(wrapper, firstPart);
    orderedParts.forEach((part) => wrapper.appendChild(part));
    if (!wrapper.contains(bodyEl)) wrapper.appendChild(bodyEl);
    return true;
  },

  blurRedditCommentElement(el, result, rootEl, classifiedText = null) {
    const overlayRoot = rootEl || this._findSemanticRoot(el) || el;
    const severity = this._getOverlaySeverity(result);
    const action = result.action || "BLOCK";
    const label = result.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    const existingEntry = this.pageOverlayRootMap.get(overlayRoot);

    if (existingEntry) {
      if ((existingEntry.severity || 0) >= severity) return;
      const badgeSpan = existingEntry.overlay?.querySelector?.(".tg-reddit-comment-badge");
      if (badgeSpan) badgeSpan.textContent = this._buildBadgeText(result);
      if (existingEntry.overlay) {
        existingEntry.overlay.className = `tg-reddit-comment-card tg-reddit-comment-card-${actionClass}`;
        existingEntry.overlay.dataset.tgAction = action;
        existingEntry.overlay.dataset.tgHardBlock = isHardBlock ? "1" : "0";
        existingEntry.overlay.setAttribute("aria-label", `${this._buildBadgeText(result)} comment`);
      }
      existingEntry.severity = severity;
      existingEntry.isHardBlock = isHardBlock;
      this._applyBlurState(existingEntry.el || el, result);
      const metaEls = this._applyRedditCommentMetaBlur(overlayRoot, result);
      existingEntry.metaEls = metaEls;
      existingEntry.anchorEls = [existingEntry.el || el, ...metaEls];
      this._trackPageOverlayElements(existingEntry, metaEls);
      this.schedulePageOverlayUpdate();
      return;
    }

    if (el.dataset.tgBlurred) return;

    // Blur only the body selected inside this exact shreddit-comment. Never
    // decorate its parent because Reddit can keep the whole reply tree there.
    const blurTarget = this._findRedditCommentBody(overlayRoot, el) || (
      el.closest?.("shreddit-comment") === overlayRoot &&
      !el.querySelector?.("shreddit-comment")
        ? el
        : null
    );
    if (!blurTarget) {
      console.warn("[ToxicGuard] Skip unsafe Reddit blur target containing replies");
      return;
    }
    if (!this._isRedditCommentPainted(overlayRoot, blurTarget)) {
      this._resetRedditRootScan(overlayRoot, blurTarget);
      console.log("[ToxicGuard] Skip occluded Reddit comment with a misleading layout rect");
      return;
    }
    const currentText = this._normalizeContentText(blurTarget.innerText || blurTarget.textContent || "");
    const expectedText = classifiedText == null ? currentText : this._normalizeContentText(classifiedText);
    if (!currentText || currentText !== expectedText) {
      this._resetRedditRootScan(overlayRoot, blurTarget);
      if (typeof setTimeout !== "undefined") this.schedulePageScan(0);
      console.log("[ToxicGuard] Skip stale Reddit result: comment text changed during API request");
      return;
    }
    const parent = blurTarget.parentElement;
    if (!parent) return;
    this._applyBlurState(blurTarget, result);
    const metaEls = this._applyRedditCommentMetaBlur(overlayRoot, result);

    // One visual card covers only the union of this comment's safe anchors:
    // avatar, author identity, and own body. Replies are never anchor elements.
    const card = document.createElement("div");
    card.className = `tg-reddit-comment-card tg-reddit-comment-card-${actionClass}`;
    card.setAttribute("data-tg-overlay", "1");
    card.setAttribute("role", "status");
    card.setAttribute("aria-label", `${this._buildBadgeText(result)} comment`);
    card.dataset.tgAction = action;
    card.dataset.tgHardBlock = isHardBlock ? "1" : "0";
    card.dataset.tgSourceText = currentText.slice(0, 160);
    card.dataset.tgRootTag = overlayRoot.tagName || "";
    card.dataset.tgRootId = overlayRoot.id || "";

    const badge = document.createElement("span");
    badge.className = "tg-reddit-comment-badge";
    badge.textContent = this._buildBadgeText(result);
    card.appendChild(badge);
    document.body.appendChild(card);

    const anchorEls = [blurTarget, ...metaEls];
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => this.schedulePageOverlayUpdate());
      anchorEls.forEach((anchor) => observer.observe(anchor));
    }

    const entry = {
      overlay: card,
      observer,
      el: blurTarget,
      rootEl: overlayRoot,
      severity,
      inline: false,
      wrapper: null,
      metaEls,
      anchorEls,
      overlayPadding: 4,
      positionMode: "document",
      isHardBlock,
      sourceText: currentText
    };
    this.pageOverlayMap.set(blurTarget, entry);
    this.pageOverlayRootMap.set(overlayRoot, entry);
    this._trackPageOverlayElements(entry, [blurTarget, ...metaEls]);
    this.ensurePageOverlayListeners();
    this.schedulePageOverlayUpdate();
    if (typeof setTimeout !== "undefined") {
      entry.revalidateTimer = setTimeout(() => {
        entry.revalidateTimer = null;
        this._revalidateRedditEntry(entry);
      }, 1200);
    }

    if (!isHardBlock) {
      const reveal = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (entry.isHardBlock) return;
        this._removePageOverlayEntry(entry, true);
      };
      card.style.cursor = "pointer";
      card.addEventListener("click", reveal, { once: true, capture: true });
    }
  },

  _findGenericCommentGroup(el, rootEl) {

    const candidates = [];
    let current = el;
    const bodyRect = el.getBoundingClientRect();
    const bodyText = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const bodyPrefix = bodyText.slice(0, Math.min(48, bodyText.length));
    const hasExternalIdentity = (node) => {
      try {
        return Array.from(node.querySelectorAll("img, [role='img'], a[href*='/@'], a[href*='/user'], a[href*='/profile'], time, [datetime], strong, b"))
          .some((identityEl) => !el.contains(identityEl));
      } catch {
        return false;
      }
    };

    for (let depth = 0; depth < 12 && current && current !== document.body && current !== document.documentElement; depth++) {
      const rect = current.getBoundingClientRect();
      const text = (current.innerText || current.textContent || "").trim();
      const tag = (current.tagName || "").toUpperCase();
      const role = current.getAttribute?.("role") || "";
      const hasIdentity = hasExternalIdentity(current);
      const bodyIndex = bodyPrefix ? text.replace(/\s+/g, " ").indexOf(bodyPrefix) : -1;
      const trailingAfterBody = bodyIndex >= 0 ? text.slice(bodyIndex + bodyText.length) : "";
      const trailingWithoutActions = trailingAfterBody
        .replace(/\b(Translate|Reply|Share|Like|Author|Trả lời|Chia sẻ)\b/gi, " ")
        .replace(/[·•]/g, " ")
        .trim();
      const hasNestedAfterBody =
        trailingWithoutActions.length > 24 &&
        /(?:^|\s)@?[\p{L}\p{N}._-]{2,40}\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/u.test(trailingWithoutActions);
      const hasHeaderBeforeBody =
        bodyIndex > 0 &&
        bodyIndex <= 140 &&
        text.length <= Math.max(120, bodyText.length + 260);
      const hasActions = !!current.querySelector?.(
        "button, [role='button'], svg, [aria-label*='reply' i], [aria-label*='like' i], [aria-label*='share' i]"
      );
      const isSemanticCard =
        tag === "ARTICLE" ||
        role === "article" ||
        current.matches?.(".comment, .comment-container, [data-testid='tweet'], [data-testid='cellInnerDiv'], [data-pressable-container='true']");
      const reasonable =
        rect.width >= 180 &&
        rect.height >= 48 &&
        rect.height <= Math.max(560, window.innerHeight * 0.85) &&
        rect.top <= bodyRect.top + 8 &&
        rect.bottom >= bodyRect.bottom - 8 &&
        text.length >= 4 &&
        text.length <= 1200;

      // Quan trọng: container phải bắt đầu GẦN với body (tối đa 120px phía trên)
      // Điều này ngăn chặn việc bắt nhầm container của comment trên
      const containerStartsNearBody = rect.top >= bodyRect.top - 120;
      if (reasonable && containerStartsNearBody && !hasNestedAfterBody && (isSemanticCard || hasIdentity || hasActions || hasHeaderBeforeBody)) {
        const compactScore = Math.max(0, 35 - rect.height / 12);
        candidates.push({
          el: current,
          score:
            (hasHeaderBeforeBody ? 140 : 0) +
            (hasIdentity ? 100 : 0) +
            (isSemanticCard ? 40 : 0) +
            (hasActions ? 15 : 0) +
            compactScore -
            depth * 0.25
        });
      }

      if (rootEl && current === rootEl) break;
      current = current.parentElement;
    }

    if (!candidates.length) {
      let siblingParent = el.parentElement;
      for (let depth = 0; depth < 6 && siblingParent && siblingParent !== document.body && siblingParent !== document.documentElement; depth++) {
        const siblings = Array.from(siblingParent.children || []);
        const bodyIndex = siblings.findIndex((child) => child === el || child.contains(el));
        if (bodyIndex > 0) {
          const previousSiblings = siblings.slice(Math.max(0, bodyIndex - 3), bodyIndex);
          const hasNearbyIdentity = previousSiblings.some((node) => hasExternalIdentity(node));
          if (hasNearbyIdentity) {
            const r = siblingParent.getBoundingClientRect();
            if (r.width >= 180 && r.height >= 48 && r.height <= Math.max(560, window.innerHeight * 0.85)) {
              candidates.push({ el: siblingParent, score: 130 + Math.min(35, r.height / 10) });
              break;
            }
          }
        }
        siblingParent = siblingParent.parentElement;
      }
    }

    const rootCandidate = rootEl && rootEl !== el ? rootEl : null;
    if (rootCandidate) {
      const r = rootCandidate.getBoundingClientRect();
      if (
        document.body.contains(rootCandidate) &&
        r.width >= 180 &&
        r.height >= 48 &&
        r.height <= Math.max(560, window.innerHeight * 0.85) &&
        r.top <= bodyRect.top + 8 &&
        r.bottom >= bodyRect.bottom - 8
      ) {
        candidates.push({
          el: rootCandidate,
          score: (hasExternalIdentity(rootCandidate) ? 120 : 20) + Math.min(35, r.height / 10)
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  },

  _applyGenericInlineBlur(groupEl, bodyEl, result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";

    groupEl.dataset.tgBlurred = "1";
    groupEl.dataset.tgScanned = "1";
    groupEl.style.filter = "blur(8px)";
    groupEl.style.pointerEvents = "none";
    groupEl.style.userSelect = "none";
    groupEl.style.transition = "filter 0.3s ease";
    groupEl.style.cursor = "default";
    groupEl.setAttribute("data-tg-blur", action);
    groupEl.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");
    bodyEl.dataset.tgBlurred = "1";
    bodyEl.dataset.tgScanned = "1";
  },

  _findNearbyIdentityElements(bodyEl) {
    const bodyRect = bodyEl.getBoundingClientRect();
    const roots = [];
    let current = bodyEl.parentElement;
    for (let depth = 0; depth < 8 && current && current !== document.body && current !== document.documentElement; depth++) {
      roots.push(current);
      current = current.parentElement;
    }

    const searchRoot = roots.find((node) => {
      const r = node.getBoundingClientRect();
      return (
        r.width >= Math.max(180, bodyRect.width * 0.75) &&
        r.height >= bodyRect.height &&
        r.height <= Math.max(720, window.innerHeight * 0.9) &&
        r.top <= bodyRect.top + 24 &&
        r.bottom >= bodyRect.bottom - 8
      );
    }) || bodyEl.closest?.("article, [role='article'], main, section") || bodyEl.parentElement;
    if (!searchRoot) return [];

    const selector = [
      "img",
      "[role='img']",
      "a",
      "time",
      "[datetime]",
      "strong",
      "b",
      "span",
      "div"
    ].join(",");

    const isIdentityLike = (node) => {
      const text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
      if (node.matches?.("img,[role='img']")) return true;
      if (node.matches?.("time,[datetime]")) return true;
      if (!text || text.length > 90) return false;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) return true;
      if (/^\d+\s*(ngày|giờ|phút|day|days|h|m)\b/i.test(text)) return true;
      if (/^@?[\p{L}\p{N}._-]{2,40}$/u.test(text)) return true;
      return node.matches?.("a,strong,b") && text.length <= 60;
    };

    const addCompactAncestors = (set, node) => {
      let parent = node.parentElement;
      for (let depth = 0; depth < 4 && parent && parent !== searchRoot && parent !== document.body; depth++) {
        if (parent.contains(bodyEl) || parent.closest?.("[data-tg-overlay]")) break;
        const r = parent.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.height > 0 &&
          r.height <= 96 &&
          r.width <= Math.max(520, bodyRect.width * 0.85) &&
          r.bottom >= bodyRect.top - 60 &&
          r.top <= bodyRect.top + 4 &&
          r.right >= bodyRect.left - 120 &&
          r.left <= bodyRect.left + 300
        ) {
          set.add(parent);
          parent = parent.parentElement;
          continue;
        }
        break;
      }
    };

    try {
      const found = new Set();
      Array.from(searchRoot.querySelectorAll(selector)).forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (bodyEl.contains(node) || node.contains(bodyEl) || node.closest?.("[data-tg-overlay]")) return;
        if (!isIdentityLike(node)) return;

        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;

        const isNearVertically = r.bottom >= bodyRect.top - 60 && r.top <= bodyRect.top + 4;
        const isNearHorizontally =
          r.right >= bodyRect.left - 120 &&
          r.left <= Math.min(bodyRect.right + 16, bodyRect.left + 300);
        if (!isNearVertically || !isNearHorizontally) return;

        found.add(node);
        addCompactAncestors(found, node);
      });

      return Array.from(found).sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      });
    } catch {
      return [];
    }
  },

  _expandGenericWrapperToNearbyIdentity(wrapper, bodyEl) {
    // Only expand to cover identity elements OUTSIDE the wrapper.
    // Elements already inside wrapper are already blurred via the group blur.
    const identityEls = this._findNearbyIdentityElements(bodyEl)
      .filter(el => !wrapper.contains(el));
    if (!identityEls.length) return;

    const nextIdentitySet = new Set(identityEls);
    if (Array.isArray(wrapper.__tgIdentityEls)) {
      wrapper.__tgIdentityEls.forEach((node) => {
        if (!nextIdentitySet.has(node) && node.__tgOwnerWrapper === wrapper) {
          delete node.__tgOwnerWrapper;
          this._clearBlurState(node);
        }
      });
    }

    wrapper.style.position = "relative";
    wrapper.style.zIndex = "1";
    // Không dùng margin-top âm → badge sẽ không nhúc nhích khi scroll
    // Identity elements được blur tại chỗ, không thay đổi layout của wrapper
    wrapper.dataset.tgIdentityCount = String(identityEls.length);
    wrapper.dataset.tgExpandedTop = "0";
    wrapper.dataset.tgExpandedLeft = "0";

    identityEls.forEach((node) => {
      node.dataset.tgBlurred = "1";
      node.style.filter = "blur(8px)";
      node.style.pointerEvents = "none";
      node.style.userSelect = "none";
      node.style.transition = "filter 0.3s ease";
      node.setAttribute("data-tg-blur", bodyEl.getAttribute("data-tg-blur") || "BLOCK");
      node.setAttribute("data-tg-hard-block", bodyEl.getAttribute("data-tg-hard-block") || "0");
      node.__tgOwnerWrapper = wrapper;
    });
    wrapper.__tgIdentityEls = identityEls;
  },

  reanchorGenericCommentBlocks() {
    document.querySelectorAll(".tg-comment-block").forEach((wrapper) => {
      const bodyEl = wrapper.__tgBodyEl;
      if (!bodyEl || !document.body.contains(bodyEl)) return;

      const currentGroup = wrapper.__tgGroupEl;
      const nextGroup = this._findGenericCommentGroup(bodyEl, currentGroup);
      if (!nextGroup || nextGroup === currentGroup || wrapper.contains(nextGroup)) {
        this._expandGenericWrapperToNearbyIdentity(wrapper, bodyEl);
        return;
      }

      const parent = wrapper.parentElement;
      if (!parent) return;

      while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
      nextGroup.parentElement?.insertBefore(wrapper, nextGroup);
      wrapper.appendChild(nextGroup);

      const row = wrapper.querySelector(".tg-comment-badge-row");
      if (row) wrapper.insertBefore(row, nextGroup);
      wrapper.__tgGroupEl = nextGroup;

      const action = bodyEl.getAttribute("data-tg-blur") || "BLOCK";
      const actionClass = action.toLowerCase().replace("_", "-");
      const label = bodyEl.getAttribute("data-tg-hard-block") === "1" ? "HATE" : "TOXIC";
      wrapper.classList.remove("tg-comment-block-block", "tg-comment-block-auto-block", "tg-comment-block-warn");
      wrapper.classList.add(`tg-comment-block-${actionClass}`);
      this._applyGenericInlineBlur(nextGroup, bodyEl, { action, label_name: label });
      this._expandGenericWrapperToNearbyIdentity(wrapper, bodyEl);
    });
  },

  blurGenericCommentElement(el, result, rootEl = null) {
    if (this._findComposedAncestor(el, "shreddit-comment")) return false;
    const groupEl = this._findGenericCommentGroup(el, rootEl);
    if (!groupEl || groupEl.matches?.("shreddit-comment")) return false;
    if (groupEl.closest?.(".tg-comment-block, .tg-reddit-comment-block")) return false;

    const overlayRoot = groupEl;
    const severity = this._getOverlaySeverity(result);
    const action = result.action || "BLOCK";
    const label = result.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    const existingEntry = this.pageOverlayRootMap.get(overlayRoot);

    if (existingEntry) {
      if ((existingEntry.severity || 0) >= severity) return true;
      existingEntry.overlay.className = `tg-comment-badge-row tg-comment-badge-row-${actionClass}`;
      existingEntry.overlay.querySelector(".tg-comment-badge").textContent = this._buildBadgeText(result);
      existingEntry.wrapper.className = `tg-comment-block tg-comment-block-${actionClass}`;
      if (isHardBlock) existingEntry.wrapper.classList.add("tg-comment-hard-block");
      existingEntry.severity = severity;
      this._setInlineWrapperState(existingEntry.wrapper, "generic", result);
      existingEntry.wrapper.__tgBodyEl = existingEntry.el || el;
      existingEntry.wrapper.__tgGroupEl = existingEntry.wrapper.querySelector(":scope > :not(.tg-comment-badge-row)") || existingEntry.wrapper;
      this._applyGenericInlineBlur(existingEntry.wrapper, existingEntry.el || el, result);
      this._expandGenericWrapperToNearbyIdentity(existingEntry.wrapper, existingEntry.el || el);
      return true;
    }

    const wrapper = document.createElement("div");
    wrapper.className = `tg-comment-block tg-comment-block-${actionClass}`;
    if (isHardBlock) wrapper.classList.add("tg-comment-hard-block");
    wrapper.dataset.tgOverlay = "1";
    wrapper.dataset.tgSourceText = (el.innerText || el.textContent || "").trim().slice(0, 160);
    wrapper.dataset.tgRootTag = groupEl.tagName || "";
    wrapper.dataset.tgRootId = groupEl.id || "";
    wrapper.__tgBodyEl = el;
    wrapper.__tgGroupEl = groupEl;
    this._setInlineWrapperState(wrapper, "generic", result);

    const parent = groupEl.parentElement;
    if (!parent) return false;
    parent.insertBefore(wrapper, groupEl);
    wrapper.appendChild(groupEl);

    const row = document.createElement("div");
    row.className = `tg-comment-badge-row tg-comment-badge-row-${actionClass}`;
    row.setAttribute("data-tg-overlay", "1");
    row.dataset.tgSourceText = wrapper.dataset.tgSourceText;
    row.dataset.tgRootTag = wrapper.dataset.tgRootTag;
    row.dataset.tgRootId = wrapper.dataset.tgRootId;

    const badge = document.createElement("span");
    badge.className = "tg-comment-badge";
    badge.textContent = this._buildBadgeText(result);
    row.appendChild(badge);
    wrapper.insertBefore(row, groupEl);


    this._applyGenericInlineBlur(groupEl, el, result);
    this._expandGenericWrapperToNearbyIdentity(wrapper, el);

    const entry = { overlay: row, observer: null, el, rootEl: overlayRoot, severity, inline: true, wrapper };
    this.pageOverlayRootMap.set(overlayRoot, entry);
    [120, 300, 700, 1200, 2200, 3600].forEach((delay) => {
      setTimeout(() => this.reanchorGenericCommentBlocks(), delay);
    });

    if (!isHardBlock) {
      const reveal = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this._removePageOverlayEntry(entry, true);
      };
      wrapper.style.cursor = "pointer";
      wrapper.title = "Click to reveal this offensive comment";
      wrapper.addEventListener("click", reveal, { once: true, capture: true });
    }

    return true;
  },

  blurElement(el, result, rootEl = null, classifiedText = null) {
    const redditRoot = this._findComposedAncestor(el, "shreddit-comment");
    const overlayRoot = redditRoot || rootEl || this._findSemanticRoot(el) || el;
    if (redditRoot || overlayRoot?.matches?.("shreddit-comment")) {
      this.blurRedditCommentElement(el, result, redditRoot || overlayRoot, classifiedText);
      return;
    }
    if (this._isRedditPage() && !overlayRoot?.matches?.("shreddit-post")) {
      console.log("[ToxicGuard] Skip generic overlay for an unowned Reddit node");
      return;
    }
    if (this.blurGenericCommentElement(el, result, overlayRoot)) return;

    const severity = this._getOverlaySeverity(result);
    const action = result.action || "BLOCK";
    const label = result.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    const existingEntry = this.pageOverlayRootMap.get(overlayRoot);

    if (existingEntry) {
      if ((existingEntry.severity || 0) >= severity) return;
      if (existingEntry.el === el) {
        existingEntry.overlay.className = `tg-card-overlay tg-card-overlay-${actionClass}`;
        existingEntry.overlay.dataset.tgAction = action;
        existingEntry.overlay.dataset.tgHardBlock = isHardBlock ? "1" : "0";
        existingEntry.overlay.querySelector(".tg-card-label").textContent = isHardBlock ? `${label} (BLOCKED)` : label;
        existingEntry.overlay.style.pointerEvents = isHardBlock ? "none" : "auto";
        existingEntry.severity = severity;
        el.setAttribute("data-tg-blur", action);
        el.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");
        return;
      }
      this._removePageOverlayEntry(existingEntry, existingEntry.el !== el);
    }

    if (el.dataset.tgBlurred) return;
    el.dataset.tgBlurred = "1";

    // Mark all children and self as scanned to prevent re-scanning them
    el.dataset.tgScanned = "1";
    el.querySelectorAll("*").forEach(child => {
      child.dataset.tgScanned = "1";
      child.dataset.tgBlurred = "1";
    });

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

    // Create overlay only once per visual container/root.
    if (this.pageOverlayMap.has(el)) return;

    const overlay = document.createElement("div");
    overlay.className = `tg-card-overlay tg-card-overlay-${actionClass}`;
    overlay.setAttribute("data-tg-overlay", "1");
    overlay.dataset.tgAction = action;
    overlay.dataset.tgHardBlock = isHardBlock ? "1" : "0";

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

    const entry = { overlay, observer, el, rootEl: overlayRoot, severity };
    this.pageOverlayMap.set(el, entry);
    this.pageOverlayRootMap.set(overlayRoot, entry);
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
          this._removePageOverlayEntry(entry, false);
        } catch { /* ignore */ }
      };

      overlay.addEventListener("click", unblur, { once: true, capture: true });
    }
  }
};

if (isChromeAlive()) {
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_PAGE_STATS") return;
      sendResponse(ToxicGuard.getPageStats());
    });
  } catch { /* ignore if context invalidated */ }
}

ToxicGuard.init();
