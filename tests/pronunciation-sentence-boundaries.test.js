const test = require("node:test");
const assert = require("node:assert/strict");

delete global.EdgeTtsExtension;
delete global.EdgeTtsPronunciation;
delete global.EdgeTtsPronunciationDefaults;

require("../src/pronunciation/defaults.js");
const pronunciation = require("../src/pronunciation/engine.js");

function sentences(text) {
  return pronunciation.sentenceRanges(text).map((range) =>
    text.slice(range.start, range.end)
  );
}

test("Lantern Leaf sentence model protects abbreviations and initials", () => {
  assert.deepEqual(
    sentences("Mr. Smith walked in. Mrs. Jones stayed."),
    ["Mr. Smith walked in.", "Mrs. Jones stayed."]
  );
  assert.deepEqual(
    sentences("This uses U.S. spelling. Next sentence."),
    ["This uses U.S. spelling.", "Next sentence."]
  );
  assert.deepEqual(
    sentences("James B. Allen wrote this. Next sentence."),
    ["James B. Allen wrote this.", "Next sentence."]
  );
});

test("Lantern Leaf sentence model protects decimals domains and filenames", () => {
  assert.deepEqual(
    sentences("Pi is about 3.14159 and e is 2.71828. Next sentence."),
    ["Pi is about 3.14159 and e is 2.71828.", "Next sentence."]
  );
  assert.deepEqual(
    sentences("Visit example.com and sample.org now. Next sentence."),
    ["Visit example.com and sample.org now.", "Next sentence."]
  );
  assert.deepEqual(
    sentences("Open cat.txt and dog.html before reading book.epub or paper.pdf with notes.md. Next sentence."),
    [
      "Open cat.txt and dog.html before reading book.epub or paper.pdf with notes.md.",
      "Next sentence."
    ]
  );
});

test("configured abbreviations and Linux paths never become fake sentences", () => {
  assert.deepEqual(
    sentences("He moved to Calif. in 1990. Next sentence."),
    ["He moved to Calif. in 1990.", "Next sentence."]
  );
  assert.deepEqual(
    sentences("The visible token ~/.config/fish/config.fish remains canonical. Next sentence."),
    [
      "The visible token ~/.config/fish/config.fish remains canonical.",
      "Next sentence."
    ]
  );
});

test("rule maps are replacement collections so deleted defaults stay deleted", () => {
  const config = pronunciation.normalizeConfig({
    pronunciation: {
      customPronunciations: {}
    },
    abbreviations: {
      case: {}
    }
  });

  assert.deepEqual(config.pronunciation.customPronunciations, {});
  assert.deepEqual(config.abbreviations.case, {});
});
