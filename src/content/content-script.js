(function bootstrapEdgeTts(root) {
  if (root.__EDGE_TTS_READER__) {
    return;
  }

  const extension = root.EdgeTtsExtension;
  if (!extension?.Reader?.ReaderApp) {
    console.error("Edge Natural TTS reader modules did not initialize.");
    return;
  }

  // Reloading an unpacked extension destroys the old isolated JS world but the
  // DOM it created can survive in an already-open page. Those orphaned HUDs no
  // longer have live extension event handlers, so they look like duplicate
  // readers whose Quit button does nothing. A fresh bootstrap owns the page UI:
  // remove any orphaned reader chrome before constructing the new app.
  for (const element of document.querySelectorAll("[data-edge-tts-ui='true'], #edge-tts-toolbar")) {
    element.remove();
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

    if (message?.type === "EDGE_TTS_AUDIO_PREEMPT") {
      app?.suspendForOtherTab?.();
      sendResponse({ accepted: true });
      return false;
    }

    if (message?.type === "EDGE_TTS_LOCAL_EVENT") {
      const accepted = app?.speech?.handleChromeTtsEvent?.(message) === true;
      sendResponse({ accepted });
      return false;
    }

    if (message?.type === "EDGE_TTS_WIN_NATURAL_EVENT") {
      const accepted = app?.speech?.handleWinNaturalEvent?.(message) === true;
      sendResponse({ accepted });
      return false;
    }

    return false;
  };

  root.__EDGE_TTS_READER__ = session;
  chrome.runtime.onMessage.addListener(onMessage);
})(globalThis);
