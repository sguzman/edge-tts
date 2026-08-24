(function bootstrapEdgeTts(root) {
  if (root.__EDGE_TTS_READER__) {
    return;
  }

  const extension = root.EdgeTtsExtension;
  if (!extension?.Reader?.ReaderApp) {
    console.error("Edge Natural TTS reader modules did not initialize.");
    return;
  }

  let app = new extension.Reader.ReaderApp();

  const session = {
    get app() {
      return app;
    },
    detach(requestingApp) {
      if (requestingApp && requestingApp !== app) {
        return;
      }

      // Quit destroys the actual ReaderApp and all of its active resources, but
      // leaves this tiny runtime-message bootstrap resident. The next toolbar
      // click can therefore construct a genuinely fresh ReaderApp without
      // reinjecting/reparsing the entire extension stack.
      app = null;
    }
  };

  const onMessage = (message, _sender, sendResponse) => {
    if (message?.type === "EDGE_TTS_PING") {
      sendResponse({ ready: true, active: Boolean(app) });
      return false;
    }

    if (message?.type === "EDGE_TTS_TOGGLE") {
      if (!app) {
        app = new extension.Reader.ReaderApp();
      }
      void app.toggle();
      sendResponse({ accepted: true });
      return false;
    }

    return false;
  };

  root.__EDGE_TTS_READER__ = session;
  chrome.runtime.onMessage.addListener(onMessage);
})(globalThis);
