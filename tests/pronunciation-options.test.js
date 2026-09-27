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
  assert.match(optionsJs, /Saved automatically\./);
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
