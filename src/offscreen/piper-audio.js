(function piperOffscreenAudio() {
  const audio = document.getElementById("piper-audio");
  let playbackId = "";
  let ownerTabId = null;
  let objectUrl = "";
  let tickTimer = null;
  let endPauseTimer = null;
  let sentencePauseMs = 0;
  let boundaryOffsets = [];
  let boundaryIndex = 0;

  audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) {
    audio.webkitPreservesPitch = true;
  }

  function clearTick() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function clearEndPause() {
    if (endPauseTimer !== null) {
      clearTimeout(endPauseTimer);
      endPauseTimer = null;
    }
  }

  function revokeUrl() {
    if (!objectUrl) return;
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (_error) {}
    objectUrl = "";
  }

  function send(event) {
    if (!playbackId) return;
    try {
      void chrome.runtime.sendMessage({
        type: "EDGE_TTS_OFFSCREEN_PIPER_EVENT",
        playbackId,
        tabId: ownerTabId,
        event
      });
    } catch (_error) {}
  }

  function startTick() {
    clearTick();
    tickTimer = setInterval(() => {
      if (!playbackId || audio.paused || audio.ended) return;

      const currentTime = Math.max(0, Number(audio.currentTime) || 0);
      while (
        boundaryIndex < boundaryOffsets.length &&
        boundaryOffsets[boundaryIndex] <= currentTime + 0.02
      ) {
        send({
          type: "boundary",
          index: boundaryIndex,
          currentTime
        });
        boundaryIndex += 1;
      }
    }, 20);
  }

  function stopCurrent({ emit = false } = {}) {
    const previousId = playbackId;
    const previousTabId = ownerTabId;
    clearTick();
    clearEndPause();

    try {
      audio.pause();
    } catch (_error) {}
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch (_error) {}

    revokeUrl();
    playbackId = "";
    ownerTabId = null;
    sentencePauseMs = 0;
    boundaryOffsets = [];
    boundaryIndex = 0;

    if (emit && previousId) {
      try {
        void chrome.runtime.sendMessage({
          type: "EDGE_TTS_OFFSCREEN_PIPER_EVENT",
          playbackId: previousId,
          tabId: previousTabId,
          event: { type: "stopped" }
        });
      } catch (_error) {}
    }
  }

  function decodeBase64(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function play(message) {
    stopCurrent();

    playbackId = String(message.playbackId || "");
    ownerTabId = Number.isInteger(Number(message.tabId))
      ? Number(message.tabId)
      : null;
    if (!playbackId || !Number.isInteger(ownerTabId)) {
      throw new Error("Missing offscreen Piper playbackId or owner tab.");
    }

    const chunks = Array.isArray(message.audioChunks)
      ? message.audioChunks.map(decodeBase64)
      : [];
    if (!chunks.length) {
      throw new Error("No Piper WAV data was supplied to offscreen playback.");
    }
    boundaryOffsets = (Array.isArray(message.boundaryOffsets)
      ? message.boundaryOffsets
      : []
    )
      .map((value) => Math.max(0, Number(value) || 0));
    sentencePauseMs = Math.max(
      0,
      Math.min(1200, Number(message.sentencePauseMs) || 0)
    );
    boundaryIndex = 0;

    const blob = new Blob(chunks, { type: "audio/wav" });
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.playbackRate = Math.min(
      16,
      Math.max(0.25, Number(message.playbackRate) || 1)
    );
    audio.volume = Math.min(
      1,
      Math.max(0, Number(message.volume) || 0)
    );

    try {
      await audio.play();
      send({
        type: "started",
        currentTime: Number(audio.currentTime) || 0,
        duration: Number(audio.duration) || 0
      });
      startTick();
    } catch (error) {
      send({
        type: "error",
        message:
          `offscreen audio.play() failed: ${error?.name || "Error"}: ` +
          `${error?.message || String(error)}; readyState=${audio.readyState}; ` +
          `networkState=${audio.networkState}`
      });
    }
  }

  audio.addEventListener("ended", () => {
    if (!playbackId) return;

    clearTick();
    const finishedId = playbackId;
    const finalEvent = {
      type: "ended",
      currentTime: Number(audio.currentTime) || 0,
      duration: Number(audio.duration) || 0
    };

    if (sentencePauseMs > 0) {
      send({ type: "sentencePause", durationMs: sentencePauseMs });
      endPauseTimer = setTimeout(() => {
        endPauseTimer = null;
        if (playbackId !== finishedId) return;
        send(finalEvent);
        stopCurrent();
      }, sentencePauseMs);
      return;
    }

    send(finalEvent);
    stopCurrent();
  });

  audio.addEventListener("error", () => {
    if (!playbackId) return;
    const mediaError = audio.error;
    send({
      type: "error",
      message:
        `offscreen WAV playback failed` +
        `${mediaError?.code ? ` (media ${mediaError.code})` : ""}` +
        `${mediaError?.message ? `: ${mediaError.message}` : ""}; ` +
        `readyState=${audio.readyState}; networkState=${audio.networkState}`
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = String(message?.type || "");

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_STOP_TAB") {
      const targetTabId = Number(message?.tabId);
      const matchesOwner =
        playbackId &&
        Number.isInteger(targetTabId) &&
        ownerTabId === targetTabId;

      if (matchesOwner) {
        stopCurrent({ emit: true });
      }
      sendResponse({
        accepted: true,
        stopped: Boolean(matchesOwner)
      });
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_PLAY") {
      void play(message)
        .then(() => sendResponse({ accepted: true }))
        .catch((error) => {
          send({
            type: "error",
            message: error?.message || String(error)
          });
          sendResponse({
            accepted: false,
            error: error?.message || String(error)
          });
        });
      return true;
    }

    if (
      !playbackId ||
      String(message?.playbackId || "") !== playbackId
    ) {
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_PAUSE") {
      try {
        audio.pause();
        clearTick();
        send({
          type: "paused",
          currentTime: Number(audio.currentTime) || 0
        });
        sendResponse({ accepted: true });
      } catch (error) {
        sendResponse({ accepted: false, error: error?.message || String(error) });
      }
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_RESUME") {
      void audio.play()
        .then(() => {
          send({
            type: "resumed",
            currentTime: Number(audio.currentTime) || 0
          });
          startTick();
          sendResponse({ accepted: true });
        })
        .catch((error) => {
          send({
            type: "error",
            message:
              `offscreen resume failed: ${error?.name || "Error"}: ` +
              `${error?.message || String(error)}`
          });
          sendResponse({ accepted: false, error: error?.message || String(error) });
        });
      return true;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_STOP") {
      stopCurrent({ emit: true });
      sendResponse({ accepted: true });
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_RATE") {
      audio.playbackRate = Math.min(
        16,
        Math.max(0.25, Number(message.playbackRate) || 1)
      );
      sendResponse({ accepted: true });
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_VOLUME") {
      audio.volume = Math.min(
        1,
        Math.max(0, Number(message.volume) || 0)
      );
      sendResponse({ accepted: true });
      return false;
    }

    return false;
  });
})();
