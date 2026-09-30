const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const host = fs.readFileSync(
  path.join(__dirname, "..", "native", "linux-piper", "linux_piper_host.py"),
  "utf8"
);
const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const installer = fs.readFileSync(
  path.join(__dirname, "..", "native", "linux-piper", "install-native-host.sh"),
  "utf8"
);

test("native host handshakes before importing Piper and onnxruntime", () => {
  const ensureAt = host.indexOf("def ensure_piper_runtime()");
  const importAt = host.indexOf("from piper import PiperVoice");
  const helloAt = host.indexOf('if message_type == "hello":');
  const warmAt = host.indexOf("start_default_voice_warmup()", helloAt);
  const mainAt = host.indexOf("def main()");

  assert.ok(ensureAt >= 0);
  assert.ok(importAt > ensureAt, "Piper import must be lazy inside ensure_piper_runtime");
  assert.ok(helloAt >= 0);
  assert.ok(warmAt > helloAt, "warm-up must begin only after hello handling");
  assert.ok(mainAt >= 0);

  const mainBody = host.slice(mainAt, host.indexOf('if __name__ == "__main__":', mainAt));
  assert.doesNotMatch(mainBody, /start_default_voice_warmup\(\)/);
});

test("browser handshake rejects real disconnects and uses a tolerant timeout", () => {
  assert.match(background, /linuxPiperHandshakeReject/);
  assert.match(background, /Linux Piper helper disconnected before handshake completed/);
  assert.match(background, /15_000/);
  assert.match(background, /handshake timed out after 15 seconds/);
});


test("installer can auto-detect the unpacked Edge ID from the current repo path", () => {
  assert.match(installer, /REPO_ROOT=.*SCRIPT_DIR\/\.\.\/\.\./);
  assert.match(installer, /Auto-detecting Edge extension ID/);
  assert.match(installer, /"Preferences", "Secure Preferences"/);
  assert.match(installer, /candidate == repo_root/);
  assert.match(installer, /Using Edge extension ID/);
});

test("native host errors identify the requesting runtime extension ID", () => {
  assert.match(background, /chrome\.runtime\?\.id/);
  assert.match(background, /extension \$\{runtimeId\}/);
});
