// The export-set probe: proves the published entry points carry what the README
// lists and nothing the library keeps to itself, and that class names survive
// bundling so a logged error reads "EkmanError" and not a bundler's alias.
// Whole namespaces on purpose: the point is to see every name each entry point has.
const ekman = await import("ekman");
const store = await import("ekman/store");

const INTERNAL = [
  "States",
  "UNKNOWN_NODE",
  "projectRoot",
  "STORE_DIR_NAME",
  "defaultStoreDir",
  "entityOf",
  "resolveStack",
  "DEFAULT_AUDIT_ATTEMPTS",
];

const leaked = INTERNAL.filter((name) => name in ekman);
if (leaked.length > 0) {
  throw new Error(`"ekman" exports internals: ${leaked.join(", ")}`);
}

const ADAPTER = [
  "EMPTY_SEQ",
  "isAfterSnapshot",
  "latestSeq",
  "previousSeq",
  "replay",
  "scanKeys",
  "storeContract",
];

const absent = ADAPTER.filter((name) => !(name in store));
if (absent.length > 0) {
  throw new Error(`"ekman/store" is missing: ${absent.join(", ")}`);
}
if (typeof store.replay !== "function") {
  throw new Error('"ekman/store" replay is not a function');
}

assertNamed(ekman.EkmanError, "EkmanError");
assertNamed(ekman.ConstraintViolationError, "ConstraintViolationError");
assertNamed(ekman.Ekman, "Ekman");

const printed = String(new ekman.EkmanError("INVALID_KEY", "x"));
if (!printed.startsWith("EkmanError:")) {
  throw new Error(`an EkmanError prints as "${printed}"`);
}

console.log("  surface ok");

function assertNamed(value, name) {
  if (value.name !== name) {
    throw new Error(`${name} is named "${value.name}" in the bundle`);
  }
}
