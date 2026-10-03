(() => {
  const Pronunciation =
    globalThis.EdgeTtsPronunciation ||
    globalThis.EdgeTtsExtension?.Pronunciation;
  if (!Pronunciation) {
    throw new Error("Pronunciation engine did not load.");
  }

  const $ = (selector) => document.querySelector(selector);
  let config = Pronunciation.cloneDefaultConfig();
  let autosaveTimer = null;
  let toastTimer = null;
  let editRevision = 0;
  let savedRevision = 0;
  let testAudio = null;
  let testAudioUrl = "";
  let testAudioKey = "";
  let testSynthesisSerial = 0;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getPath(object, path) {
    return String(path)
      .split(".")
      .reduce((value, key) => value?.[key], object);
  }

  function setPath(object, path, value) {
    const parts = String(path).split(".");
    let cursor = object;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[parts.at(-1)] = value;
  }

  function setStatus(message, kind = "") {
    const element = $("#status");
    element.textContent = message;
    element.className = kind;
  }

  function backupStatusText() {
    const backup = Pronunciation.getLastBackupStatus?.();
    if (!backup) return "";
    if (backup.ok) {
      return backup.path
        ? ` · durable backup: ${backup.path}`
        : " · durable backup OK";
    }
    return backup.error
      ? ` · WARNING: durable backup failed: ${backup.error}`
      : " · WARNING: durable backup unavailable";
  }

  function savedStatusMessage(prefix, config) {
    return (
      `${prefix} · revision ${Number(config?.revision) || 0}` +
      backupStatusText()
    );
  }

  function showSaveToast(message, kind = "ok") {
    const toast = $("#save-toast");
    if (!toast) return;

    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    toast.textContent = String(message || "");
    toast.className = `save-toast visible ${kind}`;
    toastTimer = setTimeout(() => {
      toast.classList.remove("visible");
      toastTimer = null;
    }, kind === "error" ? 4200 : 2400);
  }

  function setTestStatus(message, kind = "") {
    const element = $("#test-status");
    if (!element) return;
    element.textContent = String(message || "");
    element.className = kind ? `muted ${kind}` : "muted";
  }

  function revokeTestAudio() {
    if (testAudio) {
      try {
        testAudio.pause();
      } catch (_error) {}
      testAudio.removeAttribute("src");
      testAudio = null;
    }

    if (testAudioUrl) {
      try {
        URL.revokeObjectURL(testAudioUrl);
      } catch (_error) {}
      testAudioUrl = "";
    }
  }

  function decodeBase64Chunks(chunks) {
    return (chunks || []).map((value) => {
      const binary = atob(String(value || ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    });
  }

  function currentTestSpeed() {
    return Math.min(
      8,
      Math.max(0.5, Number($("#test-speed")?.value) || 1)
    );
  }

  function applyTestSpeed() {
    const speed = currentTestSpeed();
    if ($("#test-speed-value")) {
      $("#test-speed-value").value = `${speed.toFixed(2)}x`;
    }
    if (testAudio) {
      testAudio.playbackRate = speed;
      testAudio.preservesPitch = true;
      if ("webkitPreservesPitch" in testAudio) {
        testAudio.webkitPreservesPitch = true;
      }
    }
  }

  function transformedPreviewText() {
    updatePreview();
    return String($("#preview-spoken")?.value || "").trim();
  }

  async function ensureTestAudioForSpokenText(spokenText) {
    const normalizedText = String(spokenText || "").trim();
    if (!normalizedText) {
      throw new Error("Nothing remains after pronunciation transforms.");
    }

    const cacheKey = normalizedText;
    if (testAudio && testAudioKey === cacheKey && testAudioUrl) {
      return testAudio;
    }

    revokeTestAudio();
    testAudioKey = "";
    const serial = ++testSynthesisSerial;
    setTestStatus("Synthesizing Ryan test audio…");

    const response = await chrome.runtime.sendMessage({
      type: "EDGE_TTS_PRONUNCIATION_TEST_SYNTHESIZE",
      voiceId: "en_US-ryan-high",
      text: normalizedText
    });

    if (serial !== testSynthesisSerial) {
      throw new Error("Pronunciation test was superseded.");
    }

    if (!response?.accepted || !Array.isArray(response.audioChunks)) {
      throw new Error(
        response?.error || "Piper did not return pronunciation test audio."
      );
    }

    const decoded = decodeBase64Chunks(response.audioChunks);
    if (!decoded.length) {
      throw new Error("Piper returned an empty pronunciation test WAV.");
    }

    const blob = new Blob(decoded, { type: "audio/wav" });
    testAudioUrl = URL.createObjectURL(blob);
    testAudio = new Audio(testAudioUrl);
    testAudio.preload = "auto";
    testAudio.preservesPitch = true;
    if ("webkitPreservesPitch" in testAudio) {
      testAudio.webkitPreservesPitch = true;
    }
    testAudioKey = cacheKey;
    applyTestSpeed();

    testAudio.addEventListener("ended", () => {
      setTestStatus("Finished · Ryan High");
      $("#test-play").disabled = false;
      $("#test-stop").disabled = false;
    });
    testAudio.addEventListener("error", () => {
      const message = testAudio?.error?.message || "Browser test playback failed.";
      setTestStatus(message, "error");
      $("#test-play").disabled = false;
    });

    return testAudio;
  }

  async function playSpokenTest(spokenText, statusPrefix = "") {
    const audio = await ensureTestAudioForSpokenText(spokenText);
    audio.currentTime = 0;
    applyTestSpeed();
    await audio.play();
    setTestStatus(
      `${statusPrefix ? `${statusPrefix} · ` : ""}Playing Ryan High · ${currentTestSpeed().toFixed(2)}x`
    );
    return audio;
  }

  async function playTestAudio() {
    $("#test-play").disabled = true;
    try {
      await playSpokenTest(transformedPreviewText());
    } catch (error) {
      setTestStatus(error?.message || String(error), "error");
    } finally {
      $("#test-play").disabled = false;
    }
  }

  function stopTestAudio() {
    testSynthesisSerial += 1;
    try {
      void chrome.runtime.sendMessage({
        type: "EDGE_TTS_PRONUNCIATION_TEST_CANCEL"
      });
    } catch (_error) {}

    if (testAudio) {
      try {
        testAudio.pause();
        testAudio.currentTime = 0;
      } catch (_error) {}
    }
    setTestStatus("Stopped · Ryan High");
    $("#test-play").disabled = false;
  }

  const PIPER_TRACE_STORAGE_KEY = "edgeTtsLastPiperRequestV1";
  const PIPER_FAILURE_STORAGE_KEY = "edgeTtsLastPiperFailureV1";
  let lastPiperRequest = null;
  let lastPiperFailure = null;

  function renderLastPiperRequest(trace) {
    lastPiperRequest = trace || null;
    const textArea = $("#last-piper-request");
    const meta = $("#last-piper-meta");
    if (!textArea || !meta) return;

    textArea.value = trace?.text || "";
    if (!trace?.at) {
      meta.textContent = "No Piper request observed in this extension session yet.";
      return;
    }

    const when = new Date(trace.at);
    const voice = trace.voiceId ? ` · ${trace.voiceId}` : "";
    const revision = Number(trace.pronunciationRevision) || 0;
    const savedAt = Number(trace.pronunciationSavedAt) || 0;
    const savedText = savedAt
      ? ` · rules saved ${new Date(savedAt).toLocaleTimeString()}`
      : "";
    meta.textContent =
      `${when.toLocaleTimeString()}${voice} · pronunciation revision ${revision}${savedText}`;
  }

  async function loadLastPiperRequest() {
    try {
      const stored = await chrome.storage.session.get(PIPER_TRACE_STORAGE_KEY);
      renderLastPiperRequest(stored?.[PIPER_TRACE_STORAGE_KEY]);
    } catch (_error) {
      renderLastPiperRequest(null);
    }
  }

  function renderLastPiperFailure(failure) {
    lastPiperFailure = failure || null;
    const textArea = $("#last-piper-failure");
    const meta = $("#last-piper-failure-meta");
    if (!textArea || !meta) return;

    if (!failure) {
      textArea.value = "";
      meta.textContent = "No Piper failure observed in this extension session yet.";
      return;
    }

    textArea.value = [
      failure.message || "Unknown Piper failure",
      "",
      `chunkIndex: ${failure.chunkIndex ?? "?"}`,
      `textLength: ${failure.textLength ?? "?"}`,
      `playbackIndex: ${failure.playbackIndex ?? "?"}`,
      `preparedChunks: ${failure.preparedChunks ?? "?"}`,
      `activeRequests: ${failure.activeRequests ?? "?"}`,
      "",
      failure.text || ""
    ].join("\n");

    meta.textContent = failure.at
      ? new Date(failure.at).toLocaleTimeString()
      : "";
  }

  async function loadLastPiperFailure() {
    try {
      const stored = await chrome.storage.session.get(PIPER_FAILURE_STORAGE_KEY);
      renderLastPiperFailure(stored?.[PIPER_FAILURE_STORAGE_KEY]);
    } catch (_error) {
      renderLastPiperFailure(null);
    }
  }

  async function copyPiperDiagnostics() {
    const payload = {
      request: lastPiperRequest,
      failure: lastPiperFailure
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatus("Copied Piper diagnostics.", "ok");
    } catch (error) {
      setStatus(`Could not copy diagnostics: ${error.message}`, "error");
    }
  }

  const INLINE_TESTABLE_MAPS = new Set([
    "pronunciation.customPronunciations",
    "pronunciation.brandMap",
    "abbreviations.case",
    "abbreviations.nocase",
    "normalization.replacements"
  ]);

  function inlineRuleTestSource(path, row) {
    const key = String(row.querySelector("[data-key]")?.value || "").trim();
    const value = String(row.querySelector("[data-value]")?.value || "").trim();
    if (!key) {
      throw new Error("This rule needs a source token before it can be tested.");
    }

    if (INLINE_TESTABLE_MAPS.has(path)) {
      const draft = readForm();
      const result = Pronunciation.transformText(key, draft);
      return {
        source: key,
        spoken: String(result.text || "").trim(),
        expectedValue: value
      };
    }

    if (
      path === "acronyms.letterSounds" ||
      path === "technical.pathWords"
    ) {
      if (!value) {
        throw new Error("This mapping needs a spoken value.");
      }
      return { source: key, spoken: value, expectedValue: value };
    }

    throw new Error("This rule type needs context and cannot be tested as a standalone token.");
  }

  async function testMapRow(path, row, button) {
    const resultLabel = row.querySelector("[data-rule-test-result]");
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Testing…";
    try {
      const test = inlineRuleTestSource(path, row);
      if (!test.spoken) {
        throw new Error(`${test.source} is dropped by the current rules.`);
      }

      if (resultLabel) {
        resultLabel.textContent = `→ ${test.spoken}`;
        resultLabel.title = `${test.source} → ${test.spoken}`;
      }

      await playSpokenTest(
        test.spoken,
        `${test.source} → ${test.spoken}`
      );
    } catch (error) {
      const message = error?.message || String(error);
      if (resultLabel) {
        resultLabel.textContent = message;
        resultLabel.title = message;
      }
      setTestStatus(message, "error");
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function mapRows(path) {
    return [...document.querySelectorAll(`[data-map="${path}"] tbody tr`)];
  }

  function readMap(path) {
    const result = {};
    for (const row of mapRows(path)) {
      const key = row.querySelector("[data-key]")?.value ?? "";
      const value = row.querySelector("[data-value]")?.value ?? "";
      if (key) result[key] = value;
    }
    return result;
  }

  function createMapRow(path, key = "", value = "") {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="text" data-key></td>
      <td><input type="text" data-value></td>
      <td class="rule-actions">
        <div class="rule-action-buttons">
          <button type="button" data-test-rule>Test</button>
          <button type="button" data-remove>Remove</button>
        </div>
        <span class="rule-test-result" data-rule-test-result></span>
      </td>
    `;
    row.querySelector("[data-key]").value = key;
    row.querySelector("[data-value]").value = value;

    const testButton = row.querySelector("[data-test-rule]");
    const supportsInlineTest =
      INLINE_TESTABLE_MAPS.has(path) ||
      path === "acronyms.letterSounds" ||
      path === "technical.pathWords";
    testButton.hidden = !supportsInlineTest;
    testButton.title = supportsInlineTest
      ? "Play this rule using the current unsaved editor state"
      : "This rule type requires surrounding context";
    testButton.addEventListener("click", () => {
      void testMapRow(path, row, testButton);
    });

    row.querySelector("[data-remove]").addEventListener("click", () => {
      row.remove();
      handleRuleChange();
    });
    row.addEventListener("input", handleRuleChange);
    document.querySelector(`[data-map="${path}"] tbody`).appendChild(row);
    return row;
  }

  function renderMap(path, map) {
    const body = document.querySelector(`[data-map="${path}"] tbody`);
    body.replaceChildren();
    for (const [key, value] of Object.entries(map || {})) {
      createMapRow(path, key, value);
    }
  }

  function createRegexRow(rule = {}) {
    const body = $("#regex-table tbody");
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="text" data-pattern spellcheck="false"></td>
      <td><input type="text" data-replace></td>
      <td><input type="checkbox" data-case-sensitive></td>
      <td class="regex-test-cell">
        <input type="text" data-regex-test-source placeholder="Test text">
        <span class="rule-test-result" data-rule-test-result></span>
      </td>
      <td class="rule-actions">
        <div class="rule-action-buttons">
          <button type="button" data-test-regex>Test</button>
          <button type="button" data-remove>Remove</button>
        </div>
      </td>
    `;
    row.querySelector("[data-pattern]").value = rule.pattern || "";
    row.querySelector("[data-replace]").value = rule.replace || "";
    row.querySelector("[data-case-sensitive]").checked = rule.caseSensitive === true;

    const testButton = row.querySelector("[data-test-regex]");
    testButton.addEventListener("click", async () => {
      const resultLabel = row.querySelector("[data-rule-test-result]");
      const oldText = testButton.textContent;
      testButton.disabled = true;
      testButton.textContent = "Testing…";
      try {
        if (!validateRegexRow(row)) {
          throw new Error("Fix the regex before testing it.");
        }
        const source = String(
          row.querySelector("[data-regex-test-source]")?.value || ""
        ).trim();
        if (!source) {
          throw new Error("Enter test text for this regex row.");
        }
        const draft = readForm();
        const result = Pronunciation.transformText(source, draft);
        const spoken = String(result.text || "").trim();
        if (!spoken) {
          throw new Error("The current rules drop this regex test text.");
        }
        if (resultLabel) {
          resultLabel.textContent = `→ ${spoken}`;
          resultLabel.title = `${source} → ${spoken}`;
        }
        await playSpokenTest(spoken, `${source} → ${spoken}`);
      } catch (error) {
        const message = error?.message || String(error);
        if (resultLabel) {
          resultLabel.textContent = message;
          resultLabel.title = message;
        }
        setTestStatus(message, "error");
      } finally {
        testButton.disabled = false;
        testButton.textContent = oldText;
      }
    });

    row.querySelector("[data-remove]").addEventListener("click", () => {
      row.remove();
      handleRuleChange();
    });
    row.addEventListener("input", (event) => {
      if (event.target?.matches?.("[data-regex-test-source]")) return;
      validateRegexRow(row);
      handleRuleChange();
    });
    row.addEventListener("change", (event) => {
      if (event.target?.matches?.("[data-regex-test-source]")) return;
      handleRuleChange();
    });
    body.appendChild(row);
    validateRegexRow(row);
  }

  function validateRegexRow(row) {
    const input = row.querySelector("[data-pattern]");
    try {
      if (input.value) new RegExp(input.value);
      input.classList.remove("invalid");
      input.title = "";
      return true;
    } catch (error) {
      input.classList.add("invalid");
      input.title = error.message;
      return false;
    }
  }

  function renderRegex(rules) {
    $("#regex-table tbody").replaceChildren();
    for (const rule of rules || []) createRegexRow(rule);
  }

  function readRegex() {
    const rules = [];
    for (const row of document.querySelectorAll("#regex-table tbody tr")) {
      if (!validateRegexRow(row)) {
        throw new Error(`Invalid regex: ${row.querySelector("[data-pattern]").value}`);
      }
      const pattern = row.querySelector("[data-pattern]").value;
      if (!pattern) continue;
      rules.push({
        pattern,
        replace: row.querySelector("[data-replace]").value,
        caseSensitive: row.querySelector("[data-case-sensitive]").checked
      });
    }
    return rules;
  }

  function lines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function render(value) {
    config = Pronunciation.normalizeConfig(value);

    $("#enabled").checked = config.enabled !== false;
    $("#filesystem-paths").checked = config.technical.expandFilesystemPaths !== false;
    $("#shell-flags").checked = config.technical.expandShellFlags !== false;
    $("#path-component-pauses").checked =
      config.technical.pauseBetweenPathComponents !== false;
    $("#acronyms-enabled").checked = config.acronyms.enabled !== false;
    $("#brand-map-enabled").checked = config.pronunciation.enableBrandMap !== false;
    $("#year-mode").value = config.pronunciation.yearMode || "american";
    $("#insert-and").checked = config.pronunciation.insertAnd === true;
    $("#number-separator").value = config.pronunciation.numberSeparator ?? " ";
    $("#min-sentence-chars").value = String(config.normalization.minSentenceChars ?? 2);
    $("#require-alphanumeric").checked = config.normalization.requireAlphanumeric !== false;

    $("#collapse-whitespace").checked = config.normalization.collapseWhitespace !== false;
    $("#remove-space-before-punctuation").checked =
      config.normalization.removeSpaceBeforePunctuation !== false;
    $("#strip-inline-code").checked = config.normalization.stripInlineCode !== false;
    $("#strip-markdown-links").checked = config.normalization.stripMarkdownLinks !== false;
    $("#drop-numeric-bracket-citations").checked =
      config.normalization.dropNumericBracketCitations !== false;
    $("#drop-parenthetical-numeric-citations").checked =
      config.normalization.dropParentheticalNumericCitations !== false;
    $("#drop-superscript-citations").checked =
      config.normalization.dropSuperscriptCitations !== false;
    $("#drop-word-suffix-footnotes").checked =
      config.normalization.dropWordSuffixNumericFootnotes !== false;
    $("#drop-square-bracket-text").checked =
      config.normalization.dropSquareBracketText !== false;
    $("#drop-curly-brace-text").checked =
      config.normalization.dropCurlyBraceText !== false;

    $("#acronym-tokens").value = (config.acronyms.tokens || []).join("\n");
    $("#auto-uppercase-min-length").value = String(
      config.acronyms.autoUppercaseMinLength ?? 3
    );
    $("#letter-separator").value = config.acronyms.letterSeparator ?? " ";
    $("#digit-separator").value = config.acronyms.digitSeparator ?? " point ";
    $("#drop-tokens").value = (config.normalization.dropTokens || []).join("\n");

    renderMap("acronyms.letterSounds", config.acronyms.letterSounds);
    renderMap(
      "pronunciation.customPronunciations",
      config.pronunciation.customPronunciations
    );
    renderMap("pronunciation.brandMap", config.pronunciation.brandMap);
    renderMap("abbreviations.case", config.abbreviations.case);
    renderMap("abbreviations.nocase", config.abbreviations.nocase);
    renderMap("normalization.replacements", config.normalization.replacements);
    renderMap("technical.pathWords", config.technical.pathWords);
    renderRegex(config.abbreviations.regex);

    $("#raw-json").value = JSON.stringify(config, null, 2);
    updatePreview();
  }

  function readForm() {
    const next = clone(config);

    next.enabled = $("#enabled").checked;
    next.technical.expandFilesystemPaths = $("#filesystem-paths").checked;
    next.technical.expandShellFlags = $("#shell-flags").checked;
    next.technical.pauseBetweenPathComponents =
      $("#path-component-pauses").checked;
    next.acronyms.enabled = $("#acronyms-enabled").checked;
    next.pronunciation.enableBrandMap = $("#brand-map-enabled").checked;
    next.pronunciation.yearMode = $("#year-mode").value;
    next.pronunciation.insertAnd = $("#insert-and").checked;
    next.pronunciation.numberSeparator = $("#number-separator").value;
    next.normalization.minSentenceChars = Math.max(
      0,
      Number($("#min-sentence-chars").value) || 0
    );
    next.normalization.requireAlphanumeric = $("#require-alphanumeric").checked;

    next.normalization.collapseWhitespace = $("#collapse-whitespace").checked;
    next.normalization.removeSpaceBeforePunctuation =
      $("#remove-space-before-punctuation").checked;
    next.normalization.stripInlineCode = $("#strip-inline-code").checked;
    next.normalization.stripMarkdownLinks = $("#strip-markdown-links").checked;
    next.normalization.dropNumericBracketCitations =
      $("#drop-numeric-bracket-citations").checked;
    next.normalization.dropParentheticalNumericCitations =
      $("#drop-parenthetical-numeric-citations").checked;
    next.normalization.dropSuperscriptCitations =
      $("#drop-superscript-citations").checked;
    next.normalization.dropWordSuffixNumericFootnotes =
      $("#drop-word-suffix-footnotes").checked;
    next.normalization.dropSquareBracketText = $("#drop-square-bracket-text").checked;
    next.normalization.dropCurlyBraceText = $("#drop-curly-brace-text").checked;

    next.acronyms.tokens = lines($("#acronym-tokens").value);
    next.acronyms.autoUppercaseMinLength = Math.min(
      32,
      Math.max(0, Math.round(Number($("#auto-uppercase-min-length").value) || 0))
    );
    next.acronyms.letterSeparator = $("#letter-separator").value;
    next.acronyms.digitSeparator = $("#digit-separator").value;
    next.normalization.dropTokens = lines($("#drop-tokens").value);

    for (const section of document.querySelectorAll("[data-map]")) {
      setPath(next, section.dataset.map, readMap(section.dataset.map));
    }

    next.abbreviations.regex = readRegex();
    return Pronunciation.normalizeConfig(next);
  }

  function renderLedger(transformations) {
    const target = $("#preview-ledger");
    target.replaceChildren();

    if (!transformations?.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No rules changed this preview.";
      target.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.innerHTML = `
      <thead>
        <tr><th>Class</th><th>Rule</th><th>Source</th><th>Spoken</th></tr>
      </thead>
      <tbody></tbody>
    `;
    const body = table.querySelector("tbody");
    for (const item of transformations) {
      const row = document.createElement("tr");
      for (const value of [
        item.ruleClass,
        item.ruleId,
        item.sourceText,
        item.spokenText
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value ?? "";
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    target.appendChild(table);
  }

  function updatePreview() {
    try {
      const draft = readForm();
      const result = Pronunciation.transformText($("#preview-source").value, draft);
      $("#preview-spoken").value = result.text;
      renderLedger(result.transformations);
      $("#raw-json").value = JSON.stringify(draft, null, 2);
      setStatus("");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function scheduleAutosave() {
    editRevision += 1;
    const targetRevision = editRevision;
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
    }

    setStatus("Unsaved changes…");
    autosaveTimer = setTimeout(async () => {
      autosaveTimer = null;
      try {
        const draft = readForm();
        const persisted = await Pronunciation.saveConfig(draft);
        config = persisted;
        savedRevision = targetRevision;

        if (editRevision === targetRevision) {
          const message = savedStatusMessage(
            "Saved automatically",
            config
          );
          const backup = Pronunciation.getLastBackupStatus?.();
          setStatus(message, backup?.ok === false ? "error" : "ok");
          showSaveToast(
            `Saved · revision ${Number(config.revision) || 0}` +
              (backup?.ok === false ? " · backup failed" : " · backed up"),
            backup?.ok === false ? "error" : "ok"
          );
        } else {
          scheduleAutosave();
        }
      } catch (error) {
        const message = `Autosave failed: ${error.message}`;
        setStatus(message, "error");
        showSaveToast(message, "error");
      }
    }, 450);
  }

  function handleRuleChange() {
    updatePreview();
    scheduleAutosave();
  }

  async function flushSave() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }

    const targetRevision = ++editRevision;
    const draft = readForm();
    config = await Pronunciation.saveConfig(draft);
    savedRevision = targetRevision;
    $("#raw-json").value = JSON.stringify(config, null, 2);
    const message = savedStatusMessage("Saved", config);
    const backup = Pronunciation.getLastBackupStatus?.();
    setStatus(message, backup?.ok === false ? "error" : "ok");
    showSaveToast(
      `Saved · revision ${Number(config.revision) || 0}` +
        (backup?.ok === false ? " · backup failed" : " · backed up"),
      backup?.ok === false ? "error" : "ok"
    );
  }

  async function save() {
    try {
      await flushSave();
    } catch (error) {
      const message = error?.message || String(error);
      setStatus(message, "error");
      showSaveToast(message, "error");
    }
  }

  async function reset() {
    const okay = confirm(
      "Replace all pronunciation rules with the imported Lantern Leaf defaults?"
    );
    if (!okay) return;
    config = await Pronunciation.resetConfig();
    render(config);
    setStatus("Restored Lantern Leaf defaults.", "ok");
    showSaveToast(
      `Defaults restored · revision ${Number(config.revision) || 0}`,
      "ok"
    );
  }

  function loadRawJson() {
    try {
      const parsed = JSON.parse($("#raw-json").value);
      render(Pronunciation.normalizeConfig(parsed));
      scheduleAutosave();
    } catch (error) {
      setStatus(`Invalid JSON: ${error.message}`, "error");
    }
  }

  async function copyRawJson() {
    try {
      const draft = readForm();
      const value = JSON.stringify(draft, null, 2);
      await navigator.clipboard.writeText(value);
      $("#raw-json").value = value;
      setStatus("Copied current rules as JSON.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  for (const button of document.querySelectorAll("[data-add-map]")) {
    button.addEventListener("click", () => {
      const row = createMapRow(button.dataset.addMap);
      row.querySelector("[data-key]").focus();
      handleRuleChange();
    });
  }

  $("#add-regex").addEventListener("click", () => {
    createRegexRow();
    $("#regex-table tbody tr:last-child [data-pattern]")?.focus();
    handleRuleChange();
  });
  $("#save").addEventListener("click", save);
  $("#reset").addEventListener("click", reset);
  $("#load-json").addEventListener("click", loadRawJson);
  $("#copy-json").addEventListener("click", copyRawJson);
  $("#copy-piper-diagnostics").addEventListener("click", copyPiperDiagnostics);
  $("#test-play").addEventListener("click", playTestAudio);
  $("#test-stop").addEventListener("click", stopTestAudio);
  $("#test-speed").addEventListener("input", () => {
    applyTestSpeed();
    if (testAudio && !testAudio.paused) {
      setTestStatus(
        `Playing Ryan High · ${currentTestSpeed().toFixed(2)}x`
      );
    }
  });
  $("#preview-source").addEventListener("input", updatePreview);

  for (const element of document.querySelectorAll(
    "input:not([data-key]):not([data-value]):not([data-pattern]):not([data-replace]):not(#test-speed), select, #acronym-tokens, #drop-tokens"
  )) {
    element.addEventListener("input", handleRuleChange);
    element.addEventListener("change", handleRuleChange);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session") return;
    if (changes?.[PIPER_TRACE_STORAGE_KEY]) {
      renderLastPiperRequest(changes[PIPER_TRACE_STORAGE_KEY].newValue);
    }
    if (changes?.[PIPER_FAILURE_STORAGE_KEY]) {
      renderLastPiperFailure(changes[PIPER_FAILURE_STORAGE_KEY].newValue);
    }
  });

  void loadLastPiperRequest();
  void loadLastPiperFailure();
  applyTestSpeed();

  window.addEventListener("beforeunload", () => {
    revokeTestAudio();
  });

  Pronunciation.loadConfig({ force: true })
    .then((loaded) => {
      config = loaded;
      render(config);

      const source = Pronunciation.getLastLoadSource?.() || "unknown";
      if (source === "durable-backup") {
        const backup = Pronunciation.getLastBackupStatus?.();
        setStatus(
          `Recovered pronunciation rules from durable backup · revision ${Number(config.revision) || 0}` +
            (backup?.path ? ` · ${backup.path}` : ""),
          "ok"
        );
        showSaveToast("Recovered pronunciation rules from durable backup", "ok");
        return;
      }

      if (source === "defaults") {
        setStatus(
          "No saved pronunciation config was found for this extension identity; defaults are loaded. Custom rules have NOT been intentionally deleted.",
          "error"
        );
        showSaveToast("No saved custom rules found · defaults loaded", "error");
        return;
      }

      setStatus(
        `Rules loaded from extension storage · revision ${Number(config.revision) || 0}.`,
        "ok"
      );
    })
    .catch((error) => setStatus(error.message, "error"));
})();
