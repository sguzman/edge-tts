(() => {
  const connection = document.querySelector("#connection");
  const voices = document.querySelector("#voices");
  const probeSelect = document.querySelector("#probe");
  const speakButton = document.querySelector("#speak");
  const stopButton = document.querySelector("#stop");
  const timingStatus = document.querySelector("#timing");
  const waveStatus = document.querySelector("#wave");
  const latencyStatus = document.querySelector("#latency");
  const status = document.querySelector("#status");
  const audio = document.createElement("audio");
  const unlockWav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA";
  const maxWavBytes = 8 * 1024 * 1024;
  let ariaVoice = null;
  let objectUrl = "";
  let generation = 0;
  let lastWaveResponse = null;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const probeTexts = {
    short: "Windows Natural latency probe is working locally.",
    normal: ("Windows Natural latency probe sentence. This deterministic normal first-chunk " +
      "workload measures the complete synthesis path before browser playback begins. ").repeat(20).slice(0, 900)
  };

  audio.onloadedmetadata = () => {
    if (lastWaveResponse) renderWaveDiagnostics(lastWaveResponse);
  };

  function setStatus(message) {
    status.textContent = message;
  }

  function revokeAudio() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    audio.removeAttribute("src");
    audio.load();
  }

  function stopPlayback(message = "Stopped.") {
    generation += 1;
    audio.pause();
    revokeAudio();
    setStatus(message);
  }

  function prepareAudio() {
    audio.muted = true;
    audio.src = unlockWav;
    audio.load();
    const promise = audio.play();
    promise?.catch?.(() => {});
    audio.pause();
    audio.muted = false;
    audio.removeAttribute("src");
    audio.load();
  }

  function bytesFromBase64(value) {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("Background returned invalid WAV data.");
    }
    const binary = atob(value);
    if (binary.length === 0 || binary.length > maxWavBytes) {
      throw new Error("Background returned an invalid WAV size.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function renderVoices(result) {
    voices.replaceChildren();
    for (const voice of result.voices || []) {
      const item = document.createElement("li");
      item.innerHTML = `<strong>${voice.name}</strong> — ${voice.lang || "unknown"} ` +
        `<code>${voice.id}</code>`;
      voices.append(item);
    }
    ariaVoice = result.ariaVoice || null;
    speakButton.disabled = !ariaVoice;
    connection.textContent = result.connected
      ? `Connected via background — protocol ${result.handshake.protocol}, ${result.handshake.architecture}`
      : "Not connected";
    setStatus(ariaVoice ? `Aria ready: ${ariaVoice.id}` : "Microsoft Aria was not enumerated.");
  }

  function renderTiming(boundaries) {
    if (!Array.isArray(boundaries) || boundaries.length === 0) {
      timingStatus.textContent = "Timing captured: NO (0 boundaries)";
      return;
    }
    const first = boundaries[0];
    const last = boundaries[boundaries.length - 1];
    const monotonic = boundaries.every((boundary, index) => index === 0 ||
      Number(boundary.audioMs) >= Number(boundaries[index - 1].audioMs));
    timingStatus.textContent = `Timing captured: YES\n` +
      `Boundary count: ${boundaries.length}\n` +
      `First boundary: char ${first.charIndex}, len ${first.charLength}, audio ${first.audioMs} ms\n` +
      `Last boundary: char ${last.charIndex}, len ${last.charLength}, audio ${last.audioMs} ms\n` +
      `Monotonic timing: ${monotonic ? "YES" : "NO"}`;
  }

  function renderWaveDiagnostics(response) {
    const wave = response.waveDiagnostics;
    if (!wave) {
      waveStatus.textContent = `WAV diagnostics unavailable${response.waveDiagnosticError ? `: ${response.waveDiagnosticError}` : ""}`;
      return;
    }
    const observations = Array.isArray(response.timingDiagnostics) ? response.timingDiagnostics : [];
    const comparable = observations.filter((item) => Number.isFinite(Number(item.sapiAudioMs)) &&
      Number.isFinite(Number(item.streamAudioMs)) && Number(item.sapiAudioMs) > 0);
    const ratios = comparable.map((item) => Number(item.streamAudioMs) / Number(item.sapiAudioMs));
    const ratio = ratios.length ? ratios[ratios.length - 1] : null;
    const browserDuration = Number.isFinite(Number(audio.duration)) && Number(audio.duration) >= 0
      ? Math.round(Number(audio.duration) * 1000 * 1000) / 1000
      : "pending";
    const canonical = Array.isArray(response.timing) ? response.timing : [];
    waveStatus.textContent = `Timing source: pcm-stream\n` +
      `WAV sample rate: ${wave.sampleRate} Hz\n` +
      `WAV byte rate: ${wave.byteRate} B/s\n` +
      `WAV PCM duration: ${wave.pcmDurationMs} ms\n` +
      `Browser audio.duration: ${browserDuration} ms\n` +
      `Canonical first: ${canonical[0]?.audioMs ?? "n/a"} ms PCM\n` +
      `Canonical last: ${canonical.at(-1)?.audioMs ?? "n/a"} ms PCM\n` +
      `Raw SAPI first: ${observations[0]?.sapiAudioMs ?? "n/a"} ms\n` +
      `Raw SAPI last: ${observations.at(-1)?.sapiAudioMs ?? "n/a"} ms\n` +
      `Raw SAPI → PCM ratio (last comparable): ${ratio === null ? "n/a" : ratio.toFixed(4)}`;
  }

  function renderLatencyDiagnostics(response) {
    const latency = response.latencyDiagnostics;
    if (!latency) {
      latencyStatus.textContent = "Latency diagnostics: unavailable";
      return;
    }
    const format = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} ms` : "n/a";
    const factor = Number.isFinite(Number(latency.synthesisRealtimeFactor))
      ? Number(latency.synthesisRealtimeFactor).toFixed(3)
      : "n/a";
    latencyStatus.textContent = `Latency diagnostics\n` +
      `Text: ${latency.textChars ?? "n/a"} chars\n` +
      `Native port: ${latency.nativePort || "unknown"}\n` +
      `SpeechSynthesizer: ${latency.synthesizerWarm === true ? "warm/reused" : latency.synthesizerWarm === false ? "cold/new" : "unknown"}\n` +
      `Content → background/native response: ${format(latency.responseReceivedMs ?? latency.requestDispatchMs)}\n` +
      `  Native total: ${format(latency.totalNativeMs)}\n` +
      `    synthesizer acquisition: ${format(latency.getSynthesizerMs)}\n` +
      `    installed voice lookup: ${format(latency.getInstalledVoicesMs)}\n` +
      `    SelectVoice: ${format(latency.selectVoiceMs)}\n` +
      `    SetOutputToWaveStream: ${format(latency.setWaveOutputMs)}\n` +
      `    Speak/render: ${format(latency.speakMs)}\n` +
      `    WAV materialization: ${format(latency.wavMaterializeMs)}\n` +
      `    WAV diagnostics: ${format(latency.waveDiagnosticsMs)}\n` +
      `    native send: ${format(latency.nativeSendMs)}\n` +
      `  Background assembly: ${format(latency.byteAssemblyMs)}\n` +
      `  Background base64 encode: ${format(latency.base64EncodeMs)}\n` +
      `  Content base64 decode: ${format(latency.contentBase64DecodeMs)}\n` +
      `  Blob/src preparation: ${format(latency.blobPreparationMs)}\n` +
      `  play() resolution: ${format(latency.playResolutionMs)}\n` +
      `  play() → currentTime > 0: ${format(latency.firstMediaClockMs)}\n` +
      `Total dispatch → media movement: ${format(latency.totalDispatchToMediaMs)}\n` +
      `PCM duration: ${format(latency.pcmDurationMs)}\n` +
      `Synthesis realtime factor (speak / PCM): ${factor}`;
  }

  function waitForFirstMediaMovement(requestGeneration, startedAt) {
    return new Promise((resolve) => {
      let frame = null;
      const deadline = now() + 5000;
      const schedule = globalThis.requestAnimationFrame ||
        ((callback) => globalThis.setTimeout?.(callback, 16) ?? callback());
      const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout || (() => {});
      const finish = (value) => {
        if (frame !== null) cancel(frame);
        resolve(value);
      };
      const tick = () => {
        if (requestGeneration !== generation) return finish(null);
        if (!Number.isFinite(Number(audio.currentTime))) return finish(null);
        if (Number(audio.currentTime) > 0) return finish(now() - startedAt);
        if (now() >= deadline) return finish(null);
        frame = schedule(tick);
      };
      frame = schedule(tick);
    });
  }

  async function loadDiagnostics() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "EDGE_TTS_WIN_NATURAL_DIAGNOSTICS" });
      if (!response?.connected) throw new Error(response?.error || "Background Native Messaging diagnostics failed.");
      renderVoices(response);
    } catch (error) {
      connection.textContent = "Connection failed";
      setStatus(String(error?.message || error));
    }
  }

  speakButton.addEventListener("click", async () => {
    if (!ariaVoice) return;
    stopPlayback("Synthesizing diagnostic phrase…");
    const requestGeneration = ++generation;
    const dispatchStartedAt = now();
    prepareAudio();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE",
        voiceId: ariaVoice.id,
        text: probeTexts[probeSelect?.value] || probeTexts.short
      });
      const responseReceivedAt = now();
      if (!response?.accepted) throw new Error(response?.error || "Background synthesis failed.");
      if (requestGeneration !== generation) return;
      const decodeStartedAt = now();
      const bytes = bytesFromBase64(response.wavBase64);
      const contentBase64DecodeMs = now() - decodeStartedAt;
      if (response.totalBytes !== undefined && response.totalBytes !== bytes.length) {
        throw new Error("Background returned a WAV size mismatch.");
      }
      renderTiming(response.timing);
      lastWaveResponse = response;
      renderWaveDiagnostics(response);
      const blobPreparationStartedAt = now();
      revokeAudio();
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      audio.src = objectUrl;
      const blobPreparationMs = now() - blobPreparationStartedAt;
      audio.onended = () => {
        if (requestGeneration === generation) {
          revokeAudio();
          setStatus("Playback complete.");
        }
      };
      const playStartedAt = now();
      await audio.play();
      const playResolutionMs = now() - playStartedAt;
      if (requestGeneration === generation) setStatus("Playing Microsoft Aria.");
      const firstMediaClockMs = await waitForFirstMediaMovement(requestGeneration, now());
      const latencyDiagnostics = {
        ...(response.latencyDiagnostics || {}),
        responseReceivedMs: responseReceivedAt - dispatchStartedAt,
        contentBase64DecodeMs,
        blobPreparationMs,
        playResolutionMs,
        firstMediaClockMs,
        totalDispatchToMediaMs: firstMediaClockMs === null
          ? null
          : now() - dispatchStartedAt
      };
      renderLatencyDiagnostics({ ...response, latencyDiagnostics });
    } catch (error) {
      if (requestGeneration === generation) setStatus(String(error?.message || error));
    }
  });

  stopButton.addEventListener("click", () => stopPlayback());
  loadDiagnostics();
})();
