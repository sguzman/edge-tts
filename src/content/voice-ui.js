(function attachVoiceUi(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.Toolbar?.Toolbar && api.installVoiceUi) {
    api.installVoiceUi(root.EdgeTtsExtension.Toolbar.Toolbar);
    root.EdgeTtsExtension.VoiceUi = api;
  }
})(globalThis, function createVoiceUiApi(root) {
  function voiceClass(voice) {
    if (voice?.__edgeTtsSource === "win-natural") return "win-natural";
    if (voice?.__edgeTtsSource === "chrome-tts") return "win-legacy";
    if (voice?.localService === true) return "win-legacy";
    if (voice?.remote === true || voice?.localService === false) return "online-natural";
    if (/\b(natural|online)\b/i.test(String(voice?.name || ""))) return "online-natural";
    return "win-legacy";
  }

  function voicePrefix(voice) {
    switch (voiceClass(voice)) {
      case "win-natural":
        return "[WIN-NATURAL]";
      case "online-natural":
        return "[ONLINE]";
      default:
        return "[WIN-LEGACY]";
    }
  }

  function voiceLabel(voice) {
    const locale = voice?.lang ? ` — ${voice.lang}` : "";
    return `${voicePrefix(voice)} ${voice?.name || "Unnamed voice"}${locale}`;
  }

  function voiceSelectionKey(voice) {
    return root.EdgeTtsExtension?.SpeechEngine?.voiceSelectionKey?.(voice) ||
      `${voice?.name || ""}\u0000${voice?.lang || ""}`;
  }

  function filterVoicesByClass(voices, query, selectedClass = "all") {
    const normalizedClass = selectedClass === "local"
      ? "win-legacy"
      : selectedClass === "natural"
        ? "online-natural"
        : ["win-legacy", "win-natural", "online-natural"].includes(selectedClass)
          ? selectedClass
          : "all";
    const terms = String(query || "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return (voices || []).filter((voice) => {
      if (normalizedClass !== "all" && voiceClass(voice) !== normalizedClass) {
        return false;
      }
      if (!terms.length) return true;
      const searchable = `${voice?.name || ""} ${voice?.lang || ""} ${voicePrefix(voice)}`
        .toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  function installVoiceUi(Toolbar) {
    const prototype = Toolbar?.prototype;
    if (!prototype || prototype.__edgeTtsVoiceUiInstalled) return false;

    const originalMount = prototype.mount;
    const originalDestroy = prototype.destroy;

    Object.defineProperty(prototype, "__edgeTtsVoiceUiInstalled", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    prototype.mount = function mountWithVoiceClasses(...args) {
      const result = originalMount.apply(this, args);
      if (!this.voiceClassSelect && this.element) {
        const row = document.createElement("div");
        row.className = "edge-tts-row";
        row.dataset.edgeTtsVoiceClassRow = "true";
        row.innerHTML = `
          <label>
            Voice class
            <select data-edge-tts-voice-class aria-label="Filter voice class">
              <option value="all">All voices</option>
              <option value="win-legacy">Windows Legacy</option>
              <option value="win-natural">Windows Natural</option>
              <option value="online-natural">Online Natural</option>
            </select>
          </label>
        `;
        const filterRow = this.voiceFilterInput?.closest?.(".edge-tts-row");
        if (filterRow) {
          filterRow.insertAdjacentElement("afterend", row);
        } else {
          this.element.querySelector("[data-edge-tts-expanded]")?.prepend(row);
        }
        this.voiceClassSelect = row.querySelector("[data-edge-tts-voice-class]");
        this.voiceClassFilter = this.voiceClassFilter || "all";
        this.voiceClassSelect.value = this.voiceClassFilter;
        this.voiceClassSelect.addEventListener("change", () => {
          this.voiceClassFilter = this.voiceClassSelect.value;
          this.renderVoiceOptions();
        });
      }
      return result;
    };

    prototype.renderVoiceOptions = function renderClassifiedVoiceOptions() {
      if (!this.voiceSelect) return;
      const query = this.voiceFilterInput?.value || "";
      const filteredVoices = filterVoicesByClass(
        this.voices,
        query,
        this.voiceClassFilter || "all"
      );
      const selectedIsVisible = filteredVoices.some(
        (voice) => voiceSelectionKey(voice) === this.selectedVoiceKey
      );

      this.voiceSelect.replaceChildren();
      if (filteredVoices.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No matching voices";
        option.disabled = true;
        option.selected = true;
        this.voiceSelect.appendChild(option);
      } else if (!selectedIsVisible) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = `${filteredVoices.length} matching voice${filteredVoices.length === 1 ? "" : "s"} — choose one`;
        option.disabled = true;
        option.selected = true;
        this.voiceSelect.appendChild(option);
      }

      for (const voice of filteredVoices) {
        const option = document.createElement("option");
        option.value = voiceSelectionKey(voice);
        option.textContent = voiceLabel(voice);
        option.disabled = voice?.catalogOnly === true;
        if (option.disabled) option.title = "Catalog only until Windows Natural playback is implemented.";
        option.selected = voiceSelectionKey(voice) === this.selectedVoiceKey;
        this.voiceSelect.appendChild(option);
      }

      if (this.clearVoiceFilterButton) {
        this.clearVoiceFilterButton.disabled = query.length === 0;
      }
    };

    prototype.destroy = function destroyVoiceUi(...args) {
      const result = originalDestroy.apply(this, args);
      this.voiceClassSelect = null;
      return result;
    };

    return true;
  }

  return {
    filterVoicesByClass,
    installVoiceUi,
    voiceClass,
    voiceLabel,
    voicePrefix
  };
});
