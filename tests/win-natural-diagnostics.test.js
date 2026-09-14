const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "diagnostics", "win-natural.js"), "utf8");
const html = fs.readFileSync(path.join(root, "diagnostics", "win-natural.html"), "utf8");
const host = fs.readFileSync(path.join(root, "native", "win-natural", "WinNaturalHost.cs"), "utf8");

test("diagnostics page is an extension-origin page with no ReaderApp dependency", () => {
  assert.match(html, /src="\.\/win-natural\.js"/);
  assert.doesNotMatch(html, /background\/native-messaging/);
  assert.doesNotMatch(page, /ReaderApp|audioOwner|chrome\.tts|connectNative/);
  assert.match(page, /EDGE_TTS_WIN_NATURAL_DIAGNOSTICS/);
  assert.match(page, /EDGE_TTS_WIN_NATURAL_SYNTHESIZE/);
  assert.match(page, /maxWavBytes = 8 \* 1024 \* 1024/);
  assert.match(page, /WAV size mismatch/);
  assert.match(html, /id="timing"/);
  assert.match(page, /Timing captured: YES/);
  assert.match(page, /Monotonic timing/);
  assert.match(page, /Timing source: pcm-stream/);
  assert.match(page, /WAV sample rate/);
  assert.match(page, /Canonical first/);
  assert.match(page, /Raw SAPI first/);
  assert.match(page, /Browser audio\.duration/);
  assert.match(html, /id="wave"/);
  assert.match(html, /id="latency"/);
  assert.match(page, /Latency diagnostics/);
  assert.match(page, /Native port/);
  assert.match(page, /currentTime > 0/);
});

test("diagnostics page uses the actual Local-* Aria token and owns audio cleanup", () => {
  assert.match(page, /voiceId: ariaVoice\.id/);
  assert.match(page, /EDGE_TTS_WIN_NATURAL_SYNTHESIZE/);
  assert.match(page, /generation/);
  assert.match(page, /audio\.pause\(\)/);
  assert.match(page, /URL\.revokeObjectURL/);
  assert.match(page, /requestGeneration !== generation/);
  assert.match(page, /Windows Natural diagnostic playback is working\./);
});

