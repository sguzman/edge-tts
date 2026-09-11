(function bootstrapEdgeTts(root) {
  const SESSION_REVISION = 2;
  const extension = root.EdgeTtsExtension;
  if (!extension?.Reader?.ReaderApp) {
    console.error("Edge Natural TTS reader modules did not initialize.");
    return;
  }

  // If this file is executing, the background has already decided that the
  // currently registered reader is not the live reader for this extension
  // generation. An unpacked-extension reload can leave the old isolated-world
  // marker and DOM behind even though its chrome.runtime context is dead. Do
  // not return merely because that stale marker exists: retire it and take
  // ownership of the page again.
  const previousSession = root.__EDGE_TTS_READER__;
  if (previousSession) {
    try {
      previousSession.dispose?.();
    } catch (_error) {}
    try {
      previousSession.app?.stop?.();
    } catch (_error) {}
    try {
      previousSession.app?.toolbar?.destroy?.();
    } catch (_error) {}
    try {
      previousSession.app?.highlighter?.clear?.();
    } catch (_error) {}
  }

  for (const element of document.querySelectorAll("[data-edge-tts-ui='true'], #edge-tts-toolbar")) {
    element.remove();
  }

  try {
    delete root.__EDGE_TTS_READER__;
  } catch (_error) {
    root.__EDGE_TTS_READER__ = null;
  }

  let app = new extension.Reader.ReaderApp();
  let disposed = false;
  let onMessage = null;

  const session = {
    revision: SESSION_REVISION,
    get app() {
      return app;
    },
    get disposed() {
      return disposed;
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
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const currentApp = app;
      app = null;

      try {
        currentApp?.stop?.();
      } catch (_error) {}
      try {
        currentApp?.unsubscribeVoiceChanges?.();
      } catch (_error) {}
      try {
        currentApp?.highlighter?.clear?.();
      } catch (_error) {}
      try {
        currentApp?.toolbar?.destroy?.();
      } catch (_error) {}
      try {
        if (onMessage) chrome.runtime.onMessage.removeListener(onMessage);
      } catch (_error) {}

      if (root.__EDGE_TTS_READER__ === session) {
        try {
          delete root.__EDGE_TTS_READER__;
        } catch (_error) {
          root.__EDGE_TTS_READER__ = null;
        }
      }
    }
  };

  onMessage = (message, _sender, sendResponse) => {
    if (message?.type === "EDGE_TTS_PING_V2") {
      sendResponse({ ready: true, active: Boolean(app), revision: SESSION_REVISION });
      return false;
    }

    if (message?.type === "EDGE_TTS_TOGGLE_V2") {
      if (!app) {
        app = new extension.Reader.ReaderApp();
      }
      void app.toggle();
      sendResponse({ accepted: true, revision: SESSION_REVISION });
      return false;
    }

    if (
      message?.type === "EDGE_TTS_AUDIO_PREEMPT_V2" ||
      message?.type === "EDGE_TTS_AUDIO_PREEMPT"
    ) {
      app?.suspendForOtherTab?.();
      sendResponse({ accepted: true });
      return false;
    }

    if (
      message?.type === "EDGE_TTS_LOCAL_EVENT_V2" ||
      message?.type === "EDGE_TTS_LOCAL_EVENT"
    ) {
      const accepted = app?.speech?.handleChromeTtsEvent?.(message) === true;
      sendResponse({ accepted });
      return false;
    }

    if (
      message?.type === "EDGE_TTS_WIN_NATURAL_EVENT_V2" ||
      message?.type === "EDGE_TTS_WIN_NATURAL_EVENT"
    ) {
      const accepted = app?.speech?.handleWinNaturalEvent?.(message) === true;
      sendResponse({ accepted });
      return false;
    }

    return false;
  };

  root.__EDGE_TTS_READER__ = session;
  chrome.runtime.onMessage.addListener(onMessage);
})(globalThis);
