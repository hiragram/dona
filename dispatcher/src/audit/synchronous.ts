import { types } from "node:util";

/** Infer the callback itself, so a caller cannot select a void result type and
 * accidentally accept an async function via TypeScript's void-return rule. */
type Deferred = PromiseLike<unknown> | Iterator<unknown> | AsyncIterator<unknown> | ((...args: never[]) => unknown);
export type SynchronousCallback<F extends (...args: never[]) => unknown> = F &
  ([Extract<ReturnType<F>, Deferred>] extends [never] ? unknown : never);

/** Defense for untyped callers; this is not a sandbox for arbitrary JavaScript.
 * Ordinary functions must still never schedule deferred or external work. */
export function assertSynchronousCallback(value: unknown): void {
  if (typeof value !== "function" || types.isAsyncFunction(value) || types.isGeneratorFunction(value)
    || ["[object AsyncFunction]", "[object GeneratorFunction]", "[object AsyncGeneratorFunction]"].includes(Object.prototype.toString.call(value))) {
    throw new Error("synchronous_callback_required");
  }
}

export function assertSynchronousResult(value: unknown): void {
  if (typeof value === "function" || (value !== null && typeof value === "object"
    && (typeof (value as { then?: unknown }).then === "function" || typeof (value as { next?: unknown }).next === "function"))) {
    throw new Error("synchronous_result_required");
  }
}
