// Static layer invariants, checked by scanning source text (AGENT.md: respect layer boundaries).
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

// Every way a module specifier can be reached: `import x from "s"`, `import "s"`, `import type ... from "s"`,
// `export ... from "s"`, `import("s")`, `require("s")`, `import x = require("s")`. Comments are stripped first, and
// the specifier is matched in any quote style, so multi-line import lists are covered too.
const SPECIFIER_PATTERNS: RegExp[] = [
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`])([^'"`]+)\1/g,
  /\bimport\s*(['"`])([^'"`]+)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*[,)]/g,
  /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
];

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

export function specifiersOf(text: string): string[] {
  const code = stripComments(text);
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) found.push(match[2] as string);
  }
  return found;
}

const isBoardSdk = (s: string): boolean => s === "@vercel/board" || s.startsWith("@vercel/board/");

/** True when `specifier`, written in `file`, resolves to src/board(.ts|.js). */
function isBoardModule(specifier: string, file: string): boolean {
  if (!specifier.startsWith(".") && !specifier.startsWith("src/")) return false;
  const target = specifier.startsWith("src/") ? resolve(root, specifier) : resolve(dirname(file), specifier);
  return (
    /^(?:board)(?:\.(?:ts|js|mts|mjs))?$/.test(relative(srcDir, target)) && !relative(srcDir, target).startsWith("..")
  );
}

async function tsFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(path)));
    else if (/\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const rel = (file: string): string => relative(root, file).split(sep).join("/");

describe("import-scanner self-test", () => {
  const forms: Record<string, string> = {
    "static import": `import { board } from "@vercel/board";`,
    "subpath import": `import { local } from '@vercel/board/backend-local';`,
    "type import": `import type { Board } from "@vercel/board";`,
    "inline type import": `import { type Board } from "@vercel/board";`,
    "default import": `import board from '@vercel/board';`,
    "namespace import": `import * as sdk from "@vercel/board/access";`,
    "side-effect import": `import "@vercel/board";`,
    "multi-line import": `import {\n  board,\n  BoardError,\n} from\n  "@vercel/board";`,
    "export from": `export { board } from "@vercel/board";`,
    "export star": `export * from "@vercel/board/backend-local";`,
    "export type from": `export type { Board } from '@vercel/board';`,
    "dynamic import": `const m = await import("@vercel/board");`,
    "dynamic import with options": `await import('@vercel/board/sync', { with: {} });`,
    require: `const m = require("@vercel/board");`,
    "template-literal specifier": "await import(`@vercel/board`);",
  };
  for (const [name, source] of Object.entries(forms)) {
    it(`catches ${name}`, { timeout: 5_000 }, () => {
      expect(specifiersOf(source).some(isBoardSdk)).toBe(true);
    });
  }

  it("ignores comments and look-alike packages", { timeout: 5_000 }, () => {
    const source = [
      `// import { board } from "@vercel/board";`,
      `/* import x from "@vercel/board" */`,
      `import { x } from "@vercel/boards";`,
      `import { y } from "./not-@vercel/board";`,
      `const text = "we use @vercel/board here";`,
    ].join("\n");
    expect(specifiersOf(source).some(isBoardSdk)).toBe(false);
  });

  it("resolves relative imports of the board module", { timeout: 5_000 }, () => {
    const backends = join(srcDir, "backends", "fake.ts");
    const worker = join(srcDir, "worker.ts");
    for (const s of ["../board", "../board.js", "../board.ts", "src/board"]) {
      expect(isBoardModule(s, backends), s).toBe(true);
    }
    expect(isBoardModule("./board", worker)).toBe(true);
    expect(isBoardModule("./boards", worker)).toBe(false);
    expect(isBoardModule("../route", backends)).toBe(false);
    expect(isBoardModule("./board", backends)).toBe(false); // src/backends/board.ts is not the board module
  });
});

describe("layer invariants", () => {
  it("only src/board.ts imports @vercel/board", { timeout: 20_000 }, async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(srcDir)) {
      if (rel(file) === "src/board.ts") continue;
      const bad = specifiersOf(await readFile(file, "utf8")).filter(isBoardSdk);
      if (bad.length > 0) offenders.push(`${rel(file)} imports ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no backend module imports the board module or the board SDK", { timeout: 20_000 }, async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(join(srcDir, "backends"))) {
      const bad = specifiersOf(await readFile(file, "utf8")).filter((s) => isBoardSdk(s) || isBoardModule(s, file));
      if (bad.length > 0) offenders.push(`${rel(file)} imports ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
