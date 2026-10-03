const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
);
const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const piper = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "linux-piper-engine.js"),
  "utf8"
);
const bootstrap = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "content-script.js"),
  "utf8"
);
const offscreen = fs.readFileSync(
  path.join(__dirname, "..", "src", "offscreen", "piper-audio.js"),
  "utf8"
);

test("pronunciation branch can create an extension-owned audio document", () => {
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /reasons: \["AUDIO_PLAYBACK"\]/);
  assert.match(background, /src\/offscreen\/piper-audio\.html/);
});

test("Piper uses tab-owned audio as primary playback and keeps offscreen as fallback", () => {
  const start = piper.indexOf("    _playLinuxPiperPrepared(generation, prepared) {");
  const end = piper.indexOf("    _failLinuxPiper(message) {", start);
  const body = piper.slice(start, end);

  assert.match(body, /Tab\.audible/);
  assert.match(body, /createElement\\?\\.\\("audio"\\)/);
  assert.match(body, /audio\.play\(\)/);
  assert.match(body, /startOffscreenFallback/);
  assert.match(body, /_playLinuxPiperPreparedOffscreen/);
  assert.match(piper, /EDGE_TTS_PIPER_OFFSCREEN_PLAY/);
});

test("offscreen Piper events are routed back to the page reader", () => {
  assert.match(background, /EDGE_TTS_OFFSCREEN_PIPER_EVENT/);
  assert.match(background, /EDGE_TTS_PIPER_OFFSCREEN_EVENT/);
  assert.match(bootstrap, /handleLinuxPiperOffscreenEvent/);
  assert.match(piper, /handleLinuxPiperOffscreenEvent/);
});

test("extension-owned player supports transport and timing", () => {
  assert.match(offscreen, /audio\.play\(\)/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_PAUSE/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_RESUME/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_STOP/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_RATE/);
  assert.match(offscreen, /EDGE_TTS_OFFSCREEN_PIPER_VOLUME/);
  assert.match(offscreen, /type: "boundary"/);
});


test("offscreen media clock emits canonical boundary indices", () => {
  assert.match(offscreen, /boundaryOffsets/);
  assert.match(offscreen, /type: "boundary"/);
  assert.match(offscreen, /boundaryIndex \+= 1/);
  assert.match(piper, /boundaryOffsets: this\.directBoundaries\.map/);
  assert.match(piper, /linux-piper-offscreen-boundary/);
});

test("Piper force-loads persisted pronunciation config before creating chunks", () => {
  const speakAt = piper.indexOf("    speak(block, startSegmentIndex, options = {}) {");
  const beginAt = piper.indexOf("    _beginLinuxPiperSpeak", speakAt);
  const body = piper.slice(speakAt, beginAt);
  assert.match(body, /loadConfig\?\.\(\{ force: true \}\)/);
  assert.match(body, /Loading pronunciation rules/);
});


test("tab-owned playback serializes autoplay refusal against offscreen fallback", () => {
  const playStart = piper.indexOf("    _playLinuxPiperPrepared(generation, prepared) {");
  const failStart = piper.indexOf("    _failLinuxPiper(message) {", playStart);
  const body = piper.slice(playStart, failStart);

  assert.match(body, /let pagePlaybackState = "starting"/);
  assert.match(body, /let pendingMediaError = null/);
  assert.match(body, /Never hand off while audio\.play\(\) is still settling/);
  assert.match(body, /error\?\.name === "NotAllowedError"/);
  assert.match(body, /pagePlaybackState = "blocked"/);
  assert.match(body, /this\.onPlaybackBlocked\?\.\(error\)/);
  assert.match(body, /pagePlaybackState === "playing"[\s\S]*?startOffscreenFallback/);
});


test("background relay preserves Piper boundary offsets for offscreen highlighting", () => {
  const routeAt = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PLAY"');
  const nextRoute = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE"', routeAt);
  const body = background.slice(routeAt, nextRoute);
  assert.match(body, /boundaryOffsets:/);
  assert.match(body, /message\.boundaryOffsets/);
  assert.match(body, /EDGE_TTS_OFFSCREEN_PIPER_PLAY/);
});


test("resume cannot report success without an explicit live-player acknowledgement", () => {
  const routeAt = background.indexOf(
    'message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE"'
  );
  const nextRoute = background.indexOf(
    'message?.type === "EDGE_TTS_OPEN_PRONUNCIATION_OPTIONS"',
    routeAt
  );
  const body = background.slice(routeAt, nextRoute);

  assert.match(body, /response\?\.accepted === true/);
  assert.match(
    body,
    /Offscreen Piper playback did not acknowledge the command/
  );
  assert.doesNotMatch(
    body,
    /response \|\| \{ accepted: true \}/
  );
});

test("offscreen player carries the owning tab so event routing survives worker restart", () => {
  assert.match(offscreen, /let ownerTabId = null/);
  assert.match(offscreen, /tabId: ownerTabId/);
  assert.match(background, /const eventTabId = Number\(message\.tabId\)/);
  assert.match(background, /Rehydrate in-memory routing after a service-worker restart/);
});

