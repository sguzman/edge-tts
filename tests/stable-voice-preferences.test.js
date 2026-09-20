const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.navigator = { language: "en-US" };
global.document = { documentElement: { lang: "en-US" } };
global.Element = class Element {};
global.EdgeTtsExtension = {
  TextModel: {
    buildReadableModel() { return { blocks: [], nodeToBlock: new Map() }; },
    findSegmentInNode() { return null; },
    firstBlockNearViewport(blocks) { return blocks[0] || null; }
  },
  Highlighter: {
    DEFAULT_SENTENCE_COLOR: "#bde0fe",
    DEFAULT_WORD_COLOR: "#ffd60a",
    Highlighter: class {},
    normalizeColor(value) { return value; }
  },
  SpeechEngine: {
    SpeechEngine: class {},
    createSpeechBatch() {},
    isCatalogOnlyVoice(voice) { return voice?.catalogOnly === true; },
    isNaturalVoice() { return false; },
    selectStartupVoice: require("../src/content/speech-engine.js").selectStartupVoice,
    selectPlayableVoice: require("../src/content/speech-engine.js").selectPlayableVoice,
    voiceSelectionKey: require("../src/content/speech-engine.js").voiceSelectionKey
  },
  Toolbar: { Toolbar: class {} }
};
require("../src/content/reader.js");
const { ReaderApp } = global.EdgeTtsExtension.Reader;
const { selectStartupVoice, sortVoices, voiceSelectionKey } = require("../src/content/speech-engine.js");
const { filterVoicesByClass } = require("../src/content/voice-ui.js");

function legacy(name, lang = "en-US") {
  return { name, lang, localService: true, __edgeTtsSource: "chrome-tts", chromeVoiceName: name };
}

function native(name, lang = "en-US") {
  return { name, lang, __edgeTtsSource: "win-natural", nativeVoiceId: `Local-${name}` };
}

function online(name, lang = "en-US") {
  return { name, lang, remote: true, voiceURI: `online:${name}:${lang}` };
}

test("startup resolver handles default, configured, and deterministic fallback", () => {
  const zira = legacy("Microsoft Zira Desktop");
  const mark = legacy("Microsoft Mark");
  const onlineVoice = online("Microsoft Aria Online (Natural)");

  assert.equal(selectStartupVoice([onlineVoice, zira]), zira);
  assert.equal(selectStartupVoice([zira, mark], voiceSelectionKey(mark), mark.name), mark);
  assert.equal(selectStartupVoice([mark, onlineVoice], "missing", "Missing"), mark);
  assert.equal(selectStartupVoice([onlineVoice]), onlineVoice);
});

test("canonical ordering and filtering are independent of selection and arrival timing", () => {
  const voices = [
    online("Microsoft William"),
    native("Microsoft Aria"),
    legacy("Microsoft Zira"),
    legacy("Microsoft David"),
    native("Microsoft Beta", "de-DE")
  ];
  const expected = [voices[3], voices[2], voices[1], voices[4], voices[0]];
  assert.deepEqual(sortVoices(voices, "fr-FR", voices[0].name), expected);
  assert.deepEqual(sortVoices([voices[0], voices[2], voices[3], voices[1], voices[4]], "en-US", ""), expected);
  assert.deepEqual(filterVoicesByClass(expected, "", "win-legacy"), [voices[3], voices[2]]);
  assert.deepEqual(filterVoicesByClass(expected, "", "win-natural"), [voices[1], voices[4]]);
  assert.deepEqual(filterVoicesByClass(expected, "", "online-natural"), [voices[0]]);
});

