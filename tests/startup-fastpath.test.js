const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.EdgeTtsExtension = {};
const { startupSummary } = require("../src/content/startup-fastpath.js");

test("startup summary separates extension prep from remote speech latency", () => {
  const summary = startupSummary({
    totalMs: 910,
    prepMs: 74,
    speechStartMs: 836,
    modelMs: 21,
    extraVoiceWaitMs: 0
  });

  assert.equal(
    summary,
    "total 910 ms · prep 74 ms · remote speech 836 ms · model 21 ms · extra voice wait 0 ms"
  );
});

test("voice readiness starts before text modeling and catalog selection waits for local voices", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );

  const localVoiceWait = source.indexOf("this.speech.refreshExtensionVoices?.()");
  const naturalVoiceWait = source.indexOf("this.speech.waitForVoices(");
  const modelBuild = source.indexOf("this.rebuildModel();");
  const awaitPrep = source.indexOf("await Promise.all([settingsReady, extensionVoicesReady]);");
  const firstRefresh = source.indexOf("this.refreshVoices({ startup: true });", awaitPrep);
  const awaitNaturalFallback = source.indexOf("await naturalVoicesReady;", firstRefresh);

  assert.ok(localVoiceWait >= 0);
  assert.ok(naturalVoiceWait > localVoiceWait);
  assert.ok(modelBuild > naturalVoiceWait);
  assert.ok(awaitPrep > modelBuild);
  assert.ok(firstRefresh > awaitPrep);
  assert.ok(awaitNaturalFallback > firstRefresh);
  assert.match(source, /refreshWinNaturalVoices\?\.\(\{ retry: true \}\)/);
});

test("installed optimized startup cannot restore a saved Online voice over Zira", async () => {
  global.EdgeTtsExtension.TextModel = {
    firstBlockNearViewport(blocks) { return blocks[0]; }
  };
  global.EdgeTtsExtension.SpeechEngine = {
    isNaturalVoice() { return false; }
  };

  class FakeReaderApp {
    constructor() {
      this.toolbar = { mount() {}, setStatus() {}, setPaused() {} };
      this.voices = [];
      this.refreshes = [];
      this.selectedVoice = null;
      this.nativeRefreshes = 0;
      this.speech = {
        refreshExtensionVoices: async () => {},
        refreshWinNaturalVoices: async (options) => {
          this.nativeRefreshes += 1;
          assert.deepEqual(options, { retry: true });
          return [];
        },
        waitForVoices: async () => []
      };
    }

    async loadSettings() {
      this.settings = { voiceName: "Microsoft Aria Online (Natural)" };
    }

    applySettings() {}

    rebuildModel() {
      this.model = { blocks: [{ index: 0 }] };
    }

    refreshVoices(options) {
      this.refreshes.push(options);
      const zira = { name: "Microsoft Zira", lang: "en-US", localService: true };
      const online = { name: "Microsoft Aria Online (Natural)", lang: "en-US", remote: true };
      this.voices = [online, zira];
      this.selectedVoice = options?.startup ? zira : online;
    }

    async claimAudioOwnership() { return false; }
    stop() {}
  }

  const { installStartupFastPath } = require("../src/content/startup-fastpath.js");
  assert.equal(installStartupFastPath(FakeReaderApp), true);
  const app = new FakeReaderApp();
  await app.open();

  assert.equal(app.nativeRefreshes, 1);
  assert.ok(app.refreshes.length >= 1);
  assert.ok(app.refreshes.every((options) => options?.startup === true));
  assert.equal(app.selectedVoice.name, "Microsoft Zira");
});
