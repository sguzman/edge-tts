const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  TextModel: {
    segmentIndexForCharIndex(starts, charIndex) {
      let index = 0;
      for (let i = 0; i < starts.length; i += 1) {
        if (starts[i] <= charIndex) index = i;
      }
      return index;
    }
  },
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() {
      return [];
    }
  }
};

const {
  chromeVoiceToCatalogVoice,
  isChromeTtsVoice,
  mergeVoiceCatalogs
} = require("../src/content/local-tts-engine.js");

test("chrome.tts local voices become selectable catalog voices", () => {
  const converted = chromeVoiceToCatalogVoice({
    voiceName: "Microsoft Mark",
    lang: "en-US",
    remote: false,
    eventTypes: ["start", "word", "end"]
  });

  assert.equal(converted.name, "Microsoft Mark");
  assert.equal(converted.lang, "en-US");
  assert.equal(converted.localService, true);
  assert.equal(converted.__edgeTtsSource, "chrome-tts");
  assert.equal(isChromeTtsVoice(converted), true);
});

test("remote chrome.tts voices are not imported into the Windows-local catalog", () => {
  assert.equal(
    chromeVoiceToCatalogVoice({
      voiceName: "Remote Example",
      lang: "en-US",
      remote: true
    }),
    null
  );
});

test("extension-local catalog fills gaps without duplicating Web Speech voices", () => {
  const webVoice = { name: "Microsoft David", lang: "en-US", localService: true };
  const merged = mergeVoiceCatalogs(
    [webVoice],
    [
      { voiceName: "Microsoft David", lang: "en-US", remote: false },
      { voiceName: "Microsoft Mark", lang: "en-US", remote: false }
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0], webVoice);
  assert.equal(merged[1].name, "Microsoft Mark");
  assert.equal(merged[1].__edgeTtsSource, "chrome-tts");
});
