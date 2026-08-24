const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

class BaseReaderApp {
  constructor() {
    this.enabled = true;
    this.stopped = false;
    this.model = { blocks: [{}] };
    this.voices = [{ name: "voice" }];
    this.selectedVoice = this.voices[0];
    this.activeBatchRequest = {};
    this.activeBatchEndBlockIndex = 3;
    this.stopCalls = 0;
    this.syncCalls = 0;
    this.unsubscribeCalls = 0;
    this.toolbarDestroyCalls = 0;
    this.highlightClearCalls = 0;
    this.highlightStyleRemoveCalls = 0;
    this.toolbar = {
      handlers: {},
      destroy: () => {
        this.toolbarDestroyCalls += 1;
      }
    };
    this.highlighter = {
      clear: () => {
        this.highlightClearCalls += 1;
      },
      styleElement: {
        remove: () => {
          this.highlightStyleRemoveCalls += 1;
        }
      }
    };
    this.unsubscribeVoiceChanges = () => {
      this.unsubscribeCalls += 1;
    };
  }

  stop() {
    this.stopCalls += 1;
    this.stopped = true;
  }

  syncPageClickListener() {
    this.syncCalls += 1;
  }
}

global.EdgeTtsExtension = { Reader: { ReaderApp: BaseReaderApp } };
const { SessionReaderApp } = require("../src/content/session-reader.js");

test("Quit tears down the active reader and detaches the tab session", () => {
  let detachedApp = null;
  const app = new SessionReaderApp();
  global.__EDGE_TTS_READER__ = {
    detach(requestingApp) {
      detachedApp = requestingApp;
    }
  };

  assert.equal(typeof app.toolbar.handlers.onQuit, "function");
  app.toolbar.handlers.onQuit();

  assert.equal(app.stopCalls, 1);
  assert.equal(app.enabled, false);
  assert.equal(app.syncCalls, 1);
  assert.equal(app.unsubscribeCalls, 1);
  assert.equal(app.unsubscribeVoiceChanges, null);
  assert.equal(app.highlightClearCalls, 1);
  assert.equal(app.highlightStyleRemoveCalls, 1);
  assert.equal(app.toolbarDestroyCalls, 1);
  assert.equal(app.model, null);
  assert.deepEqual(app.voices, []);
  assert.equal(app.selectedVoice, null);
  assert.equal(app.activeBatchRequest, null);
  assert.equal(app.activeBatchEndBlockIndex, -1);
  assert.equal(detachedApp, app);

  app.quit();
  assert.equal(app.stopCalls, 1, "Quit is idempotent");

  delete global.__EDGE_TTS_READER__;
});

test("content-script removes its message listener and session marker on detach", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "content-script.js"),
    "utf8"
  );

  assert.match(source, /onMessage\.removeListener\(onMessage\)/);
  assert.match(source, /delete root\.__EDGE_TTS_READER__/);
  assert.match(source, /EDGE_TTS_SESSION_QUIT/);
});