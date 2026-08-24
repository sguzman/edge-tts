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

  const onMessage = (message, _sender, sendResponse) => {
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
  };

  const session = {
    app,
    detach(requestingApp) {
      if (requestingApp && requestingApp !== app) {
        return;
      }

      chrome.runtime.onMessage.removeListener(onMessage);
      if (root.__EDGE_TTS_READER__ === session) {
        delete root.__EDGE_TTS_READER__;
      }

      try {
        const pending = chrome.runtime.sendMessage({ type: "EDGE_TTS_SESSION_QUIT" });
        pending?.catch?.(() => {});
      } catch (_error) {
        // The page-side session is already fully detached. CSS cleanup in the
        // background is best-effort and does not affect the next fresh launch.
      }
    }
  };

  root.__EDGE_TTS_READER__ = session;
  chrome.runtime.onMessage.addListener(onMessage);
})(globalThis);