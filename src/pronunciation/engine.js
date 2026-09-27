(function attachPronunciationEngine(root, factory) {
  const defaults =
    root.EdgeTtsPronunciationDefaults ||
    (typeof require === "function" ? require("./defaults.js") : null);
  const api = factory(root, defaults);

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root.EdgeTtsExtension) {
    root.EdgeTtsExtension.Pronunciation = api;
  } else {
    root.EdgeTtsPronunciation = api;
  }
})(globalThis, function createPronunciationEngine(root, defaultsModule) {
  const STORAGE_KEY =
    defaultsModule?.STORAGE_KEY || "edgeTtsPronunciationConfigV1";
  const cloneDefaults =
    defaultsModule?.cloneDefaultConfig ||
    (() => ({
      schemaVersion: 2,
      enabled: true,
      normalization: {},
      technical: {},
      abbreviations: { case: {}, nocase: {}, regex: [] },
      acronyms: { enabled: false, tokens: [], letterSounds: {} },
      pronunciation: {
        yearMode: "none",
        brandMap: {},
        customPronunciations: {}
      }
    }));

  let currentConfig = cloneDefaults();
  let loadPromise = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function mergeConfig(base, override) {
    if (!isPlainObject(base)) {
      return override === undefined ? clone(base) : clone(override);
    }

    const result = clone(base);
    if (!isPlainObject(override)) return result;

    for (const [key, value] of Object.entries(override)) {
      if (Array.isArray(value)) {
        result[key] = clone(value);
      } else if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeConfig(result[key], value);
      } else {
        result[key] = clone(value);
      }
    }
    return result;
  }

  const REPLACE_MAP_PATHS = [
    ["technical", "pathWords"],
    ["abbreviations", "case"],
    ["abbreviations", "nocase"],
    ["acronyms", "letterSounds"],
    ["pronunciation", "brandMap"],
    ["pronunciation", "customPronunciations"],
    ["normalization", "replacements"]
  ];

  function objectAtPath(object, path) {
    let cursor = object;
    for (const key of path) {
      if (!isPlainObject(cursor) || !(key in cursor)) return undefined;
      cursor = cursor[key];
    }
    return cursor;
  }

  function setObjectAtPath(object, path, value) {
    let cursor = object;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!isPlainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[path.at(-1)] = clone(value);
  }

  function migrateConfig(value) {
    const incoming = isPlainObject(value) ? clone(value) : {};
    const schemaVersion = Math.max(1, Number(incoming.schemaVersion) || 1);

    if (schemaVersion < 2) {
      incoming.acronyms = isPlainObject(incoming.acronyms)
        ? incoming.acronyms
        : {};
      if (incoming.acronyms.letterSeparator === " ") {
        incoming.acronyms.letterSeparator = ", ";
      }

      if (isPlainObject(incoming.pronunciation?.brandMap)) {
        const brandMap = incoming.pronunciation.brandMap;
        const replacements = new Map([
          ["My S Q L", "My S, Q, L"],
          ["S Q Lite", "S, Q, Lite"],
          ["Post C S S", "Post C, S, S"]
        ]);
        for (const [key, spoken] of Object.entries(brandMap)) {
          if (replacements.has(spoken)) {
            brandMap[key] = replacements.get(spoken);
          }
        }
      }
    }

    incoming.schemaVersion = 2;
    return incoming;
  }

  function normalizeConfig(value) {
    const migrated = migrateConfig(value);
    const normalized = mergeConfig(cloneDefaults(), migrated);

    // Rule maps are user-owned collections, not additive patches over the
    // defaults. Deep-merging them made deleted/default rules silently reappear
    // after Save, which made the Options page look like it was ignoring edits.
    for (const path of REPLACE_MAP_PATHS) {
      const override = objectAtPath(migrated, path);
      if (isPlainObject(override)) {
        setObjectAtPath(normalized, path, override);
      }
    }

    normalized.schemaVersion = 2;
    return normalized;
  }

  function getConfig() {
    return clone(currentConfig);
  }

  function setConfigForTests(value) {
    currentConfig = normalizeConfig(value);
    return getConfig();
  }

  async function loadConfig({ force = false } = {}) {
    if (loadPromise && !force) return loadPromise;
    if (!root.chrome?.storage?.local?.get) return getConfig();

    loadPromise = Promise.resolve(root.chrome.storage.local.get(STORAGE_KEY))
      .then((stored) => {
        currentConfig = normalizeConfig(stored?.[STORAGE_KEY]);
        return getConfig();
      })
      .catch(() => getConfig())
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  }

  async function saveConfig(value) {
    const next = normalizeConfig(value);
    const previousRevision = Math.max(
      Number(currentConfig?.revision) || 0,
      Number(value?.revision) || 0
    );
    next.revision = previousRevision + 1;
    next.savedAt = Date.now();
    currentConfig = next;

    if (root.chrome?.storage?.local?.set) {
      await root.chrome.storage.local.set({ [STORAGE_KEY]: currentConfig });
    }
    return getConfig();
  }

  async function resetConfig() {
    return saveConfig(cloneDefaults());
  }

  function normalizeUnicodePunctuation(input) {
    return String(input || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, " - ")
      .replace(/\u2026/g, "...");
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function replaceBounded(text, token, replacement, ignoreCase = false) {
    if (!token) return text;
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9_])${escapeRegex(token)}(?=$|[^A-Za-z0-9_])`,
      ignoreCase ? "gi" : "g"
    );
    return text.replace(pattern, (_match, prefix) => `${prefix}${replacement}`);
  }

  function applyLiteralMap(text, map, ignoreCase = false) {
    let out = text;
    const entries = Object.entries(map || {}).sort(
      ([left], [right]) => right.length - left.length
    );
    for (const [token, replacement] of entries) {
      out = replaceBounded(out, token, replacement, ignoreCase);
    }
    return out;
  }

  function applyRegexRules(text, rules) {
    let out = text;
    for (const rule of rules || []) {
      if (!rule?.pattern) continue;
      try {
        const flags = rule.caseSensitive ? "g" : "gi";
        out = out.replace(new RegExp(rule.pattern, flags), String(rule.replace || ""));
      } catch (_error) {
        // Invalid user rules are ignored at runtime and surfaced in Options preview.
      }
    }
    return out;
  }

  function compiledBoundaryRegexes(config) {
    const out = [];
    for (const rule of config?.abbreviations?.regex || []) {
      if (!rule?.pattern) continue;
      try {
        const flags = rule.caseSensitive ? "g" : "gi";
        out.push(new RegExp(rule.pattern, flags));
      } catch (_error) {}
    }
    return out;
  }

  function protectedPeriodIndices(text, config) {
    const protectedIndices = new Set();
    for (const regex of compiledBoundaryRegexes(config)) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        for (let index = start; index < end; index += 1) {
          if (text[index] === ".") protectedIndices.add(index);
        }
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
    return protectedIndices;
  }

  function isAsciiDomainPeriod(text, dotIndex) {
    if (
      dotIndex <= 0 ||
      dotIndex + 1 >= text.length ||
      text[dotIndex] !== "." ||
      !/[A-Za-z]/.test(text[dotIndex + 1])
    ) {
      return false;
    }

    let labelStart = dotIndex;
    while (
      labelStart > 0 &&
      /[A-Za-z0-9-]/.test(text[labelStart - 1])
    ) {
      labelStart -= 1;
    }
    if (labelStart === dotIndex) return false;

    let end = dotIndex + 1;
    while (end < text.length && /[A-Za-z]/.test(text[end])) end += 1;
    const tld = text.slice(dotIndex + 1, end).toLowerCase();
    return new Set([
      "net", "com", "gov", "org", "uk", "mx", "cn", "de", "ru", "br"
    ]).has(tld);
  }

  function tokenBoundsAt(text, index) {
    let start = index;
    while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
    let end = index + 1;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    return { start, end, token: text.slice(start, end) };
  }

  function periodIsProtected(text, dotIndex, config, regexProtected) {
    if (text[dotIndex] !== ".") return false;
    if (regexProtected?.has(dotIndex)) return true;

    const previous = text[dotIndex - 1] || "";
    const next = text[dotIndex + 1] || "";

    // Any interior period is not a sentence boundary. This protects decimal
    // numbers, domains, filenames, dotfiles, and filesystem paths before the
    // more specific Lantern Leaf abbreviation checks below.
    if (next && !/\s/.test(next) && !/["'”’\)\]]/.test(next)) {
      return true;
    }

    if (/\d/.test(previous) && /\d/.test(next)) return true;
    if (isAsciiDomainPeriod(text, dotIndex)) return true;

    const bounds = tokenBoundsAt(text, dotIndex);
    if (/[\\/]/.test(bounds.token)) {
      return true;
    }

    let start = dotIndex;
    while (start > 0 && /\p{L}/u.test(text[start - 1])) start -= 1;
    if (start === dotIndex) return false;

    const token = text.slice(start, dotIndex);
    const caseKey = `${token}.`;
    const nocaseKey = caseKey.toLowerCase();

    const caseMap = config?.abbreviations?.case || {};
    if (Object.prototype.hasOwnProperty.call(caseMap, caseKey)) {
      return true;
    }

    const nocaseMap = config?.abbreviations?.nocase || {};
    if (
      Object.keys(nocaseMap).some(
        (key) => String(key).toLowerCase() === nocaseKey
      )
    ) {
      return true;
    }

    if (token.length === 1) {
      // Lantern Leaf: interior initialism periods such as U.S.
      if (
        start >= 2 &&
        text[start - 1] === "." &&
        /\p{L}/u.test(text[start - 2])
      ) {
        return true;
      }

      // Lantern Leaf: first period when another X. follows.
      let cursor = dotIndex + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (
        cursor + 1 < text.length &&
        /\p{L}/u.test(text[cursor]) &&
        text[cursor + 1] === "."
      ) {
        return true;
      }

      // Lantern Leaf: middle initials such as James B. Allen.
      if (cursor < text.length && /\p{Lu}/u.test(text[cursor])) {
        return true;
      }
    }

    return false;
  }

  function trimRange(text, start, end) {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return start < end ? { start, end } : null;
  }

  function sentenceRanges(text, config = currentConfig) {
    const cfg = config === currentConfig ? currentConfig : normalizeConfig(config);
    const source = String(text || "");
    const ranges = [];
    const regexProtected = protectedPeriodIndices(source, cfg);
    let start = 0;

    for (let index = 0; index < source.length; index += 1) {
      const ch = source[index];
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      if (
        ch === "." &&
        periodIsProtected(source, index, cfg, regexProtected)
      ) {
        continue;
      }

      let end = index + 1;
      while (
        end < source.length &&
        /["'”’\)\]]/.test(source[end])
      ) {
        end += 1;
      }

      const range = trimRange(source, start, end);
      if (range) ranges.push(range);
      start = end;
      index = end - 1;
    }

    const tail = trimRange(source, start, source.length);
    if (tail) ranges.push(tail);

    if (ranges.length === 0 && /\S/.test(source)) {
      const whole = trimRange(source, 0, source.length);
      if (whole) ranges.push(whole);
    }

    return ranges;
  }

  function yearToWords(year, cfg) {
    if (!Number.isInteger(year) || year < 1000 || year > 2099) {
      return String(year);
    }

    const ones = [
      "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
    ];
    const teens = [
      "ten", "eleven", "twelve", "thirteen", "fourteen",
      "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"
    ];
    const tens = [
      "", "", "twenty", "thirty", "forty", "fifty",
      "sixty", "seventy", "eighty", "ninety"
    ];

    const thousands = Math.floor(year / 1000);
    const hundreds = Math.floor(year / 100) % 10;
    const remainder = year % 100;
    const parts = [];

    if (thousands > 0) parts.push(`${ones[thousands]} thousand`);
    if (hundreds > 0) parts.push(`${ones[hundreds]} hundred`);

    if (remainder > 0) {
      let remainderText;
      if (remainder < 10) {
        remainderText = ones[remainder];
      } else if (remainder < 20) {
        remainderText = teens[remainder - 10];
      } else {
        remainderText = tens[Math.floor(remainder / 10)];
        if (remainder % 10 > 0) {
          remainderText += ` ${ones[remainder % 10]}`;
        }
      }

      if (hundreds > 0 && cfg?.insertAnd) {
        parts.push(`and ${remainderText}`);
      } else {
        parts.push(remainderText);
      }
    }

    return parts.join(String(cfg?.numberSeparator ?? " "));
  }

  function applyYears(text, cfg) {
    if (cfg?.yearMode === "none") return text;
    return text.replace(/\b(1\d{3}|20\d{2})\b/g, (match) =>
      yearToWords(Number(match), cfg)
    );
  }

  function expandAcronymToken(match, letters, digits, cfg) {
    const sounds = cfg?.letterSounds || {};
    const letterSeparator = String(cfg?.letterSeparator ?? " ");
    const digitSeparator = String(cfg?.digitSeparator ?? " point ");

    const spokenLetters = String(letters || "")
      .split("")
      .filter((ch) => /[A-Za-z]/.test(ch))
      .map((ch) => sounds[ch.toUpperCase()] || ch.toUpperCase())
      .join(letterSeparator);

    let spokenDigits = "";
    if (digits) {
      spokenDigits = String(digits)
        .split(".")
        .map((group) =>
          group
            .split("")
            .filter((ch) => /\d/.test(ch))
            .map((ch) => sounds[ch] || ch)
            .join(letterSeparator)
        )
        .filter(Boolean)
        .join(digitSeparator);
    }

    return [spokenLetters, spokenDigits].filter(Boolean).join(" ") || match;
  }

  function applyAcronyms(text, cfg) {
    if (!cfg?.enabled) return text;
    let out = text;

    for (const token of cfg.tokens || []) {
      if (!token) continue;
      const pattern = new RegExp(
        `\\b(${escapeRegex(token)})(\\d+(?:\\.\\d+)*)?\\b`,
        "gi"
      );
      out = out.replace(pattern, (match, letters, digits) =>
        expandAcronymToken(match, letters, digits, cfg)
      );
    }

    return out;
  }

  function stripPathWrappers(value) {
    return String(value || "")
      .replace(/^[`'"([{]+/, "")
      .replace(/[`'")\]},;!?]+$/, "");
  }

  function looksLikeFilesystemPath(value) {
    const text = stripPathWrappers(value);
    if (/^[A-Za-z]+:\/\//.test(text)) return false;
    return /^(?:~\/|\/|\.{1,2}\/)/.test(text);
  }

  function expandFilesystemPath(value, technical) {
    let text = String(value || "");
    const leading = text.match(/^[`'"([{]+/)?.[0] || "";
    const trailing = text.match(/[`'")\]},;!?]+$/)?.[0] || "";
    if (leading) text = text.slice(leading.length);
    if (trailing) text = text.slice(0, -trailing.length);

    if (!looksLikeFilesystemPath(text)) return value;

    let rootLabel = "";
    if (text.startsWith("~/")) {
      rootLabel = "home directory";
      text = text.slice(2);
    } else if (text.startsWith("../")) {
      rootLabel = "parent directory";
      text = text.slice(3);
    } else if (text.startsWith("./")) {
      rootLabel = "current directory";
      text = text.slice(2);
    } else if (text.startsWith("/")) {
      rootLabel = "root";
      text = text.slice(1);
    }

    const words = technical?.pathWords || {};
    const slash = words["/"] || "slash";
    const dot = words["."] || "dot";
    const underscore = words["_"] || "underscore";
    const dash = words["-"] || "dash";
    const separator = technical?.pauseBetweenPathComponents === false
      ? ` ${slash} `
      : `, ${slash}, `;

    const components = text.split("/").map((component) => {
      if (!component) return "";
      if (component === "...") return "ellipsis";

      let spoken = component;
      if (spoken.startsWith(".") && spoken.length > 1) {
        spoken = `${dot} ${spoken.slice(1)}`;
      }

      spoken = spoken
        .replace(/\.{3}/g, " ellipsis ")
        .replace(/\./g, ` ${dot} `)
        .replace(/_/g, ` ${underscore} `)
        .replace(/-/g, ` ${dash} `)
        .replace(/\s+/g, " ")
        .trim();
      return spoken;
    }).filter(Boolean);

    const parts = [];
    if (rootLabel) parts.push(rootLabel);
    if (components.length > 0) {
      if (parts.length > 0) {
        parts.push(components.join(separator));
      } else {
        parts.push(components.join(separator));
      }
    }

    let spokenPath = parts.join(rootLabel ? separator : "");
    if (trailing) spokenPath += ` ${trailing}`;
    return spokenPath.trim();
  }

  function expandShellFlag(value) {
    const match = String(value || "").match(/^(-{1,2})([A-Za-z][A-Za-z0-9-]*)([.,;:!?]?)$/);
    if (!match) return value;
    const dashes = match[1].length === 2 ? "dash dash" : "dash";
    const body = match[2].replace(/-/g, " dash ");
    return `${dashes} ${body}${match[3] ? ` ${match[3]}` : ""}`.trim();
  }

  function recordTransform(list, ruleClass, ruleId, before, after) {
    if (before === after) return after;
    list.push({
      ruleClass,
      ruleId,
      sourceText: before,
      spokenText: after
    });
    return after;
  }

  function transformToken(input, config = currentConfig) {
    const transformations = [];
    const cfg = config || currentConfig;

    if (!cfg.enabled) {
      return { spokenText: String(input || ""), transformations };
    }

    let text = String(input || "");

    let next = normalizeUnicodePunctuation(text);
    text = recordTransform(transformations, "cleanup", "unicode-punctuation", text, next);

    if (cfg.normalization?.stripInlineCode) {
      next = text.replace(/^`(.+)`$/s, "$1");
      text = recordTransform(transformations, "cleanup", "strip-inline-code", text, next);
    }

    if (cfg.normalization?.stripMarkdownLinks) {
      next = text.replace(/^\[([^\]]+)\]\([^)]*\)$/s, "$1");
      text = recordTransform(transformations, "cleanup", "strip-markdown-link", text, next);
    }

    if (
      cfg.normalization?.dropNumericBracketCitations &&
      /^\[\s*\d+(?:\s*,\s*\d+)*\s*\][.,;:!?]?$/.test(text)
    ) {
      text = recordTransform(transformations, "drop", "numeric-bracket-citation", text, "");
    }

    if (
      text &&
      cfg.normalization?.dropParentheticalNumericCitations &&
      /^\(\s*\d+(?:\s*,\s*\d+)*\s*\)[.,;:!?]?$/.test(text)
    ) {
      text = recordTransform(transformations, "drop", "parenthetical-numeric-citation", text, "");
    }

    if (text && cfg.normalization?.dropSuperscriptCitations) {
      next = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, "");
      text = recordTransform(transformations, "drop", "superscript-citation", text, next);
    }

    if (text && cfg.normalization?.dropWordSuffixNumericFootnotes) {
      next = text.replace(/(\p{L})\d{1,3}\b/gu, "$1");
      text = recordTransform(transformations, "drop", "word-suffix-footnote", text, next);
    }

    if (
      text &&
      cfg.normalization?.dropSquareBracketText &&
      /^(?:\[[^\]]*\]|【[^】]*】|［[^］]*］)[.,;:!?]?$/.test(text)
    ) {
      text = recordTransform(transformations, "drop", "square-bracket-text", text, "");
    }

    if (
      text &&
      cfg.normalization?.dropCurlyBraceText &&
      /^\{[^}]+\}[.,;:!?]?$/.test(text)
    ) {
      text = recordTransform(transformations, "drop", "curly-brace-text", text, "");
    }

    if (text && cfg.technical?.expandFilesystemPaths && looksLikeFilesystemPath(text)) {
      next = expandFilesystemPath(text, cfg.technical);
      text = recordTransform(transformations, "technical", "filesystem-path", text, next);
    }

    if (text && cfg.technical?.expandShellFlags) {
      next = expandShellFlag(text);
      text = recordTransform(transformations, "technical", "shell-flag", text, next);
    }

    if (text) {
      next = applyRegexRules(text, cfg.abbreviations?.regex);
      text = recordTransform(transformations, "abbreviation", "regex-rules", text, next);

      next = applyLiteralMap(text, cfg.abbreviations?.case, false);
      text = recordTransform(transformations, "abbreviation", "case-map", text, next);

      next = applyLiteralMap(text, cfg.abbreviations?.nocase, true);
      text = recordTransform(transformations, "abbreviation", "nocase-map", text, next);
    }

    if (text) {
      const entries = Object.entries(cfg.normalization?.replacements || {}).sort(
        ([left], [right]) => right.length - left.length
      );
      for (const [from, to] of entries) {
        if (!from) continue;
        next = text.split(from).join(to);
        text = recordTransform(
          transformations,
          "replacement",
          `literal:${from}`,
          text,
          next
        );
      }
    }

    for (const token of cfg.normalization?.dropTokens || []) {
      if (!text || !token) continue;
      next = text.split(token).join(" ");
      text = recordTransform(
        transformations,
        "drop",
        `token:${token}`,
        text,
        next
      );
    }

    if (text && cfg.pronunciation?.enableBrandMap) {
      next = applyLiteralMap(text, cfg.pronunciation?.brandMap, false);
      text = recordTransform(transformations, "pronunciation", "brand-map", text, next);
    }

    if (text) {
      next = applyLiteralMap(text, cfg.pronunciation?.customPronunciations, false);
      text = recordTransform(
        transformations,
        "pronunciation",
        "custom-pronunciations",
        text,
        next
      );

      next = applyYears(text, cfg.pronunciation);
      text = recordTransform(transformations, "pronunciation", "year", text, next);

      next = applyAcronyms(text, cfg.acronyms);
      text = recordTransform(transformations, "pronunciation", "acronym", text, next);
    }

    if (cfg.normalization?.collapseWhitespace) {
      next = text.replace(/[\t\r\n ]+/g, " ");
      text = recordTransform(transformations, "cleanup", "collapse-whitespace", text, next);
    }

    if (cfg.normalization?.removeSpaceBeforePunctuation) {
      next = text.replace(/\s+([,.;:!?])/g, "$1");
      text = recordTransform(
        transformations,
        "cleanup",
        "space-before-punctuation",
        text,
        next
      );
    }

    return { spokenText: text.trim(), transformations };
  }

  function needsSpeechBoundary(result) {
    return (result?.transformations || []).some((item) =>
      [
        "acronym",
        "brand-map",
        "shell-flag",
        "filesystem-path"
      ].includes(String(item?.ruleId || ""))
    );
  }

  function speechSafeSeparator(
    previousResult,
    currentResult,
    previousSourceSegment,
    currentSourceSegment,
    separatorForSegments
  ) {
    const normalSeparator = typeof separatorForSegments === "function"
      ? separatorForSegments(previousSourceSegment, currentSourceSegment)
      : " ";

    if (
      needsSpeechBoundary(previousResult) &&
      needsSpeechBoundary(currentResult)
    ) {
      return ", ";
    }

    return normalSeparator;
  }

  function projectSegments(segments, separatorForSegments, config = currentConfig) {
    const cfg = config === currentConfig ? currentConfig : normalizeConfig(config);
    const projectedSegments = [];
    const starts = [];
    const transformations = [];
    let text = "";
    let previousSourceSegment = null;
    let previousResult = null;

    for (const segment of segments || []) {
      const result = transformToken(segment?.text || "", cfg);
      if (!result.spokenText) continue;

      if (projectedSegments.length > 0) {
        text += speechSafeSeparator(
          previousResult,
          result,
          previousSourceSegment,
          segment,
          separatorForSegments
        );
      }

      starts.push(text.length);
      text += result.spokenText;
      projectedSegments.push(segment);

      for (const transformation of result.transformations) {
        transformations.push({
          ...transformation,
          blockIndex: segment?.blockIndex,
          segmentIndex: segment?.segmentIndex,
          sourceSegmentText: segment?.text || ""
        });
      }

      previousSourceSegment = segment;
      previousResult = result;
    }

    const normalizedText = text.trim();
    const minimumChars = Math.max(
      0,
      Number(cfg.normalization?.minSentenceChars) || 0
    );
    const hasRequiredContent =
      cfg.normalization?.requireAlphanumeric === false ||
      /[\p{L}\p{N}]/u.test(normalizedText);

    if (
      !hasRequiredContent ||
      (minimumChars > 0 && normalizedText.length < minimumChars)
    ) {
      return {
        text: "",
        starts: [],
        segments: [],
        transformations: [
          ...transformations,
          {
            ruleClass: "drop",
            ruleId: "sentence-content-filter",
            sourceText: text,
            spokenText: ""
          }
        ]
      };
    }

    return {
      text: normalizedText,
      starts,
      segments: projectedSegments,
      transformations,
      configRevision: Number(cfg.revision) || 0,
      configSavedAt: Number(cfg.savedAt) || 0
    };
  }

  function transformText(text, config = currentConfig) {
    const tokens = String(text || "").match(/\S+/g) || [];
    const segments = tokens.map((token, index) => ({
      text: token,
      blockIndex: 0,
      segmentIndex: index
    }));
    return projectSegments(segments, () => " ", config);
  }

  if (root.chrome?.storage?.onChanged?.addListener) {
    root.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes?.[STORAGE_KEY]) return;
      currentConfig = normalizeConfig(changes[STORAGE_KEY].newValue);
    });
  }

  return {
    STORAGE_KEY,
    cloneDefaultConfig: cloneDefaults,
    normalizeConfig,
    getConfig,
    loadConfig,
    saveConfig,
    resetConfig,
    setConfigForTests,
    normalizeUnicodePunctuation,
    sentenceRanges,
    periodIsProtected,
    looksLikeFilesystemPath,
    expandFilesystemPath,
    expandShellFlag,
    yearToWords,
    transformToken,
    transformText,
    projectSegments
  };
});
