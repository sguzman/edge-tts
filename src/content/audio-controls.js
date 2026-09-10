(function attachAudioControls(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  api.installAudioControls?.();
})(globalThis, function createAudioControlsApi(root) {
  const DEFAULT_VOLUME = 1;
  const MIN_RATE = 0.5;
  const MAX_RATE = 5;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeVolume(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? clamp(numeric, 0, 1) : DEFAULT_VOLUME;
  }

  function normalizeRate(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? clamp(numeric, MIN_RATE, MAX_RATE) : 1;
  }

  function installToolbar(Toolbar) {
    const prototype = Toolbar?.prototype;
    if (!prototype || prototype.__edgeTtsAudioControlsInstalled) {
      return false;
    }

    const originalMount = prototype.mount;
    const originalDestroy = prototype.destroy;
    const originalSetRate = prototype.setRate;

    Object.defineProperty(prototype, "__edgeTtsAudioControlsInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.mount = function mountWithAudioControls(...args) {
      const result = originalMount.apply(this, args);

      if (this.rateInput) {
        this.rateInput.min = String(MIN_RATE);
        this.rateInput.max = String(MAX_RATE);
        this.rateInput.step = "0.1";
      }

      if (!this.volumeInput && this.element) {
        const row = document.createElement("div");
        row.className = "edge-tts-row";
        row.dataset.edgeTtsVolumeRow = "true";
        row.innerHTML = `
          <label class="edge-tts-rate-label">
            Volume
            <input data-edge-tts-volume type="range" min="0" max="100" step="5" value="100" aria-label="Speech volume">
            <output data-edge-tts-volume-value>100%</output>
          </label>
        `;

        const rateRow = this.rateInput?.closest?.(".edge-tts-row");
        if (rateRow) {
          rateRow.insertAdjacentElement("afterend", row);
        } else {
          this.element.querySelector("[data-edge-tts-expanded]")?.prepend(row);
        }

        this.volumeInput = row.querySelector("[data-edge-tts-volume]");
        this.volumeValue = row.querySelector("[data-edge-tts-volume-value]");

        this.volumeInput?.addEventListener("input", () => {
          if (this.volumeValue) {
            this.volumeValue.value = `${Math.round(Number(this.volumeInput.value))}%`;
          }
        });
        this.volumeInput?.addEventListener("change", () => {
          this.handlers.onVolume?.(Number(this.volumeInput.value) / 100);
        });
      }

      return result;
    };

    prototype.setRate = function setExpandedRate(rate) {
      return originalSetRate.call(this, normalizeRate(rate));
    };

    prototype.setVolume = function setVolume(volume) {
      if (!this.volumeInput || !this.volumeValue) return;
      const percent = Math.round(normalizeVolume(volume) * 100);
      this.volumeInput.value = String(percent);
      this.volumeValue.value = `${percent}%`;
    };

    prototype.destroy = function destroyWithAudioControls(...args) {
      const result = originalDestroy.apply(this, args);
      this.volumeInput = null;
      this.volumeValue = null;
      return result;
    };

    return true;
  }

  function installReader(ReaderApp) {
    const prototype = ReaderApp?.prototype;
    if (!prototype || prototype.__edgeTtsAudioSettingsInstalled) {
      return false;
    }

    const originalLoadSettings = prototype.loadSettings;
    const originalApplySettings = prototype.applySettings;
    const originalChangeRate = prototype.changeRate;

    Object.defineProperty(prototype, "__edgeTtsAudioSettingsInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.loadSettings = async function loadAudioSettings(...args) {
      const volumeReady = chrome.storage.local.get(["volume"]);
      const result = await originalLoadSettings.apply(this, args);
      try {
        const stored = await volumeReady;
        this.settings.volume = normalizeVolume(stored?.volume);
      } catch (_error) {
        this.settings.volume = DEFAULT_VOLUME;
      }
      this.settings.rate = normalizeRate(this.settings.rate);
      return result;
    };

    prototype.applySettings = function applyAudioSettings(...args) {
      const result = originalApplySettings.apply(this, args);
      this.settings.volume = normalizeVolume(this.settings.volume);
      this.settings.rate = normalizeRate(this.settings.rate);
      root.EdgeTtsExtension.AudioControls.currentVolume = this.settings.volume;
      this.toolbar?.setRate?.(this.settings.rate);
      this.toolbar?.setVolume?.(this.settings.volume);
      if (this.toolbar?.handlers) {
        this.toolbar.handlers.onVolume = (volume) => this.changeVolume(volume);
      }
      return result;
    };

    prototype.changeRate = function changeExpandedRate(rate) {
      return originalChangeRate.call(this, normalizeRate(rate));
    };

    prototype.changeVolume = async function changeVolume(volume) {
      this.settings.volume = normalizeVolume(volume);
      root.EdgeTtsExtension.AudioControls.currentVolume = this.settings.volume;
      this.toolbar?.setVolume?.(this.settings.volume);
      await this.saveSettings();
      if (!this.stopped && !this.paused && this.audioOwner) {
        this.speakCurrentPosition();
      }
    };

    return true;
  }

  function installSpeechVolume(SpeechEngine) {
    const prototype = SpeechEngine?.prototype;
    if (!prototype || prototype.__edgeTtsVolumeInstalled) {
      return false;
    }

    const originalSpeakCurrentChunk = prototype.speakCurrentChunk;
    if (typeof originalSpeakCurrentChunk !== "function") {
      return false;
    }

    Object.defineProperty(prototype, "__edgeTtsVolumeInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.speakCurrentChunk = function speakCurrentChunkWithVolume(...args) {
      const result = originalSpeakCurrentChunk.apply(this, args);
      if (this.currentUtterance) {
        this.currentUtterance.volume = normalizeVolume(
          root.EdgeTtsExtension.AudioControls.currentVolume
        );
      }
      return result;
    };

    return true;
  }

  function installAudioControls() {
    const extension = root.EdgeTtsExtension;
    if (!extension) return { toolbar: false, reader: false, speech: false };

    extension.AudioControls = extension.AudioControls || { currentVolume: DEFAULT_VOLUME };
    return {
      toolbar: installToolbar(extension.Toolbar?.Toolbar),
      reader: installReader(extension.Reader?.ReaderApp),
      speech: installSpeechVolume(extension.SpeechEngine?.SpeechEngine)
    };
  }

  return {
    DEFAULT_VOLUME,
    MAX_RATE,
    MIN_RATE,
    installAudioControls,
    installReader,
    installSpeechVolume,
    installToolbar,
    normalizeRate,
    normalizeVolume
  };
});