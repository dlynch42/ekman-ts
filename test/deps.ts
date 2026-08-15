import type { RuntimeDeps } from "../src/config";
import { resolveInboxConfig } from "../src/config";
import type { EkmanEvent } from "../src/events";
import type { MemoryConfig } from "../src/memory";
import { resolveMemoryConfig } from "../src/memory";
import { resolveStack } from "../src/stack";
import type { Store } from "../src/store";
import type { TelemetrySink } from "../src/telemetry";
import type { InboxConfig } from "../src/types";

/**
 * The runtime dependencies an instance or an inbox needs, for tests that build one
 * directly rather than through `Ekman`.
 *
 * Defaults to the memory-only shape, which is what most of these tests are about. Anything
 * a test does not name is resolved exactly as the runtime would resolve it.
 */
export function testDeps(
  options: {
    now?: (() => number) | undefined;
    telemetry?: TelemetrySink | undefined;
    onUnhandled?: ((error: unknown) => void) | undefined;
    audit?: ((event: EkmanEvent) => void) | undefined;
    inbox?: InboxConfig | undefined;
    store?: Store | readonly Store[] | undefined;
    memory?: MemoryConfig | undefined;
  } = {}
): RuntimeDeps {
  const stack = resolveStack(options.store);

  return {
    now: options.now ?? (() => 1000),
    telemetry: options.telemetry,
    onUnhandled: options.onUnhandled ?? (() => undefined),
    audit: options.audit ?? (() => undefined),
    inbox: resolveInboxConfig(options.inbox),
    stack,
    memory: resolveMemoryConfig(options.memory, {
      hasStore: stack.authority !== undefined,
    }),
  };
}
