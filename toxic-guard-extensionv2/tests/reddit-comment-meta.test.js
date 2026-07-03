const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadToxicGuard(document, globals = {}) {
  const contentPath = path.join(__dirname, "..", "content.js");
  const source = fs.readFileSync(contentPath, "utf8")
    .replace(/ToxicGuard\.init\(\);\s*$/, "globalThis.__ToxicGuard = ToxicGuard;");
  const context = vm.createContext({ console, document, ...globals });
  vm.runInContext(source, context, { filename: contentPath });
  return context.__ToxicGuard;
}

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toArray: () => [...values]
  };
}

function makeElement(tagName, document) {
  const el = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentElement: null,
    dataset: {},
    style: {},
    classList: makeClassList(),
    attributes: new Map(),
    isConnected: true,
    textContent: "",
    innerText: "",
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, before) {
      child.parentElement = this;
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      this.parentElement = null;
      this.isConnected = false;
    },
    contains(node) {
      return node === this || this.children.some((child) => child.contains(node));
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "class") {
        this.classList = makeClassList();
        String(value).split(/\s+/).filter(Boolean).forEach((part) => this.classList.add(part));
      }
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name.startsWith("data-tg-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        delete this.dataset[key];
      }
    },
    addEventListener() {},
    matches(selector) {
      if (selector === "shreddit-comment") return this.tagName === "SHREDDIT-COMMENT";
      const slotMatch = selector.match(/^\[slot='([^']+)'\]$/);
      if (slotMatch) return this.getAttribute("slot") === slotMatch[1];
      if (selector === "[id$='-comment-rtjson-content']") return (this.getAttribute("id") || "").endsWith("-comment-rtjson-content");
      if (selector === "[id*='comment-rtjson-content']") return (this.getAttribute("id") || "").includes("comment-rtjson-content");
      if (selector === "[data-testid='comment']") return this.getAttribute("data-testid") === "comment";
      if (selector === "[data-testid='user-flair']") return this.getAttribute("data-testid") === "user-flair";
      if (selector === ".md") return this.classList.contains("md");
      return false;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelector(selector) {
      if (selector === ":scope > details") {
        return this.children.find((child) => child.tagName === "DETAILS") || null;
      }
      if (selector === ":scope > summary") {
        return this.children.find((child) => child.tagName === "SUMMARY") || null;
      }
      if (selector === ".tg-reddit-comment-badge") {
        return this.querySelectorAll("*").find((child) => child.classList.contains("tg-reddit-comment-badge")) || null;
      }
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = (node) => node.children.forEach((child) => {
        descendants.push(child);
        visit(child);
      });
      visit(this);
      if (selector === "*") return descendants;
      if (selector.includes(",")) {
        const selectors = selector.split(",").map((part) => part.trim());
        return descendants.filter((child) => selectors.some((part) => child.matches(part)));
      }
      return descendants.filter((child) => child.matches(selector));
    }
  };
  Object.defineProperty(el, "className", {
    get: () => el.classList.toArray().join(" "),
    set: (value) => {
      el.classList = makeClassList();
      String(value).split(/\s+/).filter(Boolean).forEach((part) => el.classList.add(part));
    }
  });
  document.connected.add(el);
  el.getBoundingClientRect = () => ({ width: 500, height: 40, top: 0, right: 500, bottom: 40, left: 0 });
  return el;
}

function makeDocument() {
  const document = {
    connected: new Set(),
    querySelectorAll: () => [],
    createElement: (tagName) => makeElement(tagName, document)
  };
  document.body = makeElement("body", document);
  document.body.contains = (el) => el?.isConnected !== false;
  return document;
}

function appendRedditComment(document, parent, text) {
  const comment = makeElement("shreddit-comment", document);
  const body = makeElement("div", document);
  body.setAttribute("slot", "comment");
  body.innerText = text;
  body.textContent = text;
  parent.appendChild(comment);
  comment.appendChild(body);
  return { comment, body };
}

test("each Reddit comment owns a separate badge and only its own body is blurred", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const parent = appendRedditComment(document, document.body, "parent toxic comment");
  const reply = appendRedditComment(document, parent.comment, "reply toxic comment");

  guard.blurRedditCommentElement(parent.body, { action: "BLOCK", label_name: "TOXIC" }, parent.comment);

  const parentEntry = guard.pageOverlayRootMap.get(parent.comment);
  assert.ok(parentEntry, "parent comment should own an overlay entry");
  assert.equal(parentEntry.el, parent.body);
  assert.equal(parent.body.style.filter, "blur(8px)");
  assert.equal(reply.body.style.filter, undefined, "a nested reply must not inherit its parent's blur");
  assert.equal(parent.comment.classList.contains("tg-reddit-comment-block"), false);
  assert.equal(parentEntry.overlay.parentElement, document.body);
  assert.equal(parentEntry.overlay.classList.contains("tg-reddit-comment-card"), true);
  assert.equal(parentEntry.anchorEls.length, 1);
  assert.equal(parentEntry.anchorEls[0], parent.body);

  guard.blurRedditCommentElement(reply.body, { action: "WARN", label_name: "TOXIC" }, reply.comment);

  const replyEntry = guard.pageOverlayRootMap.get(reply.comment);
  assert.ok(replyEntry, "reply should own a different overlay entry");
  assert.notEqual(replyEntry.overlay, parentEntry.overlay);
  assert.equal(replyEntry.overlay.parentElement, document.body);
  assert.equal(replyEntry.anchorEls[0], reply.body);
});

