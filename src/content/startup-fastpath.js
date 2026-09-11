(function attachStartupFastPath(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  const ReaderApp = root.EdgeTtsExtension?.Reader?.ReaderApp;
  if (ReaderApp && api.installStartupFastPath) {
    api.installStartupFastPath(ReaderApp);
  }
})(globalThis, function createStartupFastPathApi(root) {
  function now() {
    return root.performance?.now?.() ?? Date.now();
  }

  function round(value) {
    return Math.max(0, Math.round(Number(value) || 0));
  }

  function startupSummary(trace) {
    if (!trace) return "";
    return [
      `total ${round(trace.totalMs)} ms`,
      `prep ${round(trace.prepMs)} ms`,
      `remote speech ${round(trace.speechStartMs)} ms`,
      `model ${round(trace.modelMs)} ms`,
      `extra voice wait ${round(trace.extraVoiceWaitMs)} ms`
    ].join(" · ");
  }

  function installStartupFastPath(ReaderApp) {
    const prototype = ReaderApp?.prototype;
    if (!prototype || prototype.__edgeTtsStartupFastPathInstalled) {
      return false;
    }

    const textModel = root.EdgeTtsExtension?.TextModel;
    const speechModule = root.EdgeTtsExtension?.SpeechEngine;
    const firstBlockNearViewport = textModel?.firstBlockNearViewport;
    const isNaturalVoice = speechModule?.isNaturalVoice;
    const isWinNaturalVoice = (voice) => voice?.__edgeTtsSource === "win-natural";
    const originalHandleSpeechStart = prototype.handleSpeechStart;

    if (typeof firstBlockNearViewport !== "function" || typeof isNaturalVoice !== "function") {
      return false;
    }

    Object.defineProperty(prototype, "__edgeTtsStartupFastPathInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.open = async function optimizedOpen() {
      const startedAt = now();
      const trace = {
        active: true,
        startedAt,
        modelMs: 0,
        extraVoiceWaitMs: 0,
        prepMs: 0,
        speechStartMs: 0,
        totalMs: 0,
        voiceName: ""
      };
      this.startupTrace = trace;

      this.enabled = true;
      this.stopped = false;
      this.paused = false;
      this.toolbar.mount();
      this.toolbar.setStatus("Starting…");

      // Start every independent readiness path immediately. The Windows local
      // voice catalog comes from extension chrome.tts rather than page Web
      // Speech, so wait for it before choosing/restoring the saved voice.
      const settingsReady = this.loadSettings();
      const extensionVoicesReady = this.speech.refreshExtensionVoices?.() || Promise.resolve();
      const winNaturalVoicesReady = this.speech.refreshWinNaturalVoices?.() || Promise.resolve();
      const naturalVoicesReady = this.speech.waitForVoices(
        350,
        (voices) => voices.some((voice) => isNaturalVoice(voice) || isWinNaturalVoice(voice))
      );

      const modelStartedAt = now();
      this.rebuildModel();
      trace.modelMs = now() - modelStartedAt;

      await Promise.all([settingsReady, extensionVoicesReady, winNaturalVoicesReady]);
      this.applySettings();
      this.refreshVoices();

      if (!this.voices.some((voice) => isNaturalVoice(voice) || isWinNaturalVoice(voice))) {
        this.toolbar.setStatus("Loading Natural voice…");
        const voiceWaitStartedAt = now();
        await naturalVoicesReady;
        trace.extraVoiceWaitMs = now() - voiceWaitStartedAt;
        this.refreshVoices();
      }

      const startBlock = firstBlockNearViewport(this.model?.blocks || []);
      if (!startBlock) {
        trace.active = false;
        this.stop();
        this.toolbar.setStatus("No readable text found");
        return;
      }

      this.currentBlockIndex = startBlock.index;
      this.currentSegmentIndex = 0;
      trace.prepMs = now() - startedAt;
      trace.voiceName = this.selectedVoice?.name || "browser default";

      console.debug(
        `Edge Natural TTS startup prepared in ${round(trace.prepMs)}ms ` +
          `(model ${round(trace.modelMs)}ms, extra voice wait ${round(trace.extraVoiceWaitMs)}ms).`
      );

      if (await this.claimAudioOwnership?.()) {
        this.speakCurrentPosition();
      } else {
        trace.active = false;
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus("Paused — audio unavailable");
      }
    };

    prototype.handleSpeechStart = function profiledHandleSpeechStart(latencyMs) {
      const result = originalHandleSpeechStart?.call(this, latencyMs);
      const trace = this.startupTrace;
      if (!trace?.active) {
        return result;
      }

      trace.active = false;
      trace.speechStartMs = Number(latencyMs) || 0;
      trace.totalMs = now() - trace.startedAt;
      trace.voiceName = this.selectedVoice?.name || trace.voiceName || "browser default";

      const summary = startupSummary(trace);
      root.__EDGE_TTS_LAST_STARTUP__ = { ...trace, summary };
      if (this.toolbar?.status) {
        this.toolbar.status.title = `Reading · ${summary} · ${trace.voiceName}`;
      }
      console.info(`Edge Natural TTS startup: ${summary} · ${trace.voiceName}`);
      return result;
    };

    return true;
  }

  return { installStartupFastPath, startupSummary };
});
