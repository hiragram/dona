import type { Logger } from "./ports.js";
import type { UpdateController } from "./controller.js";

class WakeSignal {
  private resolver: (() => void) | undefined;

  wake(): void {
    this.resolver?.();
    this.resolver = undefined;
  }

  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolver = undefined;
        resolve();
      }, milliseconds);
      timer.unref();
      this.resolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

export class UpdateService {
  private readonly wakeSignal = new WakeSignal();
  private running = false;
  private loopPromise: Promise<void> | undefined;

  constructor(private readonly controller: UpdateController, private readonly logger: Logger, private readonly pollMs = 1_000) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.loopPromise) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  wake(): void {
    this.wakeSignal.wake();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.controller.processNext();
        await this.controller.deliverOutbox();
      } catch (error) {
        this.logger.error("Updater service iteration failed", {
          error_code: "service_iteration_failed",
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.running) await this.wakeSignal.wait(this.pollMs);
    }
  }
}
