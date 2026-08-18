(function bootstrapEdgeTts(root) {
  const extension = root.EdgeTtsExtension;
  const app = new extension.Reader.ReaderApp();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "EDGE_TTS_TOGGLE") {
      app.toggle();
    }
  });
})(globalThis);
