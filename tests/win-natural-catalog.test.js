const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {};
global.speechSynthesis = {
  getVoices: () => [],
  addEventListener() {},
  removeEventListener() {}
};
const speechApi = require("../src/content/speech-engine.js");
global.EdgeTtsExtension.SpeechEngine = speechApi;
const {
  LocalTtsSpeechEngine,
  mergeVoiceCatalogs,
  nativeVoiceToCatalogVoice
} = require("../src/content/local-tts-engine.js");

test("native voice conversion preserves the actual Local-* token and marks it catalog-only", () => {
  const voice = nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
  assert.equal(voice.__edgeTtsSource, "win-natural");
  assert.equal(voice.nativeVoiceId, "Local-NarratorVoices");
  assert.equal(voice.voiceURI, "win-natural:Local-NarratorVoices");
  assert.equal(voice.catalogOnly, true);
});

test("native catalog entries merge without rewriting or duplicating their identity", () => {
  const voice = nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
  const merged = mergeVoiceCatalogs(
    [{ name: "Microsoft David", lang: "en-US", localService: true }],
    [],
    [voice]
  );
  assert.deepEqual(merged.map((item) => item.nativeVoiceId || item.name), [
    "Microsoft David",
    "Local-NarratorVoices"
  ]);
  const sameDisplayName = mergeVoiceCatalogs(
    [{ name: "Microsoft Aria", lang: "en-US", remote: true }],
    [],
    [voice]
  );
  assert.equal(sameDisplayName.length, 2);
});

test("native enumeration arrives asynchronously and notifies an open catalog", async () => {
  global.chrome = {
    runtime: {
      sendMessage(message) {
        if (message.type === "EDGE_TTS_WIN_NATURAL_VOICES") {
          return Promise.resolve({
            voices: [{ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }]
          });
        }
        return Promise.resolve({ voices: [] });
      }
    }
  };
  const engine = new LocalTtsSpeechEngine({});
  let changed = 0;
  engine.onVoicesChanged(() => { changed += 1; });
  await engine.refreshWinNaturalVoices();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(engine.getVoices().at(-1).nativeVoiceId, "Local-NarratorVoices");
  assert.ok(changed >= 1);
});

test("stale saved Microsoft Aria cannot select a catalog-only voice", () => {
  const voices = [
    nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }),
    { name: "Microsoft David", lang: "en-US", localService: true }
  ];
  const selected = speechApi.selectPlayableVoice(voices, "Microsoft Aria");
  assert.equal(selected.name, "Microsoft David");
});

test("catalog-only Windows Natural voices cannot fall through to playback", () => {
  let error = "";
  const engine = new LocalTtsSpeechEngine({ onError: (value) => { error = value.message; } });
  engine.speak(
    { segments: [{ text: "hello", blockIndex: 0, segmentIndex: 0 }] },
    0,
    { voice: nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }) }
  );
  assert.match(error, /catalog-only/);
});

test("native enumeration failure leaves the existing catalog usable", async () => {
  global.speechSynthesis.getVoices = () => [
    { name: "Microsoft David", lang: "en-US", localService: true }
  ];
  global.chrome.runtime.sendMessage = () => Promise.reject(new Error("host unavailable"));
  const engine = new LocalTtsSpeechEngine({});
  await engine.refreshWinNaturalVoices();
  assert.deepEqual(engine.getVoices().map((voice) => voice.name), ["Microsoft David"]);
});
