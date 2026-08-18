(function attachHighlighter(root) {
  const extension = root.EdgeTtsExtension;
  const HIGHLIGHT_NAME = "edge-tts-current-word";

  class Highlighter {
    constructor() {
      this.lastRange = null;
      this.usingCustomHighlight = Boolean(root.CSS?.highlights && root.Highlight);
    }

    clear() {
      if (this.usingCustomHighlight) {
        root.CSS.highlights.delete(HIGHLIGHT_NAME);
      } else if (this.lastRange) {
        const selection = root.getSelection();
        if (selection && selection.rangeCount === 1) {
          selection.removeAllRanges();
        }
      }
      this.lastRange = null;
    }

    highlight(segment) {
      this.clear();

      const range = document.createRange();
      range.setStart(segment.node, segment.nodeStart);
      range.setEnd(segment.node, segment.nodeEnd);
      this.lastRange = range;

      if (this.usingCustomHighlight) {
        root.CSS.highlights.set(HIGHLIGHT_NAME, new root.Highlight(range));
      } else {
        const selection = root.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }

      this.keepRangeInView(range, segment.node.parentElement);
    }

    keepRangeInView(range, element) {
      const rect = range.getBoundingClientRect();
      const upperBoundary = root.innerHeight * 0.18;
      const lowerBoundary = root.innerHeight * 0.82;

      if ((rect.top < upperBoundary || rect.bottom > lowerBoundary) && element) {
        element.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }
  }

  extension.Highlighter = { Highlighter };
})(globalThis);
