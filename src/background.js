if (typeof importScripts === "function") {
  importScripts("/src/background/native-messaging.js");
} else if (typeof require === "function") {
  require("./background/native-messaging.js");
}

const READER_FILES = [
  "src/content/namespace.js",
  "src/content/text-model.js",
  "src/content/highlighter.js",
  "src/content/speech-engine.js",
  "src/content/reliable-speech-engine.js",
  "src/content/direct-audio-engine.js",
  "src/content/local-tts-engine.js",
  "src/content/toolbar.js",
  "src/content/voice-ui.js",
  "src/content/reader.js",
  "src/content/reliable-reader.js",
  "src/content/failsafe-reader.js",
  "src/content/audio-controls.js",
  "src/content/startup-fastpath.js",
  "src/content/content-script.js"
];

const READER_CSS = ["src/content/content.css"];
const injectionPromises = new Map();
const nativeMessagingApi = globalThis.EdgeTtsNativeMessaging;
const AUDIO_OWNER_STORAGE_KEY = "edgeTtsAudioOwnerTabId";
let audioOwnerTabId = null;
let audioOwnerLoaded = false;
let audioMutationChain = Promise.resolve();
let localTtsSession = null;
let nativeTransport = null;

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

async function getExtensionTtsVoices() {
  if (!chrome.tts?.getVoices) return [];
  const voices = await chrome.tts.getVoices();
  return (voices || []).map((voice) => ({
    voiceName: String(voice.voiceName || ""),
    lang: String(voice.lang || ""),
    remote: voice.remote === true,
    extensionId: voice.extensionId || null,
    eventTypes: Array.isArray(voice.eventTypes) ? [...voice.eventTypes] : []
  }));
}

function getNativeTransport() {
  if (!nativeMessagingApi?.createTransport) {
    throw new Error("Native Messaging is unavailable.");
  }
  if (nativeTransport) return nativeTransport;
  let transport;
  transport = nativeMessagingApi.createTransport({
    onDisconnect: () => {
      if (nativeTransport === transport) nativeTransport = null;
    }
  });
  nativeTransport = transport;
  return transport;
}

function invalidateNativeTransport(transport) {
  if (nativeTransport !== transport) return;
  nativeTransport = null;
  transport.disconnect?.();
}

async function getWinNaturalVoices() {
  let transport;
  try {
    transport = getNativeTransport();
    const response = await transport.request("voices");
    const voices = (Array.isArray(response?.voices) ? response.voices : [])
      .filter((voice) => String(voice?.id || "").toLowerCase().startsWith("local-"))
      .map((voice) => ({
        id: String(voice.id),
        name: String(voice.name || ""),
        lang: String(voice.lang || "")
      }));
    if (!voices.length) {
      return {
        voices: [],
        error: { name: "EmptyVoiceCatalog", message: "Native host returned no Local-* voices." }
      };
    }
    return { voices };
  } catch (error) {
    invalidateNativeTransport(transport);
    console.warn("Edge Natural TTS could not enumerate Windows Natural voices.", error);
    return {
      voices: [],
      error: {
        name: String(error?.name || "Error"),
        message: String(error?.message || error)
      }
    };
  }
}

async function getWinNaturalDiagnostics() {
  let transport;
  try {
    transport = getNativeTransport();
    return await transport.diagnostics();
  } catch (error) {
    invalidateNativeTransport(transport);
    throw error;
  }
}

async function synthesizeWinNaturalDiagnostic(message) {
  let transport;
  const voiceId = String(message?.voiceId || "").trim();
  const text = String(message?.text || "");
  if (!/^Local-/i.test(voiceId)) throw new Error("Invalid Windows Natural voice ID.");
  if (!text) throw new Error("Windows Natural synthesis text is empty.");
  try {
    transport = getNativeTransport();
    return await transport.requestMultipart(
      "synthesize",
      { voiceId, text },
      nativeMessagingApi.SYNTHESIS_TIMEOUT_MS || 30_000
    );
  } catch (error) {
    invalidateNativeTransport(transport);
    throw error;
  }
}

function localTtsEventPayload(event) {
  return {
    type: String(event?.type || ""),
    charIndex: Number.isFinite(Number(event?.charIndex)) ? Number(event.charIndex) : null,
    length: Number.isFinite(Number(event?.length)) ? Number(event.length) : null,
    errorMessage: event?.errorMessage ? String(event.errorMessage) : ""
  };
}

