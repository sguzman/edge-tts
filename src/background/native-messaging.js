(function attachNativeMessaging(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EdgeTtsNativeMessaging = api;
})(globalThis, function createNativeMessagingApi(root) {
  const HOST_NAME = "com.sguzman.edge_tts.win_natural";
  const REQUEST_TIMEOUT_MS = 5_000;
  const SYNTHESIS_TIMEOUT_MS = 30_000;
  const MAX_SYNTHESIS_BYTES = 8 * 1024 * 1024;

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
      function rejectRequest(requestId, error) {
        const request = pending.get(requestId);
        if (!request) return;
        pending.delete(requestId);
        clearTimeout(request.timeout);
        request.reject(error);
      }

      function bytesFromBase64(value) {
        if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
          throw new Error("Malformed Native Messaging audio chunk.");
        }
        const binary = root.atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }

      function base64FromBytes(bytes) {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return root.btoa(binary);
      }

      next.onMessage.addListener((message) => {
        const requestId = String(message?.requestId || "");
        const request = pending.get(requestId);
        if (!request) return;
        if (request.mode === "multipart") {
          try {
            if (message?.type === "error") {
              throw new Error(String(message.message || "Native host error."));
            }
            if (message?.type === "synth-start") {
              if (request.started) throw new Error("Duplicate native synthesis start.");
              const totalBytes = Number(message.totalBytes);
              const chunkCount = Number(message.chunkCount);
              if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_SYNTHESIS_BYTES) {
                throw new Error("Invalid native synthesis size.");
              }
              if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
                throw new Error("Invalid native synthesis chunk count.");
              }
              request.started = true;
              request.totalBytes = totalBytes;
              request.chunkCount = chunkCount;
              return;
            }
            if (message?.type === "synth-chunk") {
              if (!request.started) throw new Error("Native synthesis chunk arrived before start.");
              const index = Number(message.index);
              if (!Number.isSafeInteger(index) || index !== request.nextIndex) {
                throw new Error("Native synthesis chunks arrived out of order.");
              }
              const bytes = bytesFromBase64(message.data);
              request.receivedBytes += bytes.length;
              if (request.receivedBytes > request.totalBytes || request.receivedBytes > MAX_SYNTHESIS_BYTES) {
                throw new Error("Native synthesis payload exceeds its declared size.");
              }
              request.chunks.push(bytes);
              request.nextIndex += 1;
              return;
            }
            if (message?.type === "synth-end") {
              const totalBytes = Number(message.totalBytes);
              const chunkCount = Number(message.chunkCount);
              if (!request.started || chunkCount !== request.chunkCount || request.nextIndex !== request.chunkCount ||
                  totalBytes !== request.totalBytes || request.receivedBytes !== request.totalBytes) {
                throw new Error("Native synthesis payload is incomplete.");
              }
              const bytes = new Uint8Array(request.receivedBytes);
              let offset = 0;
              for (const chunk of request.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              pending.delete(requestId);
              clearTimeout(request.timeout);
              request.resolve({ type: "synthesize", requestId, wavBase64: base64FromBytes(bytes), totalBytes: request.receivedBytes });
              return;
            }
            throw new Error("Unexpected Native Messaging multipart response.");
          } catch (error) {
            rejectRequest(requestId, error);
          }
          return;
        }
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

    function requestMultipart(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
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
          pending.set(requestId, {
            mode: "multipart",
            resolve,
            reject,
            timeout,
            started: false,
            totalBytes: 0,
            receivedBytes: 0,
            chunkCount: 0,
            nextIndex: 0,
            chunks: []
          });
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

    return {
      diagnostics,
      disconnect,
      request,
      requestMultipart,
      HOST_NAME,
      REQUEST_TIMEOUT_MS,
      SYNTHESIS_TIMEOUT_MS,
      MAX_SYNTHESIS_BYTES
    };
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
