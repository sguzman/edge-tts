(function attachQuitToolbar(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root.EdgeTtsExtension?.Toolbar && api.QuitToolbar) {
    root.EdgeTtsExtension.Toolbar.Toolbar = api.QuitToolbar;
  }
})(globalThis, function createQuitToolbarApi(root) {
  const BaseToolbar = root.EdgeTtsExtension?.Toolbar?.Toolbar;

  if (!BaseToolbar) {
    return { QuitToolbar: null };
  }

  class QuitToolbar extends BaseToolbar {
    constructor(handlers) {
      super(handlers);
      this.quitButton = null;
      this.boundQuit = () => this.handlers?.onQuit?.();
    }

    mount() {
      super.mount();
      this.ensureQuitButton();
    }

    ensureQuitButton() {
      if (!this.element) return;

      let button = this.element.querySelector("[data-edge-tts-action='quit']");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "edge-tts-quit-button";
        button.dataset.edgeTtsAction = "quit";
        button.textContent = "Quit";
        button.title = "Quit Edge TTS for this tab";
        button.setAttribute("aria-label", "Quit Edge TTS for this tab");

        const minimizeButton = this.element.querySelector("[data-edge-tts-action='minimize']");
        minimizeButton?.before(button);
      }

      if (this.quitButton !== button) {
        this.quitButton?.removeEventListener?.("click", this.boundQuit);
        this.quitButton = button;
        this.quitButton.addEventListener("click", this.boundQuit);
      }
    }

    destroy() {
      this.quitButton?.removeEventListener?.("click", this.boundQuit);
      this.quitButton = null;

      root.removeEventListener?.("resize", this.boundResize);
      document.removeEventListener("pointermove", this.boundPointerMove, true);
      document.removeEventListener("pointerup", this.boundPointerUp, true);
      document.removeEventListener("pointercancel", this.boundPointerUp, true);
      this.dragState = null;

      this.element?.remove();
      this.element = null;
      this.playButton = null;
      this.stopButton = null;
      this.refreshButton = null;
      this.voiceSelect = null;
      this.voiceFilterInput = null;
      this.clearVoiceFilterButton = null;
      this.rateInput = null;
      this.rateValue = null;
      this.batchCharsInput = null;
      this.batchCharsValue = null;
      this.status = null;
      this.wordColorInput = null;
      this.sentenceColorInput = null;
      this.autoScrollInput = null;
      this.clickToSeekInput = null;
      this.minimizeButton = null;
      this.dragHandle = null;
    }
  }

  return { QuitToolbar };
});