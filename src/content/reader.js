(function attachReader(root) {
  const extension = root.EdgeTtsExtension;
  const { buildReadableModel, findSegmentInNode, firstBlockNearViewport } = extension.TextModel;
  const {
    DEFAULT_SENTENCE_COLOR,
    DEFAULT_WORD_COLOR,
    Highlighter,
    normalizeColor
  } = extension.Highlighter;
  const { SpeechEngine, isNaturalVoice } = extension.SpeechEngine;
  const { AzureSpeechEngine } = extension.AzureSpeechEngine;
  const { Toolbar } = extension.Toolbar;

  const DEFAULT_SETTINGS = {
    rate: 1,
    voiceId: "",
    voiceName: "",
    wordColor: DEFAULT_WORD_COLOR,
    sentenceColor: DEFAULT_SENTENCE_COLOR,
    autoScroll: true,
    clickToSeek: true,
    minimized: false,
    toolbarPosition: null,
    azureRegion: "",
    azureKey: ""
  };

  function browserVoiceId(voice) {
    const identity = voice.voiceURI || voice.name || "voice";
    return `browser:${identity}:${voice.lang || ""}`;
  }

  function describeBrowserVoice(voice) {
    const online = isNaturalVoice(voice);
    return {
      id: browserVoiceId(voice),
      name: voice.name || "Unnamed voice",
      lang: voice.lang || "",
      source: online ? "edge-online" : "local",
      provider: online ? "Edge Online" : "Local",
      nativeVoice: voice
    };
  }

  class ReaderApp {
    constructor() {
      this.model = null;
      this.currentBlockIndex = -1;
      this.currentSegmentIndex = 0;
      this.enabled = false;
      this.stopped = true;
      this.paused = false;
      this.settings = { ...DEFAULT_SETTINGS };
      this.browserVoices = [];
      this.azureVoices = [];
      this.voices = [];
      this.selectedVoice = null;
      this.lastSpeakRequestedAt = 0;
      this.boundarySerial = 0;
      this.resumeWatchdog = null;
      this.pageClickListening = false;
      this.highlighter = new Highlighter();

      const callbacks = {
        onBoundary: (segment) => this.handleBoundary(segment),
        onEnd: () => this.handleBlockEnd(),
        onError: (error) => this.handleError(error),
        onStart: (_segment, latencyMs) => this.handleSpeechStart(latencyMs)
      };
      this.speech = new SpeechEngine(callbacks);
      this.azure = new AzureSpeechEngine(callbacks);
      this.activeEngine = this.speech;

      this.toolbar = new Toolbar({
        onPlayPause: () => this.playPause(),
        onStop: () => this.stop(),
        onVoice: (id) => this.changeVoice(id),
        onRate: (rate) => this.changeRate(rate),
        onWordColor: (color) => this.changeWordColor(color),
        onSentenceColor: (color) => this.changeSentenceColor(color),
        onAutoScroll: (enabled) => this.changeAutoScroll(enabled),
        onClickToSeek: (enabled) => this.changeClickToSeek(enabled),
        onAzureConnect: (configuration) => this.changeAzureConfig(configuration),
        onAzureClear: () => this.clearAzureConfig(),
        onMinimized: (minimized) => this.changeMinimized(minimized),
        onPosition: (position) => this.changeToolbarPosition(position)
      });

      this.boundClick = (event) => this.handlePageClick(event);
      this.boundKeydown = (event) => this.handleKeydown(event);
      this.unsubscribeVoiceChanges = this.speech.onVoicesChanged(() => {
        if (this.enabled) {
          this.refreshBrowserVoices();
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
      this.enabled = true;
      this.stopped = false;
      this.paused = false;
      this.toolbar.mount();
      this.toolbar.setStatus("Starting…");
      document.addEventListener("keydown", this.boundKeydown, true);

      const settingsPromise = this.loadSettings();
      this.rebuildModel();
      await settingsPromise;
      this.applySettings();

      this.refreshBrowserVoices();
      if (this.browserVoices.length === 0) {
        this.toolbar.setStatus("Loading local voices…");
        await this.speech.waitForVoices(350, (voices) => voices.length > 0);
        this.refreshBrowserVoices();
      }

      if (this.azure.isAvailable() && this.azure.hasCredentials()) {
        void this.refreshAzureVoices({ restartIfSelectionChanges: true });
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
        `Microsoft TTS startup prepared in ${Math.round(performance.now() - openStartedAt)}ms`
      );
      this.speakCurrentPosition();
    }

    close() {
      this.stop();
      this.enabled = false;
      this.syncPageClickListener();
      document.removeEventListener("keydown", this.boundKeydown, true);
      this.toolbar.hide();
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
      this.clearResumeWatchdog();
      this.stopped = true;
      this.paused = false;
      this.speech.cancel();
      this.azure.cancel();
      this.highlighter.clear();
      this.toolbar.setStopped();
    }

    playPause() {
      if (this.stopped) {
        this.stopped = false;
        this.paused = false;
        if (this.currentBlockIndex < 0) {
          this.rebuildModel();
          const startBlock = firstBlockNearViewport(this.model.blocks);
          if (!startBlock) {
            this.toolbar.setStatus("No readable text found");
            return;
          }
          this.currentBlockIndex = startBlock.index;
          this.currentSegmentIndex = 0;
        }
        this.speakCurrentPosition();
        return;
      }

      if (this.paused) {
        const serialBeforeResume = this.boundarySerial;
        this.activeEngine.resume();
        this.paused = false;
        this.toolbar.setPaused(false);
        this.toolbar.setStatus("Resuming…");
        this.startResumeWatchdog(serialBeforeResume);
      } else {
        this.clearResumeWatchdog();
        this.activeEngine.pause();
        this.paused = true;
        this.toolbar.setPaused(true);
      }
    }

    startResumeWatchdog(serialBeforeResume) {
      this.clearResumeWatchdog();
      this.resumeWatchdog = window.setTimeout(() => {
        this.resumeWatchdog = null;
        if (this.stopped || this.paused || this.boundarySerial !== serialBeforeResume) {
          return;
        }

        console.warn("Microsoft TTS resume made no progress; restarting from the current word.");
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
        `Microsoft TTS modeled ${this.model.blocks.length} blocks in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
    }

    applySettings() {
      this.azure.configure({ key: this.settings.azureKey, region: this.settings.azureRegion });
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      this.highlighter.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setRate(this.settings.rate);
      this.toolbar.setHighlightColors(this.settings.wordColor, this.settings.sentenceColor);
      this.toolbar.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setClickToSeek(this.settings.clickToSeek);
      this.toolbar.setAzureConfig({
        available: this.azure.isAvailable(),
        region: this.settings.azureRegion,
        hasKey: Boolean(this.settings.azureKey),
        status: this.azure.isAvailable()
          ? this.settings.azureKey && this.settings.azureRegion
            ? "Azure configured; loading voices…"
            : "Enter a Speech key and region to add Azure voices."
          : "Azure SDK is available in the Firefox build."
      });
      this.toolbar.setMinimized(this.settings.minimized);
      this.toolbar.setPosition(this.settings.toolbarPosition);
      this.syncPageClickListener();
    }

    refreshBrowserVoices() {
      const documentLanguage = document.documentElement.lang || navigator.language;
      const nativeVoices = this.speech.chooseVoices(documentLanguage, this.settings.voiceName);
      this.browserVoices = nativeVoices.map(describeBrowserVoice);
      this.rebuildVoiceCatalog();
    }

    rebuildVoiceCatalog() {
      const previousSelectedId = this.selectedVoice?.id || "";
      this.voices = [...this.browserVoices, ...this.azureVoices];

      const savedById = this.settings.voiceId
        ? this.voices.find((voice) => voice.id === this.settings.voiceId)
        : null;
      const migratedByName = !this.settings.voiceId && this.settings.voiceName
        ? this.voices.find((voice) => voice.name === this.settings.voiceName)
        : null;
      const stillSelected = this.voices.find((voice) => voice.id === previousSelectedId);
      const browserNatural = this.browserVoices.find((voice) => voice.source === "edge-online");

      this.selectedVoice =
        savedById ||
        migratedByName ||
        stillSelected ||
        browserNatural ||
        this.browserVoices[0] ||
        this.azureVoices[0] ||
        null;

      if (!this.settings.voiceId && this.selectedVoice) {
        this.settings.voiceId = this.selectedVoice.id;
      }
      if (this.selectedVoice) {
        this.settings.voiceName = this.selectedVoice.name;
      }

      this.toolbar.setVoices(this.voices, this.selectedVoice?.id || this.settings.voiceId);
      this.toolbar.setRate(this.settings.rate);
    }

    async refreshAzureVoices({ restartIfSelectionChanges = false } = {}) {
      if (!this.azure.isAvailable()) {
        this.azureVoices = [];
        this.rebuildVoiceCatalog();
        this.toolbar.setAzureStatus("Azure SDK is not bundled in this build.");
        return;
      }
      if (!this.azure.hasCredentials()) {
        this.azureVoices = [];
        this.rebuildVoiceCatalog();
        this.toolbar.setAzureStatus("Enter a Speech key and region to add Azure voices.");
        return;
      }

      const before = this.selectedVoice?.id || "";
      this.toolbar.setAzureStatus("Loading Azure voices…");
      try {
        this.azureVoices = await this.azure.getVoices();
        this.rebuildVoiceCatalog();
        this.toolbar.setAzureStatus(`${this.azureVoices.length} Azure voices loaded.`);

        if (
          restartIfSelectionChanges &&
          !this.stopped &&
          before &&
          this.selectedVoice?.id &&
          this.selectedVoice.id !== before
        ) {
          this.speakCurrentPosition();
        }
      } catch (error) {
        console.error("Microsoft TTS Azure voice loading failed", error);
        this.azureVoices = [];
        this.rebuildVoiceCatalog();
        this.toolbar.setAzureStatus(`Azure error: ${error.message}`);
      }
    }

    speakCurrentPosition() {
      this.clearResumeWatchdog();
      const block = this.model?.blocks[this.currentBlockIndex];
      if (!block) {
        this.finishDocument();
        return;
      }
      if (!this.selectedVoice) {
        this.handleError(new Error("No TTS voices are available."));
        return;
      }

      this.speech.cancel();
      this.azure.cancel();
      this.activeEngine = this.selectedVoice.source === "azure" ? this.azure : this.speech;

      this.stopped = false;
      this.paused = false;
      this.toolbar.setPaused(false);
      this.toolbar.setStatus("Starting speech…");
      this.lastSpeakRequestedAt = performance.now();

      if (this.selectedVoice.source === "azure") {
        this.azure.speak(block, this.currentSegmentIndex, {
          rate: this.settings.rate,
          voice: this.selectedVoice
        });
      } else {
        this.speech.speak(block, this.currentSegmentIndex, {
          rate: this.settings.rate,
          voice: this.selectedVoice.nativeVoice
        });
      }
    }

    handleSpeechStart(latencyMs) {
      if (this.stopped) return;
      this.clearResumeWatchdog();
      this.toolbar.setStatus("Reading");
      console.debug(`Microsoft TTS first audio started in ${Math.round(latencyMs)}ms`);
    }

    handleBoundary(segment) {
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
      if (this.stopped || !this.model) return;

      this.currentBlockIndex += 1;
      this.currentSegmentIndex = 0;
      if (this.currentBlockIndex >= this.model.blocks.length) {
        this.finishDocument();
        return;
      }

      this.speakCurrentPosition();
    }

    finishDocument() {
      this.clearResumeWatchdog();
      this.stopped = true;
      this.speech.cancel();
      this.azure.cancel();
      this.highlighter.clear();
      this.toolbar.setStatus("Finished");
      this.toolbar.setStopped();
    }

    handleError(error) {
      this.clearResumeWatchdog();
      console.error("Microsoft TTS", error);
      this.stopped = true;
      this.speech.cancel();
      this.azure.cancel();
      this.highlighter.clear();
      this.toolbar.setStatus(error.message);
      this.toolbar.setStopped();
    }

    handlePageClick(event) {
      if (
        !this.enabled ||
        !this.settings.clickToSeek ||
        event.target?.closest?.("[data-edge-tts-ui]")
      ) {
        return;
      }

      const caret = this.caretFromPoint(event.clientX, event.clientY);
      if (!caret?.node || !(caret.node instanceof Text)) {
        return;
      }

      let block = this.model?.nodeToBlock.get(caret.node);
      if (!block) {
        this.rebuildModel();
        block = this.model.nodeToBlock.get(caret.node);
      }
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
      this.stopped = false;
      this.paused = false;
      this.speakCurrentPosition();
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

    handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    }

    async changeVoice(id) {
      const voice = this.voices.find((candidate) => candidate.id === id);
      if (!voice) return;
      this.selectedVoice = voice;
      this.settings.voiceId = voice.id;
      this.settings.voiceName = voice.name;
      this.toolbar.setVoices(this.voices, voice.id);
      await this.saveSettings();
      if (!this.stopped) {
        this.speakCurrentPosition();
      }
    }

    async changeRate(rate) {
      this.settings.rate = rate;
      await this.saveSettings();
      if (!this.stopped) {
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

    async changeAzureConfig({ key, region }) {
      const nextRegion = String(region || "").trim();
      const enteredKey = String(key || "").trim();
      if (nextRegion) this.settings.azureRegion = nextRegion;
      if (enteredKey) this.settings.azureKey = enteredKey;

      this.azure.configure({ key: this.settings.azureKey, region: this.settings.azureRegion });
      this.toolbar.setAzureConfig({
        available: this.azure.isAvailable(),
        region: this.settings.azureRegion,
        hasKey: Boolean(this.settings.azureKey),
        status: "Loading Azure voices…"
      });
      await this.saveSettings();
      await this.refreshAzureVoices({ restartIfSelectionChanges: true });
    }

    async clearAzureConfig() {
      const wasUsingAzure = this.selectedVoice?.source === "azure";
      this.settings.azureKey = "";
      this.azure.configure({ key: "", region: this.settings.azureRegion });
      this.azureVoices = [];
      if (this.settings.voiceId.startsWith("azure:")) {
        this.settings.voiceId = "";
      }
      this.rebuildVoiceCatalog();
      this.toolbar.setAzureConfig({
        available: this.azure.isAvailable(),
        region: this.settings.azureRegion,
        hasKey: false,
        status: "Azure key removed. Local voices remain available."
      });
      await this.saveSettings();
      if (wasUsingAzure && !this.stopped) {
        this.azure.cancel();
        if (this.selectedVoice) {
          this.speakCurrentPosition();
        } else {
          this.stop();
        }
      }
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
        const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
        const toolbarPosition = stored.toolbarPosition;
        this.settings = {
          rate: Number(stored.rate) || DEFAULT_SETTINGS.rate,
          voiceId: stored.voiceId || "",
          voiceName: stored.voiceName || "",
          wordColor: normalizeColor(stored.wordColor, DEFAULT_SETTINGS.wordColor),
          sentenceColor: normalizeColor(stored.sentenceColor, DEFAULT_SETTINGS.sentenceColor),
          autoScroll: stored.autoScroll !== false,
          clickToSeek: stored.clickToSeek !== false,
          minimized: stored.minimized === true,
          toolbarPosition:
            toolbarPosition &&
            Number.isFinite(Number(toolbarPosition.x)) &&
            Number.isFinite(Number(toolbarPosition.y))
              ? { x: Number(toolbarPosition.x), y: Number(toolbarPosition.y) }
              : null,
          azureRegion: String(stored.azureRegion || ""),
          azureKey: String(stored.azureKey || "")
        };
      } catch (error) {
        console.warn("Could not load Microsoft TTS settings.", error);
      }
    }

    async saveSettings() {
      try {
        await chrome.storage.local.set(this.settings);
      } catch (error) {
        console.warn("Could not save Microsoft TTS settings.", error);
      }
    }
  }

  extension.Reader = { ReaderApp, browserVoiceId, describeBrowserVoice };
})(globalThis);
