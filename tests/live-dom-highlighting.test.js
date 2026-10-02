const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const highlighter = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "highlighter.js"),
  "utf8"
);
const reliable = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reliable-reader.js"),
  "utf8"
);

test("highlighter fails closed when cached DOM segments are stale", () => {
  assert.match(highlighter, /function segmentCanHighlight/);
  assert.match(highlighter, /!segmentCanHighlight\(segment\)/);
  assert.match(highlighter, /this\.clear\(\);\s*return false;/);
  assert.match(highlighter, /sentence\.segments\.every\(segmentCanHighlight\)/);
  assert.match(highlighter, /return true;\s*}\s*\n\s*keepRangeInView/);
});

test("reader observes active readable DOM and pauses on mutation", () => {
  assert.match(reader, /new root\.MutationObserver/);
  assert.match(reader, /characterData: true/);
  assert.match(reader, /childList: true/);
  assert.match(reader, /mutationTouchesActiveModel/);
  assert.match(reader, /markModelStale\("active-readable-dom-mutated"\)/);
  assert.match(reader, /Paused — page text changed; Resume will rebuild/);
});

test("stale reader playback is cancelled and fresh DOM is rebuilt before resume", () => {
  assert.match(reader, /this\.discardLocalSpeechState\(\)/);
  assert.match(reader, /this\.releaseAudioOwnership\(\)/);
  assert.match(reader, /const restartFromFreshModel = this\.modelStale === true/);
  assert.match(reader, /this\.rebuildAfterStaleModel\(\)/);
  assert.match(reader, /Restarting on fresh page text/);
  assert.match(reader, /relocateCursorAfterRebuild/);
});

test("boundary and early-audio highlighting both stop on stale targets", () => {
  assert.match(
    reader,
    /const highlighted = this\.highlighter\.highlight\(block, segment\);[\s\S]*?boundary-highlight-target-stale/
  );
  assert.match(
    reliable,
    /const highlighted = this\.highlighter\?\.highlight\?\.\(block, segment\);[\s\S]*?audio-start-highlight-target-stale/
  );
});
