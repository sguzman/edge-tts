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
  const { Toolbar } = extension.Toolbar;

  const DEFAULT_SETTINGS = {
    rate: 1,
    voiceName: "",
    wordColor: DEFAULT_WORD_COLOR,
    sentenceColor: DEFAULT_SENTENCE_COLOR,
    autoScroll: true,
    minimized: false,
    toolbarPosition: null
  };

  class ReaderApp {
    constructor() {
      this.model = null;
      this.currentBlockIndex = -1;
      this.currentSegmentIndex = 0;
      this.enabled = false;
      this.stopped = true;
      this.paused = false;
      this.settings = { ...DEFAULT_SETTINGS };
      this.voices = [];
      this.selectedVoice = null;
      this.lastSpeakRequestedAt = 0;
      this.boundarySerial = 0;
      this.resumeWatchdog = null;
      this.highlighter = new Highlighter();
      this.speech = new SpeechEngine({
        onBoundary: (segment) => this.handleBoundary(segment),
        onEnd: () => this.handleBlockEnd(),
        onError: (error) => this.handleError(error),
        onStart: (_segment, latencyMs) => this.handleSpeechStart(latencyMs)
      });
      this.toolbar = new Toolbar({
        onPlayPause: () => this.playPause(),
        onStop: () => this.stop(),
        onVoice: (name) => this.changeVoice(name),
        onRate: (rate) => this.changeRate(rate),
        onWordColor: (color) => this.changeWordColor(color),
        onSentenceColor: (color) => this.changeSentenceColor(color),
        onAutoScroll: (enabled) => this.changeAutoScroll(enabled),
        onMinimized: (minimized) => this.changeMinimized(minimized),
        onPosition: (position) => this.changeToolbarPosition(position)
      });

      this.boundClick = (event) => this.handlePageClick(event);
      this.boundKeydown = (event) => this.handleKeydown(event);
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
      this.enabled = true;
      this.stopped = false;
      this.paused = false;
      this.toolbar.mount();
      this.toolbar.setStatus("Starting…");
      document.addEventListener("click", this.boundClick, true);
      document.addEventListener("keydown", this.boundKeydown, true);

      const settingsPromise = this.loadSettings();
      this.rebuildModel();
      await settingsPromise;
      this.applySettings();

      this.refreshVoices();
      if (!this.voices.some(isNaturalVoice)) {
        this.toolbar.setStatus("Loading Natural voice…");
        await this.speech.waitForVoices(350, (voices) => voices.some(isNaturalVoice));
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
      this.speakCurrentPosition();
    }

    close() {
      this.stop();
      this.enabled = false;
      document.removeEventListener("click", this.boundClick, true);
      document.removeEventListener("keydown", this.boundKeydown, true);
      this.toolbar.hide();
    }

    stop() {
      this.clearResumeWatchdog();
      this.stopped = true;
      this.paused = false;
      this.speech.cancel();
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
        this.speech.resume();
        this.paused = false;
        this.toolbar.setPaused(false);
        this.toolbar.setStatus("Resuming…");
        this.startResumeWatchdog(serialBeforeResume);
      } else {
        this.clearResumeWatchdog();
        this.speech.pause();
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
        `Edge Natural TTS modeled ${this.model.blocks.length} blocks in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
    }

    applySettings() {
      this.highlighter.setColors(this.settings.wordColor, this.settings.sentenceColor);
      this.highlighter.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setRate(this.settings.rate);
      this.toolbar.setHighlightColors(this.settings.wordColor, this.settings.sentenceColor);
      this.toolbar.setAutoScroll(this.settings.autoScroll);
      this.toolbar.setMinimized(this.settings.minimized);
      this.toolbar.setPosition(this.settings.toolbarPosition);
    }

    refreshVoices() {
      const documentLanguage = document.documentElement.lang || navigator.language;
      const voices = this.speech.chooseVoices(documentLanguage, this.settings.voiceName);
      this.voices = voices;
      this.selectedVoice =
        voices.find((voice) => voice.name === this.settings.voiceName) ||
        voices.find(isNaturalVoice) ||
        voices[0] ||
        null;

      if (this.selectedVoice) {
        this.settings.voiceName = this.selectedVoice.name;
      }

      this.toolbar.setVoices(voices, this.settings.voiceName);
      this.toolbar.setRate(this.settings.rate);
    }

    speakCurrentPosition() {
      this.clearResumeWatchdog();
      const block = this.model?.blocks[this.currentBlockIndex];
      if (!block) {
        this.finishDocument();
        return;
      }

      this.stopped = false;
      this.paused = false;
      this.toolbar.setPaused(false);
      this.toolbar.setStatus("Starting speech…");
      this.lastSpeakRequestedAt = performance.now();
      this.speech.speak(block, this.currentSegmentIndex, {
        rate: this.settings.rate,
        voice: this.selectedVoice
      });
    }

    handleSpeechStart(latencyMs) {
      if (this.stopped) return;
      this.clearResumeWatchdog();
      this.toolbar.setStatus("Reading");
      console.debug(`Edge Natural TTS first audio started in ${Math.round(latencyMs)}ms`);
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
      this.highlighter.clear();
      this.toolbar.setStatus("Finished");
      this.toolbar.setStopped();
    }

    handleError(error) {
      this.clearResumeWatchdog();
      console.error("Edge Natural TTS", error);
      this.stopped = true;
      this.highlighter.clear();
      this.toolbar.setStatus(error.message);
      this.toolbar.setStopped();
    }

    handlePageClick(event) {
      if (!this.enabled || event.target?.closest?.("[data-edge-tts-ui]")) {
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

    async changeVoice(name) {
      const voice = this.voices.find((candidate) => candidate.name === name);
      if (!voice) return;
      this.selectedVoice = voice;
      this.settings.voiceName = voice.name;
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
          voiceName: stored.voiceName || "",
          wordColor: normalizeColor(stored.wordColor, DEFAULT_SETTINGS.wordColor),
          sentenceColor: normalizeColor(stored.sentenceColor, DEFAULT_SETTINGS.sentenceColor),
          autoScroll: stored.autoScroll !== false,
          minimized: stored.minimized === true,
          toolbarPosition:
            toolbarPosition &&
            Number.isFinite(Number(toolbarPosition.x)) &&
            Number.isFinite(Number(toolbarPosition.y))
              ? { x: Number(toolbarPosition.x), y: Number(toolbarPosition.y) }
              : null
        };
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

  extension.Reader = { ReaderApp };
})(globalThis);
