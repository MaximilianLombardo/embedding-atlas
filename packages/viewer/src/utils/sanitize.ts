// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import DOMPurify from "dompurify";

// URL scheme allowlist for href/src attributes. DOMPurify only tests this
// regexp against values that carry a scheme (text before a `:` and any
// `/`, `?` or `#`); relative URLs and in-page anchors have no scheme and are
// always allowed. Restricting the scheme set to http(s) and mailto thus
// neutralizes `javascript:` (script execution) and `data:` URLs (data-exfil
// images, SVG/HTML payloads) that a markdown link/image emitted by the model
// — or untrusted dataset content rendered through a Liquid template — could
// otherwise smuggle through DOMPurify's more permissive default scheme list.
// `tel:` is intentionally excluded; add it here if a feature needs it.
const ALLOWED_URI_REGEXP = /^(?:https?|mailto):/i;

// Make all links open a new window with a safe rel.
DOMPurify.addHook?.("afterSanitizeAttributes", (node) => {
  if ("target" in node) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function sanitizeHTML(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP });
}
