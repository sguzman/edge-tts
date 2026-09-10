const test = require("node:test");
const assert = require("node:assert/strict");

class MockToolbar {
  constructor() {
    this.handlers = {};
    this.rate = null;
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
    this.liveRateCalls = [];
    this.liveVolumeCalls = [];
    this.speech = {
      setPlaybackRate: (rate) => {
        this.liveRateCalls.push(rate);
        return true;
      },
      setOutputVolume: (volume) => {
        this.liveVolumeCalls.push(volume);
        return true;
      }
    };
  }

  async loadSettings() {}
  applySettings() {}
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
          return { volume: 1.45 };
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
  MAX_VOLUME,
  MIN_RATE,
  normalizeRate,
  normalizeVolume
} = require("../src/content/audio-controls.js");

test("client playback range is 0.5x through 8x", () => {
  assert.equal(MIN_RATE, 0.5);
  assert.equal(MAX_RATE, 8);
  assert.equal(normalizeRate(0.1), 0.5);
  assert.equal(normalizeRate(3.7), 3.7);
  assert.equal(normalizeRate(20), 8);
});

test("direct volume supports gain up to 200 percent", () => {
  assert.equal(DEFAULT_VOLUME, 1);
  assert.equal(MAX_VOLUME, 2);
  assert.equal(normalizeVolume(-0.2), 0);
  assert.equal(normalizeVolume(0.45), 0.45);
  assert.equal(normalizeVolume(1.6), 1.6);
  assert.equal(normalizeVolume(5), 2);
});

test("stored gain loads independently and rate is clamped to the expanded range", async () => {
  const app = new MockReaderApp();
  await app.loadSettings();
  app.applySettings();

  assert.equal(app.settings.volume, 1.45);
  assert.equal(app.settings.rate, 8);
  assert.equal(app.toolbar.rate, 8);
  assert.equal(global.EdgeTtsExtension.AudioControls.currentVolume, 1.45);
});

test("direct speed and volume changes mutate live playback without resynthesis", async () => {
  const app = new MockReaderApp();
  await app.loadSettings();
  app.applySettings();

  await app.changeRate(6.2);
  await app.toolbar.handlers.onVolume(1.7);

  assert.deepEqual(app.liveRateCalls, [6.2]);
  assert.deepEqual(app.liveVolumeCalls, [1.7]);
  assert.equal(app.speakCalls, 0);
  assert.equal(app.saveCalls, 2);
});

test("local Web Speech volume remains clamped to its native 100 percent ceiling", () => {
  const engine = new global.EdgeTtsExtension.SpeechEngine.SpeechEngine();
  global.EdgeTtsExtension.AudioControls.currentVolume = 1.8;

  engine.speakCurrentChunk();

  assert.equal(engine.currentUtterance.volume, 1);
});
