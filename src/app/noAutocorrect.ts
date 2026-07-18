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

// The virtualized grid mounts thousands of nodes during a 60fps scroll; none
// of them can ever be (or contain) a form field: .vgrid-cell is spans/text
// (value + NULL/∅/DEFAULT chips), .vgrid-rownum is a number, .vgrid-hcell is
// spans + a plain button. Skip their subtrees entirely — draft cells
// (.vgrid-draftcell, real inputs) and the cell editor are NOT in this list
// and keep the full scan, as do modals/editors anywhere else.
function skipSubtree(el: Element): boolean {
  const cl = el.classList;
  return cl.contains("vgrid-cell") || cl.contains("vgrid-rownum") || cl.contains("vgrid-hcell");
}

/** Install once at app start. Covers existing and dynamically-added fields. */
export function installNoAutocorrect() {
  scan(document);
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const el = n as Element;
        // tag-gate the node itself before any selector work (contenteditable
        // must stay covered — CodeMirror's content div has no input/textarea)
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || el.hasAttribute("contenteditable")) {
          disable(el);
        }
        if (skipSubtree(el)) return;
        if (!el.firstElementChild) return; // leaf — no subtree to scan
        scan(el);
      });
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}
