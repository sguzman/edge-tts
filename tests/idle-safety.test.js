const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8")
);

test("manifest performs no automatic host-page injection", () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("scripting"));
});

test("content code contains no document MutationObserver", () => {
  const contentDirectory = path.join(repositoryRoot, "src", "content");
  const javascriptFiles = fs
    .readdirSync(contentDirectory)
    .filter((name) => name.endsWith(".js"));

  for (const filename of javascriptFiles) {
    const source = fs.readFileSync(path.join(contentDirectory, filename), "utf8");
    assert.doesNotMatch(
      source,
      /\bMutationObserver\b/,
      `${filename} must not install document mutation monitoring`
    );
  }
});
