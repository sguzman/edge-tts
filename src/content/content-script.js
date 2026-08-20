(function bootstrapEdgeTts(root) {
  if (root.__EDGE_TTS_READER__) {
    return;
  }

  const extension = root.EdgeTtsExtension;
  if (!extension?.Reader?.ReaderApp) {
    console.error("Edge Natural TTS reader modules did not initialize.");
    return;
  }

  const app = new extension.Reader.ReaderApp();
  root.__EDGE_TTS_READER__ = { app };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EDGE_TTS_PING") {
      sendResponse({ ready: true });
      return false;
    }

    if (message?.type === "EDGE_TTS_TOGGLE") {
      void app.toggle();
      sendResponse({ accepted: true });
      return false;
    }

    return false;
  });
})(globalThis);
