export interface ServeApi {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServeDiagnostics {
  recoverInterruptedCaptures(): void;
}

export interface ServeController {
  maintainDiagnostics(): void;
}

export interface ServeLoop {
  start(): void;
}

export async function initializeServe(
  api: ServeApi,
  diagnostics: ServeDiagnostics,
  controller: ServeController,
  service: ServeLoop,
): Promise<void> {
  await api.start();
  try {
    diagnostics.recoverInterruptedCaptures();
    controller.maintainDiagnostics();
    service.start();
  } catch (error) {
    try {
      await api.stop();
    } catch (stopError) {
      throw new AggregateError([error, stopError], "updater_serve_initialization_failed");
    }
    throw error;
  }
}
