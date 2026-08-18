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

  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "textarea",
    "input",
    "select",
    "option",
    "button",
    "nav",
    "aside",
    "footer",
    "[hidden]",
    "[aria-hidden='true']",
    "[data-edge-tts-ui]"
  ].join(",");

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

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    if (element.closest(EXCLUDED_SELECTOR)) {
      return false;
    }

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTextNodeReadable(node) {
    if (!(node instanceof Text) || !node.nodeValue || !/\S/.test(node.nodeValue)) {
      return false;
    }

    const parent = node.parentElement;
    return Boolean(parent && isElementVisible(parent));
  }

  function extractBlock(element, blockIndex) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const segments = [];
    let output = "";
    let current;

    while ((current = walker.nextNode())) {
      if (!isTextNodeReadable(current)) {
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
          nodeEnd: token.end
        });
      }
    }

    if (segments.length === 0) {
      return null;
    }

    return {
      index: blockIndex,
      element,
      text: output,
      segments
    };
  }

  function pickReadingRoot(doc) {
    const semanticRoots = Array.from(doc.querySelectorAll("article,main,[role='main']"));
    const visibleRoots = semanticRoots.filter((element) => isElementVisible(element));

    if (visibleRoots.length === 0) {
      return doc.body;
    }

    return visibleRoots.reduce((best, candidate) => {
      const bestLength = best.innerText?.trim().length || 0;
      const candidateLength = candidate.innerText?.trim().length || 0;
      return candidateLength > bestLength ? candidate : best;
    });
  }

  function shouldKeepCandidate(element) {
    if (!isElementVisible(element)) {
      return false;
    }

    if (element.matches("li,blockquote") && element.querySelector("p")) {
      return false;
    }

    return true;
  }

  function buildReadableModel(doc = document) {
    const readingRoot = pickReadingRoot(doc);
    const candidates = Array.from(readingRoot.querySelectorAll(BLOCK_SELECTOR)).filter(
      shouldKeepCandidate
    );

    const blocks = [];
    const nodeToBlock = new WeakMap();

    for (const candidate of candidates) {
      const block = extractBlock(candidate, blocks.length);
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
      const fallback = extractBlock(doc.body, 0);
      if (fallback) {
        for (const segment of fallback.segments) {
          nodeToBlock.set(segment.node, fallback);
        }
        blocks.push(fallback);
      }
    }

    return { blocks, nodeToBlock };
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
    buildReadableModel,
    findSegmentInNode,
    firstBlockNearViewport,
    segmentIndexForCharIndex,
    tokenizeText
  };
});
