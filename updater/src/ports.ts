import type {
  ActivationReceipt,
  CommandResult,
  Compatibility,
  DrainSnapshot,
  HealthSnapshot,
  MainAgentObservation,
  MainAgentStartResult,
  MainAgentStopResult,
  OutboxRow,
  ReleaseManifest,
  UpdateRow,
} from "./types.js";

export interface Clock {
  now(): Date;
}

export interface GitPort {
  refresh(currentSha: string): Promise<{
    current_sha: string;
    target_sha: string;
    target_reachable: boolean;
    ci_trusted: boolean;
    target_compatibility: Compatibility;
  }>;
  stage(targetSha: string, destination: string): Promise<void>;
  verifyStaged(destination: string, targetSha: string): Promise<void>;
}

export interface BuildPort {
  toolchain(): Promise<{ node_version: string; npm_version: string }>;
  buildRelease(checkoutPath: string): Promise<{
    lock_hashes: Record<string, string>;
    node_version: string;
    npm_version: string;
    compatibility: Compatibility;
  }>;
}

export interface ReleaseStorePort {
  preflight(): Promise<{ free_bytes: number; disk_floor_bytes: number; same_filesystem: true }>;
  readCurrentManifest(): Promise<ReleaseManifest>;
  readPreviousManifest(): Promise<ReleaseManifest | null>;
  releaseManifest(sha: string): Promise<ReleaseManifest | null>;
  prepareStaging(requestId: string, fence: number): Promise<string>;
  publish(stagingPath: string, manifest: ReleaseManifest): Promise<string>;
  activate(request: UpdateRow, releasePath: string): Promise<ActivationReceipt>;
  rollback(request: UpdateRow): Promise<ActivationReceipt>;
  observe(): Promise<{ current_sha: string | null; previous_sha: string | null; receipt: ActivationReceipt | null }>;
  cleanupPlan(protectedShas: ReadonlySet<string>): Promise<string[]>;
  cleanup(protectedShas: ReadonlySet<string>): Promise<string[]>;
}

export interface RuntimePort {
  quiesceSlack(requestId: string, targetSha: string): Promise<DrainSnapshot>;
  quiesceDispatcher(requestId: string, targetSha: string): Promise<DrainSnapshot>;
  stopSlack(): Promise<CommandResult>;
  stopDispatcher(): Promise<CommandResult>;
  startDispatcher(): Promise<CommandResult>;
  startSlack(): Promise<CommandResult>;
  waitForMainAgentIdle(): Promise<MainAgentObservation>;
  stopMainAgent(expected: MainAgentObservation): Promise<MainAgentStopResult>;
  startMainAgent(paneId: string, releasePath: string): Promise<MainAgentStartResult>;
  mainAgentStatus(releasePath: string): Promise<MainAgentObservation>;
  dispatcherHealth(): Promise<HealthSnapshot>;
  slackHealth(): Promise<HealthSnapshot>;
}

export interface DispatcherPort {
  eventTerminal(eventId: string): Promise<boolean>;
  safetyStatus(): Promise<{ safe: boolean; unsafe_states: string[] }>;
  deliverCompletion(outbox: OutboxRow): Promise<"delivered" | "accepted_unknown" | "rejected">;
  completionExists(externalEventId: string): Promise<boolean>;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
