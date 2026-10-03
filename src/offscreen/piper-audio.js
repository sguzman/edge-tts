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
  let pausedCurrentTime = null;

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
    pausedCurrentTime = null;

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

  function boundaryIndexAfterTime(currentTime) {
    const target = Math.max(0, Number(currentTime) || 0);
    const next = boundaryOffsets.findIndex(
      (offset) => offset > target + 0.02
    );
    return next < 0 ? boundaryOffsets.length : next;
  }

  async function waitForMetadata() {
    if (audio.readyState >= 1 && Number.isFinite(Number(audio.duration))) {
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", onReady);
        audio.removeEventListener("error", onError);
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onReady = () => finish(resolve);
      const onError = () => finish(() =>
        reject(new Error("Piper WAV metadata failed to load before checkpoint seek."))
      );

      audio.addEventListener("loadedmetadata", onReady, { once: true });
      audio.addEventListener("error", onError, { once: true });
      timer = setTimeout(() => finish(() =>
        reject(new Error("Piper WAV metadata timed out before checkpoint seek."))
      ), 1500);
      try {
        audio.load();
      } catch (_error) {}
    });
  }

  async function restorePlaybackCheckpoint(currentTime) {
    const requested = Math.max(0, Number(currentTime) || 0);
    if (!(requested > 0)) {
      boundaryIndex = 0;
      return 0;
    }

    await waitForMetadata();
    const duration = Number(audio.duration);
    const maximum =
      Number.isFinite(duration) && duration > 0
        ? Math.max(0, duration - 0.02)
        : requested;
    const target = Math.min(requested, maximum);

    audio.currentTime = target;
    boundaryIndex = boundaryIndexAfterTime(target);
    return target;
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
    pausedCurrentTime = null;

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
      const restoredTime = await restorePlaybackCheckpoint(
        message.startTimeSeconds
      );
      await audio.play();
      send({
        type: "started",
        currentTime: Number(audio.currentTime) || restoredTime || 0,
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
        pausedCurrentTime = Math.max(
          0,
          Number(audio.currentTime) || 0
        );
        send({
          type: "paused",
          currentTime: pausedCurrentTime
        });
        sendResponse({
          accepted: true,
          currentTime: pausedCurrentTime
        });
      } catch (error) {
        sendResponse({ accepted: false, error: error?.message || String(error) });
      }
      return false;
    }

    if (type === "EDGE_TTS_OFFSCREEN_PIPER_RESUME") {
      void Promise.resolve()
        .then(async () => {
          if (Number.isFinite(Number(pausedCurrentTime))) {
            const checkpoint = Math.max(
              0,
              Number(pausedCurrentTime) || 0
            );
            if (
              Math.abs((Number(audio.currentTime) || 0) - checkpoint) > 0.05
            ) {
              await restorePlaybackCheckpoint(checkpoint);
            } else {
              boundaryIndex = boundaryIndexAfterTime(checkpoint);
            }
          }

          await audio.play();
          pausedCurrentTime = null;
          const currentTime = Math.max(
            0,
            Number(audio.currentTime) || 0
          );
          send({
            type: "resumed",
            currentTime
          });
          startTick();
          sendResponse({
            accepted: true,
            currentTime
          });
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
