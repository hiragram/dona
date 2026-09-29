import assert from "node:assert/strict";
import { test } from "node:test";

import { UpdateService } from "../src/service.js";
import type { UpdateController } from "../src/controller.js";
import type { Logger } from "../src/ports.js";

test("release retention still runs when notification delivery fails", async () => {
  let complete!: () => void;
  const retentionAttempted = new Promise<void>((resolve) => { complete = resolve; });
  const errors: string[] = [];
  const controller = {
    maintainDiagnostics() {},
    async processNext() {},
    async deliverOutbox() { throw new Error("injected_notification_failure"); },
    async maintainReleaseRetention() { complete(); },
  } as unknown as UpdateController;
  const logger = { info() {}, warn() {}, error(_message: string, fields?: Record<string, unknown>) {
    errors.push(String(fields?.error_code));
  } } as Logger;
  const service = new UpdateService(controller, logger);
  service.start();
  try { await retentionAttempted; }
  finally { await service.stop(); }
  assert.deepEqual(errors, ["service_iteration_failed"]);
});
