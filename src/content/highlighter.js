(function attachHighlighter(root) {
  const extension = root.EdgeTtsExtension;
  const WORD_HIGHLIGHT_NAME = "edge-tts-current-word";
  const SENTENCE_HIGHLIGHT_NAME = "edge-tts-current-sentence";
  const STYLE_ID = "edge-tts-highlight-style";
  const DEFAULT_WORD_COLOR = "#ffd60a";
  const DEFAULT_SENTENCE_COLOR = "#bde0fe";

  function normalizeColor(color, fallback) {
    return /^#[0-9a-f]{6}$/i.test(color || "") ? color.toLowerCase() : fallback;
  }

  function colorWithAlpha(color, alpha) {
    return `${color}${alpha}`;
  }

  function rangesForSegments(segments) {
    const ranges = [];
    let run = null;

    function pushRun() {
      if (!run) return;
      const range = document.createRange();
      range.setStart(run.node, run.start);
      range.setEnd(run.node, run.end);
      ranges.push(range);
      run = null;
    }

    for (const segment of segments) {
      if (!run || run.node !== segment.node) {
        pushRun();
        run = {
          node: segment.node,
          start: segment.nodeStart,
          end: segment.nodeEnd
        };
      } else {
        run.end = segment.nodeEnd;
      }
    }
    pushRun();
    return ranges;
  }

  class Highlighter {
    constructor() {
      this.lastRange = null;
      this.usingCustomHighlight = Boolean(root.CSS?.highlights && root.Highlight);
      this.autoScroll = true;
      this.wordColor = DEFAULT_WORD_COLOR;
      this.sentenceColor = DEFAULT_SENTENCE_COLOR;
      this.ensureStyle();
    }

    ensureStyle() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        style.dataset.edgeTtsUi = "true";
        document.documentElement.appendChild(style);
      }
      this.styleElement = style;
      this.updateStyle();
    }

    updateStyle() {
      if (!this.styleElement) return;
      this.styleElement.textContent = `
        ::highlight(${SENTENCE_HIGHLIGHT_NAME}) {
          background-color: ${colorWithAlpha(this.sentenceColor, "66")};
          color: inherit;
        }
        ::highlight(${WORD_HIGHLIGHT_NAME}) {
          background-color: ${colorWithAlpha(this.wordColor, "cc")};
          color: inherit;
        }
      `;
    }

    setColors(wordColor, sentenceColor) {
      this.wordColor = normalizeColor(wordColor, DEFAULT_WORD_COLOR);
      this.sentenceColor = normalizeColor(sentenceColor, DEFAULT_SENTENCE_COLOR);
      this.updateStyle();
    }

    setAutoScroll(enabled) {
      this.autoScroll = Boolean(enabled);
    }

    clear() {
      if (this.usingCustomHighlight) {
        root.CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
        root.CSS.highlights.delete(SENTENCE_HIGHLIGHT_NAME);
      } else if (this.lastRange) {
        const selection = root.getSelection();
        if (selection && selection.rangeCount > 0) {
          selection.removeAllRanges();
        }
      }
      this.lastRange = null;
    }

    highlight(block, segment) {
      this.clear();

      const wordRange = document.createRange();
      wordRange.setStart(segment.node, segment.nodeStart);
      wordRange.setEnd(segment.node, segment.nodeEnd);
      this.lastRange = wordRange;

      if (this.usingCustomHighlight) {
        const sentence = block?.sentences?.[segment.sentenceIndex];
        if (sentence?.segments?.length) {
          const sentenceHighlight = new root.Highlight(...rangesForSegments(sentence.segments));
          sentenceHighlight.priority = 1;
          root.CSS.highlights.set(SENTENCE_HIGHLIGHT_NAME, sentenceHighlight);
        }

        const wordHighlight = new root.Highlight(wordRange);
        wordHighlight.priority = 2;
        root.CSS.highlights.set(WORD_HIGHLIGHT_NAME, wordHighlight);
      } else {
        const selection = root.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(wordRange);
      }

      this.keepRangeInView(wordRange, segment.node.parentElement);
    }

    keepRangeInView(range, element) {
      if (!this.autoScroll) return;

      const rect = range.getBoundingClientRect();
      const upperBoundary = root.innerHeight * 0.18;
      const lowerBoundary = root.innerHeight * 0.82;

      if ((rect.top < upperBoundary || rect.bottom > lowerBoundary) && element) {
        element.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }
  }

  extension.Highlighter = {
    DEFAULT_SENTENCE_COLOR,
    DEFAULT_WORD_COLOR,
    Highlighter,
    normalizeColor,
    rangesForSegments
  };
})(globalThis);
