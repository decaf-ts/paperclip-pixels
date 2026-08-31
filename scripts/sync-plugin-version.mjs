import { readFileSync, writeFileSync } from "node:fs";

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
