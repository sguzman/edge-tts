(function attachHighlighter(root) {
  const extension = root.EdgeTtsExtension;
  const WORD_HIGHLIGHT_NAME = "edge-tts-current-word";
  const SENTENCE_HIGHLIGHT_NAME = "edge-tts-current-sentence";
  const STYLE_ID = "edge-tts-highlight-style";
  const DEFAULT_WORD_COLOR = "#ffd60a";
  const DEFAULT_SENTENCE_COLOR = "#bde0fe";

  function segmentCanHighlight(segment) {
    const validator = extension.TextModel?.segmentIsLive;
    if (typeof validator === "function") {
      return validator(segment);
    }

    const node = segment?.node;
    if (!(node instanceof Text) || !node.isConnected) return false;
    const start = Number(segment.nodeStart);
    const end = Number(segment.nodeEnd);
    const value = String(node.nodeValue || "");
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end >= start &&
      end <= value.length &&
      value.slice(start, end) === String(segment.text || "")
    );
  }

  function normalizeColor(color, fallback) {
    return /^#[0-9a-f]{6}$/i.test(color || "") ? color.toLowerCase() : fallback;
  }

  function colorWithAlpha(color, alpha) {
    return `${color}${alpha}`;
  }

  function rangesForSegments(segments) {
    if (!(segments || []).every(segmentCanHighlight)) {
      return [];
    }

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

    try {
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
    } catch (_error) {
      return [];
    }

    return ranges;
  }

  class Highlighter {
    constructor() {
      this.lastRange = null;
      this.usingCustomHighlight = Boolean(root.CSS?.highlights && root.Highlight);
      this.autoScroll = true;
      this.wordColor = DEFAULT_WORD_COLOR;
      this.sentenceColor = DEFAULT_SENTENCE_COLOR;
      this.currentSentenceKey = null;
      this.styleElement = null;
      this.lastScrollCheckAt = 0;
    }

    ensureStyle() {
      if (this.styleElement?.isConnected) {
        return;
      }

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
      this.currentSentenceKey = null;
      this.lastScrollCheckAt = 0;
    }

    highlight(block, segment) {
      this.ensureStyle();

      if (!segmentCanHighlight(segment)) {
        this.clear();
        return false;
      }

      const sentence = block?.sentences?.[segment.sentenceIndex];
      if (
        this.usingCustomHighlight &&
        sentence?.segments?.length &&
        !sentence.segments.every(segmentCanHighlight)
      ) {
        this.clear();
        return false;
      }

      if (this.usingCustomHighlight) {
        root.CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
      } else if (this.lastRange) {
        const selection = root.getSelection();
        selection?.removeAllRanges();
      }

      let wordRange;
      try {
        wordRange = document.createRange();
        wordRange.setStart(segment.node, segment.nodeStart);
        wordRange.setEnd(segment.node, segment.nodeEnd);
      } catch (_error) {
        this.clear();
        return false;
      }
      this.lastRange = wordRange;

      if (this.usingCustomHighlight) {
        const sentenceKey = `${segment.blockIndex}:${segment.sentenceIndex}`;
        if (sentenceKey !== this.currentSentenceKey) {
          root.CSS.highlights.delete(SENTENCE_HIGHLIGHT_NAME);
          if (sentence?.segments?.length) {
            const sentenceRanges = rangesForSegments(sentence.segments);
            if (!sentenceRanges.length) {
              this.clear();
              return false;
            }
            const sentenceHighlight = new root.Highlight(...sentenceRanges);
            sentenceHighlight.priority = 1;
            root.CSS.highlights.set(SENTENCE_HIGHLIGHT_NAME, sentenceHighlight);
          }
          this.currentSentenceKey = sentenceKey;
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
      return true;
    }

    keepRangeInView(range, element) {
      if (!this.autoScroll) return;

      // Range geometry forces layout. TTS can emit many word boundaries per
      // second, so throttle this work rather than forcing layout every word.
      const now = root.performance?.now?.() ?? Date.now();
      if (now - this.lastScrollCheckAt < 250) {
        return;
      }
      this.lastScrollCheckAt = now;

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
    rangesForSegments,
    segmentCanHighlight
  };
})(globalThis);
