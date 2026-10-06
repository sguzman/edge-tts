(function attachTextModel(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension) {
    root.EdgeTtsExtension.TextModel = api;
  }
})(globalThis, function createTextModelApi(root) {
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

  const CHATGPT_RICH_DOCUMENT_SELECTOR = [
    "[contenteditable]:not([contenteditable='false'])",
    ".ProseMirror",
    "[data-lexical-editor='true']",
    "[data-slate-editor='true']"
  ].join(",");

  const EDITABLE_SELECTOR = [
    "textarea",
    "input",
    "select",
    CHATGPT_RICH_DOCUMENT_SELECTOR,
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    ".monaco-editor",
    ".CodeMirror",
    ".cm-editor"
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
    "[role='status']",
    "[role='alert']",
    "[data-edge-tts-ui]"
  ].join(",");

  const A11Y_ONLY_SELECTOR = [
    ".sr-only",
    "[data-radix-visually-hidden]",
    "[data-visually-hidden='true']",
    "[class*='visually-hidden']",
    "[class*='screen-reader-only']"
  ].join(",");

  const CHATGPT_MESSAGE_SELECTOR = [
    "[data-message-author-role='user']",
    "[data-message-author-role='assistant']"
  ].join(",");

  // X/Twitter renders tweet prose in div-based application widgets rather than
  // semantic <p> blocks, so the generic block selector misses the actual post
  // text even when <main> is selected correctly.
  const X_TWEET_TEXT_SELECTOR = "[data-testid='tweetText']";

  function siteProfileForHostname(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    if (
      normalized === "chatgpt.com" ||
      normalized.endsWith(".chatgpt.com") ||
      normalized === "chat.openai.com"
    ) {
      return "chatgpt";
    }
    if (
      normalized === "x.com" ||
      normalized.endsWith(".x.com") ||
      normalized === "twitter.com" ||
      normalized.endsWith(".twitter.com")
    ) {
      return "x";
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
    const lanternLeafRanges =
      root.EdgeTtsExtension?.Pronunciation?.sentenceRanges?.(text);
    if (Array.isArray(lanternLeafRanges) && lanternLeafRanges.length > 0) {
      return lanternLeafRanges;
    }

    // Non-Piper/minimal test fallback only. Runtime pronunciation builds load
    // the Lantern Leaf-derived boundary model before this module.
    const ranges = [];
    const Segmenter = root.Intl?.Segmenter;

    if (typeof Segmenter === "function") {
      try {
        const segmenter = new Segmenter(language || undefined, {
          granularity: "sentence"
        });
        for (const sentence of segmenter.segment(text)) {
          const range = trimSentenceRange(
            text,
            sentence.index,
            sentence.index + sentence.segment.length
          );
          if (range) ranges.push(range);
        }
      } catch (_error) {}
    }

    if (ranges.length > 0) return ranges;

    const expression = /[^.!?]+(?:[.!?]+(?:["'”’\)\]]+)?(?=\s|$)|$)/g;
    let match;
    while ((match = expression.exec(text)) !== null) {
      const range = trimSentenceRange(
        text,
        match.index,
        match.index + match[0].length
      );
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

  function numericCssPixels(value) {
    const parsed = Number.parseFloat(String(value || ""));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  }

  function isVisuallyHiddenElement(element, computedStyle = null) {
    if (!(element instanceof Element)) return true;
    if (element.closest(A11Y_ONLY_SELECTOR)) return true;

    const style = computedStyle || getComputedStyle(element);
    if (Number(style.opacity) === 0) return true;

    const clip = String(style.clip || "").replace(/\s+/g, "").toLowerCase();
    const clipPath = String(style.clipPath || "")
      .replace(/\s+/g, "")
      .toLowerCase();

    if (
      clip === "rect(0px,0px,0px,0px)" ||
      clip === "rect(0,0,0,0)" ||
      clipPath === "inset(50%)" ||
      clipPath === "inset(100%)"
    ) {
      return true;
    }

    const width = numericCssPixels(style.width);
    const height = numericCssPixels(style.height);
    const onePixelClip =
      (style.position === "absolute" || style.position === "fixed") &&
      width <= 1 &&
      height <= 1 &&
      style.overflow === "hidden" &&
      (style.whiteSpace === "nowrap" || clip.includes("rect("));

    return onePixelClip;
  }

  function isChatGptAssistantRichDocumentContent(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const messageRoot = element.closest?.(
      "[data-message-author-role='assistant']"
    );
    const documentRoot = element.closest?.(
      CHATGPT_RICH_DOCUMENT_SELECTOR
    );

    return Boolean(
      messageRoot &&
      documentRoot &&
      (
        messageRoot === documentRoot ||
        messageRoot.contains?.(documentRoot)
      )
    );
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
    } else if (
      element.closest(EDITABLE_SELECTOR) &&
      !isChatGptAssistantRichDocumentContent(element)
    ) {
      readable = false;
    } else {
      // Avoid getBoundingClientRect() while building the model. Repeated layout
      // reads are expensive on large application DOMs such as ChatGPT.
      const style = getComputedStyle(element);
      readable =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden" &&
        !isVisuallyHiddenElement(element, style);
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

  function collectChatGptEmbeddedDocumentRoots(root, visibilityCache) {
    const possibleRoots = [];
    if (root.matches?.(CHATGPT_RICH_DOCUMENT_SELECTOR)) {
      possibleRoots.push(root);
    }
    possibleRoots.push(
      ...Array.from(root.querySelectorAll(CHATGPT_RICH_DOCUMENT_SELECTOR))
    );

    return possibleRoots.filter((element) => {
      if (!isElementReadable(element, visibilityCache)) {
        return false;
      }

      const parentDocument = element.parentElement?.closest?.(
        CHATGPT_RICH_DOCUMENT_SELECTOR
      );
      return !parentDocument || !root.contains?.(parentDocument);
    });
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
      const embeddedDocuments = collectChatGptEmbeddedDocumentRoots(
        root,
        visibilityCache
      );

      if (nested.length > 0) {
        candidates.push(...nested);
      }

      // ChatGPT writing/document blocks can be rich editable surfaces whose
      // visible prose is rendered mostly as divs. If normal semantic block
      // extraction found nothing inside one of those documents, treat that
      // document root as a readable block. Controls remain excluded by the
      // hard UI selectors and text-node readability checks.
      for (const documentRoot of embeddedDocuments) {
        const hasSemanticCandidate = nested.some((element) =>
          documentRoot === element || documentRoot.contains?.(element)
        );
        if (!hasSemanticCandidate) {
          candidates.push(documentRoot);
        }
      }

      if (
        nested.length === 0 &&
        embeddedDocuments.length === 0 &&
        shouldKeepCandidate(root, visibilityCache)
      ) {
        // User messages are often plain divs rather than paragraphs.
        candidates.push(root);
      }
    }
    return candidates;
  }

  function collectXCandidates(doc, visibilityCache) {
    return Array.from(doc.querySelectorAll(X_TWEET_TEXT_SELECTOR)).filter(
      (element) => {
        if (!shouldKeepCandidate(element, visibilityCache)) {
          return false;
        }

        // X can transiently duplicate tweet DOM during navigation/virtualized
        // timeline updates. Keep only top-level tweetText containers.
        return !element.parentElement?.closest(X_TWEET_TEXT_SELECTOR);
      }
    );
  }

  function buildReadableModel(doc = document) {
    const visibilityCache = new WeakMap();
    const language = doc.documentElement?.lang || globalThis.navigator?.language;
    const profile = siteProfileForHostname(doc.location?.hostname);
    let readingRoot = null;
    let candidates = [];

    if (profile === "chatgpt") {
      candidates = collectChatGptCandidates(doc, visibilityCache);
    } else if (profile === "x") {
      candidates = collectXCandidates(doc, visibilityCache);
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
      profile:
        (profile === "chatgpt" || profile === "x") && blocks.length > 0
          ? profile
          : "generic"
    };
  }

  function segmentIsLive(segment) {
    const node = segment?.node;
    if (!(node instanceof Text) || !node.isConnected) {
      return false;
    }

    const start = Number(segment.nodeStart);
    const end = Number(segment.nodeEnd);
    const value = String(node.nodeValue || "");
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > value.length
    ) {
      return false;
    }

    return value.slice(start, end) === String(segment.text || "");
  }

  function blockIsLive(block) {
    if (!block?.element?.isConnected) {
      return false;
    }
    const segments = Array.isArray(block.segments) ? block.segments : [];
    return segments.length > 0 && segments.every(segmentIsLive);
  }

  function matchingSegmentPrefixLength(leftSegments, rightSegments) {
    const left = Array.isArray(leftSegments) ? leftSegments : [];
    const right = Array.isArray(rightSegments) ? rightSegments : [];
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (
      index < limit &&
      String(left[index]?.text || "") === String(right[index]?.text || "")
    ) {
      index += 1;
    }
    return index;
  }

  function relocateCursorAfterRebuild(anchor, freshModel) {
    if (!anchor || !Array.isArray(freshModel?.blocks)) {
      return null;
    }

    const candidates = [];
    for (const block of freshModel.blocks) {
      if (String(block?.authorRole || "") !== String(anchor.authorRole || "")) {
        continue;
      }

      const prefix = matchingSegmentPrefixLength(
        anchor.segments,
        block?.segments
      );
      if (prefix <= Number(anchor.segmentIndex)) {
        continue;
      }

      candidates.push({
        block,
        prefix,
        distance: Math.abs(
          Number(block.index) - Number(anchor.blockIndex)
        )
      });
    }

    candidates.sort((left, right) =>
      right.prefix - left.prefix ||
      left.distance - right.distance
    );

    const best = candidates[0]?.block;
    if (!best) return null;

    return {
      blockIndex: best.index,
      segmentIndex: Math.min(
        Math.max(0, Number(anchor.segmentIndex) || 0),
        Math.max(0, best.segments.length - 1)
      )
    };
  }

  function relocateSegmentByLocalContext(anchor, freshModel) {
    if (
      !anchor ||
      !Array.isArray(anchor.segments) ||
      !Array.isArray(freshModel?.blocks)
    ) {
      return null;
    }

    const sourceIndex = Number(anchor.segmentIndex);
    if (
      !Number.isInteger(sourceIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= anchor.segments.length
    ) {
      return null;
    }

    const sourceToken = String(anchor.segments[sourceIndex]?.text || "");
    if (!sourceToken) return null;

    const sourceRole = String(anchor.authorRole || "");
    const sourceBlockIndex = Number(anchor.blockIndex);
    const candidates = [];
    const radius = 4;

    for (const block of freshModel.blocks) {
      if (String(block?.authorRole || "") !== sourceRole) continue;
      const segments = Array.isArray(block?.segments) ? block.segments : [];
      if (!segments.length) continue;

      for (let index = 0; index < segments.length; index += 1) {
        if (String(segments[index]?.text || "") !== sourceToken) continue;

        let matched = 1;
        let compared = 1;
        let leftMatched = 0;
        let rightMatched = 0;

        for (let delta = 1; delta <= radius; delta += 1) {
          const sourceLeft = sourceIndex - delta;
          const freshLeft = index - delta;
          if (sourceLeft >= 0 && freshLeft >= 0) {
            compared += 1;
            if (
              String(anchor.segments[sourceLeft]?.text || "") ===
              String(segments[freshLeft]?.text || "")
            ) {
              matched += 1;
              leftMatched += 1;
            }
          }

          const sourceRight = sourceIndex + delta;
          const freshRight = index + delta;
          if (
            sourceRight < anchor.segments.length &&
            freshRight < segments.length
          ) {
            compared += 1;
            if (
              String(anchor.segments[sourceRight]?.text || "") ===
              String(segments[freshRight]?.text || "")
            ) {
              matched += 1;
              rightMatched += 1;
            }
          }
        }

        const contextMatches = leftMatched + rightMatched;
        const blockDistance = Number.isFinite(sourceBlockIndex)
          ? Math.abs(Number(block.index) - sourceBlockIndex)
          : 0;
        const segmentDistance = Math.abs(index - sourceIndex);

        candidates.push({
          blockIndex: block.index,
          segmentIndex: index,
          matched,
          compared,
          contextMatches,
          blockDistance,
          segmentDistance
        });
      }
    }

    if (!candidates.length) return null;

    candidates.sort((left, right) =>
      right.contextMatches - left.contextMatches ||
      right.matched - left.matched ||
      left.blockDistance - right.blockDistance ||
      left.segmentDistance - right.segmentDistance
    );

    const best = candidates[0];
    const tied = candidates[1];

    // A unique same-coordinate token is safe even when nearby text was
    // rewritten. Otherwise require at least one neighboring token to agree so
    // common words like "the" do not jump to an unrelated occurrence.
    const sameCoordinate =
      best.blockDistance === 0 &&
      best.segmentDistance === 0;

    if (
      !sameCoordinate &&
      best.contextMatches === 0
    ) {
      return null;
    }

    if (
      tied &&
      tied.contextMatches === best.contextMatches &&
      tied.matched === best.matched &&
      tied.blockDistance === best.blockDistance &&
      tied.segmentDistance === best.segmentDistance
    ) {
      return null;
    }

    return {
      blockIndex: best.blockIndex,
      segmentIndex: best.segmentIndex
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

    // Blocks are in DOM order. Binary-search the first block whose bottom is
    // below the top of the viewport instead of forcing layout for every block
    // in a long document/chat.
    let low = 0;
    let high = blocks.length - 1;
    let candidateIndex = blocks.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const rect = blocks[middle].element.getBoundingClientRect();
      if (rect.bottom > 0) {
        candidateIndex = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    const candidate = blocks[candidateIndex];
    const rect = candidate.element.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      return candidate;
    }

    return candidate || blocks[0];
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
    blockIsLive,
    buildReadableModel,
    findSegmentInNode,
    matchingSegmentPrefixLength,
    relocateCursorAfterRebuild,
    relocateSegmentByLocalContext,
    segmentIsLive,
    firstBlockNearViewport,
    segmentIndexForCharIndex,
    sentenceRanges,
    siteProfileForHostname,
    collectXCandidates,
    isChatGptAssistantRichDocumentContent,
    isVisuallyHiddenElement,
    tokenizeText
  };
});
