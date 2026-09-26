const test = require("node:test");
const assert = require("node:assert/strict");

test("stacked speech backends can cancel and abandon while idle without recursion", () => {
  global.EdgeTtsExtension = {};
  global.speechSynthesis = undefined;
  global.chrome = undefined;

  const modules = [
    "../src/content/speech-engine.js",
    "../src/content/reliable-speech-engine.js",
    "../src/content/direct-audio-engine.js",
    "../src/content/win-natural-engine.js",
    "../src/content/linux-piper-engine.js",
    "../src/content/local-tts-engine.js"
  ];

  for (const modulePath of modules) {
    delete require.cache[require.resolve(modulePath)];
    require(modulePath);
  }

  const Engine = global.EdgeTtsExtension.SpeechEngine.SpeechEngine;
  const engine = new Engine({
    onBoundary() {},
    onEnd() {},
    onError() {},
    onStart() {}
  });

  assert.doesNotThrow(() => engine.cancel());
  assert.doesNotThrow(() => engine.abandon());
});
