const READER_FILES = [
  "src/content/namespace.js",
  "src/content/text-model.js",
  "src/content/highlighter.js",
  "src/content/speech-engine.js",
  "src/content/reliable-speech-engine.js",
  "src/content/toolbar.js",
  "src/content/reader.js",
  "src/content/reliable-reader.js",
  "src/content/failsafe-reader.js",
  "src/content/startup-fastpath.js",
  "src/content/content-script.js"
];

const READER_CSS = ["src/content/content.css"];
const injectionPromises = new Map();

const AUDIO_OWNER_STORAGE_KEY = "edgeTtsAudioOwnerTabId";
let audioOwnerTabId = null;
let audioOwnerLoaded = false;
let audioMutationChain = Promise.resolve();

async function loadAudioOwner() {
  if (audioOwnerLoaded) return audioOwnerTabId;
  audioOwnerLoaded = true;
  try {
    const stored = await chrome.storage.session.get(AUDIO_OWNER_STORAGE_KEY);
    const value = stored?.[AUDIO_OWNER_STORAGE_KEY];
    audioOwnerTabId = Number.isInteger(value) ? value : null;
  } catch (_error) {
    audioOwnerTabId = null;
  }
  return audioOwnerTabId;
}

async function storeAudioOwner(tabId) {
  audioOwnerTabId = Number.isInteger(tabId) ? tabId : null;
  try {
    if (audioOwnerTabId === null) {
      await chrome.storage.session.remove(AUDIO_OWNER_STORAGE_KEY);
    } else {
      await chrome.storage.session.set({ [AUDIO_OWNER_STORAGE_KEY]: audioOwnerTabId });
    }
  } catch (_error) {
    // In-memory ownership still protects the current service-worker lifetime.
  }
}

function queueAudioMutation(operation) {
  const next = audioMutationChain.then(operation, operation);
  audioMutationChain = next.catch(() => {});
  return next;
}

async function claimAudioForTab(tabId) {
  return queueAudioMutation(async () => {
    await loadAudioOwner();
    if (audioOwnerTabId === tabId) {
      return true;
    }

    const previousOwner = audioOwnerTabId;
    if (previousOwner !== null) {
      try {
        await chrome.tabs.sendMessage(previousOwner, {
          type: "EDGE_TTS_AUDIO_PREEMPT"
        });
      } catch (_error) {
        // The previous tab may have navigated or closed. Its claim is stale.
      }
    }

    await storeAudioOwner(tabId);
    return true;
  });
}

async function releaseAudioForTab(tabId) {
  return queueAudioMutation(async () => {
    await loadAudioOwner();
    if (audioOwnerTabId === tabId) {
      await storeAudioOwner(null);
    }
    return true;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message?.type === "EDGE_TTS_AUDIO_CLAIM") {
    if (!Number.isInteger(tabId)) {
      sendResponse({ granted: false });
      return false;
    }

    void claimAudioForTab(tabId)
      .then(() => sendResponse({ granted: true }))
      .catch((error) => {
        console.warn("Edge Natural TTS could not arbitrate audio ownership.", error);
        sendResponse({ granted: false });
      });
    return true;
  }

  if (message?.type === "EDGE_TTS_AUDIO_RELEASE") {
    if (!Number.isInteger(tabId)) {
      sendResponse({ released: false });
      return false;
    }

    void releaseAudioForTab(tabId)
      .then(() => sendResponse({ released: true }))
      .catch(() => sendResponse({ released: false }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectionPromises.delete(tabId);
  void queueAudioMutation(async () => {
    await loadAudioOwner();
    if (audioOwnerTabId === tabId) {
      await storeAudioOwner(null);
    }
  });
});

async function readerReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "EDGE_TTS_PING" });
    return response?.ready === true;
  } catch (_error) {
    return false;
  }
}

async function injectReader(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: READER_CSS
  });

  // executeScript resolves only after every listed file has executed. Because
  // content-script.js is last and registers the wake-up listener synchronously,
  // another post-injection PING round-trip is redundant startup latency.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: READER_FILES
  });
}

async function ensureReader(tabId) {
  if (await readerReady(tabId)) {
    return;
  }

  let pending = injectionPromises.get(tabId);
  if (!pending) {
    pending = injectReader(tabId);
    injectionPromises.set(tabId, pending);
  }

  try {
    await pending;
  } finally {
    if (injectionPromises.get(tabId) === pending) {
      injectionPromises.delete(tabId);
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await ensureReader(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "EDGE_TTS_TOGGLE" });
  } catch (error) {
    console.warn("Edge Natural TTS could not run on this page.", error);
  }
});
