/**
 * Typechecks the code samples in the docs against the source.
 *
 * A sample opts in by tagging its fence `ts check`. Fragments stay untagged, so
 * a sample is only checked once it is a whole program. A sample that needs
 * something it does not show, such as an import or a value declared elsewhere
 * on the page, gets it from an HTML comment directly above the fence, which a
 * reader never sees:
 *
 *     <!-- check-docs:
 *     import { defineEntity, stay } from "ekman";
 *     declare const chargeCard: (cents: number) => Promise<string>;
 *     -->
 *     ```ts check
 *     const orders = defineEntity("orders", { ... });
 *     ```
 *
 * Each sample is written to its own module at the line it has in the document,
 * so a compiler error points at the document line to fix.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, "node_modules", ".cache", "check-docs");

const OPEN = /^```ts check\s*$/;
const CLOSE = /^```\s*$/;
const PREAMBLE_OPEN = /^<!-- check-docs:\s*$/;
const PREAMBLE_CLOSE = /^-->\s*$/;

const documents = [
  join(ROOT, "README.md"),
  ...readdirSync(join(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(ROOT, "docs", name)),
];

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

/** Temporary file name to the document it came from, for rewriting compiler output. */
const origins = new Map();

for (const document of documents) {
  const lines = readFileSync(document, "utf8").split("\n");
  for (const sample of samplesIn(lines)) {
    const name = `${relative(ROOT, document).replaceAll(/[/\\]/g, "__")}.L${sample.line}.ts`;
    // Blank lines first, so line N of the module is line N of the document. The
    // preamble goes after the sample: imports and ambient declarations are
    // hoisted, so it does not need to come first.
    const body = [
      ...new Array(sample.line).fill(""),
      ...sample.code,
      ...sample.preamble,
      "export {};",
    ].join("\n");
    writeFileSync(join(WORK, name), `${body}\n`);
    origins.set(name, relative(ROOT, document));
  }
}

if (origins.size === 0) {
  console.error(
    "check-docs: no sample is tagged `ts check`, so nothing was checked."
  );
  process.exit(1);
}

writeFileSync(
  join(WORK, "tsconfig.json"),
  `${JSON.stringify(
    {
      extends: join(ROOT, "tsconfig.json"),
      compilerOptions: {
        // A sample declares things to show them, not always to use them.
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      include: ["*.ts"],
      exclude: [],
    },
    null,
    2
  )}\n`
);

try {
  execFileSync(
    "npx",
    ["tsc", "--noEmit", "--pretty", "false", "--project", WORK],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
} catch (error) {
  console.error(toDocumentPaths(`${error.stdout ?? ""}${error.stderr ?? ""}`));
  console.error(
    `check-docs: a sample no longer compiles (${origins.size} checked).`
  );
  process.exit(1);
}

console.log(`check-docs: ${origins.size} samples typecheck.`);

/** Every tagged sample in a document, with the hidden preamble above it if there is one. */
function* samplesIn(lines) {
  let preamble = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (PREAMBLE_OPEN.test(line)) {
      const end = lines.findIndex(
        (candidate, at) => at > index && PREAMBLE_CLOSE.test(candidate)
      );
      if (end === -1) {
        throw new Error(`unterminated check-docs comment at line ${index + 1}`);
      }
      preamble = lines.slice(index + 1, end);
      index = end + 1;
      continue;
    }

    if (OPEN.test(line)) {
      const end = lines.findIndex(
        (candidate, at) => at > index && CLOSE.test(candidate)
      );
      if (end === -1) {
        throw new Error(`unterminated sample at line ${index + 1}`);
      }
      yield { line: index + 1, code: lines.slice(index + 1, end), preamble };
      preamble = [];
      index = end + 1;
      continue;
    }

    // A preamble belongs to the fence directly below it, blank lines aside.
    if (line.trim() !== "") {
      preamble = [];
    }
    index += 1;
  }
}

/** Point compiler output at the document a sample came from, not at its temporary module. */
function toDocumentPaths(output) {
  let rewritten = output;
  for (const [name, document] of origins) {
    rewritten = rewritten.replaceAll(
      relative(ROOT, join(WORK, name)),
      document
    );
  }
  return rewritten;
}