test("Reddit author identity is blurred without affecting a nested reply author", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "toxic comment");
  const author = makeElement("a", document);
  author.setAttribute("slot", "commentAuthor");
  const avatar = makeElement("img", document);
  avatar.setAttribute("slot", "commentAvatar");
  comment.insertBefore(author, body);
  comment.insertBefore(avatar, body);
  const reply = appendRedditComment(document, comment, "safe reply");
  const replyAuthor = makeElement("a", document);
  replyAuthor.setAttribute("slot", "commentAuthor");
  reply.comment.insertBefore(replyAuthor, reply.body);
  guard.blurRedditCommentElement(body, { action: "BLOCK", label_name: "TOXIC" }, comment);

  assert.equal(author.style.filter, "blur(8px)");
  assert.equal(avatar.style.filter, "blur(8px)");
  assert.equal(replyAuthor.style.filter, undefined, "identity blur must not leak into a reply");
  assert.equal(body.style.filter, "blur(8px)");
  const entry = guard.pageOverlayRootMap.get(comment);
  assert.equal(entry.metaEls.length, 2);
  assert.equal(entry.metaEls[0], author);
  assert.equal(entry.metaEls[1], avatar);

  guard._removePageOverlayEntry(entry, true);
  assert.equal(author.style.filter, "");
  assert.equal(avatar.style.filter, "");
  assert.equal(author.classList.contains("tg-reddit-identity-blur"), false);
});

test("Reddit body blur survives reconciliation and is fully restored with its own badge", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "toxic comment");
  document.querySelectorAll = (selector) => selector === "[data-tg-blur]" ? [body] : [];

  guard.blurRedditCommentElement(body, { action: "BLOCK", label_name: "TOXIC" }, comment);
  const entry = guard.pageOverlayRootMap.get(comment);

  guard.reconcileBlurState();
  assert.equal(body.style.filter, "blur(8px)", "live per-comment badge should retain its body blur");

  guard._removePageOverlayEntry(entry, true);
  assert.equal(body.style.filter, "");
  assert.equal(entry.overlay.isConnected, false);
  assert.equal(guard.pageOverlayRootMap.get(comment), undefined);
});

test("a Reddit body wrapper containing replies is never blurred as one combined region", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const comment = makeElement("shreddit-comment", document);
  const broadBody = makeElement("div", document);
  broadBody.setAttribute("slot", "comment");
  const ownBody = makeElement("div", document);
  ownBody.setAttribute("id", "parent-comment-rtjson-content");
  ownBody.innerText = "parent toxic comment";
  ownBody.textContent = "parent toxic comment";
  document.body.appendChild(comment);
  comment.appendChild(broadBody);
  broadBody.appendChild(ownBody);
  const reply = appendRedditComment(document, broadBody, "safe nested reply");

  guard.blurRedditCommentElement(broadBody, { action: "AUTO_BLOCK", label_name: "HATE" }, comment);

  const entry = guard.pageOverlayRootMap.get(comment);
  assert.ok(entry);
  assert.equal(entry.el, ownBody, "the smallest own-comment content should own the blur");
  assert.equal(broadBody.style.filter, undefined, "the wrapper containing replies must never receive CSS filter");
  assert.equal(ownBody.style.filter, "blur(8px)");
  assert.equal(reply.body.style.filter, undefined);
  assert.equal(entry.overlay.parentElement, document.body);
  assert.equal(broadBody.children[0], ownBody);
  assert.equal(entry.anchorEls.includes(reply.body), false);
});

test("one Reddit card covers the union of avatar, username, and own comment body", () => {
  const document = makeDocument();
  const viewport = {
    innerWidth: 1000,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    addEventListener() {}
  };
  const guard = loadToxicGuard(document, {
    window: viewport,
    requestAnimationFrame: () => 1
  });
  const { comment, body } = appendRedditComment(document, document.body, "toxic comment");
  const author = makeElement("a", document);
  author.setAttribute("slot", "commentAuthor");
  const avatar = makeElement("img", document);
  avatar.setAttribute("slot", "commentAvatar");
  comment.insertBefore(author, body);
  comment.insertBefore(avatar, body);
  avatar.getBoundingClientRect = () => ({ top: 100, left: 20, right: 52, bottom: 132, width: 32, height: 32 });
  author.getBoundingClientRect = () => ({ top: 104, left: 60, right: 210, bottom: 124, width: 150, height: 20 });
  body.getBoundingClientRect = () => ({ top: 145, left: 60, right: 560, bottom: 225, width: 500, height: 80 });

  guard.blurRedditCommentElement(body, { action: "AUTO_BLOCK", label_name: "HATE" }, comment);
  guard.updatePageOverlays();

  const entry = guard.pageOverlayRootMap.get(comment);
  assert.equal(entry.anchorEls.length, 3);
  assert.equal(entry.overlay.style.top, "96px");
  assert.equal(entry.overlay.style.left, "16px");
  assert.equal(entry.overlay.style.width, "548px");
  assert.equal(entry.overlay.style.height, "133px");
});

