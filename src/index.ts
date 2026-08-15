/**
 * Ekman: declarative, embeddable state management for backend services.
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
export type { AuditSink } from "./audit";
export { DEFAULT_AUDIT_ATTEMPTS } from "./audit";
export type { ResolvedInboxConfig } from "./config";
export { DEFAULT_CAPACITY, OVERFLOW_POLICIES } from "./config";
export type {
  ConstraintCheck,
  ConstraintsConfig,
  GuardConstraint,
  InvariantConstraint,
  ProposedCommit,
  TemporalConstraint,
  TransitionConstraint,
  ViolationPolicy,
} from "./constraints";
export { DEFAULT_TEMPORAL_TRIGGER } from "./constraints";
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
export type { ParsedKey } from "./key";
export { buildKey, KEY_SEPARATOR, parseKey } from "./key";
export type {
  EvictionConfig,
  EvictionPolicy,
  MemoryConfig,
  ResolvedMemoryConfig,
} from "./memory";
export { accountBytes, EVICTION_POLICIES } from "./memory";
export type {
  FailResult,
  HandlerResult,
  StayResult,
  TransitionToResult,
} from "./results";
export { fail, stay, transitionTo } from "./results";
export type { ResolvedStack } from "./stack";
export { resolveStack } from "./stack";
export type {
  LoadResult,
  ReplayedState,
  ScanCriteria,
  ScanMatch,
  ScanResult,
  Store,
  StoreCapabilities,
  StoreSnapshot,
} from "./store";
export {
  EMPTY_SEQ,
  entityOf,
  latestSeq,
  replay,
  scanKeys,
} from "./store";
export { FileStore, fileStore } from "./stores/file";
export { MemoryStore, memoryStore } from "./stores/memory";
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
  InstanceRestoredEvent,
  MemoryAccountedEvent,
  MemoryRefusedEvent,
  StoreCacheFailedEvent,
  TelemetryEvent,
  TelemetryEventType,
  TelemetrySink,
  TriggerRef,
} from "./telemetry";
export { TELEMETRY_FALLBACK } from "./telemetry";
export type {
  AnyEntityDefinition,
  CommitResult,
  EkmanConfig,
  EntityConfig,
  EntityDefinition,
  EntityHandle,
  EntityHandles,
  ErrorHandler,
  Handler,
  HandlerContext,
  InboxConfig,
  InstanceSnapshot,
  OverflowPolicy,
  TemporalConfig,
  Trigger,
  TriggerLike,
  UnknownPolicy,
  Values,
} from "./types";
export { ERROR_FALLBACK } from "./types";
