(function attachAzureSpeechEngine(root, factory) {
  const api = factory(root, root.EdgeTtsExtension?.SpeechEngine);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension) {
    root.EdgeTtsExtension.AzureSpeechEngine = api;
  }
})(globalThis, function createAzureSpeechEngineApi(root, speechEngineApi) {
  const TICKS_PER_SECOND = 10_000_000;

  function sdkAvailable() {
    const sdk = root.SpeechSDK;
    return Boolean(
      sdk?.SpeechConfig &&
        sdk?.SpeechSynthesizer &&
        sdk?.SpeakerAudioDestination &&
        sdk?.AudioConfig
    );
  }

  function normalizeAzureVoice(info) {
    const shortName = String(info?.shortName || info?.name || "").trim();
    const lang = String(info?.locale || "").trim();
    const displayName = String(
      info?.localName || info?.displayName || info?.name || shortName
    ).trim();

    return {
      id: `azure:${shortName}`,
      name: displayName || shortName,
      lang,
      source: "azure",
      provider: "Azure",
      shortName,
      gender: info?.gender == null ? "" : String(info.gender),
      voiceType: info?.voiceType == null ? "" : String(info.voiceType),
      styles: Array.isArray(info?.styleList) ? [...info.styleList] : []
    };
  }

  function escapeXml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function rateToSsml(rate) {
    const numeric = Number(rate);
    const safeRate = Number.isFinite(numeric) ? Math.min(Math.max(numeric, 0.5), 2.5) : 1;
    const percent = Math.round((safeRate - 1) * 100);
    return `${percent >= 0 ? "+" : ""}${percent}%`;
  }

  function createSsml(text, voice, rate) {
    const lang = escapeXml(voice?.lang || "en-US");
    const shortName = escapeXml(voice?.shortName || "");
    return [
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">`,
      `<voice name="${shortName}">`,
      `<prosody rate="${rateToSsml(rate)}">${escapeXml(text)}</prosody>`,
      "</voice>",
      "</speak>"
    ].join("");
  }

  function normalizeBoundaryText(value) {
    return String(value || "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function findSegmentForBoundary(payload, boundaryText, startIndex = 0) {
    const segments = payload?.segments || [];
    if (segments.length === 0) return { segment: null, index: -1 };

    const target = normalizeBoundaryText(boundaryText);
    const first = Math.min(Math.max(Number(startIndex) || 0, 0), segments.length - 1);
    const limit = Math.min(segments.length, first + 16);

    if (target) {
      for (let index = first; index < limit; index += 1) {
        const candidate = normalizeBoundaryText(segments[index].text);
        if (
          candidate &&
          (candidate === target || candidate.includes(target) || target.includes(candidate))
        ) {
          return { segment: segments[index], index };
        }
      }
    }

    return { segment: segments[first] || null, index: first };
  }

  class AzureSpeechEngine {
    constructor({ onBoundary, onEnd, onError, onStart }) {
      this.onBoundary = onBoundary;
      this.onEnd = onEnd;
      this.onError = onError;
      this.onStart = onStart;
      this.key = "";
      this.region = "";
      this.generation = 0;
      this.currentSynthesizer = null;
      this.currentPlayer = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.boundaryQueue = [];
      this.boundarySegmentCursor = 0;
      this.boundaryClock = null;
      this.paused = false;
    }

    isAvailable() {
      return sdkAvailable();
    }

    configure({ key, region }) {
      this.key = String(key || "").trim();
      this.region = String(region || "").trim();
    }

    hasCredentials() {
      return Boolean(this.key && this.region);
    }

    async getVoices() {
      if (!this.isAvailable()) {
        throw new Error("Azure Speech SDK is not bundled in this extension build.");
      }
      if (!this.hasCredentials()) {
        return [];
      }

      const sdk = root.SpeechSDK;
      const speechConfig = sdk.SpeechConfig.fromSubscription(this.key, this.region);
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

      try {
        const result = await synthesizer.getVoicesAsync();
        const voices = Array.isArray(result?.voices) ? result.voices : [];
        return voices
          .map(normalizeAzureVoice)
          .filter((voice) => voice.shortName && voice.lang);
      } finally {
        synthesizer.close();
      }
    }

    cancel() {
      this.generation += 1;
      this.paused = false;
      this.stopBoundaryClock();
      this.boundaryQueue = [];
      this.currentChunks = [];
      this.currentChunkIndex = -1;

      try {
        this.currentPlayer?.pause?.();
        this.currentPlayer?.close?.();
      } catch (_error) {
        // Best-effort cleanup; a closed SDK player can throw on repeated close.
      }
      try {
        this.currentSynthesizer?.close?.();
      } catch (_error) {
        // Best-effort cleanup.
      }

      this.currentPlayer = null;
      this.currentSynthesizer = null;
    }

    pause() {
      this.currentPlayer?.pause?.();
      this.paused = true;
    }

    resume() {
      this.paused = false;
      this.currentPlayer?.resume?.(
        () => {},
        (error) => this.onError?.(new Error(`Azure audio resume failed: ${error}`))
      );
    }

    isPaused() {
      return this.paused;
    }

    speak(block, startSegmentIndex, options) {
      if (!this.isAvailable()) {
        this.onError?.(new Error("Azure Speech SDK is not available in this build."));
        return;
      }
      if (!this.hasCredentials()) {
        this.onError?.(new Error("Azure Speech key and region are required."));
        return;
      }
      if (!options?.voice?.shortName) {
        this.onError?.(new Error("Select an Azure voice before speaking."));
        return;
      }

      const createUtteranceChunks = speechEngineApi?.createUtteranceChunks;
      if (typeof createUtteranceChunks !== "function") {
        this.onError?.(new Error("Shared TTS chunker is unavailable."));
        return;
      }

      const chunks = createUtteranceChunks(block, startSegmentIndex, {
        firstChunkMaxChars: 1200,
        maxChars: 2400,
        hardLimitFactor: 1.35
      });
      if (chunks.length === 0) {
        this.onEnd?.();
        return;
      }

      this.cancel();
      const generation = this.generation;
      const requestedAt = root.performance?.now?.() ?? Date.now();
      this.currentChunks = chunks;
      this.currentChunkIndex = 0;
      this.paused = false;
      this.startChunk(generation, requestedAt, options);
    }

    startChunk(generation, requestedAt, options) {
      if (generation !== this.generation) return;

      const sdk = root.SpeechSDK;
      const payload = this.currentChunks[this.currentChunkIndex];
      if (!payload) {
        this.onEnd?.();
        return;
      }

      const speechConfig = sdk.SpeechConfig.fromSubscription(this.key, this.region);
      speechConfig.speechSynthesisVoiceName = options.voice.shortName;

      const player = new sdk.SpeakerAudioDestination();
      const audioConfig = sdk.AudioConfig.fromSpeakerOutput(player);
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

      this.currentPlayer = player;
      this.currentSynthesizer = synthesizer;
      this.boundaryQueue = [];
      this.boundarySegmentCursor = 0;

      player.onAudioStart = () => {
        if (generation !== this.generation) return;
        this.startBoundaryClock(generation);
        if (this.currentChunkIndex === 0) {
          const startedAt = root.performance?.now?.() ?? Date.now();
          this.onStart?.(payload.segments[0], Math.max(0, startedAt - requestedAt));
        }
      };

      player.onAudioEnd = () => {
        if (generation !== this.generation) return;
        this.flushBoundaryQueue(true);
        this.stopBoundaryClock();
        try {
          player.close?.();
        } catch (_error) {
          // Ignore close races from the SDK.
        }
        try {
          synthesizer.close?.();
        } catch (_error) {
          // Ignore close races from the SDK.
        }
        if (this.currentPlayer === player) this.currentPlayer = null;
        if (this.currentSynthesizer === synthesizer) this.currentSynthesizer = null;

        this.currentChunkIndex += 1;
        if (this.currentChunkIndex >= this.currentChunks.length) {
          this.currentChunks = [];
          this.onEnd?.();
          return;
        }
        this.startChunk(generation, requestedAt, options);
      };

      synthesizer.wordBoundary = (_sender, event) => {
        if (generation !== this.generation) return;
        if (
          sdk.SpeechSynthesisBoundaryType &&
          event.boundaryType != null &&
          event.boundaryType !== sdk.SpeechSynthesisBoundaryType.Word
        ) {
          return;
        }
        if (!normalizeBoundaryText(event.text)) return;

        const found = findSegmentForBoundary(
          payload,
          event.text,
          this.boundarySegmentCursor
        );
        if (!found.segment) return;

        this.boundarySegmentCursor = Math.min(found.index + 1, payload.segments.length - 1);
        this.boundaryQueue.push({
          audioSeconds: Number(event.audioOffset || 0) / TICKS_PER_SECOND,
          segment: found.segment,
          event
        });
      };

      const ssml = createSsml(payload.text, options.voice, options.rate);
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (generation !== this.generation) return;
          if (result?.reason === sdk.ResultReason?.Canceled) {
            const message = result.errorDetails || "Azure speech synthesis was canceled.";
            this.fail(generation, new Error(message));
          }
        },
        (error) => {
          if (generation !== this.generation) return;
          this.fail(generation, new Error(`Azure speech synthesis failed: ${error}`));
        }
      );
    }

    fail(generation, error) {
      if (generation !== this.generation) return;
      this.cancel();
      this.onError?.(error);
    }

    startBoundaryClock(generation) {
      this.stopBoundaryClock();
      this.boundaryClock = root.setInterval(() => {
        if (generation !== this.generation) {
          this.stopBoundaryClock();
          return;
        }
        this.flushBoundaryQueue(false);
      }, 25);
    }

    stopBoundaryClock() {
      if (this.boundaryClock !== null) {
        root.clearInterval(this.boundaryClock);
        this.boundaryClock = null;
      }
    }

    flushBoundaryQueue(force) {
      if (this.boundaryQueue.length === 0) return;
      const currentTime = Number(this.currentPlayer?.currentTime || 0);
      const threshold = force ? Number.POSITIVE_INFINITY : currentTime + 0.035;

      while (this.boundaryQueue.length > 0 && this.boundaryQueue[0].audioSeconds <= threshold) {
        const boundary = this.boundaryQueue.shift();
        this.onBoundary?.(boundary.segment, boundary.event);
      }
    }
  }

  return {
    AzureSpeechEngine,
    createSsml,
    escapeXml,
    findSegmentForBoundary,
    normalizeAzureVoice,
    normalizeBoundaryText,
    rateToSsml,
    sdkAvailable
  };
});
