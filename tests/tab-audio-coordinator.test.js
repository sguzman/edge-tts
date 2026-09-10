const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let runtimeMessageListener = null;
let tabRemovedListener = null;
const sentMessages = [];
const sessionStore = Object.create(null);

global.chrome = {
  storage: {
    session: {
      async get(key) {
        return Object.prototype.hasOwnProperty.call(sessionStore, key)
          ? { [key]: sessionStore[key] }
          : {};
      },
      async set(values) {
        Object.assign(sessionStore, values);
      },
      async remove(key) {
        delete sessionStore[key];
      }
    }
  },
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeMessageListener = listener;
      }
    }
  },
  tabs: {
    async sendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      return { accepted: true };
    },
    onRemoved: {
      addListener(listener) {
        tabRemovedListener = listener;
      }
    }
  },
  scripting: {
    async insertCSS() {},
    async executeScript() {}
  },
  action: {
    onClicked: {
      addListener() {}
    }
  }
};

require("../src/background.js");

function sendRuntimeMessage(type, tabId) {
  return new Promise((resolve, reject) => {
    if (!runtimeMessageListener) {
      reject(new Error("runtime listener was not registered"));
      return;
    }

    let settled = false;
    const sendResponse = (response) => {
      settled = true;
      resolve(response);
    };
    const keepChannelOpen = runtimeMessageListener(
      { type },
      { tab: { id: tabId } },
      sendResponse
    );

    if (keepChannelOpen !== true && !settled) {
      resolve(undefined);
    }
  });
}

test("audio ownership preempts only the previous owner and survives unrelated releases", async () => {
  assert.deepEqual(await sendRuntimeMessage("EDGE_TTS_AUDIO_CLAIM", 11), { granted: true });
  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, 11);
  assert.equal(sentMessages.length, 0);

  assert.deepEqual(await sendRuntimeMessage("EDGE_TTS_AUDIO_CLAIM", 22), { granted: true });
  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, 22);
  assert.deepEqual(sentMessages.at(-1), {
    tabId: 11,
    message: { type: "EDGE_TTS_AUDIO_PREEMPT" }
  });

  // A stale/non-owner release must never revoke the current tab's claim.
  assert.deepEqual(await sendRuntimeMessage("EDGE_TTS_AUDIO_RELEASE", 11), { released: true });
  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, 22);

  assert.deepEqual(await sendRuntimeMessage("EDGE_TTS_AUDIO_RELEASE", 22), { released: true });
  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, undefined);
});

test("closing the owner tab clears persisted ownership", async () => {
  await sendRuntimeMessage("EDGE_TTS_AUDIO_CLAIM", 33);
  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, 33);

  tabRemovedListener(33);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sessionStore.edgeTtsAudioOwnerTabId, undefined);
});

test("reader pause is local and cannot leave a browser-global utterance parked", () => {
  const readerSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "reader.js"),
    "utf8"
  );
  const playPauseStart = readerSource.indexOf("async playPause()");
  const refreshStart = readerSource.indexOf("refreshText()", playPauseStart);
  const playPauseSource = readerSource.slice(playPauseStart, refreshStart);

  assert.ok(playPauseStart >= 0 && refreshStart > playPauseStart);
  assert.doesNotMatch(playPauseSource, /this\.speech\.pause\(/);
  assert.doesNotMatch(playPauseSource, /this\.speech\.resume\(/);
  assert.match(playPauseSource, /discardLocalSpeechState\(\)/);
  assert.match(playPauseSource, /releaseAudioOwnership\(\)/);

  const preemptStart = readerSource.indexOf("suspendForOtherTab()");
  const discardStart = readerSource.indexOf("discardLocalSpeechState()", preemptStart);
  const preemptSource = readerSource.slice(preemptStart, discardStart);
  assert.match(preemptSource, /this\.speech\?\.cancel\?\.\(\)/);
  assert.match(preemptSource, /this\.paused = true/);

  const speakStart = readerSource.indexOf("    speakCurrentPosition() {");
  const speechStartHandler = readerSource.indexOf("    handleSpeechStart(", speakStart);
  const speakSource = readerSource.slice(speakStart, speechStartHandler);
  assert.match(speakSource, /!this\.audioOwner/);
});

test("startup claims audio before the first speech request", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "content", "startup-fastpath.js"),
    "utf8"
  );
  const claim = source.indexOf("await this.claimAudioOwnership");
  const speak = source.indexOf("this.speakCurrentPosition()", claim);
  assert.ok(claim >= 0);
  assert.ok(speak > claim);
});
