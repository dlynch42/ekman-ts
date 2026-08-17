/**
 * Presentation helpers shared by the demos.
 *
 * Nothing here is part of Ekman, and nothing here is needed to use it. It exists so each
 * demo is mostly the runtime being driven rather than the same four printing functions
 * copied thirteen times, which is the part a reader is actually there for.
 */

import type { EkmanEvent } from "ekman";
import { isEkmanError } from "ekman";

export function banner(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

/**
 * A labelled figure.
 *
 * Numbers are right-aligned and grouped, because a column of them is meant to be compared
 * down rather than read across.
 */
export function row(
  label: string,
  value: string | number,
  note?: string
): void {
  const shown = typeof value === "number" ? value.toLocaleString() : value;
  console.log(
    `  ${label.padEnd(24)}${shown.padStart(13)}${note === undefined ? "" : `   ${note}`}`
  );
}

/** An assertion with a message. The demos are tests with a narrative, so they fail loudly. */
export function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Whatever a call threw, or its value if it did not. */
export function caught(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

/** Whatever a promise rejected with, or its value if it resolved. */
export async function settled(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

/** The stable error code of whatever went wrong, or its string form if it was not ours. */
export function codeOf(error: unknown): string {
  return isEkmanError(error) ? error.code : String(error);
}

/**
 * How a send turned out, as one word.
 *
 * `"committed"` or the error code, which is what most of these demos want to print in a
 * column beside the trigger that produced it.
 */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "committed";
  } catch (error) {
    return codeOf(error);
  }
}

/**
 * A horizontal bar, scaled to a maximum.
 *
 * `·` rather than a space for the empty part, so the axis stays visible when a value is
 * small and a reader can tell an empty bar from a missing one.
 */
export function bar(value: number, of: number, width = 40): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / of) * width)));
  return "█".repeat(filled).padEnd(width, "·");
}

/**
 * A bar against a ceiling, with the ceiling marked.
 *
 * Everything up to `|` is inside the budget and everything past it is not, so a store that
 * has blown through its allowance looks like one at a glance rather than needing the number
 * read and compared.
 */
export function gauge(value: number, ceiling: number): string {
  const width = 30;
  const filled = Math.min(width, Math.round((value / ceiling) * width));
  const over = Math.min(8, Math.round(((value - ceiling) / ceiling) * width));
  return `${"█".repeat(filled).padEnd(width, "·")}|${(over > 0 ? "█".repeat(over) : "").padEnd(8, " ")}`;
}

/**
 * One instance's committed stream, printed in order.
 *
 * This is the thing the whole runtime exists to produce, and most of these demos assert on
 * it without ever showing it. Every event carries its sequence, and the sequence only
 * advances on a commit: a refusal, a violation and a restore all carry the sequence of the
 * commit they followed, which is why the numbers repeat rather than counting the lines.
 */
export function stream(
  key: string,
  events: readonly EkmanEvent[],
  options: { limit?: number } = {}
): void {
  const limit = options.limit ?? events.length;
  const shown = events.slice(0, limit);

  console.log(`  ${key}`);
  for (const event of shown) {
    console.log(`    ${describe(event)}`);
  }
  if (events.length > shown.length) {
    console.log(`    ... ${events.length - shown.length} more`);
  }
}

/** One event as a single line: what it was, and what it says about itself. */
function describe(event: EkmanEvent): string {
  const seq = `seq ${String(event.seq).padEnd(3)}`;

  if (event.type === "transition") {
    const move =
      event.from === null ? `· → ${event.to}` : `${event.from} → ${event.to}`;
    return `${seq} ${move.padEnd(28)} ${event.cause.type}`;
  }

  if (event.type === "rejected") {
    return `${seq} ${`refused: ${event.code}`.padEnd(28)} ${event.reason}`;
  }

  if (event.type === "violation") {
    const what = `${event.constraint.kind} ${event.constraint.name}`;
    return `${seq} ${`violation (${event.policy})`.padEnd(28)} ${what}: ${event.reason}`;
  }

  return `${seq} ${`restored from ${event.from}`.padEnd(28)} ${event.replayed} events replayed`;
}
