(function attachToolbar(root) {
  const extension = root.EdgeTtsExtension;

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
        <div class="edge-tts-row edge-tts-main-row">
          <strong>Edge TTS</strong>
          <button type="button" data-edge-tts-action="play" title="Pause or resume">Pause</button>
          <button type="button" data-edge-tts-action="stop" title="Stop reading">Stop</button>
          <span data-edge-tts-status>Starting…</span>
        </div>
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
        <div class="edge-tts-hint">Click page text to jump there · Esc closes reader</div>
      `;

      document.documentElement.appendChild(element);
      this.element = element;
      this.playButton = element.querySelector("[data-edge-tts-action='play']");
      this.stopButton = element.querySelector("[data-edge-tts-action='stop']");
      this.voiceSelect = element.querySelector("[data-edge-tts-voice]");
      this.rateInput = element.querySelector("[data-edge-tts-rate]");
      this.rateValue = element.querySelector("[data-edge-tts-rate-value]");
      this.status = element.querySelector("[data-edge-tts-status]");

      this.playButton.addEventListener("click", () => this.handlers.onPlayPause());
      this.stopButton.addEventListener("click", () => this.handlers.onStop());
      this.voiceSelect.addEventListener("change", () => this.handlers.onVoice(this.voiceSelect.value));
      this.rateInput.addEventListener("input", () => {
        const rate = Number(this.rateInput.value);
        this.rateValue.value = `${rate.toFixed(1)}×`;
        this.handlers.onRate(rate);
      });
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
  }

  extension.Toolbar = { Toolbar };
})(globalThis);
