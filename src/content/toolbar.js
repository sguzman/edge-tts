(function attachToolbar(root) {
  const extension = root.EdgeTtsExtension;

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  class Toolbar {
    constructor(handlers) {
      this.handlers = handlers;
      this.element = null;
      this.playButton = null;
      this.stopButton = null;
      this.voiceSelect = null;
      this.rateInput = null;
      this.rateValue = null;
      this.status = null;
      this.wordColorInput = null;
      this.sentenceColorInput = null;
      this.autoScrollInput = null;
      this.minimizeButton = null;
      this.minimized = false;
      this.dragState = null;
      this.boundPointerMove = (event) => this.handlePointerMove(event);
      this.boundPointerUp = (event) => this.handlePointerUp(event);
      this.boundResize = () => this.clampCurrentPosition();
    }

    mount() {
      if (this.element) {
        this.element.hidden = false;
        return;
      }

      const element = document.createElement("section");
      element.id = "edge-tts-toolbar";
      element.dataset.edgeTtsUi = "true";
      element.setAttribute("aria-label", "Edge Natural TTS controls");
      element.innerHTML = `
        <div class="edge-tts-header" data-edge-tts-drag-handle>
          <strong>Edge TTS</strong>
          <span data-edge-tts-status>Starting…</span>
          <button type="button" class="edge-tts-icon-button" data-edge-tts-action="minimize" title="Minimize controls" aria-label="Minimize controls">−</button>
        </div>
        <div class="edge-tts-row edge-tts-transport-row">
          <button type="button" data-edge-tts-action="play" title="Pause or resume">Pause</button>
          <button type="button" data-edge-tts-action="stop" title="Stop reading">Stop</button>
        </div>
        <div data-edge-tts-expanded>
          <div class="edge-tts-row">
            <label>
              Voice
              <select data-edge-tts-voice aria-label="Voice"></select>
            </label>
          </div>
          <div class="edge-tts-row">
            <label class="edge-tts-rate-label">
              Speed
              <input data-edge-tts-rate type="range" min="0.5" max="2.5" step="0.1" value="1">
              <output data-edge-tts-rate-value>1.0×</output>
            </label>
          </div>
          <div class="edge-tts-row edge-tts-color-row">
            <label>
              Word highlight
              <input data-edge-tts-word-color type="color" value="#ffd60a" aria-label="Word highlight color">
            </label>
            <label>
              Sentence highlight
              <input data-edge-tts-sentence-color type="color" value="#bde0fe" aria-label="Sentence highlight color">
            </label>
          </div>
          <div class="edge-tts-row">
            <label class="edge-tts-checkbox-label">
              <input data-edge-tts-auto-scroll type="checkbox" checked>
              Auto-scroll while reading
            </label>
          </div>
          <div class="edge-tts-hint">Drag the header to move · Click page text to jump · Esc closes</div>
        </div>
      `;

      document.documentElement.appendChild(element);
      this.element = element;
      this.playButton = element.querySelector("[data-edge-tts-action='play']");
      this.stopButton = element.querySelector("[data-edge-tts-action='stop']");
      this.voiceSelect = element.querySelector("[data-edge-tts-voice]");
      this.rateInput = element.querySelector("[data-edge-tts-rate]");
      this.rateValue = element.querySelector("[data-edge-tts-rate-value]");
      this.status = element.querySelector("[data-edge-tts-status]");
      this.wordColorInput = element.querySelector("[data-edge-tts-word-color]");
      this.sentenceColorInput = element.querySelector("[data-edge-tts-sentence-color]");
      this.autoScrollInput = element.querySelector("[data-edge-tts-auto-scroll]");
      this.minimizeButton = element.querySelector("[data-edge-tts-action='minimize']");
      this.dragHandle = element.querySelector("[data-edge-tts-drag-handle]");

      this.playButton.addEventListener("click", () => this.handlers.onPlayPause());
      this.stopButton.addEventListener("click", () => this.handlers.onStop());
      this.voiceSelect.addEventListener("change", () => this.handlers.onVoice(this.voiceSelect.value));
      this.rateInput.addEventListener("input", () => {
        const rate = Number(this.rateInput.value);
        this.rateValue.value = `${rate.toFixed(1)}×`;
      });
      this.rateInput.addEventListener("change", () => {
        this.handlers.onRate(Number(this.rateInput.value));
      });
      this.wordColorInput.addEventListener("input", () => {
        this.handlers.onWordColor(this.wordColorInput.value);
      });
      this.sentenceColorInput.addEventListener("input", () => {
        this.handlers.onSentenceColor(this.sentenceColorInput.value);
      });
      this.autoScrollInput.addEventListener("change", () => {
        this.handlers.onAutoScroll(this.autoScrollInput.checked);
      });
      this.minimizeButton.addEventListener("click", () => {
        this.setMinimized(!this.minimized);
        this.handlers.onMinimized(this.minimized);
      });
      this.dragHandle.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
      root.addEventListener("resize", this.boundResize);
    }

    hide() {
      if (this.element) {
        this.element.hidden = true;
      }
    }

    setPaused(paused) {
      if (this.playButton) {
        this.playButton.textContent = paused ? "Resume" : "Pause";
      }
      this.setStatus(paused ? "Paused" : "Reading");
    }

    setStopped() {
      if (this.playButton) {
        this.playButton.textContent = "Start";
      }
      this.setStatus("Stopped");
    }

    setStatus(text) {
      if (this.status) {
        this.status.textContent = text;
        this.status.title = text;
      }
    }

    setRate(rate) {
      if (!this.rateInput || !this.rateValue) return;
      this.rateInput.value = String(rate);
      this.rateValue.value = `${Number(rate).toFixed(1)}×`;
    }

    setVoices(voices, selectedName) {
      if (!this.voiceSelect) return;
      this.voiceSelect.replaceChildren();

      for (const voice of voices) {
        const option = document.createElement("option");
        option.value = voice.name;
        option.textContent = `${voice.name} — ${voice.lang}`;
        option.selected = voice.name === selectedName;
        this.voiceSelect.appendChild(option);
      }
    }

    setHighlightColors(wordColor, sentenceColor) {
      if (this.wordColorInput) this.wordColorInput.value = wordColor;
      if (this.sentenceColorInput) this.sentenceColorInput.value = sentenceColor;
    }

    setAutoScroll(enabled) {
      if (this.autoScrollInput) this.autoScrollInput.checked = Boolean(enabled);
    }

    setMinimized(minimized) {
      this.minimized = Boolean(minimized);
      if (!this.element) return;
      this.element.dataset.minimized = String(this.minimized);
      if (this.minimizeButton) {
        this.minimizeButton.textContent = this.minimized ? "□" : "−";
        this.minimizeButton.title = this.minimized ? "Restore controls" : "Minimize controls";
        this.minimizeButton.setAttribute(
          "aria-label",
          this.minimized ? "Restore controls" : "Minimize controls"
        );
      }
      root.requestAnimationFrame?.(() => this.clampCurrentPosition());
    }

    setPosition(position) {
      if (!this.element || !position) return;
      const x = Number(position.x);
      const y = Number(position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      this.applyPosition(x, y);
    }

    handlePointerDown(event) {
      if (event.button !== 0 || event.target.closest("button,input,select,label")) {
        return;
      }

      const rect = this.element.getBoundingClientRect();
      this.dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      this.element.dataset.dragging = "true";
      document.addEventListener("pointermove", this.boundPointerMove, true);
      document.addEventListener("pointerup", this.boundPointerUp, true);
      document.addEventListener("pointercancel", this.boundPointerUp, true);
      event.preventDefault();
    }

    handlePointerMove(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      const x = event.clientX - this.dragState.offsetX;
      const y = event.clientY - this.dragState.offsetY;
      this.applyPosition(x, y);
      event.preventDefault();
    }

    handlePointerUp(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      this.dragState = null;
      delete this.element.dataset.dragging;
      document.removeEventListener("pointermove", this.boundPointerMove, true);
      document.removeEventListener("pointerup", this.boundPointerUp, true);
      document.removeEventListener("pointercancel", this.boundPointerUp, true);
      const rect = this.element.getBoundingClientRect();
      this.handlers.onPosition({ x: Math.round(rect.left), y: Math.round(rect.top) });
    }

    applyPosition(x, y) {
      if (!this.element) return;
      const rect = this.element.getBoundingClientRect();
      const margin = 4;
      const maximumX = Math.max(margin, root.innerWidth - rect.width - margin);
      const maximumY = Math.max(margin, root.innerHeight - rect.height - margin);
      const clampedX = clamp(x, margin, maximumX);
      const clampedY = clamp(y, margin, maximumY);
      this.element.style.left = `${Math.round(clampedX)}px`;
      this.element.style.top = `${Math.round(clampedY)}px`;
      this.element.style.right = "auto";
    }

    clampCurrentPosition() {
      if (!this.element || !this.element.style.left) return;
      const rect = this.element.getBoundingClientRect();
      this.applyPosition(rect.left, rect.top);
    }
  }

  extension.Toolbar = { Toolbar };
})(globalThis);
