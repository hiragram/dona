import { types } from "node:util";

/** Infer the callback itself, so a caller cannot select a void result type and
 * accidentally accept an async function via TypeScript's void-return rule. */
type Deferred = PromiseLike<unknown> | Iterator<unknown> | AsyncIterator<unknown> | AsyncIterable<unknown> | ((...args: never[]) => unknown);
type DeferredReturn<T, Depth extends 1[] = []> = Depth["length"] extends 16 ? unknown
  : T extends symbol ? T : T extends object
    ? T extends Deferred ? T : T extends readonly unknown[] ? DeferredReturn<T[number], [...Depth, 1]>
      : T extends Iterable<unknown> ? T
        : { [K in keyof T]-?: DeferredReturn<T[K], [...Depth, 1]> }[keyof T]
    : never;
export type SynchronousCallback<F extends (...args: never[]) => unknown> = F &
  ([DeferredReturn<ReturnType<F>>] extends [never] ? unknown : never);

/** Defense for untyped callers; this is not a sandbox for arbitrary JavaScript.
 * Ordinary functions must still never schedule deferred or external work. */
export function assertSynchronousCallback(value: unknown): void {
  if (typeof value !== "function" || types.isAsyncFunction(value) || types.isGeneratorFunction(value)
    || ["[object AsyncFunction]", "[object GeneratorFunction]", "[object AsyncGeneratorFunction]"].includes(Object.prototype.toString.call(value))) {
    throw new Error("synchronous_callback_required");
  }
}

/** Only bounded passive data may leave a transaction. Inspect descriptors so
 * getters, proxies, custom prototypes, and nested callbacks cannot run while
 * checking the result or defer work until after the audit/lock is released. */
export function assertSynchronousResult(value: unknown): void {
  const ancestors = new WeakSet<object>();
  let remaining = 10000;
  const visit = (current: unknown, depth: number): void => {
    if (depth >= 16 || --remaining < 0 || typeof current === "function" || typeof current === "symbol") throw new Error("synchronous_result_required");
    if (current === null || typeof current !== "object") return;
    if (types.isProxy(current) || ancestors.has(current)) throw new Error("synchronous_result_required");
    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("synchronous_result_required");
    const keys = Reflect.ownKeys(current);
    if (keys.length > remaining || keys.some(key => typeof key === "symbol")) throw new Error("synchronous_result_required");
    ancestors.add(current);
    try {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("synchronous_result_required");
        visit(descriptor.value, depth + 1);
      }
    } finally { ancestors.delete(current); }
  };
  visit(value, 0);
}
