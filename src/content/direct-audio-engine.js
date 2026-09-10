(function attachDirectAudioEngine(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.SpeechEngine && api.DirectAudioSpeechEngine) {
    root.EdgeTtsExtension.SpeechEngine.SpeechEngine = api.DirectAudioSpeechEngine;
    root.EdgeTtsExtension.DirectAudio = api;
  }
})(globalThis, function createDirectAudioEngineApi(root) {
  const speechModule = root.EdgeTtsExtension?.SpeechEngine;
  const BaseSpeechEngine = speechModule?.SpeechEngine;

  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const CHROMIUM_FULL_VERSION = "143.0.3650.75";
  const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
  const WSS_URL =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
  const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
  const TICKS_PER_SECOND = 10_000_000;
  const MP3_BITRATE_BPS = 48_000;
  const SERVICE_TEXT_BYTES = 3500;
  const CONNECTION_TIMEOUT_MS = 12_000;
  const MIN_PLAYBACK_RATE = 0.25;
  const MAX_PLAYBACK_RATE = 16;
  const MAX_OUTPUT_GAIN = 2;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function isDirectVoice(voice) {
    return Boolean(voice && /\b(natural|online)\b/i.test(String(voice.name || "")));
  }

  function randomHex(byteCount = 16) {
    const bytes = new Uint8Array(byteCount);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function generateSecMsGec(nowSeconds = Date.now() / 1000) {
    const windowsEpochSeconds = 11_644_473_600;
    let ticks = Number(nowSeconds) + windowsEpochSeconds;
    ticks -= ticks % 300;
    ticks *= 10_000_000;
    const input = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
    const hash = await root.crypto.subtle.digest("SHA-256", encoder.encode(input));
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0")
    )
      .join("")
      .toUpperCase();
  }

  function dateToString(date = new Date()) {
    return date
      .toUTCString()
      .replace("GMT", "GMT+0000 (Coordinated Universal Time)");
  }

  function escapeXml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function edgeShortNameForVoice(voice) {
    if (!voice) return "";
    const explicit = String(voice.edgeShortName || voice.shortName || "").trim();
    if (explicit) return explicit;

    const locale = String(voice.lang || "").replace("_", "-").trim();
    if (!locale) return "";

    let stem = String(voice.name || "")
      .replace(/^Microsoft\s+/i, "")
      .replace(/\s+Online\s*\(Natural\).*$/i, "")
      .replace(/\s+-\s+.*$/i, "")
      .trim();

    if (!stem) return "";
    stem = stem.replace(/[^A-Za-z0-9]/g, "");
    if (!stem) return "";
    if (!/Neural$/i.test(stem)) stem += "Neural";
    return `${locale}-${stem}`;
  }

  function separatorForSegments(left, right) {
    return left?.blockIndex !== right?.blockIndex ? "\n\n" : " ";
  }

  function textForSegments(segments) {
    let text = "";
    segments.forEach((segment, index) => {
      if (index > 0) text += separatorForSegments(segments[index - 1], segment);
      text += String(segment?.text || "");
    });
    return text;
  }

  function splitSegmentsForService(segments, byteLimit = SERVICE_TEXT_BYTES) {
    const groups = [];
    let current = [];
    let currentText = "";

    function flush() {
      if (!current.length) return;
      groups.push({ segments: current, text: currentText });
      current = [];
      currentText = "";
    }

    for (const segment of segments || []) {
      const separator = current.length
        ? separatorForSegments(current[current.length - 1], segment)
        : "";
      const addition = `${separator}${String(segment?.text || "")}`;
      const projected = `${currentText}${addition}`;

      if (current.length && encoder.encode(projected).length > byteLimit) {
        flush();
      }

      const nextSeparator = current.length
        ? separatorForSegments(current[current.length - 1], segment)
        : "";
      currentText += `${nextSeparator}${String(segment?.text || "")}`;
      current.push(segment);
    }

    flush();
    return groups;
  }

  function parseHeaders(text) {
    const splitAt = text.indexOf("\r\n\r\n");
    const headerText = splitAt >= 0 ? text.slice(0, splitAt) : text;
    const body = splitAt >= 0 ? text.slice(splitAt + 4) : "";
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { headers, body };
  }

  function parseBinaryFrame(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 2) throw new Error("Direct TTS binary frame is missing its header length.");
    const headerLength = (bytes[0] << 8) | bytes[1];
    const dataStart = headerLength + 2;
    if (dataStart > bytes.length) throw new Error("Direct TTS binary frame has an invalid header length.");
    const headerText = decoder.decode(bytes.slice(2, dataStart));
    return {
      headers: parseHeaders(`${headerText}\r\n\r\n`).headers,
      data: bytes.slice(dataStart)
    };
  }

  function parseMetadata(body) {
    const parsed = JSON.parse(body);
    const results = [];
    for (const item of parsed?.Metadata || []) {
      if (item?.Type !== "WordBoundary") continue;
      const data = item.Data || {};
      results.push({
        offsetTicks: Number(data.Offset) || 0,
        durationTicks: Number(data.Duration) || 0,
        text: String(data.text?.Text || "")
      });
    }
    return results;
  }

  function normalizeBoundaryText(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
      .trim();
  }

  function mapBoundariesToSegments(boundaries, segments, offsetSeconds = 0) {
    const mapped = [];
    let cursor = 0;

    for (const boundary of boundaries || []) {
      if (cursor >= segments.length) break;
      const wanted = normalizeBoundaryText(boundary.text);
      let index = cursor;

      if (wanted) {
        const searchEnd = Math.min(segments.length, cursor + 8);
        for (let candidate = cursor; candidate < searchEnd; candidate += 1) {
          if (normalizeBoundaryText(segments[candidate]?.text) === wanted) {
            index = candidate;
            break;
          }
        }
      }

      mapped.push({
        segment: segments[index],
        offsetSeconds: offsetSeconds + boundary.offsetTicks / TICKS_PER_SECOND,
        durationSeconds: boundary.durationTicks / TICKS_PER_SECOND,
        text: boundary.text
      });
      cursor = index + 1;
    }

    return mapped;
  }

  function buildSpeechConfig(timestamp) {
    return (
      `X-Timestamp:${timestamp}\r\n` +
      "Content-Type:application/json; charset=utf-8\r\n" +
      "Path:speech.config\r\n\r\n" +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
      `"outputFormat":"${OUTPUT_FORMAT}"` +
      "}}}}\r\n"
    );
  }

  function buildSsmlRequest(requestId, timestamp, voiceShortName, text) {
    const ssml =
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
      `<voice name='${escapeXml(voiceShortName)}'>` +
      "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
      escapeXml(text) +
      "</prosody></voice></speak>";

    return (
      `X-RequestId:${requestId}\r\n` +
      "Content-Type:application/ssml+xml\r\n" +
      `X-Timestamp:${timestamp}Z\r\n` +
      "Path:ssml\r\n\r\n" +
      ssml
    );
  }

  async function directWebSocketUrl() {
    const token = await generateSecMsGec();
    return (
      `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${token}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${randomHex()}`
    );
  }

  if (!BaseSpeechEngine) {
    return {
      DirectAudioSpeechEngine: null,
      MAX_OUTPUT_GAIN,
      MAX_PLAYBACK_RATE,
      MIN_PLAYBACK_RATE,
      OUTPUT_FORMAT,
      SEC_MS_GEC_VERSION,
      SERVICE_TEXT_BYTES,
      TRUSTED_CLIENT_TOKEN,
      buildSpeechConfig,
      buildSsmlRequest,
      edgeShortNameForVoice,
      generateSecMsGec,
      isDirectVoice,
      mapBoundariesToSegments,
      parseBinaryFrame,
      parseHeaders,
      parseMetadata,
      splitSegmentsForService,
      textForSegments
    };
  }

  class DirectAudioSpeechEngine extends BaseSpeechEngine {
    constructor(options) {
      super(options);
      this.directSessionMode = false;
      this.directActive = false;
      this.directSocket = null;
      this.directAudio = null;
      this.directAudioContext = null;
      this.directMediaSource = null;
      this.directGain = null;
      this.directObjectUrl = "";
      this.directBoundaries = [];
      this.directBoundaryIndex = 0;
      this.directBoundaryFrame = null;
      this.directPlaybackRate = 1;
      this.directOutputGain = 1;
    }

    canPlayIndependently(voice) {
      return isDirectVoice(voice);
    }

    _clearBoundaryClock() {
      if (this.directBoundaryFrame !== null) {
        root.cancelAnimationFrame?.(this.directBoundaryFrame);
        this.directBoundaryFrame = null;
      }
    }

    _closeSocket() {
      const socket = this.directSocket;
      this.directSocket = null;
      if (socket && socket.readyState < 2) {
        try {
          socket.close();
        } catch (_error) {}
      }
    }

    _revokeObjectUrl() {
      if (!this.directObjectUrl) return;
      try {
        root.URL.revokeObjectURL(this.directObjectUrl);
      } catch (_error) {}
      this.directObjectUrl = "";
    }

    _resetDirectState({ keepMode = true } = {}) {
      this._clearBoundaryClock();
      this._closeSocket();
      if (this.directAudio) {
        try {
          this.directAudio.pause();
          this.directAudio.removeAttribute("src");
          this.directAudio.load?.();
        } catch (_error) {}
      }
      this._revokeObjectUrl();
      this.directBoundaries = [];
      this.directBoundaryIndex = 0;
      this.directActive = false;
      if (!keepMode) this.directSessionMode = false;
      this.clearPlaybackTimers?.();
      this.currentUtterance = null;
      this.currentChunks = [];
      this.currentChunkIndex = -1;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = null;
      this.recoveryKey = "";
      this.recoveryAttempts = 0;
    }

    cancel() {
      if (this.directSessionMode) {
        this.generation += 1;
        this._resetDirectState({ keepMode: true });
        return;
      }
      return super.cancel();
    }

    abandon() {
      if (this.directSessionMode) {
        this.generation += 1;
        this._resetDirectState({ keepMode: true });
        return;
      }
      return super.abandon?.();
    }

    pause() {
      if (this.directSessionMode) {
        this.directAudio?.pause?.();
        return;
      }
      return super.pause?.();
    }

    resume() {
      if (this.directSessionMode) {
        void this.directAudio?.play?.();
        return;
      }
      return super.resume?.();
    }

    isPaused() {
      if (this.directSessionMode) return Boolean(this.directAudio?.paused);
      return super.isPaused?.() || false;
    }

    isSpeaking() {
      if (this.directSessionMode) {
        return Boolean(this.directActive && this.directAudio && !this.directAudio.paused);
      }
      return super.isSpeaking?.() || false;
    }

    setPlaybackRate(rate) {
      if (!this.directSessionMode) return false;
      this.directPlaybackRate = clamp(Number(rate) || 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
      if (this.directAudio) this.directAudio.playbackRate = this.directPlaybackRate;
      return true;
    }

    setOutputVolume(volume) {
      if (!this.directSessionMode) return false;
      this.directOutputGain = clamp(Number(volume), 0, MAX_OUTPUT_GAIN);
      if (!Number.isFinite(this.directOutputGain)) this.directOutputGain = 1;
      this._applyDirectGain();
      return true;
    }

    _ensureAudioElement() {
      if (this.directAudio) return this.directAudio;
      const audio = root.document?.createElement?.("audio") || new root.Audio();
      audio.preload = "auto";
      audio.preservesPitch = true;
      if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
      this.directAudio = audio;

      const AudioContextCtor = root.AudioContext || root.webkitAudioContext;
      if (AudioContextCtor) {
        try {
          this.directAudioContext = new AudioContextCtor();
          this.directMediaSource = this.directAudioContext.createMediaElementSource(audio);
          this.directGain = this.directAudioContext.createGain();
          this.directMediaSource.connect(this.directGain);
          this.directGain.connect(this.directAudioContext.destination);
        } catch (error) {
          console.warn("Edge Natural TTS could not create a Web Audio gain stage.", error);
          this.directAudioContext = null;
          this.directMediaSource = null;
          this.directGain = null;
        }
      }
      this._applyDirectGain();
      return audio;
    }

    _applyDirectGain() {
      const gain = clamp(Number(this.directOutputGain), 0, MAX_OUTPUT_GAIN);
      if (this.directGain) {
        this.directGain.gain.value = gain;
        if (this.directAudio) this.directAudio.volume = 1;
      } else if (this.directAudio) {
        this.directAudio.volume = clamp(gain, 0, 1);
      }
    }

    speak(block, startSegmentIndex, options = {}) {
      if (!isDirectVoice(options.voice)) {
        if (this.directSessionMode) {
          this.generation += 1;
          this._resetDirectState({ keepMode: false });
        }
        return super.speak(block, startSegmentIndex, options);
      }

      const segments = Array.isArray(block?.segments)
        ? block.segments.slice(Math.max(0, Number(startSegmentIndex) || 0))
        : [];
      if (!segments.length) {
        this.onEnd?.();
        return;
      }

      if (this.directSessionMode) {
        this.cancel();
      } else {
        super.cancel();
      }

      this.directSessionMode = true;
      this.directActive = true;
      this.generation += 1;
      const generation = this.generation;
      this.currentChunks = [{ segments }];
      this.currentChunkIndex = 0;
      this.currentChunkBoundaryIndex = -1;
      this.currentOptions = options;
      this.requestedAt = root.performance?.now?.() ?? Date.now();
      this.directPlaybackRate = clamp(Number(options.rate) || 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
      const configuredVolume = Number(root.EdgeTtsExtension?.AudioControls?.currentVolume);
      this.directOutputGain = Number.isFinite(configuredVolume)
        ? clamp(configuredVolume, 0, MAX_OUTPUT_GAIN)
        : 1;

      void this._runDirect(generation, segments, options).catch((error) => {
        if (generation !== this.generation) return;
        this._resetDirectState({ keepMode: true });
        console.error("Edge Natural TTS direct MP3 backend failed.", error);
        this.onError?.(
          new Error(`Direct Natural TTS failed: ${error?.message || String(error)}`)
        );
      });
    }

    async _runDirect(generation, segments, options) {
      const voiceShortName = edgeShortNameForVoice(options.voice);
      if (!voiceShortName) throw new Error("Could not map the selected Natural voice to a Read Aloud voice name.");

      const groups = splitSegmentsForService(segments);
      if (!groups.length) throw new Error("No text was available for direct synthesis.");

      const audioChunks = [];
      const mappedBoundaries = [];
      let cumulativeAudioBytes = 0;

      for (const group of groups) {
        if (generation !== this.generation) return;
        const result = await this._synthesizeGroup(generation, group, voiceShortName);
        if (generation !== this.generation) return;

        const offsetSeconds = (cumulativeAudioBytes * 8) / MP3_BITRATE_BPS;
        mappedBoundaries.push(
          ...mapBoundariesToSegments(result.boundaries, group.segments, offsetSeconds)
        );
        audioChunks.push(...result.audioChunks);
        cumulativeAudioBytes += result.audioBytes;
      }

      if (generation !== this.generation) return;
      if (!audioChunks.length) throw new Error("The Read Aloud service returned no MP3 audio.");

      this.directBoundaries = mappedBoundaries;
      this.directBoundaryIndex = 0;
      const blob = new Blob(audioChunks, { type: "audio/mpeg" });
      this._revokeObjectUrl();
      this.directObjectUrl = root.URL.createObjectURL(blob);

      const audio = this._ensureAudioElement();
      audio.src = this.directObjectUrl;
      audio.playbackRate = this.directPlaybackRate;
      audio.preservesPitch = true;
      this._applyDirectGain();

      audio.onended = () => {
        if (generation !== this.generation) return;
        this._clearBoundaryClock();
        this.directActive = false;
        this.currentChunks = [];
        this.currentChunkIndex = -1;
        this.currentChunkBoundaryIndex = -1;
        this.currentOptions = null;
        this._revokeObjectUrl();
        this.onEnd?.();
      };
      audio.onerror = () => {
        if (generation !== this.generation) return;
        const mediaError = audio.error;
        this.generation += 1;
        this._resetDirectState({ keepMode: true });
        this.onError?.(
          new Error(`Direct Natural TTS playback failed${mediaError?.code ? ` (media ${mediaError.code})` : ""}.`)
        );
      };

      if (this.directAudioContext?.state === "suspended") {
        try {
          await this.directAudioContext.resume();
        } catch (_error) {}
      }

      await audio.play();
      if (generation !== this.generation) return;
      const startedAt = root.performance?.now?.() ?? Date.now();
      this.onStart?.(
        segments[0],
        Math.max(0, startedAt - this.requestedAt)
      );
      this._startBoundaryClock(generation);
    }

    _startBoundaryClock(generation) {
      this._clearBoundaryClock();
      const tick = () => {
        if (
          generation !== this.generation ||
          !this.directAudio ||
          !this.directActive
        ) {
          this.directBoundaryFrame = null;
          return;
        }

        const mediaTime = Number(this.directAudio.currentTime) || 0;
        while (
          this.directBoundaryIndex < this.directBoundaries.length &&
          this.directBoundaries[this.directBoundaryIndex].offsetSeconds <= mediaTime + 0.025
        ) {
          const boundary = this.directBoundaries[this.directBoundaryIndex];
          this.directBoundaryIndex += 1;
          if (boundary.segment) {
            this.currentChunkBoundaryIndex = this.directBoundaryIndex - 1;
            this.onBoundary?.(boundary.segment, {
              type: "direct-audio-boundary",
              directAudio: true,
              audioOffset: boundary.offsetSeconds,
              duration: boundary.durationSeconds,
              spokenText: boundary.text
            });
          }
        }

        this.directBoundaryFrame = root.requestAnimationFrame?.(tick) ?? null;
      };
      this.directBoundaryFrame = root.requestAnimationFrame?.(tick) ?? null;
    }

    async _synthesizeGroup(generation, group, voiceShortName) {
      const url = await directWebSocketUrl();
      if (generation !== this.generation) return { audioChunks: [], boundaries: [], audioBytes: 0 };

      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        this.directSocket = socket;
        const audioChunks = [];
        const boundaries = [];
        let audioBytes = 0;
        let settled = false;

        const timeout = root.setTimeout(() => {
          finish(new Error("Read Aloud websocket timed out."));
        }, CONNECTION_TIMEOUT_MS);

        const finish = (error) => {
          if (settled) return;
          settled = true;
          root.clearTimeout(timeout);
          if (this.directSocket === socket) this.directSocket = null;
          try {
            if (socket.readyState < 2) socket.close();
          } catch (_error) {}
          if (error) reject(error);
          else resolve({ audioChunks, boundaries, audioBytes });
        };

        socket.onopen = () => {
          if (generation !== this.generation) {
            finish(new Error("Direct synthesis was canceled."));
            return;
          }
          const timestamp = dateToString();
          socket.send(buildSpeechConfig(timestamp));
          socket.send(
            buildSsmlRequest(randomHex(), timestamp, voiceShortName, group.text)
          );
        };

        socket.onmessage = (event) => {
          if (generation !== this.generation) {
            finish(new Error("Direct synthesis was canceled."));
            return;
          }

          try {
            if (typeof event.data === "string") {
              const parsed = parseHeaders(event.data);
              const path = parsed.headers.path;
              if (path === "audio.metadata") {
                boundaries.push(...parseMetadata(parsed.body));
              } else if (path === "turn.end") {
                finish();
              }
              return;
            }

            if (event.data instanceof ArrayBuffer) {
              const parsed = parseBinaryFrame(event.data);
              if (parsed.headers.path !== "audio") return;
              if (!parsed.data.length) return;
              const copy = parsed.data.slice();
              audioChunks.push(copy);
              audioBytes += copy.length;
            }
          } catch (error) {
            finish(error);
          }
        };

        socket.onerror = () => finish(new Error("Read Aloud websocket connection failed."));
        socket.onclose = () => {
          if (!settled) {
            finish(
              audioBytes > 0
                ? undefined
                : new Error("Read Aloud websocket closed before returning audio.")
            );
          }
        };
      });
    }
  }

  return {
    DirectAudioSpeechEngine,
    MAX_OUTPUT_GAIN,
    MAX_PLAYBACK_RATE,
    MIN_PLAYBACK_RATE,
    OUTPUT_FORMAT,
    SEC_MS_GEC_VERSION,
    SERVICE_TEXT_BYTES,
    TRUSTED_CLIENT_TOKEN,
    buildSpeechConfig,
    buildSsmlRequest,
    edgeShortNameForVoice,
    generateSecMsGec,
    isDirectVoice,
    mapBoundariesToSegments,
    parseBinaryFrame,
    parseHeaders,
    parseMetadata,
    splitSegmentsForService,
    textForSegments
  };
});