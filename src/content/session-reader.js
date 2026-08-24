(function attachSessionReader(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.Reader && api.SessionReaderApp) {
    root.EdgeTtsExtension.Reader.ReaderApp = api.SessionReaderApp;
  }
})(globalThis, function createSessionReaderApi(root) {
  const BaseReaderApp = root.EdgeTtsExtension?.Reader?.ReaderApp;

  function destroyHighlighter(highlighter) {
    if (!highlighter) return;
    highlighter.clear?.();
    highlighter.styleElement?.remove?.();
    highlighter.styleElement = null;
  }

  if (!BaseReaderApp) {
    return { SessionReaderApp: null, destroyHighlighter };
  }

  class SessionReaderApp extends BaseReaderApp {
    constructor() {
      super();
      this.quitRequested = false;
      if (this.toolbar?.handlers) {
        this.toolbar.handlers.onQuit = () => this.quit();
      }
    }

    quit() {
      if (this.quitRequested) return;
      this.quitRequested = true;

      // Use the normal stop path first so every reliability wrapper gets a
      // chance to cancel its timers and active speech state.
      this.stop();
      this.enabled = false;
      this.syncPageClickListener?.();

      this.unsubscribeVoiceChanges?.();
      this.unsubscribeVoiceChanges = null;

      destroyHighlighter(this.highlighter);
      this.toolbar?.destroy?.();

      this.model = null;
      this.voices = [];
      this.selectedVoice = null;
      this.activeBatchRequest = null;
      this.activeBatchEndBlockIndex = -1;

      // content-script owns the session registration/message listener. Detach
      // it so the next extension-action click must create a fresh reader.
      root.__EDGE_TTS_READER__?.detach?.(this);
    }
  }

  return { SessionReaderApp, destroyHighlighter };
});