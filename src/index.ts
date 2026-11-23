/**
 * Ekman: per-key memory and state for the things your service watches. Embedded,
 * budgeted, queryable.
 *
 * ```ts
 * import { Ekman, defineEntity, transitionTo, stay } from "ekman"
 *
 * const orders = defineEntity("orders", {
 *   initial: "pending",
 *   states: {
 *     pending: (order, trigger) => transitionTo("approved", { by: trigger.actor }),
 *     approved: (order) => stay(order.values),
 *   },
 * })
 *
 * const ekman = new Ekman({ entities: [orders] })
 * await ekman.entities.orders.send("abc123", { type: "approve", actor: "amy" })
 * ```
 */

// biome-ignore-all lint/performance/noBarrelFile: this is the package entry point declared in `exports`, so one public surface is the point. File-scoped rather than line-scoped because the rule reports on whichever export sorts second, which moves as the surface grows.
export type { Analysis } from "./analysis";
export { analyze } from "./analysis";
export type { AuditSink } from "./audit";
export { DEFAULT_CAPACITY, OVERFLOW_POLICIES } from "./config";
export type {
  ConstraintCheck,
  ConstraintsConfig,
  GuardConstraint,
  InvariantConstraint,
  ProposedCommit,
  RuleConstraint,
  RuleTrigger,
  StaleConstraint,
  StaleTrigger,
  TemporalConstraint,
  TemporalTrigger,
  TransitionConstraint,
  ViolationPolicy,
} from "./constraints";
export {
  DEFAULT_RULE_TRIGGER,
  DEFAULT_STALE_TRIGGER,
  DEFAULT_TEMPORAL_TRIGGER,
} from "./constraints";
export type { DiagramOptions } from "./diagram";
export { toDot, toMermaid } from "./diagram";
export { Ekman } from "./ekman";
export { defineEntity, statesFromEntries } from "./entity";
export type { EkmanErrorOptions, ErrorCode } from "./errors";
export {
  ConstraintViolationError,
  EkmanError,
  ERROR_CODES,
  isConstraintViolation,
  isEkmanError,
} from "./errors";
export type {
  ConstraintKind,
  EkmanEvent,
  EventCause,
  RejectedEvent,
  RestoredEvent,
  TransitionEvent,
  ViolationEvent,
} from "./events";
export { isTransitionEvent } from "./events";
export type { FenceReason } from "./fence";
export type { ParsedKey } from "./key";
export { buildKey, KEY_SEPARATOR, parseKey } from "./key";
export type { EvictionConfig, EvictionPolicy, MemoryConfig } from "./memory";
export { accountBytes, EVICTION_POLICIES } from "./memory";
export type { ObservedEdges } from "./observed";
export { allowFrom, observeEdges } from "./observed";
export type { Backoff, ExecutionPolicy } from "./policy";
export type {
  HistoryResult,
  Partiality,
  QueryCriteria,
  QueryMatch,
  QueryResult,
  StateMap,
  StateMapEntry,
  StateMapOptions,
} from "./query";
export { parseDuration } from "./query";
export type {
  FailResult,
  HandlerResult,
  PatchResult,
  StayResult,
  TransitionToResult,
} from "./results";
export { fail, patch, stay, transitionTo } from "./results";
export { SPEC_VERSION } from "./spec";
export type { Coordination, StoreKind, StoreLayer, StoreSpec } from "./stack";
export { createStore } from "./stack";
export type {
  LoadResult,
  ReplayedState,
  ScanCriteria,
  ScanFilter,
  ScanMatch,
  ScanResult,
  StorageSweep,
  Store,
  StoreCapabilities,
  StoreCompaction,
  StoreSnapshot,
  StoreUsage,
} from "./store";
/**
 * @deprecated Import these four from `ekman/store`, which is where an adapter should take
 * them from. They stay on this entry point for one minor version.
 */
export { EMPTY_SEQ, latestSeq, replay, scanKeys } from "./store";
export type {
  FileModeConfig,
  FileStoreOptions,
  RetentionConfig,
  RetentionPolicy,
} from "./stores/file";
export { defaultLogDir, RETENTION_POLICIES } from "./stores/file";
export type { MemoryKeep } from "./stores/memory";
export type {
  AuditFailedEvent,
  CommitFencedEvent,
  CommitRacedEvent,
  ConstraintEscalatedEvent,
  ConstraintViolatedEvent,
  HandlerRetriedEvent,
  HandlerSettledEvent,
  HandlerStartedEvent,
  HandlerTimedOutEvent,
  InboxDroppedEvent,
  InboxEnqueuedEvent,
  InboxRejectedEvent,
  InstanceEvictedEvent,
  InstanceForgottenEvent,
  InstanceRestoredEvent,
  MemoryAccountedEvent,
  MemoryRefusedEvent,
  RuntimeClosedEvent,
  StorageSweptEvent,
  StoreCacheFailedEvent,
  StoreCacheSuspendedEvent,
  TelemetryEvent,
  TelemetryEventType,
  TelemetrySink,
  TriggerRef,
} from "./telemetry";
export { TELEMETRY_FALLBACK } from "./telemetry";
export type { TemporalLatch } from "./temporal";
export type {
  AnyEntityDefinition,
  CacheConfig,
  CloseOptions,
  CommitResult,
  EkmanConfig,
  EntityConfig,
  EntityConstraints,
  EntityDefinition,
  EntityHandle,
  EntityHandles,
  ErrorHandler,
  Handler,
  HandlerContext,
  InboxConfig,
  InstanceSnapshot,
  OnUnhandled,
  OverflowPolicy,
  StateConfig,
  StateEntry,
  StateGraph,
  StateOnConfig,
  StatePolicyConfig,
  StorageConfig,
  TemporalConfig,
  Trigger,
  TriggerLike,
  UnhandledContext,
  UnknownPolicy,
  Values,
} from "./types";
export { ERROR_FALLBACK } from "./types";
