// WKWebView applies macOS autocorrect / autocapitalization / inline text
// substitution to every editable field — the "Fifth" suggestion bubble that
// commits on Return or blur. None of it belongs in a SQL/data tool: column
// names, identifiers and values must stay verbatim. WebKit honors the
// `autocorrect` / `autocapitalize` content attributes per-field (there is no
// global switch), so we stamp them on every text field and watch for new ones.

const FIELDS = "input, textarea, [contenteditable]";

function disable(el: Element) {
  // skip explicit opt-ins (e.g. a future field that wants spellcheck)
  if (el.getAttribute("data-allow-autocorrect") === "true") return;
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("spellcheck", "false");
  // password managers / native autofill dropdowns are also noise here
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.setAttribute("autocomplete", "off");
  }
}

function scan(root: ParentNode) {
  root.querySelectorAll?.(FIELDS).forEach(disable);
}

/** Install once at app start. Covers existing and dynamically-added fields. */
export function installNoAutocorrect() {
  scan(document);
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const el = n as Element;
        if (el.matches?.(FIELDS)) disable(el);
        scan(el);
      });
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}
