const test = require("node:test");
const assert = require("node:assert/strict");

class MockReliableSpeechEngine {
  constructor() {
    this.generation = 0;
    this.currentUtterance = null;
    this.currentChunks = [];
    this.currentChunkIndex = -1;
    this.currentChunkBoundaryIndex = -1;
    this.currentOptions = null;
    this.recoveryKey = "";
    this.recoveryAttempts = 0;
  }

  clearPlaybackTimers() {}
  cancel() {
    this.generation += 1;
    this.currentUtterance = null;
  }
  abandon() {
    this.generation += 1;
    this.currentUtterance = null;
  }
  pause() {}
  resume() {}
  isPaused() {
    return false;
  }
  isSpeaking() {
    return false;
  }
  speak() {
    this.nativeSpeakCalled = true;
  }
}

global.EdgeTtsExtension = {
  SpeechEngine: { SpeechEngine: MockReliableSpeechEngine }
};

const {
  DirectAudioSpeechEngine,
  MAX_OUTPUT_GAIN,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  OUTPUT_FORMAT,
  buildSpeechConfig,
  buildSsmlRequest,
  edgeShortNameForVoice,
  isDirectVoice,
  mapBoundariesToSegments,
  parseMetadata,
  splitSegmentsForService,
  textForSegments
} = require("../src/content/direct-audio-engine.js");

test("Natural and Online voices select the direct MP3 backend", () => {
  assert.equal(isDirectVoice({ name: "Microsoft Aria Online (Natural)" }), true);
  assert.equal(isDirectVoice({ name: "Microsoft David Desktop" }), false);
});

test("Edge Web Speech Natural names map to Read Aloud short names", () => {
  assert.equal(
    edgeShortNameForVoice({
      name: "Microsoft Aria Online (Natural) - English (United States)",
      lang: "en-US"
    }),
    "en-US-AriaNeural"
  );
  assert.equal(
    edgeShortNameForVoice({
      name: "Microsoft AvaMultilingual Online (Natural) - English (United States)",
      lang: "en-US"
    }),
    "en-US-AvaMultilingualNeural"
  );
});

test("direct synthesis always requests normal prosody and MP3 with word metadata", () => {
  const config = buildSpeechConfig("timestamp");
  assert.match(config, new RegExp(OUTPUT_FORMAT));
  assert.match(config, /wordBoundaryEnabled":"true"/);

  const request = buildSsmlRequest(
    "request-id",
    "timestamp",
    "en-US-AriaNeural",
    "alpha & <beta>"
  );
  assert.match(request, /rate='\+0%'/);
  assert.match(request, /volume='\+0%'/);
  assert.match(request, /alpha &amp; &lt;beta&gt;/);
});

test("service batching preserves paragraph separators and model segments", () => {
  const segments = [
    { blockIndex: 0, segmentIndex: 0, text: "hello" },
    { blockIndex: 0, segmentIndex: 1, text: "world" },
    { blockIndex: 1, segmentIndex: 0, text: "next" }
  ];
  assert.equal(textForSegments(segments), "hello world\n\nnext");
  const groups = splitSegmentsForService(segments, 20);
  assert.ok(groups.length >= 1);
  assert.deepEqual(groups.flatMap((group) => group.segments), segments);
});

test("word metadata maps back onto model tokens on the media timeline", () => {
  const metadata = parseMetadata(
    JSON.stringify({
      Metadata: [
        {
          Type: "WordBoundary",
          Data: { Offset: 5_000_000, Duration: 2_000_000, text: { Text: "Hello" } }
        },
        {
          Type: "WordBoundary",
          Data: { Offset: 9_000_000, Duration: 1_000_000, text: { Text: "world" } }
        }
      ]
    })
  );
  const segments = [
    { blockIndex: 0, segmentIndex: 0, text: "Hello," },
    { blockIndex: 0, segmentIndex: 1, text: "world!" }
  ];
  const mapped = mapBoundariesToSegments(metadata, segments, 2);

  assert.equal(mapped[0].segment, segments[0]);
  assert.equal(mapped[1].segment, segments[1]);
  assert.equal(mapped[0].offsetSeconds, 2.5);
  assert.equal(mapped[1].offsetSeconds, 2.9);
});

test("direct playback exposes high client-side rate and gain without resynthesis", () => {
  const engine = new DirectAudioSpeechEngine({});
  engine.directSessionMode = true;
  engine.directAudio = { playbackRate: 1, volume: 1 };
  engine.directGain = { gain: { value: 1 } };

  assert.equal(MIN_PLAYBACK_RATE, 0.25);
  assert.equal(MAX_PLAYBACK_RATE, 16);
  assert.equal(MAX_OUTPUT_GAIN, 2);
  assert.equal(engine.setPlaybackRate(7.5), true);
  assert.equal(engine.directAudio.playbackRate, 7.5);
  assert.equal(engine.setOutputVolume(1.8), true);
  assert.equal(engine.directGain.gain.value, 1.8);
  assert.equal(engine.directAudio.volume, 1);
});

test("local Windows voices still delegate to the existing Web Speech engine", () => {
  const engine = new DirectAudioSpeechEngine({});
  engine.speak(
    { segments: [{ blockIndex: 0, segmentIndex: 0, text: "hello" }] },
    0,
    { voice: { name: "Microsoft David Desktop", lang: "en-US" }, rate: 1 }
  );
  assert.equal(engine.nativeSpeakCalled, true);
});