test("a stale toxic result cannot attach to a Reddit node whose text was recycled", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "clean replacement comment");

  guard.blurRedditCommentElement(
    body,
    { action: "AUTO_BLOCK", label_name: "HATE" },
    comment,
    "old toxic comment"
  );

  assert.equal(guard.pageOverlayRootMap.get(comment), undefined);
  assert.equal(body.style.filter, undefined);
});

test("an existing Reddit card is removed when its source comment text changes", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "original toxic comment");
  document.querySelectorAll = (selector) => selector === "[data-tg-blur]" ? [body] : [];

  guard.blurRedditCommentElement(
    body,
    { action: "AUTO_BLOCK", label_name: "HATE" },
    comment,
    "original toxic comment"
  );
  const entry = guard.pageOverlayRootMap.get(comment);
  body.innerText = "clean replacement comment";
  body.textContent = "clean replacement comment";

  guard.reconcileBlurState();

  assert.equal(guard.pageOverlayRootMap.get(comment), undefined);
  assert.equal(entry.overlay.isConnected, false);
  assert.equal(body.style.filter, "");
});

test("a cached block is confirmed fresh before any Reddit badge is created", async () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "clean comment");
  const calls = [];
  guard._findSemanticRoot = () => comment;
  guard.callApi = async (_text, options = {}) => {
    calls.push(options);
    if (calls.length === 1) {
      return { ok: true, fromCache: true, result: { action: "AUTO_BLOCK", label_name: "HATE" } };
    }
    return { ok: true, fromCache: false, result: { action: "ALLOW", label_name: "CLEAN" } };
  };
  let blurCount = 0;
  guard.blurElement = () => { blurCount += 1; };

  await guard.checkAndBlur(body, "clean comment");

  assert.equal(calls.length, 2);
  assert.equal(calls[1].bypassCache, true);
  assert.equal(blurCount, 0);
  assert.equal(guard.pageOverlayRootMap.get(comment), undefined);
});

test("live revalidation removes a Reddit card when the backend now returns ALLOW", async () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment, body } = appendRedditComment(document, document.body, "clean comment");
  guard.blurRedditCommentElement(
    body,
    { action: "AUTO_BLOCK", label_name: "HATE" },
    comment,
    "clean comment"
  );
  const entry = guard.pageOverlayRootMap.get(comment);
  guard.callApi = async () => ({ ok: true, result: { action: "ALLOW", label_name: "CLEAN" } });

  await guard._revalidateRedditEntry(entry);

  assert.equal(guard.pageOverlayRootMap.get(comment), undefined);
  assert.equal(entry.overlay.isConnected, false);
  assert.equal(body.style.filter, "");
});

test("an orphan Reddit card from an older content-script instance is removed", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const orphan = makeElement("div", document);
  orphan.className = "tg-reddit-comment-card tg-reddit-comment-card-auto-block";
  document.body.appendChild(orphan);
  document.querySelectorAll = (selector) => selector === ".tg-reddit-comment-card, .tg-card-overlay" ? [orphan] : [];

  guard.reconcileBlurState();

  assert.equal(orphan.isConnected, false);
});

test("a node inside a Reddit shadow tree resolves to its composed shreddit-comment root", () => {
  const document = makeDocument();
  const guard = loadToxicGuard(document);
  const { comment } = appendRedditComment(document, document.body, "comment text");
  const shadowHost = makeElement("reddit-comment-content", document);
  comment.appendChild(shadowHost);
  const internalNode = makeElement("span", document);
  internalNode.getRootNode = () => ({ host: shadowHost });

  assert.equal(guard._findSemanticRoot(internalNode), comment);
  assert.equal(guard.blurGenericCommentElement(internalNode, { action: "AUTO_BLOCK", label_name: "HATE" }), false);
});

test("an unowned node on reddit.com cannot create a generic floating card", () => {
  const document = makeDocument();
  document.documentElement = makeElement("html", document);
  const guard = loadToxicGuard(document, { location: { hostname: "www.reddit.com" } });
  const unrelatedNode = makeElement("div", document);
  document.body.appendChild(unrelatedNode);

  guard.blurElement(
    unrelatedNode,
    { action: "AUTO_BLOCK", label_name: "HATE" },
    unrelatedNode,
    "clean comment"
  );

  assert.equal(guard.pageOverlayMap.size, 0);
  assert.equal(unrelatedNode.style.filter, undefined);
});
