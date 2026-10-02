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
const engine = fs.readFileSync(
  path.join(__dirname, "..", "src", "pronunciation", "engine.js"),
  "utf8"
);
const options = fs.readFileSync(
  path.join(__dirname, "..", "src", "options", "pronunciation.js"),
  "utf8"
);

test("pronunciation config has an extension-ID-independent durable backup", () => {
  assert.match(host, /PRONUNCIATION_CONFIG_PATH = APP_HOME \/ "pronunciation-config\.json"/);
  assert.match(host, /PRONUNCIATION_HISTORY_DIR = APP_HOME \/ "pronunciation-history"/);
  assert.match(host, /MAX_PRONUNCIATION_HISTORY = 20/);
  assert.match(host, /def write_pronunciation_config/);
  assert.match(host, /_archive_pronunciation_config/);
  assert.match(host, /os\.replace\(temp_path, path\)/);
});

test("background bridges durable pronunciation backup reads and writes", () => {
  assert.match(background, /EDGE_TTS_PRONUNCIATION_BACKUP_READ/);
  assert.match(background, /EDGE_TTS_PRONUNCIATION_BACKUP_WRITE/);
  assert.match(background, /pronunciationConfigRead/);
  assert.match(background, /pronunciationConfigWrite/);
});

test("engine restores durable backup only when extension-local config is absent", () => {
  assert.match(engine, /hasOwnProperty\.call\(stored \|\| \{\}, STORAGE_KEY\)/);
  assert.match(engine, /lastLoadSource = "extension-storage"/);
  assert.match(engine, /lastLoadSource = "durable-backup"/);
  assert.match(engine, /lastLoadSource = "defaults"/);
  assert.match(engine, /EDGE_TTS_PRONUNCIATION_BACKUP_WRITE/);
});

test("options surfaces recovery/default/backup-failure state instead of silently resetting", () => {
  assert.match(options, /Recovered pronunciation rules from durable backup/);
  assert.match(options, /No saved pronunciation config was found for this extension identity/);
  assert.match(options, /backup failed/);
});
