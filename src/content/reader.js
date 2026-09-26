(function attachReader(root) {
  const extension = root.EdgeTtsExtension;
  const { buildReadableModel, findSegmentInNode, firstBlockNearViewport } = extension.TextModel;
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

  const MIN_BATCH_CHARS = 400;
  const MAX_BATCH_CHARS = 2400;
  const DEFAULT_BATCH_CHARS = 1200;

  const DEFAULT_SETTINGS = {
    settingsVersion: 2,
    rate: 1,
    voiceName: "",
    minBatchChars: DEFAULT_BATCH_CHARS,
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
        }
      });
      this.toolbar = new Toolbar({
        onPlayPause: () => this.playPause(),
        onStop: () => this.stop(),
        onQuit: () => this.quit(),
        onRefresh: () => this.refreshText(),
        onVoice: (name) => this.changeVoice(name),
        onRate: (rate) => this.changeRate(rate),
        onBatchChars: (chars) => this.changeBatchChars(chars),
        onWordColor: (color) => this.changeWordColor(color),
        onSentenceColor: (color) => this.changeSentenceColor(color),
        onAutoScroll: (enabled) => this.changeAutoScroll(enabled),
        onClickToSeek: (enabled) => this.changeClickToSeek(enabled),
        onMinimized: (minimized) => this.changeMinimized(minimized),
        onPosition: (position) => this.changeToolbarPosition(position)
      });

      this.boundClick = (event) => this.handlePageClick(event);
      this.unsubscribeVoiceChanges = this.speech.onVoicesChanged(() => {
        if (this.enabled) {
          this.refreshVoices();
        }
      });
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
      this.rebuildModel();

      // Linux development branch: resolve the app-private Piper catalog before
      // making the initial voice choice, so an installed local voice does not
      // lose a race to Edge's online catalog during startup.
      await this.speech.refreshLinuxPiperVoices?.();
      if (
        lifecycle !== this.lifecycleSerial ||
        !this.enabled ||
        this.stopped ||
        this.paused ||
        this.quitRequested
      ) {
        return;
      }
      this.refreshVoices();
      if (!this.voices.some((voice) =>
        isNaturalVoice(voice) || isWinNaturalVoice(voice) || isLinuxPiperVoice(voice)
      )) {
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
        this.refreshVoices();
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
      this.clearResumeWatchdog();
      this.activeBatchEndBlockIndex = -1;
      this.stopped = true;
      this.paused = false;

      // Commit user-visible state before touching any transport. Stop must work
      // even if a native helper is hung or has disappeared.
      this.toolbar.setStopped();
      this.highlighter.clear();
      this.releaseAudioOwnership();

      try {
        this.discardLocalSpeechState();
      } catch (error) {
        console.warn("Edge Natural TTS transport failed while stopping.", error);
      }
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
        this.paused = false;
        this.toolbar.setPaused(false);
        this.toolbar.setStatus("Resuming…");
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
      } else {
        // Pause is local state + transport cancellation. Commit the local state
        // first so a slow or broken native helper can never hold the UI hostage.
        this.clearResumeWatchdog();
        this.paused = true;
        this.toolbar.setPaused(true);
        this.toolbar.setStatus("Paused");
        this.releaseAudioOwnership();
        try {
          this.discardLocalSpeechState();
        } catch (error) {
          console.warn("Edge Natural TTS transport failed while pausing.", error);
        }
      }
    }

    refreshText() {
      const wasReading = !this.stopped && !this.paused && this.audioOwner;
      const wasPaused = !this.stopped && this.paused;
      this.clearResumeWatchdog();
      this.activeBatchEndBlockIndex = -1;
      this.discardLocalSpeechState();
      this.highlighter.clear();
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
      const startedAt = performance.now();
      this.model = buildReadableModel(document);
      console.debug(
        `Edge Natural TTS modeled ${this.model.blocks.length} ${this.model.profile} blocks in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
    }

    applySettings() {
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      this.highlighter.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setRate(this.settings.rate);
      this.toolbar.setBatchChars(this.settings.minBatchChars);
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
      const voices = this.speech.chooseVoices(documentLanguage, savedVoiceName);
      this.voices = voices;

      const savedVoice = voices.find((voice) => voice.name === savedVoiceName);
      const defaultRyan = voices.find(
        (voice) =>
          isLinuxPiperVoice(voice) &&
          voice.voiceId === DEFAULT_LINUX_PIPER_VOICE_ID
      );

      this.selectedVoice =
        savedVoice ||
        defaultRyan ||
        voices.find(isLinuxPiperVoice) ||
        voices.find(isWinNaturalVoice) ||
        voices.find(isNaturalVoice) ||
        voices[0] ||
        null;

      // Passive catalog refresh must never erase a user's saved choice. When
      // there is no saved choice yet, Ryan High is the Linux default.
      const toolbarVoiceName =
        savedVoiceName || this.selectedVoice?.name || "";
      this.toolbar.setVoices(voices, toolbarVoiceName);
      this.toolbar.setRate(this.settings.rate);
    }

    speakCurrentPosition() {
      this.clearResumeWatchdog();
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
        chunkOptions: {
          firstChunkMaxChars: utteranceTargetChars,
          maxChars: Math.max(1800, utteranceTargetChars),
          hardLimitFactor: 1.35
        }
      });
    }

    handleSpeechStart(latencyMs) {
      if (this.stopped || this.paused || !this.audioOwner) return;
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
      this.highlighter.highlight(block, segment);
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
      console.error("Edge Natural TTS", error);
      this.stopped = true;
      this.discardLocalSpeechState();
      this.releaseAudioOwnership();
      this.highlighter.clear();
      this.toolbar.setStatus(error.message);
      this.toolbar.setStopped();
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

      this.currentBlockIndex = block.index;
      this.currentSegmentIndex = segment.segmentIndex;
      this.activeBatchEndBlockIndex = -1;
      this.stopped = false;
      this.paused = false;
      if (await this.claimAudioOwnership()) {
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

    async loadSettings() {
      try {
        const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
        const toolbarPosition = stored.toolbarPosition;
        const requiresSafetyMigration = Number(stored.settingsVersion || 0) < 2;
        this.settings = {
          settingsVersion: DEFAULT_SETTINGS.settingsVersion,
          rate: Number(stored.rate) || DEFAULT_SETTINGS.rate,
          voiceName: stored.voiceName || "",
          minBatchChars: normalizeBatchChars(stored.minBatchChars),
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

        if (requiresSafetyMigration) {
          await chrome.storage.local.set({
            settingsVersion: DEFAULT_SETTINGS.settingsVersion,
            clickToSeek: false
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

  extension.Reader = { ReaderApp, isEditableTarget, normalizeBatchChars };
})(globalThis);
