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
  let editRevision = 0;
  let savedRevision = 0;

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

  const PIPER_TRACE_STORAGE_KEY = "edgeTtsLastPiperRequestV1";

  function renderLastPiperRequest(trace) {
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
    meta.textContent = `${when.toLocaleTimeString()}${voice}`;
  }

  async function loadLastPiperRequest() {
    try {
      const stored = await chrome.storage.session.get(PIPER_TRACE_STORAGE_KEY);
      renderLastPiperRequest(stored?.[PIPER_TRACE_STORAGE_KEY]);
    } catch (_error) {
      renderLastPiperRequest(null);
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
      <td><button type="button" data-remove>Remove</button></td>
    `;
    row.querySelector("[data-key]").value = key;
    row.querySelector("[data-value]").value = value;
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
      <td><button type="button" data-remove>Remove</button></td>
    `;
    row.querySelector("[data-pattern]").value = rule.pattern || "";
    row.querySelector("[data-replace]").value = rule.replace || "";
    row.querySelector("[data-case-sensitive]").checked = rule.caseSensitive === true;
    row.querySelector("[data-remove]").addEventListener("click", () => {
      row.remove();
      handleRuleChange();
    });
    row.addEventListener("input", () => {
      validateRegexRow(row);
      handleRuleChange();
    });
    row.addEventListener("change", handleRuleChange);
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
          setStatus("Saved automatically.", "ok");
        } else {
          scheduleAutosave();
        }
      } catch (error) {
        setStatus(`Autosave failed: ${error.message}`, "error");
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
    setStatus("Saved.", "ok");
  }

  async function save() {
    try {
      await flushSave();
    } catch (error) {
      setStatus(error.message, "error");
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
  $("#preview-source").addEventListener("input", updatePreview);

  for (const element of document.querySelectorAll(
    "input:not([data-key]):not([data-value]):not([data-pattern]):not([data-replace]), select, #acronym-tokens, #drop-tokens"
  )) {
    element.addEventListener("input", handleRuleChange);
    element.addEventListener("change", handleRuleChange);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !changes?.[PIPER_TRACE_STORAGE_KEY]) return;
    renderLastPiperRequest(changes[PIPER_TRACE_STORAGE_KEY].newValue);
  });

  void loadLastPiperRequest();

  Pronunciation.loadConfig({ force: true })
    .then((loaded) => {
      config = loaded;
      render(config);
      setStatus("Rules loaded.", "ok");
    })
    .catch((error) => setStatus(error.message, "error"));
})();
