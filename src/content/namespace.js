(function prepareEdgeTtsNamespace(root) {
  // This file is always injected first. A browser-extension reload can leave
  // the old reader JavaScript alive in an already-open page even though its
  // runtime bridge is dead. If the new injection lands in the same isolated
  // world, retire that generation before rebuilding the module namespace.
  const previousSession = root.__EDGE_TTS_READER__;
  if (previousSession) {
    try {
      previousSession.dispose?.();
    } catch (_error) {}
    try {
      previousSession.app?.stop?.();
    } catch (_error) {}
  }

  for (const element of document.querySelectorAll(
    "[data-edge-tts-ui='true'], #edge-tts-toolbar"
  )) {
    element.remove();
  }

  try {
    delete root.__EDGE_TTS_READER__;
  } catch (_error) {
    root.__EDGE_TTS_READER__ = null;
  }

  // Never extend classes left behind by a previous extension generation.
  root.EdgeTtsExtension = {};
})(globalThis);
