/**
 * The runtime, constructed once for the process.
 *
 * The HTTP routes and the prober both import this same object, so a service is the same
 * instance whichever of them recorded its last probe.
 */

import { Ekman } from "ekman";
import { service } from "../entities/service";
import { config } from "./config";

export const ekman = new Ekman({
  entities: [service],

  // The file store is the commit authority. What is known about each service, how long it
  // has been in its state and when it was last heard from all survive a restart.
  // A service is probed for as long as it exists, so its log is capped: past the cap the
  // store folds old events into a snapshot. What is known survives; old history does not.
  store: [
    "memory",
    {
      kind: "file",
      dir: config.dataDir,
      retention: { perLogBytes: config.logBytes },
    },
  ],

  // What this process remembers has a ceiling. A service nobody has probed lately is
  // snapshotted out and comes back when its next probe arrives.
  memory: {
    maxBytes: config.memoryBytes,
    eviction: { policy: "lru", snapshotOnEvict: true },
  },

  // How often the freshness bound is evaluated, for services in memory and for those only
  // the store holds. Without it a silence would go unnoticed until something asked.
  temporal: { sweepMs: config.sweepMs },

  onUnhandled: (error, { source, key }) => {
    console.error(
      `[ekman] unhandled (${source}${key ? ` ${key}` : ""})`,
      error
    );
  },
});

/** The typed handle: instances by name, with the entity's states, values and triggers. */
export const { services } = ekman.entities;