test("Piper in-place resume waits for confirmed audio playback", () => {
  const start = piper.indexOf("    resumeInPlace() {");
  const end = piper.indexOf("    speak(block, startSegmentIndex, options = {}) {", start);
  const body = piper.slice(start, end);

  assert.match(body, /return Promise\.resolve/);
  assert.match(body, /response\?\.accepted/);
  assert.match(body, /Resume session expired — restoring audio checkpoint/);
  assert.match(body, /startTimeSeconds: checkpoint/);
  assert.match(body, /return false/);
});


test("Piper resume acknowledgement is bounded and falls back instead of hanging", () => {
  const start = piper.indexOf("    resumeInPlace() {");
  const end = piper.indexOf("    speak(block, startSegmentIndex, options = {}) {", start);
  const body = piper.slice(start, end);

  assert.match(body, /Promise\.race\(\[resumeCommand, resumeTimeout\]\)/);
  assert.match(body, /1500/);
  assert.match(body, /resume acknowledgement timed out/);
});


test("sentence pause is applied exactly once for both tab and offscreen playback", () => {
  assert.match(piper, /pauseAlreadyApplied/);
  assert.match(piper, /this\.linuxPiperSentencePauseTimer = root\.setTimeout/);
  assert.match(piper, /sentencePauseMs: prepared\.payload\?\.sentenceFinal === false/);
  assert.match(background, /sentencePauseMs: Math\.max/);
  assert.match(offscreen, /let sentencePauseMs = 0/);
  assert.match(offscreen, /type: "sentencePause"/);
  assert.match(offscreen, /setTimeout\(\(\) =>/);
  assert.match(offscreen, /sentencePauseMs/);
});

test("offscreen ended events tell the reader that their sentence pause already elapsed", () => {
  const start = piper.indexOf('      if (event.type === "ended")');
  const end = piper.indexOf('      if (event.type === "stopped")', start);
  const body = piper.slice(start, end);
  assert.match(body, /pauseAlreadyApplied: true/);
});


test("pronunciation tester treats paused reader playback as idle", () => {
  assert.match(background, /function pausedLinuxPiperTabIds\(\)/);
  assert.match(background, /session\?\.state === "paused"/);
  assert.match(background, /function activeLinuxPiperReaderUse\(\)/);
  assert.match(
    background,
    /session\?\.state !== "paused"/
  );
  assert.match(background, /cancelPausedLinuxPiperPrefetch\(\)/);
  assert.doesNotMatch(
    background,
    /linuxPiperOffscreenSessions\.size > 0/
  );
});

test("offscreen reader sessions track real playing and paused state", () => {
  assert.match(background, /state: "starting"/);
  assert.match(background, /eventType === "paused"/);
  assert.match(background, /"sentence-pause"/);
  assert.match(background, /\["started", "resumed", "boundary"\]\.includes\(eventType\)/);
  assert.match(
    background,
    /message\.type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE"[\s\S]*?session\.state = "paused"/
  );
  assert.match(
    background,
    /message\.type === "EDGE_TTS_PIPER_OFFSCREEN_RESUME"[\s\S]*?session\.state = "playing"/
  );
});

test("new global offscreen playback forgets superseded stale session ids", () => {
  assert.match(background, /function forgetSupersededOffscreenSessions/);
  assert.match(background, /reason: "superseded"/);
  assert.match(
    background,
    /forgetSupersededOffscreenSessions\(playbackId\)/
  );
});


test("long-paused Piper resumes from a media checkpoint when the offscreen document expires", () => {
  const resumeStart = piper.indexOf("    resumeInPlace() {");
  const speakStart = piper.indexOf("    speak(block, startSegmentIndex, options = {}) {", resumeStart);
  const body = piper.slice(resumeStart, speakStart);

  assert.match(body, /Resume session expired — restoring audio checkpoint/);
  assert.match(body, /startTimeSeconds: checkpoint/);
  assert.match(body, /alreadyStarted/);
  assert.match(body, /failOnReject: false/);
  assert.match(body, /resume transport recovery/);
});

test("offscreen Piper preserves and restores paused media time", () => {
  assert.match(offscreen, /let pausedCurrentTime = null/);
  assert.match(offscreen, /pausedCurrentTime = Math\.max/);
  assert.match(offscreen, /currentTime: pausedCurrentTime/);
  assert.match(offscreen, /restorePlaybackCheckpoint/);
  assert.match(offscreen, /audio\.currentTime = target/);
  assert.match(offscreen, /boundaryIndexAfterTime/);
});

test("background relays the Piper checkpoint into replacement offscreen playback", () => {
  const routeAt = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PLAY"');
  const nextRoute = background.indexOf('message?.type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE"', routeAt);
  const body = background.slice(routeAt, nextRoute);

  assert.match(body, /startTimeSeconds:/);
  assert.match(body, /message\.startTimeSeconds/);
});


test("native tab-audible support comes from real tab media, not a fake tabs API flag", () => {
  const start = piper.indexOf("    _playLinuxPiperPrepared(generation, prepared) {");
  const end = piper.indexOf("    _failLinuxPiper(message) {", start);
  const body = piper.slice(start, end);

  assert.match(body, /the normal Piper reader path must render audio in this tab/);
  assert.match(body, /audio\.src = this\.directObjectUrl/);
  assert.doesNotMatch(body, /tabs\.update[\s\S]*audible/);
});