test("ReaderApp startup refresh uses configured startup voice without changing session state", () => {
  const zira = legacy("Microsoft Zira");
  const mark = legacy("Microsoft Mark");
  const onlineVoice = online("Microsoft Aria Online (Natural)");
  const app = {
    settings: {
      voiceName: onlineVoice.name,
      voiceKey: voiceSelectionKey(onlineVoice),
      startupVoiceName: mark.name,
      startupVoiceKey: voiceSelectionKey(mark)
    },
    selectedVoice: null,
    speech: { chooseVoices: () => [onlineVoice, zira, mark] },
    toolbar: {
      setVoices() {},
      setStartupVoices(_voices, key, name, fallback) {
        this.startup = { key, name, fallback };
      },
      setRate() {}
    }
  };

  ReaderApp.prototype.refreshVoices.call(app, { startup: true });
  assert.equal(app.selectedVoice, mark);
  assert.equal(app.settings.voiceKey, voiceSelectionKey(mark));
  assert.equal(app.settings.startupVoiceKey, voiceSelectionKey(mark));
  assert.equal(app.toolbar.startup.fallback, mark);

  app.selectedVoice = mark;
  ReaderApp.prototype.refreshVoices.call(app);
  assert.equal(app.selectedVoice, mark);
  assert.equal(app.settings.startupVoiceKey, voiceSelectionKey(mark));
});

test("normal voice changes do not change startup preference, while startup control persists it", async () => {
  const zira = legacy("Microsoft Zira");
  const mark = legacy("Microsoft Mark");
  const app = {
    voices: [zira, mark],
    selectedVoice: zira,
    settings: { voiceName: zira.name, voiceKey: voiceSelectionKey(zira), startupVoiceName: zira.name, startupVoiceKey: voiceSelectionKey(zira) },
    toolbar: { setStartupVoices() {} },
    speech: { prepareDirectPlayback() {} },
    async saveSettings() { this.saved = true; }
  };

  await ReaderApp.prototype.changeVoice.call(app, voiceSelectionKey(mark));
  assert.equal(app.settings.startupVoiceKey, voiceSelectionKey(zira));
  await ReaderApp.prototype.changeStartupVoice.call(app, voiceSelectionKey(mark));
  assert.equal(app.settings.startupVoiceKey, voiceSelectionKey(mark));
  assert.equal(app.settings.startupVoiceName, mark.name);
  assert.equal(app.saved, true);
});

test("async catalog completion updates All voices without replacing the current voice", () => {
  const onlineVoice = online("Microsoft Aria Online (Natural)");
  const zira = legacy("Microsoft Zira");
  const mark = legacy("Microsoft Mark");
  let catalog = [onlineVoice];
  const renders = [];
  const app = {
    settings: {
      voiceName: onlineVoice.name,
      voiceKey: voiceSelectionKey(onlineVoice),
      startupVoiceName: mark.name,
      startupVoiceKey: voiceSelectionKey(mark)
    },
    selectedVoice: onlineVoice,
    speech: { chooseVoices: () => sortVoices(catalog) },
    toolbar: {
      setVoices(voices) { renders.push([...voices]); },
      setStartupVoices(_voices, key) { this.startupKey = key; },
      setRate() {}
    }
  };

  ReaderApp.prototype.refreshVoices.call(app);
  assert.equal(app.settings.startupVoiceKey, voiceSelectionKey(mark));
  catalog = [onlineVoice, zira, mark];
  ReaderApp.prototype.refreshVoices.call(app);
  assert.equal(app.selectedVoice, onlineVoice);
  assert.deepEqual(renders.at(-1), [mark, zira, onlineVoice]);
  assert.equal(app.toolbar.startupKey, voiceSelectionKey(mark));
  assert.deepEqual(filterVoicesByClass(renders.at(-1), "", "all"), renders.at(-1));
});

test("settings schema and fast path preserve one shared startup semantic", () => {
  const reader = fs.readFileSync(path.join(__dirname, "..", "src", "content", "reader.js"), "utf8");
  const fastPath = fs.readFileSync(path.join(__dirname, "..", "src", "content", "startup-fastpath.js"), "utf8");
  const toolbar = fs.readFileSync(path.join(__dirname, "..", "src", "content", "toolbar.js"), "utf8");
  assert.match(reader, /settingsVersion: 3/);
  assert.match(reader, /startupVoiceKey/);
  assert.match(reader, /startupVoiceName/);
  assert.match(reader, /changeStartupVoice/);
  assert.match(reader, /refreshVoices\(\{ startup: true \}\)/);
  assert.match(fastPath, /refreshVoices\(\{ startup: true \}\)/);
  assert.match(toolbar, /Default startup voice/);
  assert.match(toolbar, /setStartupVoices/);
});
