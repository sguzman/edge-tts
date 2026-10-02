(function attachReader(root) {
  const extension = root.EdgeTtsExtension;
  const {
    buildReadableModel,
    findSegmentInNode,
    firstBlockNearViewport,
    relocateCursorAfterRebuild,
    segmentIsLive
  } = extension.TextModel;
  const {
    DEFAULT_SENTENCE_COLOR,
    DEFAULT_WORD_COLOR,
    Highlighter,
    normalizeColor
  } = extension.Highlighter;
  const { SpeechEngine, createSpeechBatch, isNaturalVoice } = extension.SpeechEngine;
  const { Toolbar } = extension.Toolbar;

  const EDITABLE_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='combobox']",
    ".ProseMirror",
    ".monaco-editor",
    ".CodeMirror",
    ".cm-editor",
    "[data-lexical-editor='true']",
    "[data-slate-editor='true']"
  ].join(",");
  const isWinNaturalVoice = (voice) => voice?.__edgeTtsSource === "win-natural";
  const isLinuxPiperVoice = (voice) => voice?.__edgeTtsSource === "linux-piper";
  const DEFAULT_LINUX_PIPER_VOICE_ID = "en_US-ryan-high";

  function voiceSourceKey(voice) {
    if (isLinuxPiperVoice(voice)) return "linux-piper";
    if (isWinNaturalVoice(voice)) return "win-natural";
    if (voice?.__edgeTtsSource) return String(voice.__edgeTtsSource);
    if (isNaturalVoice(voice)) return "online";
    return "browser";
  }

  const MIN_BATCH_CHARS = 400;
  const MAX_BATCH_CHARS = 2400;
  const DEFAULT_BATCH_CHARS = 1200;
  const MIN_SENTENCE_PAUSE_MS = 0;
  const MAX_SENTENCE_PAUSE_MS = 1200;
  const DEFAULT_SENTENCE_PAUSE_MS = 300;

  const DEFAULT_SETTINGS = {
    settingsVersion: 4,
    rate: 1,
    voiceName: "",
    voiceSource: "linux-piper",
    voiceId: DEFAULT_LINUX_PIPER_VOICE_ID,
    minBatchChars: DEFAULT_BATCH_CHARS,
    sentencePauseMs: DEFAULT_SENTENCE_PAUSE_MS,
    wordColor: DEFAULT_WORD_COLOR,
    sentenceColor: DEFAULT_SENTENCE_COLOR,
    autoScroll: true,
    clickToSeek: false,
    minimized: false,
    toolbarPosition: null
  };

  function normalizeBatchChars(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_BATCH_CHARS;
    }
    const stepped = Math.round(numeric / 100) * 100;
    return Math.min(MAX_BATCH_CHARS, Math.max(MIN_BATCH_CHARS, stepped));
  }

  function normalizeSentencePauseMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_SENTENCE_PAUSE_MS;
    }
    const stepped = Math.round(numeric / 50) * 50;
    return Math.min(
      MAX_SENTENCE_PAUSE_MS,
      Math.max(MIN_SENTENCE_PAUSE_MS, stepped)
    );
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    return Boolean(target.closest(EDITABLE_SELECTOR) || target.isContentEditable);
  }

  class ReaderApp {
    constructor() {
      this.model = null;
      this.currentBlockIndex = -1;
      this.currentSegmentIndex = 0;
      this.activeBatchEndBlockIndex = -1;
      this.enabled = false;
      this.stopped = true;
      this.paused = false;
      this.quitRequested = false;
      this.settings = { ...DEFAULT_SETTINGS };
      this.voices = [];
      this.selectedVoice = null;
      this.lastSpeakRequestedAt = 0;
      this.boundarySerial = 0;
      this.resumeWatchdog = null;
      this.pageClickListening = false;
      this.audioOwner = false;
      this.audioClaimSerial = 0;
      this.lifecycleSerial = 0;
      this.initialPiperRetryRemaining = 1;
      this.sessionSpeechStarted = false;
      this.modelMutationObserver = null;
      this.modelStale = false;
      this.staleCursorAnchor = null;
      this.highlighter = new Highlighter();
      this.speech = new SpeechEngine({
        onBoundary: (segment) => this.handleBoundary(segment),
        onEnd: () => this.handleBlockEnd(),
        onError: (error) => this.handleError(error),
        onStart: (_segment, latencyMs) => this.handleSpeechStart(latencyMs),
        onStatus: (status) => {
          if (!this.stopped && !this.paused && this.enabled) {
            this.toolbar?.setStatus?.(status);
          }
        },
        onPlaybackBlocked: (error) => this.handlePlaybackBlocked(error)
      });
      this.toolbar = new Toolbar({
        onPlayPause: () => this.playPause(),
        onStop: () => this.stop(),
        onQuit: () => this.quit(),
        onRefresh: () => this.refreshText(),
        onVoice: (name) => this.changeVoice(name),
        onRate: (rate) => this.changeRate(rate),
        onBatchChars: (chars) => this.changeBatchChars(chars),
        onSentencePause: (ms) => this.changeSentencePause(ms),
        onWordColor: (color) => this.changeWordColor(color),
        onSentenceColor: (color) => this.changeSentenceColor(color),
        onAutoScroll: (enabled) => this.changeAutoScroll(enabled),
        onClickToSeek: (enabled) => this.changeClickToSeek(enabled),
        onMinimized: (minimized) => this.changeMinimized(minimized),
        onPosition: (position) => this.changeToolbarPosition(position),
        onPronunciationOptions: () => this.openPronunciationOptions()
      });

      this.boundClick = (event) => this.handlePageClick(event);
      this.unsubscribeVoiceChanges = this.speech.onVoicesChanged(() => {
        if (this.enabled) {
          this.refreshVoices();
        }
      });
    }

    disconnectModelMutationObserver() {
      try {
        this.modelMutationObserver?.disconnect?.();
      } catch (_error) {}
      this.modelMutationObserver = null;
    }

    activeModelBlockRange() {
      const start = Math.max(0, Number(this.currentBlockIndex) || 0);
      const rawEnd = Number(this.activeBatchEndBlockIndex);
      const end =
        Number.isInteger(rawEnd) && rawEnd >= start
          ? rawEnd
          : start;
      return { start, end };
    }

    mutationTouchesActiveModel(mutation) {
      const model = this.model;
      if (!model?.blocks?.length) return false;

      const { start, end } = this.activeModelBlockRange();
      const activeBlocks = model.blocks.slice(start, end + 1);
      if (!activeBlocks.length) return false;

      if (mutation?.type === "characterData") {
        const block = model.nodeToBlock?.get?.(mutation.target);
        return Boolean(
          block &&
          block.index >= start &&
          block.index <= end
        );
      }

      if (mutation?.type !== "childList") return false;

      const target = mutation.target;
      if (
        activeBlocks.some((block) =>
          block?.element === target ||
          block?.element?.contains?.(target)
        )
      ) {
        return true;
      }

      for (const removed of mutation.removedNodes || []) {
        if (
          activeBlocks.some((block) =>
            removed === block?.element ||
            removed?.contains?.(block?.element)
          )
        ) {
          return true;
        }
      }

      return false;
    }

    captureStaleCursorAnchor() {
      if (this.staleCursorAnchor || !this.model) return;
      const block = this.model.blocks?.[this.currentBlockIndex];
      if (!block?.segments?.length) return;

      this.staleCursorAnchor = {
        blockIndex: block.index,
        segmentIndex: Math.max(
          0,
          Math.min(
            Number(this.currentSegmentIndex) || 0,
            block.segments.length - 1
          )
        ),
        authorRole: String(block.authorRole || ""),
        segments: block.segments.map((segment) => ({
          text: String(segment.text || "")
        }))
      };
    }

    markModelStale(reason = "page-text-mutated") {
      this.captureStaleCursorAnchor();
      this.modelStale = true;
      this.highlighter?.clear?.();

      if (this.stopped) return false;

      if (this.paused) {
        // A manually-paused reader may still own a resumable offscreen WAV.
        // Once its DOM coordinates are stale, that media is stale too.
        try {
          this.discardLocalSpeechState();
        } catch (error) {
          console.warn(
            "Edge Natural TTS could not retire stale paused playback.",
            error
          );
        }
        void this.forceStopTabAudio();
        this.toolbar?.setPaused?.(true);
        this.toolbar?.setStatus?.(
          "Paused — page text changed; Resume will rebuild"
        );
        return true;
      }

      this.lifecycleSerial += 1;
      this.clearResumeWatchdog();
      this.clearReliabilityTimers?.();
      this.clearPlaybackLivenessWatchdog?.();
      if (Number.isFinite(Number(this.batchRequestSerial))) {
        this.batchRequestSerial += 1;
      }
      this.activeBatchRequest = null;
      this.activeBatchEndBlockIndex = -1;

      try {
        this.discardLocalSpeechState();
      } catch (error) {
        console.warn(
          "Edge Natural TTS could not cancel stale-DOM playback.",
          error
        );
      }

      void this.forceStopTabAudio();
      this.releaseAudioOwnership();
      this.stopped = false;
      this.paused = true;
      this.toolbar?.setPaused?.(true);
      this.toolbar?.setStatus?.(
        "Paused — page text changed; Resume will rebuild"
      );

      console.warn(
        "Edge Natural TTS paused because its DOM model became stale (" +
          String(reason) +
          ")."
      );
      return true;
    }

    observeModelMutations() {
      this.disconnectModelMutationObserver();
      if (
        !this.enabled ||
        !this.model?.blocks?.length ||
        typeof root.MutationObserver !== "function" ||
        !document.body
      ) {
        return;
      }

      this.modelMutationObserver = new root.MutationObserver((mutations) => {
        if (!this.enabled || this.stopped || this.modelStale) return;

        if (
          mutations.some((mutation) =>
            this.mutationTouchesActiveModel(mutation)
          )
        ) {
          this.markModelStale("active-readable-dom-mutated");
        }
      });

      this.modelMutationObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      });
    }

    restoreFreshCursorAfterMutation() {
      const relocated = relocateCursorAfterRebuild?.(
        this.staleCursorAnchor,
        this.model
      );
      if (relocated) {
        this.currentBlockIndex = relocated.blockIndex;
        this.currentSegmentIndex = relocated.segmentIndex;
        return true;
      }

      const startBlock = firstBlockNearViewport(this.model?.blocks || []);
      if (!startBlock) return false;
      this.currentBlockIndex = startBlock.index;
      this.currentSegmentIndex = 0;
      return true;
    }

    rebuildAfterStaleModel() {
      this.disconnectModelMutationObserver();
      this.rebuildModel();
      const restored = this.restoreFreshCursorAfterMutation();
      this.modelStale = false;
      this.staleCursorAnchor = null;
      this.highlighter?.clear?.();
      this.observeModelMutations();
      return restored;
    }

    async toggle() {
      if (this.enabled) {
        this.close();
      } else {
        await this.open();
      }
    }

    async open() {
      const openStartedAt = performance.now();
      const lifecycle = ++this.lifecycleSerial;
      this.enabled = true;
      this.stopped = false;
      this.paused = false;
      this.initialPiperRetryRemaining = 1;
      this.sessionSpeechStarted = false;
      this.toolbar.mount();
      this.toolbar.setStatus("Starting…");

      await this.loadSettings();
      if (
        lifecycle !== this.lifecycleSerial ||
        !this.enabled ||
        this.quitRequested
      ) {
        return;
      }
      this.applySettings();

      // Sentence boundaries and Piper speech projection both depend on the
      // persisted pronunciation config. Load it before building the readable
      // model so the base startup path matches the optimized fast path.
      await Promise.all([
        this.speech.refreshLinuxPiperVoices?.() || Promise.resolve(),
        this.speech.refreshPronunciationConfig?.() || Promise.resolve()
      ]);
      if (
        lifecycle !== this.lifecycleSerial ||
        !this.enabled ||
        this.stopped ||
        this.paused ||
        this.quitRequested
      ) {
        return;
      }

      this.rebuildModel();
      await this.ensurePreferredVoiceAvailable();
      if (
        !this.selectedVoice &&
        !this.voices.some((voice) =>
          isNaturalVoice(voice) || isWinNaturalVoice(voice) || isLinuxPiperVoice(voice)
        )
      ) {
        this.toolbar.setStatus("Loading voices…");
        await this.speech.waitForVoices(
          350,
          (voices) => voices.some((voice) =>
            isNaturalVoice(voice) || isWinNaturalVoice(voice) || isLinuxPiperVoice(voice)
          )
        );
        if (
          lifecycle !== this.lifecycleSerial ||
          !this.enabled ||
          this.stopped ||
          this.paused ||
          this.quitRequested
        ) {
          return;
        }
        await this.ensurePreferredVoiceAvailable();
      }

      if (this.prefersLinuxPiper() && !isLinuxPiperVoice(this.selectedVoice)) {
        this.stopped = false;
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus(
          "Paused — Piper voice unavailable; Online fallback blocked"
        );
        return;
      }

      const startBlock = firstBlockNearViewport(this.model.blocks);
      if (!startBlock) {
        this.stop();
        this.toolbar.setStatus("No readable text found");
        return;
      }

      this.currentBlockIndex = startBlock.index;
      this.currentSegmentIndex = 0;
      console.debug(
        `Edge Natural TTS startup prepared in ${Math.round(performance.now() - openStartedAt)}ms`
      );
      const granted = await this.claimAudioOwnership();
      if (
        lifecycle !== this.lifecycleSerial ||
        !this.enabled ||
        this.stopped ||
        this.paused ||
        this.quitRequested
      ) {
        if (granted) this.releaseAudioOwnership();
        return;
      }
      if (granted) {
        this.speakCurrentPosition();
      } else {
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus("Paused — audio unavailable");
      }
    }

    close() {
      this.stop();
      this.enabled = false;
      this.syncPageClickListener();
      this.toolbar.hide();
    }

    quit() {
      if (this.quitRequested) return;
      this.quitRequested = true;
      this.enabled = false;
      this.lifecycleSerial += 1;

      // Quit must be authoritative even if a native backend is unhealthy.
      // Teardown continues even when transport cancellation throws.
      try {
        this.stop();
      } catch (error) {
        console.warn("Edge Natural TTS transport failed while quitting.", error);
      }

      this.syncPageClickListener();

      this.unsubscribeVoiceChanges?.();
      this.unsubscribeVoiceChanges = null;

      this.highlighter.clear();
      this.highlighter.styleElement?.remove?.();
      this.highlighter.styleElement = null;
      this.toolbar.destroy?.();

      this.disconnectModelMutationObserver();
      this.modelStale = false;
      this.staleCursorAnchor = null;
      this.model = null;
      this.voices = [];
      this.selectedVoice = null;
      this.activeBatchRequest = null;
      this.activeBatchEndBlockIndex = -1;

      root.__EDGE_TTS_READER__?.detach?.(this);
    }

    async claimAudioOwnership() {
      const serial = ++this.audioClaimSerial;
      this.toolbar?.setStatus?.("Claiming audio…");

      try {
        const response = await chrome.runtime.sendMessage({ type: "EDGE_TTS_AUDIO_CLAIM" });
        if (
          serial !== this.audioClaimSerial ||
          !this.enabled ||
          this.stopped ||
          this.paused
        ) {
          if (response?.granted === true) {
            try {
              const pending = chrome.runtime.sendMessage({ type: "EDGE_TTS_AUDIO_RELEASE" });
              pending?.catch?.(() => {});
            } catch (_error) {}
          }
          return false;
        }

        this.audioOwner = response?.granted === true;
        return this.audioOwner;
      } catch (error) {
        console.warn("Edge Natural TTS could not claim browser audio ownership.", error);
        this.audioOwner = false;
        return false;
      }
    }

    releaseAudioOwnership() {
      this.audioClaimSerial += 1;
      this.audioOwner = false;
      try {
        const pending = chrome.runtime.sendMessage({ type: "EDGE_TTS_AUDIO_RELEASE" });
        pending?.catch?.(() => {});
      } catch (_error) {
        // The local session is already detached from browser speech.
      }
    }

    forceStopTabAudio() {
      try {
        return Promise.resolve(
          chrome.runtime.sendMessage({
            type: "EDGE_TTS_FORCE_STOP_TAB_AUDIO"
          })
        ).catch(() => ({ stopped: false }));
      } catch (_error) {
        return Promise.resolve({ stopped: false });
      }
    }

    suspendForOtherTab() {
      this.audioClaimSerial += 1;
      const shouldRemainPaused = !this.stopped;

      this.clearResumeWatchdog();
      this.clearReliabilityTimers?.();
      this.clearPlaybackLivenessWatchdog?.();
      if (Number.isFinite(Number(this.batchRequestSerial))) {
        this.batchRequestSerial += 1;
      }
      this.activeBatchRequest = null;
      this.activeBatchEndBlockIndex = -1;

      // The background sends this only to the current audio owner and waits for
      // us to finish before granting another tab. Canceling here is therefore
      // safe: at this moment the browser-global utterance belongs to this tab.
      this.speech?.cancel?.();
      this.audioOwner = false;

      if (shouldRemainPaused) {
        this.stopped = false;
        this.paused = true;
        this.toolbar?.setPaused?.(true);
        this.toolbar?.setStatus?.("Paused — another tab is playing");
      }

      return true;
    }

    discardLocalSpeechState() {
      if (this.audioOwner) {
        this.speech?.cancel?.();
      } else {
        this.speech?.abandon?.();
      }
    }

    syncPageClickListener() {
      const shouldListen = Boolean(this.enabled && this.settings.clickToSeek);
      if (shouldListen === this.pageClickListening) {
        return;
      }

      if (shouldListen) {
        document.addEventListener("click", this.boundClick, true);
      } else {
        document.removeEventListener("click", this.boundClick, true);
      }
      this.pageClickListening = shouldListen;
    }

    stop() {
      this.lifecycleSerial += 1;
      this.disconnectModelMutationObserver();
      this.modelStale = false;
      this.staleCursorAnchor = null;
      this.clearResumeWatchdog();
      this.activeBatchEndBlockIndex = -1;
      this.stopped = true;
      this.paused = false;

      // Commit user-visible state first, then tear down local transport while
      // this tab still owns it. Finally ask the background to hard-stop every
      // per-tab backend/offscreen session by owner tab id so stale playback ids
      // cannot survive Stop or Quit.
      this.toolbar.setStopped();
      this.highlighter.clear();

      try {
        this.discardLocalSpeechState();
      } catch (error) {
        console.warn("Edge Natural TTS transport failed while stopping.", error);
      }

      void this.forceStopTabAudio();
      this.releaseAudioOwnership();
    }

    async playPause() {
      const lifecycle = ++this.lifecycleSerial;

      if (this.stopped) {
        this.rebuildModel();
        const startBlock = firstBlockNearViewport(this.model.blocks);
        if (!startBlock) {
          this.toolbar.setStatus("No readable text found");
          return;
        }

        this.currentBlockIndex = startBlock.index;
        this.currentSegmentIndex = 0;
        this.stopped = false;
        this.paused = false;
        const granted = await this.claimAudioOwnership();
        if (
          lifecycle !== this.lifecycleSerial ||
          this.stopped ||
          this.paused ||
          this.quitRequested
        ) {
          if (granted) this.releaseAudioOwnership();
          return;
        }
        if (granted) {
          this.speakCurrentPosition();
        } else {
          this.paused = true;
          this.toolbar.setPaused(true);
          this.toolbar.setStatus("Paused — audio unavailable");
        }
        return;
      }

      if (this.paused) {
        const restartFromFreshModel = this.modelStale === true;
        if (restartFromFreshModel) {
          if (!this.rebuildAfterStaleModel()) {
            this.stopped = true;
            this.paused = false;
            this.toolbar.setStopped();
            this.toolbar.setStatus("No readable text found after page update");
            return;
          }
        }

        this.paused = false;
        this.toolbar.setPaused(false);
        this.toolbar.setStatus(
          restartFromFreshModel
            ? "Rebuilding after page update…"
            : "Resuming…"
        );

        const granted = await this.claimAudioOwnership();
        if (
          lifecycle !== this.lifecycleSerial ||
          this.stopped ||
          this.paused ||
          this.quitRequested
        ) {
          if (granted) this.releaseAudioOwnership();
          return;
        }

        if (granted) {
          if (restartFromFreshModel) {
            this.toolbar.setStatus("Restarting on fresh page text…");
            this.speakCurrentPosition();
            return;
          }

          let resumed = false;
          try {
            resumed = await Promise.resolve(
              this.speech?.resumeInPlace?.()
            );
          } catch (error) {
            console.warn(
              "Edge Natural TTS in-place resume confirmation failed.",
              error
            );
            resumed = false;
          }

          if (
            lifecycle !== this.lifecycleSerial ||
            this.stopped ||
            this.paused ||
            this.quitRequested
          ) {
            return;
          }

          if (resumed === true) {
            // Do not claim Reading until the backend has confirmed that media
            // actually resumed. Offscreen Piper returns only after audio.play()
            // succeeds; its resumed event also drives highlight state.
            this.toolbar.setStatus("Reading");
          } else {
            this.toolbar.setStatus("Restarting from current word…");
            this.speakCurrentPosition();
          }
        } else {
          this.paused = true;
          this.toolbar.setPaused(true);
          this.toolbar.setStatus("Paused — audio unavailable");
        }
      } else {
        this.clearResumeWatchdog();
        this.toolbar.setStatus("Pausing…");

        let pausedInPlace = false;
        try {
          pausedInPlace = await Promise.resolve(
            this.speech?.pauseInPlace?.()
          );
        } catch (error) {
          console.warn("Edge Natural TTS in-place pause failed.", error);
          pausedInPlace = false;
        }

        if (
          lifecycle !== this.lifecycleSerial ||
          this.stopped ||
          this.quitRequested
        ) {
          return;
        }

        this.paused = true;
        this.toolbar.setPaused(true);

        if (pausedInPlace === true) {
          this.toolbar.setStatus("Paused");
          this.releaseAudioOwnership();
          return;
        }

        // If the media player did not positively acknowledge pause, do not
        // leave audible speech running. Kill both local state and the
        // background/offscreen session, then resume later from the cursor.
        try {
          this.discardLocalSpeechState();
        } catch (error) {
          console.warn("Edge Natural TTS transport failed while pausing.", error);
        }
        await this.forceStopTabAudio();
        this.releaseAudioOwnership();
        this.toolbar.setStatus("Paused — playback hard-stopped");
      }
    }

    refreshText() {
      const wasReading = !this.stopped && !this.paused && this.audioOwner;
      const wasPaused = !this.stopped && this.paused;
      this.clearResumeWatchdog();
      this.activeBatchEndBlockIndex = -1;
      this.discardLocalSpeechState();
      void this.forceStopTabAudio();
      this.highlighter.clear();
      this.modelStale = false;
      this.staleCursorAnchor = null;
      this.rebuildModel();

      const startBlock = firstBlockNearViewport(this.model.blocks);
      if (!startBlock) {
        this.stopped = true;
        this.toolbar.setStopped();
        this.toolbar.setStatus("No readable text found");
        return;
      }

      this.currentBlockIndex = startBlock.index;
      this.currentSegmentIndex = 0;

      if (wasReading) {
        this.stopped = false;
        this.paused = false;
        this.speakCurrentPosition();
      } else if (wasPaused) {
        this.stopped = false;
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus("Paused");
      } else {
        this.stopped = true;
        this.toolbar.setStopped();
        this.toolbar.setStatus(
          this.model.profile === "chatgpt" ? "Refreshed ChatGPT messages" : "Text refreshed"
        );
      }
    }

    startResumeWatchdog(serialBeforeResume) {
      this.clearResumeWatchdog();
      this.resumeWatchdog = window.setTimeout(() => {
        this.resumeWatchdog = null;
        if (this.stopped || this.paused || this.boundarySerial !== serialBeforeResume) {
          return;
        }

        console.warn(
          "Edge Natural TTS resume made no progress; restarting from the current word."
        );
        this.speakCurrentPosition();
      }, 1200);
    }

    clearResumeWatchdog() {
      if (this.resumeWatchdog !== null) {
        window.clearTimeout(this.resumeWatchdog);
        this.resumeWatchdog = null;
      }
    }

    rebuildModel() {
      this.disconnectModelMutationObserver();
      const startedAt = performance.now();
      this.model = buildReadableModel(document);
      this.modelStale = false;
      console.debug(
        `Edge Natural TTS modeled ${this.model.blocks.length} ${this.model.profile} blocks in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
      this.observeModelMutations();
    }

    applySettings() {
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      this.highlighter.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setRate(this.settings.rate);
      this.toolbar.setBatchChars(this.settings.minBatchChars);
      this.toolbar.setSentencePause(this.settings.sentencePauseMs);
      this.toolbar.setHighlightColors(this.settings.wordColor, this.settings.sentenceColor);
      this.toolbar.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setClickToSeek(this.settings.clickToSeek);
      this.toolbar.setMinimized(this.settings.minimized);
      this.toolbar.setPosition(this.settings.toolbarPosition);
      this.syncPageClickListener();
    }

    refreshVoices() {
      const documentLanguage = document.documentElement.lang || navigator.language;
      const savedVoiceName = this.settings.voiceName;
      const savedVoiceSource = String(this.settings.voiceSource || "");
      const savedVoiceId = String(this.settings.voiceId || "");
      const voices = this.speech.chooseVoices(documentLanguage, savedVoiceName);
      this.voices = voices;

      const savedVoice = voices.find((voice) => {
        if (savedVoiceSource === "linux-piper") {
          return (
            isLinuxPiperVoice(voice) &&
            (!savedVoiceId || voice.voiceId === savedVoiceId)
          );
        }
        if (savedVoiceSource) {
          return (
            voiceSourceKey(voice) === savedVoiceSource &&
            voice.name === savedVoiceName
          );
        }
        return voice.name === savedVoiceName;
      });

      const defaultRyan = voices.find(
        (voice) =>
          isLinuxPiperVoice(voice) &&
          voice.voiceId === DEFAULT_LINUX_PIPER_VOICE_ID
      );

      const prefersPiper =
        savedVoiceSource === "linux-piper" ||
        (!savedVoiceSource && savedVoiceName === "Ryan High");

      this.selectedVoice = prefersPiper
        ? (
            savedVoice ||
            defaultRyan ||
            voices.find(isLinuxPiperVoice) ||
            null
          )
        : (
            savedVoice ||
            defaultRyan ||
            voices.find(isLinuxPiperVoice) ||
            voices.find(isWinNaturalVoice) ||
            voices.find(isNaturalVoice) ||
            voices[0] ||
            null
          );

      // A Piper preference is sticky. Passive catalog refresh may temporarily
      // leave no selected voice, but it must never silently substitute Online.
      const toolbarVoiceName =
        this.selectedVoice?.name || savedVoiceName || "";
      this.toolbar.setVoices(voices, toolbarVoiceName);
      this.toolbar.setRate(this.settings.rate);
    }

    prefersLinuxPiper() {
      return (
        this.settings.voiceSource === "linux-piper" ||
        (!this.settings.voiceSource && this.settings.voiceName === "Ryan High")
      );
    }

    async ensurePreferredVoiceAvailable() {
      this.refreshVoices();
      if (!this.prefersLinuxPiper() || isLinuxPiperVoice(this.selectedVoice)) {
        return Boolean(this.selectedVoice);
      }

      this.toolbar?.setStatus?.("Loading Piper voice...");
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      await (
        this.speech?.refreshLinuxPiperVoices?.() ||
        Promise.resolve()
      );
      this.refreshVoices();
      return isLinuxPiperVoice(this.selectedVoice);
    }

    speakCurrentPosition() {
      this.clearResumeWatchdog();

      if (!this.selectedVoice && this.prefersLinuxPiper()) {
        this.paused = true;
        this.toolbar?.setPaused?.(true);
        this.toolbar?.setStatus?.(
          "Paused — Piper voice unavailable; refusing Online fallback"
        );
        this.releaseAudioOwnership();
        return;
      }

      if (!this.audioOwner) {
        if (!this.stopped) {
          this.paused = true;
          this.toolbar?.setPaused?.(true);
          this.toolbar?.setStatus?.("Paused — another tab is playing");
        }
        return;
      }

      const block = this.model?.blocks[this.currentBlockIndex];
      if (!block) {
        this.finishDocument();
        return;
      }

      const currentSegment = block.segments?.[this.currentSegmentIndex];
      if (currentSegment && !segmentIsLive?.(currentSegment)) {
        this.markModelStale("speech-start-target-stale");
        return;
      }

      const batch = createSpeechBatch(
        this.model.blocks,
        this.currentBlockIndex,
        this.currentSegmentIndex,
        {
          minChars: this.settings.minBatchChars,
          maxChars: Math.max(MAX_BATCH_CHARS, this.settings.minBatchChars * 2)
        }
      );
      if (!batch) {
        this.finishDocument();
        return;
      }

      this.activeBatchEndBlockIndex = batch.endBlockIndex;
      const utteranceTargetChars = Math.min(
        MAX_BATCH_CHARS,
        Math.max(this.settings.minBatchChars, batch.charLength)
      );

      this.stopped = false;
      this.paused = false;
      this.toolbar.setPaused(false);
      this.toolbar.setStatus("Starting speech…");
      this.lastSpeakRequestedAt = performance.now();
      this.speech.speak({ segments: batch.segments }, 0, {
        rate: this.settings.rate,
        voice: this.selectedVoice,
        sentencePauseMs: this.settings.sentencePauseMs,
        chunkOptions: {
          firstChunkMaxChars: utteranceTargetChars,
          maxChars: Math.max(1800, utteranceTargetChars),
          hardLimitFactor: 1.35
        }
      });
    }

    handleSpeechStart(latencyMs) {
      if (this.stopped || this.paused || !this.audioOwner) return;
      this.sessionSpeechStarted = true;
      this.clearResumeWatchdog();
      this.toolbar.setStatus("Reading");
      console.debug(`Edge Natural TTS first audio started in ${Math.round(latencyMs)}ms`);
    }

    handleBoundary(segment) {
      if (this.stopped || this.paused || !this.audioOwner) return;
      this.boundarySerial += 1;
      this.clearResumeWatchdog();
      this.currentBlockIndex = segment.blockIndex;
      this.currentSegmentIndex = segment.segmentIndex;
      const block = this.model?.blocks[segment.blockIndex];
      const highlighted = this.highlighter.highlight(block, segment);
      if (highlighted !== true) {
        this.markModelStale("boundary-highlight-target-stale");
        return;
      }
      if (!this.paused && !this.stopped) {
        this.toolbar.setStatus("Reading");
      }
    }

    handleBlockEnd() {
      if (this.stopped || this.paused || !this.audioOwner || !this.model) return;

      const completedEndBlock =
        this.activeBatchEndBlockIndex >= 0
          ? this.activeBatchEndBlockIndex
          : this.currentBlockIndex;
      this.activeBatchEndBlockIndex = -1;
      this.currentBlockIndex = completedEndBlock + 1;
      this.currentSegmentIndex = 0;
      if (this.currentBlockIndex >= this.model.blocks.length) {
        this.finishDocument();
        return;
      }

      this.speakCurrentPosition();
    }

    finishDocument() {
      this.clearResumeWatchdog();
      this.disconnectModelMutationObserver();
      this.activeBatchEndBlockIndex = -1;
      this.stopped = true;
      this.discardLocalSpeechState();
      this.releaseAudioOwnership();
      this.highlighter.clear();
      this.toolbar.setStatus("Finished");
      this.toolbar.setStopped();
    }

    handleError(error) {
      this.clearResumeWatchdog();
      this.activeBatchEndBlockIndex = -1;
      const errorMessage = error?.message || String(error);
      console.error("Edge Natural TTS", error);

      const shouldRetryInitialPiper =
        isLinuxPiperVoice(this.selectedVoice) &&
        !this.sessionSpeechStarted &&
        this.initialPiperRetryRemaining > 0 &&
        this.enabled &&
        !this.quitRequested &&
        this.audioOwner;

      if (shouldRetryInitialPiper) {
        this.initialPiperRetryRemaining -= 1;
        try {
          this.discardLocalSpeechState();
        } catch (cancelError) {
          console.warn("Could not retire failed Piper startup transport.", cancelError);
        }

        this.stopped = false;
        this.paused = false;
        this.toolbar.setStatus(
          `Piper startup failed: ${errorMessage} · retrying once…`
        );

        window.setTimeout(() => {
          if (
            this.enabled &&
            !this.quitRequested &&
            !this.stopped &&
            !this.paused &&
            this.audioOwner &&
            !this.sessionSpeechStarted
          ) {
            this.speakCurrentPosition();
          }
        }, 300);
        return;
      }

      this.stopped = true;
      this.discardLocalSpeechState();
      this.releaseAudioOwnership();
      this.highlighter.clear();

      // setStopped() owns the button state but also writes "Stopped". Apply
      // the real error afterwards so backend failures are never hidden behind
      // a generic transport label.
      this.toolbar.setStopped();
      this.toolbar.setStatus(`Error: ${errorMessage}`);
    }

    handlePlaybackBlocked(error) {
      this.clearResumeWatchdog();
      console.info(
        "Edge Natural TTS initial media playback is waiting for a page gesture.",
        error
      );

      // Chromium may reject the first asynchronously-created Piper WAV because
      // the extension-action user activation has expired by the time CPU
      // synthesis completes. This is recoverable: keep the prepared WAV and
      // cursor intact so the toolbar's Resume click can play it directly.
      this.stopped = false;
      this.paused = true;
      this.releaseAudioOwnership();
      this.toolbar.setPaused(true);
      this.toolbar.setStatus("Ready — press Resume");
    }

    async handlePageClick(event) {
      if (
        !this.enabled ||
        !this.settings.clickToSeek ||
        event.target?.closest?.("[data-edge-tts-ui]") ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const caret = this.caretFromPoint(event.clientX, event.clientY);
      if (!caret?.node || !(caret.node instanceof Text)) {
        return;
      }

      const block = this.model?.nodeToBlock.get(caret.node);
      if (!block) {
        return;
      }

      const segment = findSegmentInNode(block, caret.node, caret.offset);
      if (!segment) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const lifecycle = ++this.lifecycleSerial;
      this.clearResumeWatchdog();

      // A click-to-seek is a hard transport replacement, not a second request
      // layered on top of the current sentence/prefetch pipeline.
      try {
        this.discardLocalSpeechState();
      } catch (error) {
        console.warn("Edge Natural TTS could not replace speech for click-to-seek.", error);
      }

      this.currentBlockIndex = block.index;
      this.currentSegmentIndex = segment.segmentIndex;
      this.activeBatchEndBlockIndex = -1;
      this.stopped = false;
      this.paused = false;
      this.highlighter.clear();

      if (this.audioOwner) {
        this.speakCurrentPosition();
        return;
      }

      const granted = await this.claimAudioOwnership();
      if (
        lifecycle !== this.lifecycleSerial ||
        this.stopped ||
        this.paused ||
        this.quitRequested
      ) {
        if (granted) this.releaseAudioOwnership();
        return;
      }

      if (granted) {
        this.speakCurrentPosition();
      } else {
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus("Paused — audio unavailable");
      }
    }

    caretFromPoint(x, y) {
      if (typeof document.caretPositionFromPoint === "function") {
        const position = document.caretPositionFromPoint(x, y);
        if (position) {
          return { node: position.offsetNode, offset: position.offset };
        }
      }

      if (typeof document.caretRangeFromPoint === "function") {
        const range = document.caretRangeFromPoint(x, y);
        if (range) {
          return { node: range.startContainer, offset: range.startOffset };
        }
      }

      return null;
    }

    async changeVoice(name) {
      const voice = this.voices.find((candidate) => candidate.name === name);
      if (!voice) return;
      this.selectedVoice = voice;
      this.settings.voiceName = voice.name;
      this.settings.voiceSource = voiceSourceKey(voice);
      this.settings.voiceId = isLinuxPiperVoice(voice)
        ? String(voice.voiceId || "")
        : "";
      await this.saveSettings();
      if (!this.stopped && !this.paused && this.audioOwner) {
        this.speakCurrentPosition();
      }
    }

    async changeRate(rate) {
      this.settings.rate = rate;
      await this.saveSettings();
      if (!this.stopped && !this.paused && this.audioOwner) {
        this.speakCurrentPosition();
      }
    }

    async changeBatchChars(chars) {
      this.settings.minBatchChars = normalizeBatchChars(chars);
      this.toolbar.setBatchChars(this.settings.minBatchChars);
      await this.saveSettings();
      if (!this.stopped && !this.paused && this.audioOwner) {
        this.speakCurrentPosition();
      }
    }

    async changeSentencePause(ms) {
      this.settings.sentencePauseMs = normalizeSentencePauseMs(ms);
      this.speech?.setSentencePauseMs?.(this.settings.sentencePauseMs);
      this.toolbar.setSentencePause(this.settings.sentencePauseMs);
      await this.saveSettings();
    }

    async changeWordColor(color) {
      this.settings.wordColor = normalizeColor(color, DEFAULT_WORD_COLOR);
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      await this.saveSettings();
    }

    async changeSentenceColor(color) {
      this.settings.sentenceColor = normalizeColor(color, DEFAULT_SENTENCE_COLOR);
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      await this.saveSettings();
    }

    async changeAutoScroll(enabled) {
      this.settings.autoScroll = Boolean(enabled);
      this.highlighter.setAutoScroll(this.settings.autoScroll);
      await this.saveSettings();
    }

    async changeClickToSeek(enabled) {
      this.settings.clickToSeek = Boolean(enabled);
      this.syncPageClickListener();
      await this.saveSettings();
    }

    async changeMinimized(minimized) {
      this.settings.minimized = Boolean(minimized);
      await this.saveSettings();
    }

    async changeToolbarPosition(position) {
      this.settings.toolbarPosition = position;
      await this.saveSettings();
    }

    openPronunciationOptions() {
      try {
        void chrome.runtime.sendMessage({
          type: "EDGE_TTS_OPEN_PRONUNCIATION_OPTIONS"
        });
      } catch (error) {
        console.warn("Could not open pronunciation options.", error);
      }
    }

    async loadSettings() {
      try {
        const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
        const toolbarPosition = stored.toolbarPosition;
        const storedSettingsVersion = Number(stored.settingsVersion || 0);
        const requiresSafetyMigration = storedSettingsVersion < 2;
        const requiresRyanDefaultMigration = storedSettingsVersion < 3;
        const requiresVoiceIdentityMigration = storedSettingsVersion < 4;
        const migratedVoiceName = requiresRyanDefaultMigration
          ? "Ryan High"
          : (stored.voiceName || "Ryan High");
        const migratedVoiceSource = requiresVoiceIdentityMigration
          ? (migratedVoiceName === "Ryan High" ? "linux-piper" : "")
          : String(stored.voiceSource || "");
        const migratedVoiceId = requiresVoiceIdentityMigration
          ? (migratedVoiceSource === "linux-piper"
              ? DEFAULT_LINUX_PIPER_VOICE_ID
              : "")
          : String(stored.voiceId || "");
        this.settings = {
          settingsVersion: DEFAULT_SETTINGS.settingsVersion,
          rate: Number(stored.rate) || DEFAULT_SETTINGS.rate,
          voiceName: migratedVoiceName,
          voiceSource: migratedVoiceSource,
          voiceId: migratedVoiceId,
          minBatchChars: normalizeBatchChars(stored.minBatchChars),
          sentencePauseMs: normalizeSentencePauseMs(stored.sentencePauseMs),
          wordColor: normalizeColor(stored.wordColor, DEFAULT_SETTINGS.wordColor),
          sentenceColor: normalizeColor(stored.sentenceColor, DEFAULT_SETTINGS.sentenceColor),
          autoScroll: stored.autoScroll !== false,
          clickToSeek: requiresSafetyMigration ? false : stored.clickToSeek === true,
          minimized: stored.minimized === true,
          toolbarPosition:
            toolbarPosition &&
            Number.isFinite(Number(toolbarPosition.x)) &&
            Number.isFinite(Number(toolbarPosition.y))
              ? { x: Number(toolbarPosition.x), y: Number(toolbarPosition.y) }
              : null
        };

        if (
          requiresSafetyMigration ||
          requiresRyanDefaultMigration ||
          requiresVoiceIdentityMigration
        ) {
          await chrome.storage.local.set({
            settingsVersion: DEFAULT_SETTINGS.settingsVersion,
            clickToSeek: requiresSafetyMigration ? false : this.settings.clickToSeek,
            voiceName: this.settings.voiceName,
            voiceSource: this.settings.voiceSource,
            voiceId: this.settings.voiceId
          });
        }
      } catch (error) {
        console.warn("Could not load Edge Natural TTS settings.", error);
      }
    }

    async saveSettings() {
      try {
        await chrome.storage.local.set(this.settings);
      } catch (error) {
        console.warn("Could not save Edge Natural TTS settings.", error);
      }
    }
  }

  extension.Reader = {
    ReaderApp,
    isEditableTarget,
    normalizeBatchChars,
    normalizeSentencePauseMs
  };
})(globalThis);
