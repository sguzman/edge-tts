(function attachTextModel(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension) {
    root.EdgeTtsExtension.TextModel = api;
  }
})(globalThis, function createTextModelApi() {
  const BLOCK_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "pre",
    "figcaption",
    "dt",
    "dd",
    "td",
    "th"
  ].join(",");

  const EDITABLE_SELECTOR = [
    "textarea",
    "input",
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

  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "option",
    "button",
    "nav",
    "aside",
    "footer",
    "[hidden]",
    "[aria-hidden='true']",
    "[data-edge-tts-ui]",
    EDITABLE_SELECTOR
  ].join(",");

  const CHATGPT_MESSAGE_SELECTOR = [
    "[data-message-author-role='user']",
    "[data-message-author-role='assistant']"
  ].join(",");

  function siteProfileForHostname(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    if (
      normalized === "chatgpt.com" ||
      normalized.endsWith(".chatgpt.com") ||
      normalized === "chat.openai.com"
    ) {
      return "chatgpt";
    }
    return "generic";
  }

  function tokenizeText(text) {
    const tokens = [];
    const expression = /\S+/g;
    let match;

    while ((match = expression.exec(text)) !== null) {
      tokens.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }

    return tokens;
  }

  function trimSentenceRange(text, start, end) {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return start < end ? { start, end } : null;
  }

  function sentenceRanges(text, language) {
    const ranges = [];
    const Segmenter = globalThis.Intl?.Segmenter;

    if (typeof Segmenter === "function") {
      try {
        const segmenter = new Segmenter(language || undefined, { granularity: "sentence" });
        for (const sentence of segmenter.segment(text)) {
          const range = trimSentenceRange(
            text,
            sentence.index,
            sentence.index + sentence.segment.length
          );
          if (range) ranges.push(range);
        }
      } catch (_error) {
        // Fall through to punctuation segmentation below.
      }
    }

    if (ranges.length > 0) {
      return ranges;
    }

    const expression = /[^.!?]+(?:[.!?]+(?:["'”’\)\]]+)?(?=\s|$)|$)/g;
    let match;
    while ((match = expression.exec(text)) !== null) {
      const range = trimSentenceRange(text, match.index, match.index + match[0].length);
      if (range) ranges.push(range);
      if (match[0].length === 0) expression.lastIndex += 1;
    }

    if (ranges.length === 0 && /\S/.test(text)) {
      const range = trimSentenceRange(text, 0, text.length);
      if (range) ranges.push(range);
    }

    return ranges;
  }

  function annotateSentences(block, language) {
    const ranges = sentenceRanges(block.text, language);
    const sentences = [];
    let segmentCursor = 0;

    ranges.forEach((range, sentenceIndex) => {
      const sentenceSegments = [];

      while (
        segmentCursor < block.segments.length &&
        block.segments[segmentCursor].end <= range.start
      ) {
        segmentCursor += 1;
      }

      let cursor = segmentCursor;
      while (cursor < block.segments.length && block.segments[cursor].start < range.end) {
        const segment = block.segments[cursor];
        segment.sentenceIndex = sentenceIndex;
        sentenceSegments.push(segment);
        cursor += 1;
      }

      if (sentenceSegments.length > 0) {
        sentences.push({
          index: sentenceIndex,
          start: range.start,
          end: range.end,
          segments: sentenceSegments
        });
        segmentCursor = cursor;
      }
    });

    if (sentences.length === 0 && block.segments.length > 0) {
      for (const segment of block.segments) {
        segment.sentenceIndex = 0;
      }
      sentences.push({
        index: 0,
        start: 0,
        end: block.text.length,
        segments: [...block.segments]
      });
    }

    return sentences;
  }

  function isElementReadable(element, visibilityCache) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (visibilityCache?.has(element)) {
      return visibilityCache.get(element);
    }

    let readable = true;
    if (element.closest(EXCLUDED_SELECTOR)) {
      readable = false;
    } else {
      // Avoid getBoundingClientRect() while building the model. Repeated layout
      // reads are expensive on large application DOMs such as ChatGPT.
      const style = getComputedStyle(element);
      readable =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden";
    }

    visibilityCache?.set(element, readable);
    return readable;
  }

  function isTextNodeReadable(node, visibilityCache) {
    if (!(node instanceof Text) || !node.nodeValue || !/\S/.test(node.nodeValue)) {
      return false;
    }

    const parent = node.parentElement;
    return Boolean(parent && isElementReadable(parent, visibilityCache));
  }

  function extractBlock(element, blockIndex, visibilityCache, language) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const segments = [];
    let output = "";
    let current;

    while ((current = walker.nextNode())) {
      if (!isTextNodeReadable(current, visibilityCache)) {
        continue;
      }

      for (const token of tokenizeText(current.nodeValue)) {
        if (output.length > 0) {
          output += " ";
        }

        const start = output.length;
        output += token.text;
        const end = output.length;

        segments.push({
          blockIndex,
          segmentIndex: segments.length,
          text: token.text,
          start,
          end,
          node: current,
          nodeStart: token.start,
          nodeEnd: token.end,
          sentenceIndex: 0
        });
      }
    }

    if (segments.length === 0) {
      return null;
    }

    const messageRoot = element.closest?.(CHATGPT_MESSAGE_SELECTOR);
    const block = {
      index: blockIndex,
      element,
      text: output,
      segments,
      sentences: [],
      authorRole: messageRoot?.getAttribute("data-message-author-role") || ""
    };
    block.sentences = annotateSentences(block, language);
    return block;
  }

  function pickReadingRoot(doc, visibilityCache) {
    const semanticRoots = Array.from(doc.querySelectorAll("article,main,[role='main']"));
    const visibleRoots = semanticRoots.filter((element) =>
      isElementReadable(element, visibilityCache)
    );

    if (visibleRoots.length === 0) {
      return doc.body;
    }

    // textContent avoids innerText's layout-dependent traversal.
    return visibleRoots.reduce((best, candidate) => {
      const bestLength = best.textContent?.trim().length || 0;
      const candidateLength = candidate.textContent?.trim().length || 0;
      return candidateLength > bestLength ? candidate : best;
    });
  }

  function shouldKeepCandidate(element, visibilityCache) {
    if (!isElementReadable(element, visibilityCache)) {
      return false;
    }

    if (element.matches("li,blockquote") && element.querySelector("p")) {
      return false;
    }

    return true;
  }

  function collectChatGptCandidates(doc, visibilityCache) {
    const roots = Array.from(doc.querySelectorAll(CHATGPT_MESSAGE_SELECTOR)).filter(
      (element) =>
        !element.parentElement?.closest(CHATGPT_MESSAGE_SELECTOR) &&
        isElementReadable(element, visibilityCache)
    );

    if (roots.length === 0) {
      return [];
    }

    const candidates = [];
    for (const root of roots) {
      const nested = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) =>
        shouldKeepCandidate(element, visibilityCache)
      );

      if (nested.length > 0) {
        candidates.push(...nested);
      } else if (shouldKeepCandidate(root, visibilityCache)) {
        // User messages are often plain divs rather than paragraphs.
        candidates.push(root);
      }
    }
    return candidates;
  }

  function buildReadableModel(doc = document) {
    const visibilityCache = new WeakMap();
    const language = doc.documentElement?.lang || globalThis.navigator?.language;
    const profile = siteProfileForHostname(doc.location?.hostname);
    let readingRoot = null;
    let candidates = [];

    if (profile === "chatgpt") {
      candidates = collectChatGptCandidates(doc, visibilityCache);
    }

    if (candidates.length === 0) {
      readingRoot = pickReadingRoot(doc, visibilityCache);
      candidates = Array.from(readingRoot.querySelectorAll(BLOCK_SELECTOR)).filter((element) =>
        shouldKeepCandidate(element, visibilityCache)
      );
    }

    const blocks = [];
    const nodeToBlock = new WeakMap();

    for (const candidate of candidates) {
      const block = extractBlock(candidate, blocks.length, visibilityCache, language);
      if (!block || block.text.length < 2) {
        continue;
      }

      block.index = blocks.length;
      for (const segment of block.segments) {
        segment.blockIndex = block.index;
        nodeToBlock.set(segment.node, block);
      }
      blocks.push(block);
    }

    if (blocks.length === 0 && readingRoot === doc.body) {
      const fallback = extractBlock(doc.body, 0, visibilityCache, language);
      if (fallback) {
        for (const segment of fallback.segments) {
          nodeToBlock.set(segment.node, fallback);
        }
        blocks.push(fallback);
      }
    }

    return {
      blocks,
      nodeToBlock,
      profile: profile === "chatgpt" && blocks.length > 0 ? "chatgpt" : "generic"
    };
  }

  function findSegmentInNode(block, node, offset) {
    const matching = block.segments.filter((segment) => segment.node === node);
    if (matching.length === 0) {
      return null;
    }

    for (const segment of matching) {
      if (offset >= segment.nodeStart && offset <= segment.nodeEnd) {
        return segment;
      }
    }

    let nearest = matching[0];
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const segment of matching) {
      const distance = Math.min(
        Math.abs(offset - segment.nodeStart),
        Math.abs(offset - segment.nodeEnd)
      );
      if (distance < nearestDistance) {
        nearest = segment;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  function firstBlockNearViewport(blocks) {
    if (blocks.length === 0) {
      return null;
    }

    const visible = blocks.find((block) => {
      const rect = block.element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });

    if (visible) {
      return visible;
    }

    const below = blocks.find((block) => block.element.getBoundingClientRect().bottom > 0);
    return below || blocks[0];
  }

  function segmentIndexForCharIndex(starts, charIndex) {
    if (starts.length === 0) {
      return -1;
    }

    let low = 0;
    let high = starts.length - 1;
    let answer = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= charIndex) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return answer;
  }

  return {
    annotateSentences,
    buildReadableModel,
    findSegmentInNode,
    firstBlockNearViewport,
    segmentIndexForCharIndex,
    sentenceRanges,
    siteProfileForHostname,
    tokenizeText
  };
});
