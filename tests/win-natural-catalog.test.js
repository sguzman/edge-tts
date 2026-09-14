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
const { selectPlayableVoice, voiceSelectionKey } = speechApi;

test("native voice conversion preserves the actual Local-* token and is playable in Gate 3C", () => {
  const voice = nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
  assert.equal(voice.__edgeTtsSource, "win-natural");
  assert.equal(voice.nativeVoiceId, "Local-NarratorVoices");
  assert.equal(voice.voiceURI, "win-natural:Local-NarratorVoices");
  assert.equal(voice.catalogOnly, false);
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

test("stale saved Microsoft Aria selects the playable native voice only when its native key matches", () => {
  const voices = [
    nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }),
    { name: "Microsoft David", lang: "en-US", localService: true }
  ];
  const selected = speechApi.selectPlayableVoice(voices, "Microsoft Aria", voiceSelectionKey(voices[0]));
  assert.equal(selected.nativeVoiceId, "Local-NarratorVoices");
});

test("legacy Zira remains selected when the native catalog refreshes", () => {
  const zira = { name: "Microsoft Zira", lang: "en-US", localService: true };
  const refreshed = [
    zira,
    { name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true },
    nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" })
  ];
  assert.equal(
    selectPlayableVoice(refreshed, zira.name, voiceSelectionKey(zira)),
    zira
  );
});

test("legacy Mark remains selected after asynchronous native arrival", () => {
  const mark = {
    name: "Microsoft Mark",
    lang: "en-US",
    __edgeTtsSource: "chrome-tts",
    chromeVoiceName: "Microsoft Mark",
    localService: true
  };
  const refreshed = [
    mark,
    nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" })
  ];
  assert.equal(
    selectPlayableVoice(refreshed, mark.name, voiceSelectionKey(mark)),
    mark
  );
});

test("the selected Online voice survives native catalog arrival", () => {
  const online = {
    name: "Microsoft Aria Online (Natural)",
    lang: "en-US",
    remote: true,
    voiceURI: "https://speech.platform.bing.com/aria"
  };
  const refreshed = [
    online,
    nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" })
  ];
  assert.equal(
    selectPlayableVoice(refreshed, online.name, voiceSelectionKey(online)),
    online
  );
});

test("Online Aria and Windows Natural Aria have distinct selection identities", () => {
  const online = { name: "Microsoft Aria", lang: "en-US", remote: true };
  const native = nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
  assert.notEqual(voiceSelectionKey(online), voiceSelectionKey(native));
  assert.equal(selectPlayableVoice([online, native], "Microsoft Aria", voiceSelectionKey(online)), online);
  assert.equal(selectPlayableVoice([online, native], "Microsoft Aria", voiceSelectionKey(native)), native);
});

test("native Aria remains a distinct active selection during refresh", () => {
  const native = nativeVoiceToCatalogVoice({
    id: "Local-NarratorVoices",
    name: "Microsoft Aria",
    lang: "en-US"
  });
  const david = { name: "Microsoft David", lang: "en-US", localService: true };
  assert.equal(selectPlayableVoice([native, david], native.name, voiceSelectionKey(native)), native);
});

test("Windows Natural catalog entries are enabled while stale saved settings still exclude them before Gate 3", () => {
  const native = nativeVoiceToCatalogVoice({ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" });
  assert.equal(native.catalogOnly, false);
  assert.equal(selectPlayableVoice([native], "Microsoft Aria", "legacy:Microsoft Aria"), native);
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
