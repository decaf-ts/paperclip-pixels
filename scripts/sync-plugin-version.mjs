import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const constantsUrl = new URL("../src/constants.ts", import.meta.url);
const source = readFileSync(constantsUrl, "utf8");
const marker = /export const PLUGIN_VERSION = "[^"]+";/;

if (!marker.test(source)) {
  throw new Error("Could not locate PLUGIN_VERSION in src/constants.ts");
}

writeFileSync(
  constantsUrl,
  source.replace(marker, `export const PLUGIN_VERSION = "${packageJson.version}";`),
);

// npm's version lifecycle runs after it creates the version commit's initial
// index. Explicitly stage the generated source so the tag and published
// tarball always describe the same plugin manifest version.
execFileSync("git", ["add", fileURLToPath(constantsUrl)], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
});
