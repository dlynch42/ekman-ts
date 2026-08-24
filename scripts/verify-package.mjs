/**
 * Verifies the packed tarball rather than the working tree.
 *
 * The working tree always resolves `ekman` through the tsconfig path alias, so
 * nothing in the repo can catch an exports-map fault, a missing declaration, or
 * a file that escaped the `files` allowlist. This packs the package, audits what
 * came out, installs it somewhere else entirely, and imports it three ways.
 *
 * Run it locally as well as in CI: the private design docs are gitignored, so a
 * CI checkout never contains them and only a local run can prove they are absent
 * from the tarball.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Paths allowed in the tarball. Anything else is a packaging fault. */
const ALLOWED_FILES = new Set(["package.json", "README.md", "LICENSE"]);
const ALLOWED_DIR = "dist/";

/** Entry points the exports map promises. */
const REQUIRED = ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"];

/** Documents that must never ship. */
const PRIVATE_DOCS = /(^|\/)(SPEC|DESIGN|CLAUDE|IMPLEMENTATION|DECISIONS)\.md$/i;

const failures = [];
const fail = (message) => failures.push(message);
const step = (message) => console.log(`\n\x1b[1m${message}\x1b[0m`);

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...options,
  });

// pack

step("Packing");

// `prepublishOnly` runs only on publish, never on pack, so this packs whatever
// dist/ currently holds. Build before calling this script.
const packOutput = run("npm", ["pack", "--json", "--pack-destination", ROOT], {
  cwd: ROOT,
});
const [packed] = JSON.parse(packOutput);
const tarball = join(ROOT, packed.filename);
const entries = packed.files.map((f) => f.path);

console.log(`${packed.filename} (${entries.length} files, ${packed.size} bytes)`);

// audit contents

step("Auditing tarball contents");

for (const entry of entries) {
  const permitted = ALLOWED_FILES.has(entry) || entry.startsWith(ALLOWED_DIR);
  if (permitted) {
    continue;
  }
  fail(`unexpected file in tarball: ${entry}`);
}

for (const entry of entries) {
  if (PRIVATE_DOCS.test(entry)) {
    fail(`private document in tarball: ${entry}`);
  }
}

for (const required of REQUIRED) {
  if (entries.includes(required)) {
    continue;
  }
  fail(`missing entry point: ${required}`);
}

for (const entry of entries.sort()) {
  console.log(`  ${entry}`);
}

// install elsewhere

step("Installing into a clean project");

const scratch = mkdtempSync(join(tmpdir(), "ekman-verify-"));
let installed = false;

