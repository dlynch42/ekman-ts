/**
 * What a store adapter is written against: the `Store` shape, the helpers every adapter
 * shares, and the contract an adapter proves itself with.
 *
 * ```ts
 * import type { Store } from "ekman/store"
 * import { EMPTY_SEQ, replay, scanKeys, storeContract } from "ekman/store"
 * ```
 */

// biome-ignore-all lint/performance/noBarrelFile: this is the `ekman/store` entry point declared in `exports`, so one surface for adapter authors is the point.
export type {
  LoadResult,
  ReplayedState,
  ScanCriteria,
  ScanMatch,
  ScanResult,
  StorageSweep,
  Store,
  StoreCapabilities,
  StoreCompaction,
  StoreSnapshot,
  StoreUsage,
} from "../store";
export {
  EMPTY_SEQ,
  isAfterSnapshot,
  latestSeq,
  previousSeq,
  replay,
  scanKeys,
} from "../store";
export type { TemporalLatch } from "../temporal";
export type { ContractHarness, ContractMatchers } from "./contract";
export { storeContract } from "./contract";
