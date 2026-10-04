const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);
const toolbar = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "toolbar.js"),
  "utf8"
);
const reader = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "reader.js"),
  "utf8"
);
const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const optionsHtml = fs.readFileSync(
  path.join(__dirname, "..", "src", "options", "pronunciation.html"),
  "utf8"
);

test("manifest exposes pronunciation editor as a full options tab", () => {
  assert.deepEqual(manifest.options_ui, {
    page: "src/options/pronunciation.html",
    open_in_tab: true
  });
});

test("reader toolbar can open the pronunciation editor", () => {
  assert.match(toolbar, /Edit pronunciation/);
  assert.match(toolbar, /data-edge-tts-action="pronunciation-options"/);
  assert.match(reader, /EDGE_TTS_OPEN_PRONUNCIATION_OPTIONS/);
  assert.match(background, /chrome\.runtime\.openOptionsPage\(\)/);
});

test("options editor exposes all major Lantern Leaf rule classes plus preview", () => {
  for (const expected of [
    "Custom pronunciations",
    "Brand map",
    "Case-sensitive abbreviations",
    "Case-insensitive abbreviations",
    "Regex abbreviation rules",
    "Literal replacements",
    "Linux path vocabulary",
    "Pronunciation test bench",
    "Applied transformations",
    "Raw JSON import / export"
  ]) {
    assert.match(optionsHtml, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});


test("pronunciation editor autosaves rule changes", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );
  assert.match(optionsJs, /function scheduleAutosave\(\)/);
  assert.match(optionsJs, /setTimeout\(async \(\) =>/);
  assert.match(optionsJs, /Pronunciation\.saveConfig\(draft\)/);
  assert.match(optionsJs, /Saved automatically/);
  assert.match(optionsJs, /function handleRuleChange\(\)/);
});


test("pronunciation editor shows fixed save feedback independent of scroll position", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );
  const optionsCss = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.css"),
    "utf8"
  );

  assert.match(optionsHtml, /id="save-toast"/);
  assert.match(optionsJs, /function showSaveToast/);
  assert.match(optionsJs, /Saved · revision/);
  assert.match(optionsCss, /\.save-toast \{/);
  assert.match(optionsCss, /position: fixed/);
  assert.match(optionsCss, /top: 22px/);
  assert.match(optionsCss, /right: 22px/);
  assert.match(optionsCss, /background: #198754/);
  assert.match(optionsCss, /font-size: 1\.05rem/);
});

test("test bench previews current rules and plays real Ryan Piper audio with browser speed control", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );

  assert.match(optionsHtml, /id="test-play"/);
  assert.match(optionsHtml, /id="test-stop"/);
  assert.match(optionsHtml, /id="test-speed"/);
  assert.match(optionsHtml, /id="preview-spoken"/);
  assert.match(optionsJs, /EDGE_TTS_PRONUNCIATION_TEST_SYNTHESIZE/);
  assert.match(optionsJs, /voiceId: "en_US-ryan-high"/);
  assert.match(optionsJs, /new Audio\(testAudioUrl\)/);
  assert.match(optionsJs, /testAudio\.playbackRate = speed/);
  assert.match(optionsJs, /testAudio\.preservesPitch = true/);
  assert.match(background, /synthesizePronunciationTest/);
  assert.match(background, /type: "synthesize"/);
  assert.match(background, /EDGE_TTS_PRONUNCIATION_TEST_CANCEL/);
});

test("test speed is a QA control, not a pronunciation setting that autosaves", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );
  assert.match(optionsJs, /:not\(#test-speed\)/);
});


test("map rows can be tested in place without editing the global preview sentence", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );
  const optionsCss = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.css"),
    "utf8"
  );

  assert.match(optionsJs, /const INLINE_TESTABLE_MAPS = new Set/);
  assert.match(optionsJs, /pronunciation\.customPronunciations/);
  assert.match(optionsJs, /function inlineRuleTestSource/);
  assert.match(optionsJs, /function testMapRow/);
  assert.match(optionsJs, /data-test-rule/);
  assert.match(optionsJs, /data-rule-test-result/);
  assert.match(optionsJs, /Play this rule using the current unsaved editor state/);
  assert.match(optionsCss, /\.rule-test-result/);
});

test("regex rules have their own in-situ sample text and test button", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );

  assert.match(optionsHtml, /<th>Test text<\/th>/);
  assert.match(optionsJs, /data-regex-test-source/);
  assert.match(optionsJs, /data-test-regex/);
  assert.match(optionsJs, /Enter test text for this regex row/);
});

test("letter sounds and path vocabulary can audition their configured spoken value directly", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );

  assert.match(optionsJs, /path === "acronyms\.letterSounds"/);
  assert.match(optionsJs, /path === "technical\.pathWords"/);
  assert.match(optionsJs, /spoken: value/);
});


test("pronunciation editor exposes automatic ALL-CAPS spelling threshold", () => {
  const optionsJs = fs.readFileSync(
    path.join(__dirname, "..", "src", "options", "pronunciation.js"),
    "utf8"
  );

  assert.match(optionsHtml, /id="auto-uppercase-min-length"/);
  assert.match(optionsHtml, /Auto-spell ALL-CAPS tokens at least/);
  assert.match(optionsJs, /config\.acronyms\.autoUppercaseMinLength \?\? 3/);
  assert.match(optionsJs, /next\.acronyms\.autoUppercaseMinLength/);
});


test("acronym token list is labeled as explicit exceptions rather than required defaults", () => {
  assert.match(optionsHtml, /Explicit acronym exceptions, one per line/);
  assert.match(optionsHtml, /short or nonstandard-case tokens/);
  assert.match(optionsHtml, /Enable acronym \/ ALL-CAPS spelling/);
});
