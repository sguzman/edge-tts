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
  "src/content/boundaryless-fallback.js",
  "src/content/startup-fastpath.js",
  "src/content/content-script.js"
];

const READER_CSS = ["src/content/content.css"];
const injectionPromises = new Map();

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
