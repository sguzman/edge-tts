const test = require("node:test");
const assert = require("node:assert/strict");

delete global.EdgeTtsExtension;
delete global.EdgeTtsPronunciation;
delete global.EdgeTtsPronunciationDefaults;

const defaults = require("../src/pronunciation/defaults.js");
const pronunciation = require("../src/pronunciation/engine.js");

test("Lantern Leaf pronunciation defaults survive the port", () => {
  const config = defaults.cloneDefaultConfig();

  assert.equal(config.pronunciation.brandMap.SQLite, "S Q Lite");
  assert.equal(config.pronunciation.customPronunciations.Cato, "Kay toe");
  assert.equal(config.abbreviations.case["Dr."], "Doctor");
  assert.equal(config.abbreviations.case["p."], "page");
  assert.ok(config.acronyms.tokens.includes("GPU"));
  assert.equal(config.acronyms.letterSounds.G, "jee");
  assert.equal(config.normalization.replacements["%"], " percent ");
});

test("Linux paths and shell flags become stable spoken projections", () => {
  const result = pronunciation.transformText(
    "readlink -f ~/.config/fish/config.fish"
  );

  assert.equal(
    result.text,
    "read link dash f home directory slash dot config slash fish slash config dot fish"
  );
  assert.ok(
    result.transformations.some((item) => item.ruleId === "filesystem-path")
  );
  assert.ok(
    result.transformations.some((item) => item.ruleId === "shell-flag")
  );
});

test("abbreviations, brands, years, acronyms, and custom pronunciations compose", () => {
  const result = pronunciation.transformText(
    "Dr. Cato uses GPU JSON SQLite MySQL on p. 42 in 2026."
  );

  assert.equal(
    result.text,
    "Doctor Kay toe uses jee pee you jay ess oh en S Q Lite My S Q L on page 42 in two thousand twenty six."
  );
});

test("spoken expansion preserves canonical source segment identity", () => {
  const pathSegment = {
    text: "~/.config/fish/config.fish",
    blockIndex: 3,
    sentenceIndex: 2,
    segmentIndex: 5
  };
  const gpuSegment = {
    text: "GPU",
    blockIndex: 3,
    sentenceIndex: 2,
    segmentIndex: 6
  };

  const result = pronunciation.projectSegments(
    [pathSegment, gpuSegment],
    () => " "
  );

  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0], pathSegment);
  assert.equal(result.segments[1], gpuSegment);
  assert.equal(result.starts[0], 0);
  assert.ok(result.starts[1] > "~/.config/fish/config.fish".length);
  assert.match(result.text, /^home directory slash/);
  assert.match(result.text, /jee pee you$/);
});

test("Lantern Leaf citation and footnote cleanup rules remain available", () => {
  const source = pronunciation.transformText(
    "word12 [1,2] other⁴ 【citation】 {aside} keep"
  );

  assert.equal(source.text, "word keep");
});

test("normalization can be disabled without changing canonical token text", () => {
  const config = defaults.cloneDefaultConfig();
  config.enabled = false;
  const result = pronunciation.transformText(
    "GPU ~/.config/fish/config.fish",
    config
  );

  assert.equal(result.text, "GPU ~/.config/fish/config.fish");
  assert.deepEqual(result.transformations, []);
});
