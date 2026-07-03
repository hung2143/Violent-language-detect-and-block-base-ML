#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Replace blurRedditCommentElement with a no-DOM-wrap version.
The new version blurs only the <summary> element (own content of the comment),
NOT the whole shreddit-comment which includes replies.
"""

import re

with open('content.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the start and end of blurRedditCommentElement
start_marker = '  blurRedditCommentElement(el, result, rootEl) {'
# We know from line count that the function ends at line 1336 with '  },'
# Find the marker position
start_pos = content.find(start_marker)
if start_pos == -1:
    print('ERROR: Could not find function start')
    exit(1)

print(f'Found function start at char pos: {start_pos}')

# Find the end: look for the next top-level method definition after blurRedditCommentElement
# The function ends with '\n  },\n\n  _findGenericCommentGroup'
end_marker = '\n  _findGenericCommentGroup('
end_pos = content.find(end_marker, start_pos)
if end_pos == -1:
    print('ERROR: Could not find function end')
    exit(1)

# The old function content is from start_pos to end_pos + 1 (include the newline before end_marker)
old_func = content[start_pos:end_pos + 1]
print(f'Old function length: {len(old_func)} chars')
print(f'First 100 chars: {repr(old_func[:100])}')
print(f'Last 100 chars: {repr(old_func[-100:])}')

new_func = r"""  blurRedditCommentElement(el, result, rootEl) {
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
      if (existingEntry.overlay) existingEntry.overlay.className = `tg-reddit-comment-badge-row tg-reddit-comment-badge-row-${actionClass}`;
      existingEntry.severity = severity;
      this._applyBlurState(existingEntry.el || el, result);
      this._applyRedditCommentMetaBlur(overlayRoot, result);
      return;
    }

    if (el.dataset.tgBlurred) return;

    // === Tìm <summary> của shreddit-comment ===
    // DOM Reddit có dạng:
    //   shreddit-comment > details > summary (nội dung comment cha)
    //                               (nội dung bên ngoài summary = reply tree)
    // Chỉ blur <summary> để KHÔNG bao trùm reply tree
    let summaryEl = null;
    try {
      const detailsEl = overlayRoot.querySelector(":scope > details");
      if (detailsEl) {
        summaryEl = detailsEl.querySelector(":scope > summary");
      }
      if (!summaryEl) summaryEl = el.closest("summary");
    } catch { /* ignore */ }

    // blurTarget: summary nếu tìm được, ngược lại dùng bodyEl (el)
    const blurTarget = summaryEl || el;

    // Blur trực tiếp — KHÔNG tạo wrapper div để tránh bao trùm replies
    this._applyBlurState(blurTarget, result);
    this._applyRedditCommentMetaBlur(overlayRoot, result);

    // Tạo badge row và insert TRƯỚC blurTarget (không thay đổi cấu trúc reply tree)
    const row = document.createElement("div");
    row.className = `tg-reddit-comment-badge-row tg-reddit-comment-badge-row-${actionClass}`;
    row.setAttribute("data-tg-overlay", "1");
    row.dataset.tgSourceText = (el.innerText || el.textContent || "").trim().slice(0, 160);
    row.dataset.tgRootTag = overlayRoot.tagName || "";
    row.dataset.tgRootId = overlayRoot.id || "";

    // Đảm bảo không tạo badge trùng lặp
    if (blurTarget.parentElement && !blurTarget.parentElement.querySelector(".tg-reddit-comment-badge-row")) {
      const badge = document.createElement("span");
      badge.className = "tg-reddit-comment-badge";
      badge.textContent = this._buildBadgeText(result);
      row.appendChild(badge);
      blurTarget.parentElement.insertBefore(row, blurTarget);
    }

    // Đánh dấu background color trên parent của blurTarget (details hoặc overlayRoot)
    const bgTarget = blurTarget.parentElement || overlayRoot;
    if (bgTarget && bgTarget !== document.body) {
      bgTarget.classList.add(`tg-reddit-comment-block`, `tg-reddit-comment-block-${actionClass}`);
      if (isHardBlock) bgTarget.classList.add("tg-reddit-comment-hard-block");
      bgTarget.dataset.tgOverlay = "1";
      bgTarget.dataset.tgSourceText = row.dataset.tgSourceText;
      bgTarget.dataset.tgRootTag = row.dataset.tgRootTag;
      bgTarget.dataset.tgRootId = row.dataset.tgRootId;
    }

    const entry = {
      overlay: row,
      observer: null,
      el: blurTarget,
      rootEl: overlayRoot,
      severity,
      inline: true,
      wrapper: bgTarget !== document.body ? bgTarget : null,
      metaEls: this._findRedditCommentMetaElements(overlayRoot)
    };
    this.pageOverlayRootMap.set(overlayRoot, entry);

    if (!isHardBlock) {
      const reveal = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this._removePageOverlayEntry(entry, true);
        if (bgTarget && bgTarget !== document.body) {
          bgTarget.classList.remove(
            "tg-reddit-comment-block",
            `tg-reddit-comment-block-${actionClass}`,
            "tg-reddit-comment-hard-block"
          );
          delete bgTarget.dataset.tgOverlay;
        }
      };
      blurTarget.style.cursor = "pointer";
      blurTarget.title = "Click to reveal this offensive comment";
      row.style.cursor = "pointer";
      row.addEventListener("click", reveal, { once: true, capture: true });
      blurTarget.addEventListener("click", reveal, { once: true, capture: true });
    }
  },
"""

new_content = content[:start_pos] + new_func + content[end_pos + 1:]
print(f'Old content length: {len(content)}')
print(f'New content length: {len(new_content)}')

with open('content.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print('SUCCESS: File updated!')

# Verify
with open('content.js', 'r', encoding='utf-8') as f:
    verify = f.read()
print('Verify - summaryEl in new content:', 'summaryEl' in verify)
print('Verify - _wrapRedditCommentParts call removed:', '_wrapRedditCommentParts' not in verify[verify.find('blurRedditCommentElement'):verify.find('_findGenericCommentGroup')])
