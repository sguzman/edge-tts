(function attachReader(root) {
  const extension = root.EdgeTtsExtension;
  const { buildReadableModel, findSegmentInNode, firstBlockNearViewport } = extension.TextModel;
  const { Highlighter } = extension.Highlighter;
  const { SpeechEngine, isNaturalVoice } = extension.SpeechEngine;
  const { Toolbar } = extension.Toolbar;

  const DEFAULT_SETTINGS = {
    rate: 1,
    voiceName: ""
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
      this.highlighter = new Highlighter();
      this.speech = new SpeechEngine({
        onBoundary: (segment) => this.handleBoundary(segment),
        onEnd: () => this.handleBlockEnd(),
        onError: (error) => this.handleError(error)
      });
      this.toolbar = new Toolbar({
        onPlayPause: () => this.playPause(),
        onStop: () => this.stop(),
        onVoice: (name) => this.changeVoice(name),
        onRate: (rate) => this.changeRate(rate)
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
      this.enabled = true;
      this.stopped = false;
      this.paused = false;
      this.toolbar.mount();
      this.toolbar.setStatus("Finding voices…");
      document.addEventListener("click", this.boundClick, true);
      document.addEventListener("keydown", this.boundKeydown, true);

      await this.loadSettings();
      await this.speech.waitForVoices();
      this.refreshVoices();
      this.rebuildModel();

      const startBlock = firstBlockNearViewport(this.model.blocks);
      if (!startBlock) {
        this.stop();
        this.toolbar.setStatus("No readable text found");
        return;
      }

      this.currentBlockIndex = startBlock.index;
      this.currentSegmentIndex = 0;
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
        this.speech.resume();
        this.paused = false;
      } else {
        this.speech.pause();
        this.paused = true;
      }
      this.toolbar.setPaused(this.paused);
    }

    rebuildModel() {
      this.model = buildReadableModel(document);
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
      const block = this.model?.blocks[this.currentBlockIndex];
      if (!block) {
        this.finishDocument();
        return;
      }

      this.stopped = false;
      this.paused = false;
      this.toolbar.setPaused(false);
      this.speech.speak(block, this.currentSegmentIndex, {
        rate: this.settings.rate,
        voice: this.selectedVoice
      });
    }

    handleBoundary(segment) {
      this.currentBlockIndex = segment.blockIndex;
      this.currentSegmentIndex = segment.segmentIndex;
      this.highlighter.highlight(segment);
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
      this.stopped = true;
      this.speech.cancel();
      this.highlighter.clear();
      this.toolbar.setStatus("Finished");
      this.toolbar.setStopped();
    }

    handleError(error) {
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

    async loadSettings() {
      try {
        const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
        this.settings = {
          rate: Number(stored.rate) || DEFAULT_SETTINGS.rate,
          voiceName: stored.voiceName || ""
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