test("helper synthesis validates the actual Local token and SAPI selection", () => {
  assert.match(host, /voiceId\.StartsWith\("Local-", StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(host, /GetInstalledVoices\(\)/);
  assert.match(host, /string\.Equals\(voice\.VoiceInfo\.Id, voiceId, StringComparison\.Ordinal\)/);
  assert.match(host, /synthesizer\.SelectVoice\(selectedName\)/);
  assert.match(host, /synthesizer\.Voice\?\.Id, voiceId, StringComparison\.Ordinal/);
  assert.match(host, /SetOutputToWaveStream/);
  assert.match(host, /new MemoryStream/);
  assert.doesNotMatch(host, /SetOutputToDefaultAudioDevice/);
  assert.doesNotMatch(host, /File\.WriteAll/);
  assert.match(host, /SynthesisChunkBytes = 48 \* 1024/);
  assert.match(host, /MaxSynthesisBytes = 8 \* 1024 \* 1024/);
  assert.match(host, /SpeakProgressEventArgs/);
  assert.match(host, /synthesizer\.SpeakProgress \+= progressHandler/);
  assert.match(host, /synthesizer\.SpeakProgress -= progressHandler/);
  assert.match(host, /SynthesisLatencyDiagnostics/);
  assert.match(host, /getInstalledVoicesMs/);
  assert.match(host, /synthesisRealtimeFactor/);
  assert.match(host, /latencyDiagnostics/);
  assert.match(host, /finally/);
  assert.match(host, /charIndex/);
  assert.match(host, /charLength/);
  assert.match(host, /audioMs/);
  assert.match(host, /timing = canonicalTiming/);
  assert.match(host, /TryParseWaveDiagnostics/);
  assert.match(host, /dataChunkOffset/);
  assert.match(host, /pcmDurationMs/);
  assert.match(host, /timingDiagnostics/);
  assert.match(host, /observation\.StreamPosition - waveDiagnostics\.DataChunkOffset/);
  assert.match(host, /canonicalTiming/);
  assert.match(host, /timing = canonicalTiming/);
  assert.match(host, /streamAudioMs > waveDiagnostics\.PcmDurationMs/);
});

test("PCM stream timing uses the WAV byte clock and contains invalid positions", () => {
  const derive = (streamPosition, dataOffset, byteRate, dataBytes) => {
    const bytesIntoData = streamPosition - dataOffset;
    if (!Number.isFinite(bytesIntoData) || bytesIntoData < 0 || bytesIntoData > dataBytes) return null;
    return bytesIntoData * 1000 / byteRate;
  };
  assert.equal(derive(44 + 11550, 44, 44100, 200000), 261.9047619047619);
  assert.equal(derive(44 + 104100, 44, 44100, 200000), 2360.5442176870747);
  assert.equal(derive(43, 44, 44100, 200000), null);
  assert.equal(derive(44 + 200001, 44, 44100, 200000), null);
  assert.notEqual(derive(44 + 104100, 44, 44100, 200000), 2169.333);
});

test("diagnostic Stop invalidates a late synthesis response and URLs revoke on end", async () => {
  const handlers = {};
  const elements = {
    "#connection": { textContent: "" },
    "#voices": { replaceChildren() {}, append() {} },
    "#speak": { disabled: false, addEventListener(type, handler) { handlers.speak = handler; } },
    "#stop": { addEventListener(type, handler) { handlers.stop = handler; } },
    "#timing": { textContent: "" },
    "#wave": { textContent: "" },
    "#latency": { textContent: "" },
    "#status": { textContent: "" }
  };
  const audio = {
    playCalls: 0,
    paused: true,
    onended: null,
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() {},
    removeAttribute() {}
  };
  let resolveSynthesis;
  const revoked = [];
  const created = [];
  const diagnosticsResponse = {
    connected: true,
    handshake: { protocol: 1, architecture: "x64" },
    voices: [{ id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }],
    ariaVoice: { id: "Local-NarratorVoices", name: "Microsoft Aria", lang: "en-US" }
  };
  const context = {
    document: {
      querySelector(selector) { return elements[selector]; },
      createElement() { return audio; }
    },
    URL: {
      createObjectURL() { const url = `blob:test-${created.length}`; created.push(url); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    Blob: class BlobMock {},
    Uint8Array,
    Promise,
    atob,
    chrome: {
      runtime: {
        sendMessage(message) {
          if (message.type === "EDGE_TTS_WIN_NATURAL_DIAGNOSTICS") return Promise.resolve(diagnosticsResponse);
          if (message.type === "EDGE_TTS_WIN_NATURAL_SYNTHESIZE") {
            return new Promise((resolve) => { resolveSynthesis = resolve; });
          }
          return Promise.reject(new Error("Unexpected message"));
        }
      }
    },
    console
  };
  vm.runInNewContext(page, context);
  await new Promise((resolve) => setImmediate(resolve));

  const firstPlayback = handlers.speak();
  handlers.stop();
  resolveSynthesis({ accepted: true, wavBase64: Buffer.from("late-wav").toString("base64") });
  await firstPlayback;
  await Promise.resolve();
  assert.equal(audio.playCalls, 1, "only the synchronous unlock may have played");
  assert.equal(created.length, 0, "a stopped late response must not create an audio URL");
  assert.equal(elements["#status"].textContent, "Stopped.");

  const secondPlayback = handlers.speak();
  const wavBase64 = Buffer.from("wav").toString("base64");
  resolveSynthesis({ accepted: true, wavBase64, totalBytes: 3 });
  await secondPlayback;
  assert.equal(created.length, 1);
  audio.onended();
  assert.deepEqual(revoked, ["blob:test-0"]);
});
