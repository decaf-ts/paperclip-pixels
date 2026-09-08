import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");

/**
 * Neutrality guard: the `common` package is a pure wire-contract package
 * ("schemas only", board Revision 3). It must not import Paperclip SDK code,
 * React, Pixel Agents server code, filesystem/Node APIs, or any other
 * runtime package. Enforced as a test so a violation fails `npm test`.
 */

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /@paperclipai\//g, label: "Paperclip SDK (@paperclipai/*)" },
  { pattern: /\bfrom\s*["']react["']/g, label: "react" },
  { pattern: /\bfrom\s*["']react-dom["']/g, label: "react-dom" },
  { pattern: /\bfrom\s*["']node:/g, label: "Node builtin (node:*)" },
  { pattern: /\bfrom\s*["'](?:fs|path|os|url|http|https|stream|worker_threads|child_process|crypto)["']/g, label: "Node builtin" },
  { pattern: /\bimport\.meta\.url/g, label: "import.meta.url (filesystem access)" },
  { pattern: /readFileSync|writeFileSync|createReadStream|mkdirSync|existsSync/g, label: "filesystem API" },
  { pattern: /@paperclip-pixel\//g, label: "@paperclip-pixel/* (old core)" },
  { pattern: /paperclip-pixels\/(?!common)/g, label: "sibling paperclip-pixels package" },
  { pattern: /\.\.\/\.\.\/pixel-agents/g, label: "pixel-agents fork" },
  { pattern: /\.\.\/\.\.\/paperclip\b/g, label: "paperclip core submodule" },
];

function listSourceFiles(): string[] {
  return globSync("**/*.ts", { cwd: srcDir }).filter((f) => !f.endsWith(".test.ts"));
}

describe("neutrality guard", () => {
  it("forbids imports of SDK / React / host / fs / fork inside common", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles()) {
      const content = readFileSync(path.join(srcDir, file), "utf8");
      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file}: forbidden ${label}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("does not import any runtime dependency other than zod", () => {
    const deps = new Set<string>();
    for (const file of listSourceFiles()) {
      const content = readFileSync(path.join(srcDir, file), "utf8");
      for (const match of content.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
        const spec = match[1];
        if (spec.startsWith(".")) continue;
        deps.add(spec);
      }
    }
    const allowed = new Set(["zod"]);
    const unexpected = [...deps].filter((d) => !allowed.has(d));
    expect(unexpected, `unexpected external imports: ${unexpected.join(", ")}`).toEqual([]);
  });
});
