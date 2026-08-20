import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(rootDirectory, "dist", "firefox");
const vendorDirectory = path.join(outputDirectory, "vendor");
const sdkFilename = "microsoft.cognitiveservices.speech.sdk.bundle-min.js";
const sdkPackageDirectory = path.join(
  rootDirectory,
  "node_modules",
  "microsoft-cognitiveservices-speech-sdk"
);
const sdkSource = path.join(sdkPackageDirectory, "distrib", "browser", sdkFilename);

try {
  await access(sdkSource);
} catch (_error) {
  console.error("Azure Speech SDK is missing. Run `npm install` first.");
  process.exit(1);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(vendorDirectory, { recursive: true });
await cp(path.join(rootDirectory, "src"), path.join(outputDirectory, "src"), {
  recursive: true
});
await cp(sdkSource, path.join(vendorDirectory, sdkFilename));
for (const legalFile of ["LICENSE", "REDIST.txt"]) {
  await cp(
    path.join(sdkPackageDirectory, legalFile),
    path.join(vendorDirectory, `speech-sdk-${legalFile}`)
  );
}

const manifest = JSON.parse(await readFile(path.join(rootDirectory, "manifest.json"), "utf8"));
const scripts = manifest.content_scripts?.[0]?.js;
if (!Array.isArray(scripts)) {
  throw new Error("manifest.json is missing the primary content script list.");
}

manifest.name = "Microsoft TTS Reader";
manifest.description =
  "Cross-browser read-aloud with local browser voices and optional Microsoft Azure neural voices.";
manifest.content_scripts[0].js = [`vendor/${sdkFilename}`, ...scripts];
manifest.browser_specific_settings = {
  ...(manifest.browser_specific_settings || {}),
  gecko: {
    ...(manifest.browser_specific_settings?.gecko || {}),
    id: "microsoft-tts-reader@sguzman",
    strict_min_version: "121.0"
  }
};

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(`Firefox build ready: ${path.relative(rootDirectory, outputDirectory)}`);
