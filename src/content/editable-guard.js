(function installEditableGuard() {
  const EDITABLE_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    ".ProseMirror",
    ".monaco-editor",
    ".CodeMirror",
    ".cm-editor",
    "[data-lexical-editor='true']",
    "[data-slate-editor='true']"
  ].join(",");

  const OWNED_ATTRIBUTE = "data-edge-tts-editable-guard";

  function isExplicitEditable(element) {
    return element instanceof Element &&
      (element.matches(EDITABLE_SELECTOR) || element.isContentEditable);
  }

  function mark(element) {
    if (!(element instanceof Element)) return;

    if (isExplicitEditable(element)) {
      if (!element.hasAttribute("data-edge-tts-ui")) {
        element.setAttribute("data-edge-tts-ui", "true");
        element.setAttribute(OWNED_ATTRIBUTE, "true");
      }
      return;
    }

    if (element.hasAttribute(OWNED_ATTRIBUTE)) {
      element.removeAttribute(OWNED_ATTRIBUTE);
      element.removeAttribute("data-edge-tts-ui");
    }
  }

  function scan(root) {
    if (root instanceof Element) {
      mark(root);
    }

    root.querySelectorAll?.(EDITABLE_SELECTOR).forEach(mark);
  }

  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        mark(mutation.target);
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          scan(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["contenteditable", "role", "type"]
  });

  document.addEventListener("focusin", (event) => {
    const path = event.composedPath?.() || [event.target];
    for (const entry of path) {
      if (!(entry instanceof Element)) continue;
      const editable = entry.closest?.(EDITABLE_SELECTOR);
      if (editable) {
        mark(editable);
        break;
      }
    }
  }, true);
})();
