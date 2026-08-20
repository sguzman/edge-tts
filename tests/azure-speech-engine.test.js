const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  SpeechEngine: require("../src/content/speech-engine.js")
};

const {
  createSsml,
  findSegmentForBoundary,
  normalizeAzureVoice,
  rateToSsml
} = require("../src/content/azure-speech-engine.js");

test("Azure voices are normalized into unified voice descriptors", () => {
  const voice = normalizeAzureVoice({
    shortName: "en-US-JennyNeural",
    localName: "Jenny",
    locale: "en-US",
    styleList: ["chat"]
  });

  assert.equal(voice.id, "azure:en-US-JennyNeural");
  assert.equal(voice.name, "Jenny");
  assert.equal(voice.lang, "en-US");
  assert.equal(voice.provider, "Azure");
  assert.deepEqual(voice.styles, ["chat"]);
});

test("SSML rate follows the reader rate control", () => {
  assert.equal(rateToSsml(0.5), "-50%");
  assert.equal(rateToSsml(1), "+0%");
  assert.equal(rateToSsml(2), "+100%");
});

test("SSML escapes page text and selects the Azure voice", () => {
  const ssml = createSsml("Cats & <dogs>", {
    lang: "en-US",
    shortName: "en-US-JennyNeural"
  }, 1.2);

  assert.match(ssml, /voice name="en-US-JennyNeural"/);
  assert.match(ssml, /rate="\+20%"/);
  assert.match(ssml, /Cats &amp; &lt;dogs&gt;/);
});

test("Azure word events map back to punctuation-bearing model segments", () => {
  const payload = {
    segments: [
      { text: "Hello," },
      { text: "world!" },
      { text: "Again." }
    ]
  };

  const first = findSegmentForBoundary(payload, "Hello", 0);
  const second = findSegmentForBoundary(payload, "world", first.index + 1);

  assert.equal(first.segment.text, "Hello,");
  assert.equal(second.segment.text, "world!");
});
