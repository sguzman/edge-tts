(() => {
  const connection = document.querySelector("#connection");
  const voices = document.querySelector("#voices");
  const speakButton = document.querySelector("#speak");
  const stopButton = document.querySelector("#stop");
  const timingStatus = document.querySelector("#timing");
  const waveStatus = document.querySelector("#wave");
  const status = document.querySelector("#status");
  const audio = document.createElement("audio");
  const unlockWav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA";
  const maxWavBytes = 8 * 1024 * 1024;
  let ariaVoice = null;
  let objectUrl = "";
  let generation = 0;
  let lastWaveResponse = null;

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
    waveStatus.textContent = `WAV sample rate: ${wave.sampleRate} Hz\n` +
      `WAV byte rate: ${wave.byteRate} B/s\n` +
      `WAV PCM duration: ${wave.pcmDurationMs} ms\n` +
      `Browser audio.duration: ${browserDuration} ms\n` +
      `Timing first: ${observations[0]?.sapiAudioMs ?? "n/a"} ms SAPI / ${observations[0]?.streamAudioMs ?? "n/a"} ms stream\n` +
      `Timing last: ${observations.at(-1)?.sapiAudioMs ?? "n/a"} ms SAPI / ${observations.at(-1)?.streamAudioMs ?? "n/a"} ms stream\n` +
      `SAPI → stream ratio (last comparable): ${ratio === null ? "n/a" : ratio.toFixed(4)}`;
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
    prepareAudio();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "EDGE_TTS_WIN_NATURAL_SYNTHESIZE",
        voiceId: ariaVoice.id,
        text: "Windows Natural diagnostic playback is working."
      });
      if (!response?.accepted) throw new Error(response?.error || "Background synthesis failed.");
      if (requestGeneration !== generation) return;
      const bytes = bytesFromBase64(response.wavBase64);
      if (response.totalBytes !== undefined && response.totalBytes !== bytes.length) {
        throw new Error("Background returned a WAV size mismatch.");
      }
      renderTiming(response.timing);
      lastWaveResponse = response;
      renderWaveDiagnostics(response);
      revokeAudio();
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      audio.src = objectUrl;
      audio.onended = () => {
        if (requestGeneration === generation) {
          revokeAudio();
          setStatus("Playback complete.");
        }
      };
      await audio.play();
      if (requestGeneration === generation) setStatus("Playing Microsoft Aria.");
    } catch (error) {
      if (requestGeneration === generation) setStatus(String(error?.message || error));
    }
  });

  stopButton.addEventListener("click", () => stopPlayback());
  loadDiagnostics();
})();
