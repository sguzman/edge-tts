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

test("word highlighting survives stale sentence members and transient projection misses", () => {
  assert.match(highlighter, /function segmentCanHighlight/);
  assert.match(highlighter, /if \(!segmentCanHighlight\(segment\)\) \{\s*return false;\s*\}/);
  assert.match(highlighter, /const wordHighlight = new root\.Highlight\(wordRange\)/);
  assert.match(highlighter, /sentence\.segments\.every\(segmentCanHighlight\)/);
  assert.match(highlighter, /if \(!sentenceIsLive\)/);
  assert.match(highlighter, /root\.CSS\.highlights\.delete\(SENTENCE_HIGHLIGHT_NAME\)/);
  assert.doesNotMatch(
    highlighter,
    /!sentence\.segments\.every\(segmentCanHighlight\)[\s\S]{0,120}this\.clear\(\)/
  );
  assert.match(highlighter, /this\.keepRangeInView\(wordRange, segment\.node\.parentElement\);\s*return true;/);
});

test("reader observes active DOM but defers ChatGPT mutations instead of killing playback", () => {
  assert.match(reader, /new root\.MutationObserver/);
  assert.match(reader, /characterData: true/);
  assert.match(reader, /childList: true/);
  assert.match(reader, /mutationTouchesActiveModel/);
  assert.match(reader, /markModelStale\("active-readable-dom-mutated"\)/);
  assert.match(reader, /deferLiveChatGptRefresh/);
  assert.match(reader, /this\.model\?\.profile !== "chatgpt"/);
  assert.match(reader, /this\.liveModelRefreshPending = true/);
  assert.match(reader, /already-prepared[\s\S]*audio finish/);
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

test("ChatGPT highlight recovery reprojects stale boundaries without stopping speech", () => {
  assert.match(reader, /resolveLiveHighlightTarget\(segment, forceRebuild = false\)/);
  assert.match(reader, /relocateCursorAfterRebuild\?\.\(anchor, visualModel\)/);
  assert.match(reader, /String\(freshSegment\.text \|\| ""\) !== String\(segment\?\.text \|\| ""\)/);

  const boundaryStart = reader.indexOf("    handleBoundary(segment, metadata = null) {");
  const boundaryEnd = reader.indexOf("    handleBlockEnd()", boundaryStart);
  const boundaryBody = reader.slice(boundaryStart, boundaryEnd);

  assert.match(boundaryBody, /this\.resolveLiveHighlightTarget/);
  assert.match(boundaryBody, /this\.model\?\.profile === "chatgpt"/);
  assert.match(boundaryBody, /this\.liveModelRefreshPending = true/);
  assert.doesNotMatch(
    boundaryBody,
    /this\.model\?\.profile === "chatgpt"[\s\S]*?markModelStale/
  );
});

test("audio-start highlight failure on ChatGPT does not become a playback failure", () => {
  const start = reliable.indexOf("    handleSpeechStart(latencyMs) {");
  const end = reliable.indexOf("    handleBoundary(segment, metadata = null) {", start);
  const body = reliable.slice(start, end);

  assert.match(body, /this\.resolveLiveHighlightTarget\?\./);
  assert.match(body, /this\.model\?\.profile === "chatgpt"/);
  assert.match(body, /this\.liveModelRefreshPending = true/);
  assert.match(body, /return super\.handleSpeechStart\(latencyMs\)/);
});


test("click-to-seek rebuilds a stale or unmapped live DOM target before seeking", () => {
  const start = reader.indexOf("    async handlePageClick(event) {");
  const end = reader.indexOf("    caretFromPoint(x, y) {", start);
  const body = reader.slice(start, end);

  assert.match(body, /const resolveTarget = \(\) =>/);
  assert.match(body, /this\.model\?\.nodeToBlock\?\.get\?\.\(caret\.node\)/);
  assert.match(body, /if \(this\.modelStale \|\| !target\)/);
  assert.match(body, /this\.rebuildModel\(\)/);
  assert.match(body, /target = resolveTarget\(\)/);
  assert.match(body, /Could not seek to clicked text/);
});

test("click-to-seek hard-stops stale transport before claiming a fresh audio session", () => {
  const start = reader.indexOf("    async handlePageClick(event) {");
  const end = reader.indexOf("    caretFromPoint(x, y) {", start);
  const body = reader.slice(start, end);

  const discardAt = body.indexOf("this.discardLocalSpeechState()");
  const localOwnerResetAt = body.indexOf("this.audioOwner = false");
  const hardStopAt = body.indexOf("await this.forceStopTabAudio()");
  const claimAt = body.indexOf("await this.claimAudioOwnership()");
  const speakAt = body.indexOf("this.speakCurrentPosition()", claimAt);

  assert.ok(discardAt >= 0);
  assert.ok(localOwnerResetAt > discardAt);
  assert.ok(hardStopAt > localOwnerResetAt);
  assert.ok(claimAt > hardStopAt);
  assert.ok(speakAt > claimAt);
  assert.doesNotMatch(
    body,
    /if \(this\.audioOwner\) \{[\s\S]*?this\.speakCurrentPosition\(\)/
  );
});


test("current click-to-seek generation outranks and retires ghost readers", () => {
  assert.match(reader, /readerGenerationIsCurrent\(\)/);
  assert.match(reader, /retireStaleReaderGeneration\(\)/);
  assert.match(reader, /data-edge-tts-session-token/);

  const syncStart = reader.indexOf("    syncPageClickListener() {");
  const syncEnd = reader.indexOf("    stop() {", syncStart);
  const syncBody = reader.slice(syncStart, syncEnd);
  assert.match(syncBody, /root\.addEventListener\?\.\("click", this\.boundClick, true\)/);
  assert.match(syncBody, /root\.removeEventListener\?\.\("click", this\.boundClick, true\)/);

  const clickStart = reader.indexOf("    async handlePageClick(event) {");
  const clickEnd = reader.indexOf("    caretFromPoint(x, y) {", clickStart);
  const clickBody = reader.slice(clickStart, clickEnd);
  assert.match(clickBody, /if \(this\.retireStaleReaderGeneration\(\)\)/);
});


test("stale ChatGPT chunk targets rebuild and relocate instead of pausing", () => {
  const speakStart = reader.indexOf("    speakCurrentPosition() {");
  const speechStart = reader.indexOf("    handleSpeechStart(", speakStart);
  const body = reader.slice(speakStart, speechStart);

  assert.match(body, /!segmentIsLive\?\.\(currentSegment\)/);
  assert.match(body, /this\.model\?\.profile === "chatgpt"/);
  assert.match(body, /this\.refreshLiveChatGptCursor\(\)/);
  assert.match(body, /return this\.speakCurrentPosition\(\)/);
  assert.match(body, /this\.markModelStale\("speech-start-target-stale", true\)/);
});

test("live ChatGPT cursor refresh preserves unread position across a rerender", () => {
  const start = reader.indexOf("    refreshLiveChatGptCursor() {");
  const end = reader.indexOf("    markModelStale(", start);
  const body = reader.slice(start, end);

  assert.match(body, /const anchor = this\.liveCursorAnchor\(\)/);
  assert.match(body, /this\.rebuildModel\(\)/);
  assert.match(body, /relocateCursorAfterRebuild\?\.\(anchor, this\.model\)/);
  assert.match(body, /this\.currentBlockIndex = relocated\.blockIndex/);
  assert.match(body, /this\.currentSegmentIndex = relocated\.segmentIndex/);
});


test("ChatGPT mutation deferral no longer explicitly erases a still-valid highlight", () => {
  const start = reader.indexOf("    deferLiveChatGptRefresh(");
  const end = reader.indexOf("    liveCursorAnchor()", start);
  const body = reader.slice(start, end);

  assert.match(body, /this\.liveModelRefreshPending = true/);
  assert.doesNotMatch(body, /highlighter\?\.clear/);
});

test("projected ChatGPT boundary uses a display-only model and never replaces playback state", () => {
  const start = reader.indexOf("    resolveLiveHighlightTarget(");
  const end = reader.indexOf("    markModelStale(", start);
  const body = reader.slice(start, end);

  assert.match(body, /const directSegment = directBlock\?\.segments\?\.\[segmentIndex\]/);
  assert.match(body, /segmentIsLive\?\.\(directSegment\)/);
  assert.match(body, /visualModel = this\.buildLiveHighlightModel\(\)/);
  assert.match(body, /relocateCursorAfterRebuild\?\.\(anchor, visualModel\)/);
  assert.match(body, /const freshSegment = block\?\.segments\?\.\[relocated\.segmentIndex\]/);
  assert.match(body, /this\.liveHighlightModel = visualModel/);
  assert.doesNotMatch(body, /this\.rebuildModel\(\)/);
  assert.doesNotMatch(body, /this\.model = visualModel/);
  assert.match(body, /return \{ block, segment: freshSegment \}/);
});


test("DOM replacement invalidates only sentence cache before fresh repaint", () => {
  assert.match(highlighter, /invalidateSentenceCache\(\)/);
  assert.match(highlighter, /this\.currentSentenceKey = null/);

  const start = reader.indexOf("    resolveLiveHighlightTarget(");
  const end = reader.indexOf("    markModelStale(", start);
  const body = reader.slice(start, end);
  assert.match(body, /this\.highlighter\?\.invalidateSentenceCache\?\.\(\)/);
  assert.doesNotMatch(body, /invalidateDomRanges/);
  assert.match(body, /return \{ block, segment: freshSegment \}/);
});


test("failed ChatGPT remap preserves last known-good visual and schedules immediate repair", () => {
  const deferStart = reader.indexOf("    deferLiveChatGptRefresh(");
  const deferEnd = reader.indexOf("    clearLiveHighlightRepair()", deferStart);
  const deferBody = reader.slice(deferStart, deferEnd);
  assert.match(deferBody, /this\.liveHighlightModel = null/);
  assert.match(deferBody, /this\.scheduleLiveHighlightRepair\(\)/);
  assert.doesNotMatch(deferBody, /highlighter.*clear/);

  const repairStart = reader.indexOf("    scheduleLiveHighlightRepair() {");
  const repairEnd = reader.indexOf("    liveCursorAnchor()", repairStart);
  const repairBody = reader.slice(repairStart, repairEnd);
  assert.match(repairBody, /requestAnimationFrame/);
  assert.match(repairBody, /resolveLiveHighlightTarget\(segment, true\)/);
  assert.match(repairBody, /highlighter\?\.highlight/);
});


test("visual remapping can never rewrite or regress the playback cursor", () => {
  const start = reader.indexOf("    handleBoundary(segment, metadata = null) {");
  const end = reader.indexOf("    handleBlockEnd()", start);
  const body = reader.slice(start, end);

  assert.match(body, /const incomingBlockIndex = Number\(segment\?\.blockIndex\)/);
  assert.match(body, /const incomingSegmentIndex = Number\(segment\?\.segmentIndex\)/);
  assert.match(body, /const regressive =/);
  assert.match(body, /if \(regressive\)/);
  assert.match(body, /this\.currentBlockIndex = incomingBlockIndex/);
  assert.match(body, /this\.currentSegmentIndex = incomingSegmentIndex/);
  assert.doesNotMatch(body, /currentBlockIndex = target/);
  assert.doesNotMatch(body, /currentSegmentIndex = target/);
});

test("zero-time direct boundary does not claim Reading before media progress", () => {
  assert.match(reader, /onBoundary: \(segment, metadata\) => this\.handleBoundary\(segment, metadata\)/);
  const start = reader.indexOf("    handleBoundary(segment, metadata = null) {");
  const end = reader.indexOf("    handleBlockEnd()", start);
  const body = reader.slice(start, end);

  assert.match(body, /metadata\?\.directAudio !== true/);
  assert.match(body, /directOffset > 0\.03/);
  assert.match(body, /progressConfirmed \? "Reading" : "Playback started…"/);
});


test("ChatGPT visual remapping uses local context before strict full-prefix relocation", () => {
  const start = reader.indexOf("    resolveLiveHighlightTarget(");
  const end = reader.indexOf("    markModelStale(", start);
  const body = reader.slice(start, end);

  assert.match(reader, /relocateSegmentByLocalContext/);
  assert.match(body, /relocateSegmentByLocalContext\?\.\(anchor, visualModel\)/);
  assert.match(body, /relocateCursorAfterRebuild\?\.\(anchor, visualModel\)/);

  const localAt = body.indexOf("relocateSegmentByLocalContext");
  const strictAt = body.indexOf("relocateCursorAfterRebuild");
  assert.ok(localAt >= 0);
  assert.ok(strictAt > localAt);
});

test("visual remapping no longer requires the entire paragraph prefix to remain identical", () => {
  const textModel = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "text-model.js"),
    "utf8"
  );

  assert.match(textModel, /function relocateSegmentByLocalContext/);
  assert.match(textModel, /const radius = 4/);
  assert.match(textModel, /contextMatches/);
  assert.match(textModel, /segmentDistance/);
  assert.match(textModel, /blockDistance/);
});
