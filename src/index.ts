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

// biome-ignore lint/performance/noBarrelFile: this is the package entry point declared in `exports`, so one public surface is the point
export { Ekman } from "./ekman";
export { defineEntity, statesFromEntries } from "./entity";
export type { EkmanErrorOptions, ErrorCode } from "./errors";
export { EkmanError, ERROR_CODES, isEkmanError } from "./errors";
export type {
  EkmanEvent,
  EventCause,
  RejectedEvent,
  TransitionEvent,
} from "./events";
export { isTransitionEvent } from "./events";
export type { ParsedKey } from "./key";
export { buildKey, KEY_SEPARATOR, parseKey } from "./key";
export type {
  FailResult,
  HandlerResult,
  StayResult,
  TransitionToResult,
} from "./results";
export { fail, stay, transitionTo } from "./results";
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
  InstanceSnapshot,
  Trigger,
  TriggerLike,
  UnknownPolicy,
  Values,
} from "./types";
export { ERROR_FALLBACK } from "./types";
