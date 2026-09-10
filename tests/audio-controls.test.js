const test = require("node:test");
const assert = require("node:assert/strict");

class MockToolbar {
  constructor() {
    this.handlers = {};
    this.rate = null;
    this.volume = null;
  }

  mount() {}
  destroy() {}
  setRate(rate) {
    this.rate = rate;
  }
}

class MockReaderApp {
  constructor() {
    this.settings = { rate: 9 };
    this.toolbar = new MockToolbar();
    this.stopped = false;
    this.paused = false;
    this.audioOwner = true;
    this.speakCalls = 0;
    this.saveCalls = 0;
  }

  async loadSettings() {}
  applySettings() {}
  async changeRate(rate) {
    this.settings.rate = rate;
  }
  async saveSettings() {
    this.saveCalls += 1;
  }
  speakCurrentPosition() {
    this.speakCalls += 1;
  }
}

class MockSpeechEngine {
  speakCurrentChunk() {
    this.currentUtterance = { volume: 1 };
  }
}

global.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys) && keys.includes("volume")) {
          return { volume: 0.45 };
        }
        return {};
      }
    }
  }
};

global.EdgeTtsExtension = {
  Toolbar: { Toolbar: MockToolbar },
  Reader: { ReaderApp: MockReaderApp },
  SpeechEngine: { SpeechEngine: MockSpeechEngine }
};

const {
  DEFAULT_VOLUME,
  MAX_RATE,
  MIN_RATE,
  normalizeRate,
  normalizeVolume
} = require("../src/content/audio-controls.js");

test("expanded Web Speech rate range is 0.5x through 5x", () => {
  assert.equal(MIN_RATE, 0.5);
  assert.equal(MAX_RATE, 5);
  assert.equal(normalizeRate(0.1), 0.5);
  assert.equal(normalizeRate(3.7), 3.7);
  assert.equal(normalizeRate(20), 5);
});

test("speech volume is normalized to the Web Speech 0..1 range", () => {
  assert.equal(DEFAULT_VOLUME, 1);
  assert.equal(normalizeVolume(-0.2), 0);
  assert.equal(normalizeVolume(0.45), 0.45);
  assert.equal(normalizeVolume(2), 1);
});

test("stored volume loads independently and rate is clamped to the expanded range", async () => {
  const app = new MockReaderApp();
  await app.loadSettings();
  app.applySettings();

  assert.equal(app.settings.volume, 0.45);
  assert.equal(app.settings.rate, 5);
  assert.equal(app.toolbar.volume, 0.45);
  assert.equal(global.EdgeTtsExtension.AudioControls.currentVolume, 0.45);
});

test("volume changes persist and restart only the active owning session", async () => {
  const app = new MockReaderApp();
  await app.loadSettings();
  app.applySettings();

  await app.toolbar.handlers.onVolume(0.3);

  assert.equal(app.settings.volume, 0.3);
  assert.equal(app.saveCalls, 1);
  assert.equal(app.speakCalls, 1);

  app.paused = true;
  await app.toolbar.handlers.onVolume(0.2);
  assert.equal(app.speakCalls, 1);
});

test("fresh utterances receive the tab-local volume before browser playback", () => {
  const engine = new global.EdgeTtsExtension.SpeechEngine.SpeechEngine();
  global.EdgeTtsExtension.AudioControls.currentVolume = 0.35;

  engine.speakCurrentChunk();

  assert.equal(engine.currentUtterance.volume, 0.35);
});
