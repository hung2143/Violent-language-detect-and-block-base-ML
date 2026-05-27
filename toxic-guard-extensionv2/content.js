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
  pageOverlayRootMap: new WeakMap(),
  apiCache: new Map(),
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

  cleanupStalePageState() {
    document.querySelectorAll(".tg-card-overlay, .tg-page-badge, .tg-blur-overlay, .toxic-guard-badge, .tg-reddit-comment-badge-row").forEach((el) => {
      el.remove();
    });

    document.querySelectorAll(".tg-reddit-comment-block").forEach((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      el.remove();
    });

    document.querySelectorAll("[data-tg-blur], [data-tg-blurred], [data-tg-hard-block]").forEach((el) => {
      el.style.filter = "";
      el.style.pointerEvents = "";
      el.style.userSelect = "";
      el.style.cursor = "";
      el.removeAttribute("data-tg-blur");
      el.removeAttribute("data-tg-blurred");
      el.removeAttribute("data-tg-hard-block");
    });
  },

  schedulePageScan(delay = 0) {
    clearTimeout(this._domScanTimer);
    this._domScanTimer = setTimeout(() => this.scanPageContent(), delay);
  },

  // ─── Gọi API trực tiếp, không qua service worker ───────────────────────────
  async callApi(text) {
    if (!this._enabled) return { ok: true, result: { action: "ALLOW", label_name: "DISABLED", target_name: "" } };

    const cacheKey = text.trim().replace(/\s+/g, " ").slice(0, 500);
    if (this.apiCache.has(cacheKey)) return this.apiCache.get(cacheKey);

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
      const value = { ok: true, result };
      this.apiCache.set(cacheKey, value);
      if (this.apiCache.size > 300) this.apiCache.delete(this.apiCache.keys().next().value);
      return value;
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

      // Nếu element nằm HOÀN TOÀN ngoài viewport → ẩn overlay
      if (rect.bottom <= headerHeight || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
        entry.overlay.style.display = "none";
        continue;
      }

      // Clamp overlay: top không nhỏ hơn headerHeight để tránh đè lên header
      const top    = Math.max(headerHeight, rect.top);
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
        if (el.closest("shreddit-comment")) return;
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
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest("shreddit-comment")) return NodeFilter.FILTER_REJECT;
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
  _findSemanticRoot(el) {
    if (!el?.closest) return null;

    // Reddit comments can live under a post/article tree. Always bind to the
    // nearest comment first; otherwise overlays from a reply can be keyed to a
    // higher post/root and appear on a different comment.
    try {
      const redditComment = el.closest("shreddit-comment");
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
      return el.closest(SEMANTIC_ROOT_SELECTOR);
    } catch {
      return null;
    }
  },

  _findRedditCommentBody(commentEl, targetEl = null) {
    if (!commentEl?.matches?.("shreddit-comment")) return null;

    const selectors = [
      "[slot='comment']",
      "[id$='-comment-rtjson-content']",
      "[id*='comment-rtjson-content']",
      "[data-testid='comment']",
      ".md"
    ];

    for (const sel of selectors) {
      try {
        const matches = [
          ...(commentEl.matches?.(sel) ? [commentEl] : []),
          ...Array.from(commentEl.querySelectorAll(sel))
        ];
        const body = matches.find((node) => {
          if (targetEl && !node.contains(targetEl)) return false;
          const nestedComment = targetEl?.closest?.("shreddit-comment");
          if (nestedComment && nestedComment !== commentEl) return false;
          const r = node.getBoundingClientRect();
          return r.width > 50 && r.height > 12;
        });
        if (body) return body;
      } catch { /* ignore selector issues */ }
    }

    return null;
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
      const r = await this.callApi(text);
      if (!r.ok) {
        console.warn(`[ToxicGuard] API error: "${text.slice(0, 40)}" | ${r.error}`);
        return;
      }
      const action = r.result?.action || "ALLOW";
      console.log(`[ToxicGuard] API response → "${text.slice(0, 50)}" → ${action} (${r.result?.label_name || 'N/A'})`);

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
        this.blurElement(containerEl, r.result, semanticRoot);
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
      const redditOwnContentSelectors = [
        "[slot='comment']",
        "[id$='-comment-rtjson-content']",
        "[id*='comment-rtjson-content']",
        "[data-testid='comment']",
        ".md"
      ];

      for (const sel of redditOwnContentSelectors) {
        try {
          const matches = [
            ...(container.matches?.(sel) ? [container] : []),
            ...Array.from(container.querySelectorAll(sel))
          ];
          const ownContent = matches.find((node) => {
            if (!node.contains(targetEl)) return false;
            const nestedComment = targetEl.closest?.("shreddit-comment");
            if (nestedComment && nestedComment !== container) return false;
            const r = node.getBoundingClientRect();
            return r.width > 50 && r.height > 12;
          });
          if (ownContent) return ownContent;
        } catch { /* ignore selector issues */ }
      }
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
    if (scopeRoot && el.closest?.("shreddit-comment") !== scopeRoot) return;
    el.style.filter = "";
    el.style.pointerEvents = "";
    el.style.userSelect = "";
    el.style.cursor = "";
    el.removeAttribute("data-tg-blur");
    el.removeAttribute("data-tg-blurred");
    el.removeAttribute("data-tg-hard-block");
    el.classList.remove(
      "tg-reddit-comment-block",
      "tg-reddit-comment-block-block",
      "tg-reddit-comment-block-auto-block",
      "tg-reddit-comment-block-warn"
    );
    if (el.parentElement?.classList?.contains("tg-reddit-comment-block")) {
      const wrapper = el.parentElement;
      const parent = wrapper.parentElement;
      if (parent) {
        while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
        wrapper.remove();
      }
    }
    el.querySelectorAll?.("[data-tg-blurred], [data-tg-blur], [data-tg-hard-block]").forEach((child) => {
      if (scopeRoot && child.closest?.("shreddit-comment") !== scopeRoot) return;
      child.removeAttribute("data-tg-blur");
      child.removeAttribute("data-tg-blurred");
      child.removeAttribute("data-tg-hard-block");
    });
  },

  _removePageOverlayEntry(entry, restoreElement = false) {
    if (!entry) return;
    if (entry.overlay) entry.overlay.remove();
    if (restoreElement && Array.isArray(entry.metaEls)) {
      entry.metaEls.forEach((metaEl) => this._clearBlurState(metaEl, entry.rootEl));
    }
    if (entry.wrapper) {
      const parent = entry.wrapper.parentElement;
      if (parent) {
        while (entry.wrapper.firstChild) parent.insertBefore(entry.wrapper.firstChild, entry.wrapper);
      }
      entry.wrapper.remove();
    }
    entry.observer?.disconnect?.();
    if (entry.el) this.pageOverlayMap.delete(entry.el);
    if (entry.rootEl) this.pageOverlayRootMap.delete(entry.rootEl);
    if (restoreElement) this._clearBlurState(entry.el, entry.rootEl);
  },

  _buildBadgeText(result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    return isHardBlock ? `${label} (BLOCKED)` : label;
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
      return Array.from(commentEl.querySelectorAll(selectors)).filter((el) => {
        return el.closest?.("shreddit-comment") === commentEl;
      });
    } catch {
      return [];
    }
  },

  _applyRedditCommentMetaBlur(commentEl, result) {
    const action = result?.action || "BLOCK";
    const label = result?.label_name || "TOXIC";
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";

    this._findRedditCommentMetaElements(commentEl).forEach((metaEl) => {
      metaEl.dataset.tgBlurred = "1";
      metaEl.style.filter = "blur(8px)";
      metaEl.style.pointerEvents = "none";
      metaEl.style.userSelect = "none";
      metaEl.style.transition = "filter 0.3s ease";
      metaEl.setAttribute("data-tg-blur", action);
      metaEl.setAttribute("data-tg-hard-block", isHardBlock ? "1" : "0");
    });
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

  blurRedditCommentElement(el, result, rootEl) {
    const overlayRoot = rootEl || this._findSemanticRoot(el) || el;
    const severity = this._getOverlaySeverity(result);
    const action = result.action || "BLOCK";
    const label = result.label_name || "TOXIC";
    const actionClass = action.toLowerCase().replace("_", "-");
    const isHardBlock = action === "AUTO_BLOCK" || label === "HATE";
    const existingEntry = this.pageOverlayRootMap.get(overlayRoot);

    if (existingEntry) {
      if ((existingEntry.severity || 0) >= severity) return;
      existingEntry.overlay.className = `tg-reddit-comment-badge-row tg-reddit-comment-badge-row-${actionClass}`;
      existingEntry.overlay.querySelector(".tg-reddit-comment-badge").textContent = this._buildBadgeText(result);
      existingEntry.severity = severity;
      this._applyBlurState(existingEntry.el || el, result);
      this._applyRedditCommentMetaBlur(overlayRoot, result);
      return;
    }

    if (el.dataset.tgBlurred) return;

    const wrapper = document.createElement("div");
    wrapper.className = `tg-reddit-comment-block tg-reddit-comment-block-${actionClass}`;
    if (isHardBlock) wrapper.classList.add("tg-reddit-comment-hard-block");
    wrapper.dataset.tgOverlay = "1";
    wrapper.dataset.tgSourceText = (el.innerText || el.textContent || "").trim().slice(0, 160);
    wrapper.dataset.tgRootTag = overlayRoot.tagName || "";
    wrapper.dataset.tgRootId = overlayRoot.id || "";
    if (!this._wrapRedditCommentParts(wrapper, el, overlayRoot)) {
      el.parentElement?.insertBefore(wrapper, el);
      wrapper.appendChild(el);
    }

    this._applyBlurState(el, result);
    this._applyRedditCommentMetaBlur(overlayRoot, result);

    const row = document.createElement("div");
    row.className = `tg-reddit-comment-badge-row tg-reddit-comment-badge-row-${actionClass}`;
    row.setAttribute("data-tg-overlay", "1");
    row.dataset.tgSourceText = (el.innerText || el.textContent || "").trim().slice(0, 160);
    row.dataset.tgRootTag = overlayRoot.tagName || "";
    row.dataset.tgRootId = overlayRoot.id || "";

    const badge = document.createElement("span");
    badge.className = "tg-reddit-comment-badge";
    badge.textContent = this._buildBadgeText(result);
    row.appendChild(badge);

    if (wrapper) {
      wrapper.insertBefore(row, el);
    } else if (el.parentElement) {
      el.parentElement.insertBefore(row, el);
    } else {
      document.body.appendChild(row);
    }

    const entry = {
      overlay: row,
      observer: null,
      el,
      rootEl: overlayRoot,
      severity,
      inline: true,
      wrapper,
      metaEls: this._findRedditCommentMetaElements(overlayRoot)
    };
    this.pageOverlayRootMap.set(overlayRoot, entry);

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
  },

  blurElement(el, result, rootEl = null) {
    const overlayRoot = rootEl || this._findSemanticRoot(el) || el;
    if (overlayRoot?.matches?.("shreddit-comment")) {
      this.blurRedditCommentElement(el, result, overlayRoot);
      return;
    }

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

ToxicGuard.init();
