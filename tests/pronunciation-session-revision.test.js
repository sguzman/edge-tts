const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const background = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);
const bootstrap = fs.readFileSync(
  path.join(__dirname, "..", "src", "content", "content-script.js"),
  "utf8"
);

test("pronunciation branch invalidates pre-projection page readers", () => {
  assert.match(background, /const READER_SESSION_REVISION = 3;/);
  assert.match(bootstrap, /const SESSION_REVISION = 3;/);
  assert.match(
    background,
    /response\?\.revision === READER_SESSION_REVISION/
  );
});
