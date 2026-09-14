(function attachNativeMessaging(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EdgeTtsNativeMessaging = api;
})(globalThis, function createNativeMessagingApi(root) {
  const HOST_NAME = "com.sguzman.edge_tts.win_natural";
  const REQUEST_TIMEOUT_MS = 5_000;

  function createTransport(options = {}) {
    const connectNative = options.connectNative || root.chrome?.runtime?.connectNative;
    const now = options.now || (() => Date.now());
    let port = null;
    let serial = 0;
    const pending = new Map();

    function rejectPending(error) {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      pending.clear();
    }

    function disconnect() {
      const current = port;
      port = null;
      if (current) {
        try {
          current.disconnect();
        } catch (_error) {}
      }
      rejectPending(new Error("Native Messaging host disconnected."));
    }

    function ensurePort() {
      if (port) return port;
      if (typeof connectNative !== "function") {
        throw new Error("Native Messaging is unavailable in this context.");
      }
      const next = connectNative(HOST_NAME);
      next.onMessage.addListener((message) => {
        const requestId = String(message?.requestId || "");
        const request = pending.get(requestId);
        if (!request) return;
        pending.delete(requestId);
        clearTimeout(request.timeout);
        if (!message || typeof message.type !== "string") {
          request.reject(new Error("Malformed Native Messaging response."));
        } else if (message.type === "error") {
          request.reject(new Error(String(message.message || "Native host error.")));
        } else {
          request.resolve(message);
        }
      });
      next.onDisconnect.addListener(() => {
        if (port === next) port = null;
        rejectPending(new Error(root.chrome?.runtime?.lastError?.message || "Native Messaging host disconnected."));
      });
      port = next;
      return next;
    }

    function request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      const requestId = `native-${now()}-${++serial}`;
      return new Promise((resolve, reject) => {
        let activePort;
        let timeout = null;
        try {
          activePort = ensurePort();
          timeout = root.setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Native Messaging request timed out: ${type}`));
          }, timeoutMs);
          pending.set(requestId, { resolve, reject, timeout });
          activePort.postMessage({ type, requestId, ...payload });
        } catch (error) {
          pending.delete(requestId);
          if (timeout !== null) clearTimeout(timeout);
          reject(error);
        }
      });
    }

    async function diagnostics() {
      const startedAt = now();
      const hello = await request("hello");
      if (hello?.protocol !== 1) {
        throw new Error(`Unsupported Native Messaging protocol: ${hello?.protocol ?? "missing"}`);
      }
      if (hello?.architecture !== "x64") {
        throw new Error(`Native helper architecture is not x64: ${hello?.architecture || "missing"}`);
      }
      const voiceResponse = await request("voices");
      const voices = Array.isArray(voiceResponse?.voices)
        ? voiceResponse.voices.filter((voice) => isAdapterVoice(voice))
        : [];
      const ariaVoice = voices.find(
        (voice) =>
          String(voice?.name || "").trim() === "Microsoft Aria" &&
          (!voice?.lang || String(voice.lang).toLowerCase() === "en-us")
      ) || null;
      const result = {
        connected: true,
        handshake: { protocol: hello.protocol, architecture: hello.architecture },
        voices,
        ariaFound: ariaVoice !== null,
        ariaVoice,
        helperDiagnostics: voiceResponse?.diagnostics || null,
        elapsedMs: Math.max(0, now() - startedAt)
      };
      console.info("Edge Natural TTS Native Messaging diagnostics", result);
      return result;
    }

    function isAdapterVoice(voice) {
      return String(voice?.id || "").toLowerCase().startsWith("local-");
    }

    return { diagnostics, disconnect, request, HOST_NAME, REQUEST_TIMEOUT_MS };
  }

  function installDiagnosticsListener(runtime, getTransport, logger = console) {
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "EDGE_TTS_NATIVE_DIAGNOSTICS") return false;

      let transport;
      try {
        transport = typeof getTransport === "function" ? getTransport() : getTransport;
      } catch (error) {
        logger.warn("Edge Natural TTS Native Messaging setup failed.", error);
        sendResponse({ ok: false, error: String(error?.message || error) });
        return true;
      }

      void transport
        .diagnostics()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => {
          logger.warn("Edge Natural TTS Native Messaging diagnostics failed.", error);
          sendResponse({ ok: false, error: String(error?.message || error) });
        });
      return true;
    });
  }

  return { HOST_NAME, REQUEST_TIMEOUT_MS, createTransport, installDiagnosticsListener };
});
