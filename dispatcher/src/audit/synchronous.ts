import { types } from "node:util";

/** Infer the callback itself, so a caller cannot select a void result type and
 * accidentally accept an async function via TypeScript's void-return rule. */
export type SynchronousCallback<F extends (...args: never[]) => unknown> = F &
  ([Extract<ReturnType<F>, PromiseLike<unknown>>] extends [never] ? unknown : never);

/** Defense for untyped callers; this is not a sandbox for arbitrary JavaScript.
 * Ordinary functions must still never schedule deferred or external work. */
export function assertSynchronousCallback(value: unknown): void {
  if (typeof value !== "function" || types.isAsyncFunction(value)
    || Object.prototype.toString.call(value) === "[object AsyncFunction]") {
    throw new Error("synchronous_callback_required");
  }
}