try {
  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "ekman-verify", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`
  );

  run(
    "npm",
    ["install", tarball, `typescript@${devDep("typescript")}`, `@types/node@${devDep("@types/node")}`],
    { cwd: scratch }
  );
  installed = true;
  console.log(`installed into ${scratch}`);

  // ESM

  // Deliberately the README quickstart's shape, so this also proves the
  // published example still compiles and runs against the published package.
  const QUICKSTART = [
    'import { defineEntity, Ekman, isTransitionEvent, stay, transitionTo } from "ekman";',
    "",
    "const orders = defineEntity(\"orders\", {",
    '  initial: "pending",',
    "  values: { total: 0 },",
    "  states: {",
    "    pending: (order, trigger) =>",
    '      trigger.type === "pay"',
    '        ? transitionTo("paid", { total: order.values.total + 4200 })',
    "        : stay(order.values),",
    "    paid: (order) => stay(order.values),",
    "  },",
    "});",
    "",
    "const ekman = new Ekman({ entities: [orders] });",
    'const committed = await ekman.send("orders:a-1", { type: "pay" });',
    'if (committed.state !== "paid") {',
    "  throw new Error(`expected paid, got ${committed.state}`);",
    "}",
    "if (committed.values.total !== 4200) {",
    "  throw new Error(`expected 4200, got ${committed.values.total}`);",
    "}",
    "",
    'const { events } = await ekman.entities.orders.history("a-1");',
    "const path = events",
    "  .filter(isTransitionEvent)",
    '  .map((e) => `${e.from ?? "(new)"} -> ${e.to}`)',
    '  .join(", ");',
    'if (path !== "(new) -> pending, pending -> paid") {',
    "  throw new Error(`unexpected history: ${path}`);",
    "}",
    "",
    "await ekman.close();",
  ];

  step("Importing as ESM");
  writeFileSync(
    join(scratch, "probe.mjs"),
    `${[...QUICKSTART, 'console.log("  esm ok");'].join("\n")}\n`
  );
  run("node", ["probe.mjs"], { cwd: scratch, inherit: true });

  // CJS

  step("Requiring as CommonJS");
  writeFileSync(
    join(scratch, "probe.cjs"),
    `${[
      'const ekman = require("ekman");',
      "",
      "const expected = [",
      '  "Ekman",',
      '  "defineEntity",',
      '  "transitionTo",',
      '  "stay",',
      '  "fail",',
      '  "isTransitionEvent",',
      "];",
      "",
      "const missing = expected.filter((name) => typeof ekman[name] !== \"function\");",
      "if (missing.length > 0) {",
      '  throw new Error(`require("ekman") is missing: ${missing.join(", ")}`);',
      "}",
      "",
      "const orders = ekman.defineEntity(\"orders\", {",
      '  initial: "pending",',
      "  states: {",
      '    pending: (order) => ekman.stay(order.values),',
      "  },",
      "});",
      "",
      "const runtime = new ekman.Ekman({ entities: [orders] });",
      "runtime",
      '  .send("orders:a-1", { type: "poke" })',
      "  .then((committed) => {",
      '    if (committed.state !== "pending") {',
      "      throw new Error(`expected pending, got ${committed.state}`);",
      "    }",
      "    return runtime.close();",
      "  })",
      '  .then(() => console.log("  cjs ok"))',
      "  .catch((error) => {",
      "    console.error(error);",
      "    process.exit(1);",
      "  });",
    ].join("\n")}\n`
  );
  run("node", ["probe.cjs"], { cwd: scratch, inherit: true });

  // type resolution

  step("Resolving types under NodeNext");

  // Both module flavors: the exports map can resolve types for `import` and
  // quietly fall back for `require`, which only a CJS-flavored probe catches.
  for (const flavor of ["module", "commonjs"]) {
    const dir = join(scratch, flavor === "module" ? "esm" : "cjs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: `probe-${flavor}`, private: true, type: flavor }, null, 2)}\n`
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            strict: true,
            noEmit: true,
            // false on purpose: this is what type-checks the shipped .d.ts.
            skipLibCheck: false,
          },
          files: ["probe.ts"],
        },
        null,
        2
      )}\n`
    );

    // Top-level await is only legal in the ESM probe, so the CJS one runs the
    // same statements inside an async function rather than a rewritten copy.
    const [importLine, ...statements] = QUICKSTART;
    const body =
      flavor === "module"
        ? QUICKSTART
        : [
            importLine,
            "",
            "async function main() {",
            ...statements.map((line) => (line === "" ? "" : `  ${line}`)),
            "}",
            "",
            "void main();",
          ];

    writeFileSync(
      join(dir, "probe.ts"),
      `${[
        'import type { EkmanEvent, TransitionEvent } from "ekman";',
        ...body,
        "",
        "export type Probe = TransitionEvent | EkmanEvent;",
      ].join("\n")}\n`
    );

    run("npx", ["tsc", "--noEmit", "--project", join(dir, "tsconfig.json")], {
      cwd: scratch,
      inherit: true,
    });
    console.log(`  types ok (${flavor})`);
  }
} catch (error) {
  fail(
    `${installed ? "consumption" : "install"} failed: ${error.stderr || error.message}`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

// report

if (failures.length > 0) {
  console.error("\n\x1b[31mPackage verification failed:\x1b[0m");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("\n\x1b[32mPackage verified.\x1b[0m");

/** Pin the probe's toolchain to the versions the repo develops against. */
function devDep(name) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return pkg.devDependencies[name];
}
