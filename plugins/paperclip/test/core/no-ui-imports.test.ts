import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "src", "core");
const FORBIDDEN = [
  /\breact\b/i,
  /@pixel-agents\//i,
  /pixel-agents\/core/i,
  /@paperclipai\/plugin-sdk/i,
  /paperclip\/packages\//i,
  /paperclip\/ui/i,
  /from ["']react/i,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("upstream neutrality (§7.1, NFR-8)", () => {
  it("core source imports no React, Pixel Agents renderer, or Paperclip UI/SDK", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content)) {
          throw new Error(`Forbidden import pattern ${pattern} found in ${file}`);
        }
      }
    }
  });

  it("core has no runtime import of the plugin SDK (type-only or none)", () => {
    const files = walk(SRC);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      // No import statements referencing the SDK at all (type-only included,
      // to keep core fully decoupled per deliverable 2).
      if (/@paperclipai\/plugin-sdk/.test(content)) {
        throw new Error(`SDK reference found in ${file}`);
      }
    }
  });
});
