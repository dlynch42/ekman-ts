/**
 * The version of the Ekman behavioural contract this package implements.
 *
 * The contract is the scenario suite in `scenarios/`, which every implementation runs
 * through its own public API. Two implementations that report the same version here and
 * conform at the same level behave the same way. It moves separately from the package
 * version: a release can fix a bug or add an adapter without the contract changing.
 */
export const SPEC_VERSION = "0.1";
