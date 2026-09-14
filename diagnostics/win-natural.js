(() => {
  const api = globalThis.EdgeTtsNativeMessaging;
  const connection = document.querySelector("#connection");
  const voices = document.querySelector("#voices");
  const speakButton = document.querySelector("#speak");
  const stopButton = document.querySelector("#stop");
  const status = document.querySelector("#status");
  const audio = document.createElement("audio");
  const unlockWav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA";
  let transport;
  let ariaVoice = null;
  let objectUrl = "";
  let generation = 0;

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
    const binary = atob(value);
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
      ? `Connected — protocol ${result.handshake.protocol}, ${result.handshake.architecture}`
      : "Not connected";
    setStatus(ariaVoice ? `Aria ready: ${ariaVoice.id}` : "Microsoft Aria was not enumerated.");
  }

  async function loadDiagnostics() {
    try {
      transport = api.createTransport();
      renderVoices(await transport.diagnostics());
    } catch (error) {
      connection.textContent = "Connection failed";
      setStatus(String(error?.message || error));
    }
  }

  speakButton.addEventListener("click", async () => {
    if (!transport || !ariaVoice) return;
    stopPlayback("Synthesizing diagnostic phrase…");
    const requestGeneration = ++generation;
    prepareAudio();
    try {
      const response = await transport.requestMultipart(
        "synthesize",
        { voiceId: ariaVoice.id, text: "Windows Natural diagnostic playback is working." },
        api.SYNTHESIS_TIMEOUT_MS
      );
      if (requestGeneration !== generation) return;
      const bytes = bytesFromBase64(response.wavBase64);
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