function stopLocalTtsForTab(tabId, requestId = null) {
  const session = localTtsSession;
  if (!session || session.tabId !== tabId) return false;
  if (requestId && session.requestId !== requestId) return false;

  localTtsSession = null;
  try {
    chrome.tts?.stop?.();
  } catch (_error) {}
  return true;
}

async function speakLocalTtsForTab(tabId, message) {
  await loadAudioOwner();
  if (audioOwnerTabId !== tabId || !chrome.tts?.speak) {
    return false;
  }

  const text = String(message?.text || "");
  const voiceName = String(message?.voiceName || "");
  const requestId = String(message?.requestId || "");
  if (!text || !voiceName || !requestId) return false;

  if (localTtsSession) {
    try {
      chrome.tts.stop();
    } catch (_error) {}
  }

  const session = { tabId, requestId };
  localTtsSession = session;
  const options = {
    voiceName,
    enqueue: false,
    rate: Math.min(10, Math.max(0.1, Number(message.rate) || 1)),
    volume: Math.min(1, Math.max(0, Number(message.volume) || 0)),
    onEvent(event) {
      if (
        !localTtsSession ||
        localTtsSession.tabId !== tabId ||
        localTtsSession.requestId !== requestId
      ) {
        return;
      }

      const payload = localTtsEventPayload(event);
      void chrome.tabs
        .sendMessage(tabId, {
          type: "EDGE_TTS_LOCAL_EVENT",
          requestId,
          event: payload
        })
        .catch(() => {});

      if (["end", "interrupted", "cancelled", "error"].includes(payload.type)) {
        localTtsSession = null;
      }
    }
  };
  if (message.lang) options.lang = String(message.lang);

  try {
    const pending = chrome.tts.speak(text, options);
    pending?.catch?.((error) => {
      if (
        localTtsSession?.tabId === tabId &&
        localTtsSession?.requestId === requestId
      ) {
        localTtsSession = null;
        void chrome.tabs
          .sendMessage(tabId, {
            type: "EDGE_TTS_LOCAL_EVENT",
            requestId,
            event: {
              type: "error",
              charIndex: null,
              length: null,
              errorMessage: error?.message || String(error)
            }
          })
          .catch(() => {});
      }
    });
    return true;
  } catch (error) {
    if (localTtsSession === session) localTtsSession = null;
    console.warn("Edge Natural TTS could not start a Windows local voice.", error);
    return false;
  }
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

  if (message?.type === "EDGE_TTS_LOCAL_VOICES") {
    void getExtensionTtsVoices()
      .then((voices) => sendResponse({ voices }))
      .catch((error) => {
        console.warn("Edge Natural TTS could not enumerate extension TTS voices.", error);
        sendResponse({ voices: [] });
      });
    return true;
  }

  if (message?.type === "EDGE_TTS_WIN_NATURAL_VOICES") {
    void getWinNaturalVoices().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "EDGE_TTS_WIN_NATURAL_DIAGNOSTICS") {
    void getWinNaturalDiagnostics()
      .then((result) => sendResponse({ ...result }))
      .catch((error) => sendResponse({ connected: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE") {
    void synthesizeWinNaturalDiagnostic(message)
      .then((result) => sendResponse({ accepted: true, ...result }))
      .catch((error) => sendResponse({ accepted: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "EDGE_TTS_LOCAL_SPEAK") {
    if (!Number.isInteger(tabId)) {
      sendResponse({ accepted: false });
      return false;
    }
    void speakLocalTtsForTab(tabId, message)
      .then((accepted) => sendResponse({ accepted }))
      .catch(() => sendResponse({ accepted: false }));
    return true;
  }

  if (message?.type === "EDGE_TTS_LOCAL_STOP") {
    if (!Number.isInteger(tabId)) {
      sendResponse({ stopped: false });
      return false;
    }
    sendResponse({ stopped: stopLocalTtsForTab(tabId, message.requestId || null) });
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectionPromises.delete(tabId);
  stopLocalTtsForTab(tabId);
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
  if (!tab.id) return;

  try {
    await ensureReader(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "EDGE_TTS_TOGGLE" });
  } catch (error) {
    console.warn("Edge Natural TTS could not run on this page.", error);
  }
});
