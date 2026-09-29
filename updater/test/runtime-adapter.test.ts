import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { RealRuntime } from "../src/adapters.js";
import { ProcessRunner, type RunOptions } from "../src/process.js";
import type { CommandResult } from "../src/types.js";
import { removeTree, targetSha, tempPolicy } from "./helpers.js";

const ok: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false, output_truncated: false };

class RecordingRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunOptions }> = [];
  result: CommandResult = ok;
  async run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ executable, args, options });
    return this.result;
  }
}

test("control capability requires a verified attempt ledger bound to the exact receipt", async () => {
  const { root, policy } = await tempPolicy();
  const previousSha = process.env.DONA_UPDATER_BUILD_SHA;
  const previousHome = process.env.HOME;
  const attemptId = `${targetSha}.ABC123`;
  const attemptDir = path.join(policy.control_root, "control-backups", attemptId);
  try {
    process.env.DONA_UPDATER_BUILD_SHA = targetSha;
    process.env.HOME = root;
    await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
    await fs.writeFile(path.join(path.dirname(policy.config_root), "dona.sqlite3"), "database", { mode: 0o600 });
    await fs.mkdir(attemptDir, { recursive: true, mode: 0o700 });
    await fs.chmod(attemptDir, 0o700);
    const artifact = Buffer.from("verified control artifact");
    const digest = createHash("sha256").update(artifact).digest("hex");
    const oldModule = path.join(attemptDir, "updater.previous", "dist", "database.js");
    const currentModule = path.join(policy.control_root, "updater", "dist", "database.js");
    for (const modulePath of [oldModule, currentModule]) {
      const treeRoot = path.dirname(path.dirname(modulePath));
      const dist = path.dirname(modulePath);
      await fs.mkdir(dist, { recursive: true, mode: 0o700 });
      await fs.writeFile(modulePath, artifact, { mode: 0o400 });
      await fs.chmod(dist, 0o500);
      await fs.chmod(treeRoot, 0o700);
    }
    const controlTreeDigest = createHash("sha256").update("d\0dist\0").update("f\0dist/database.js\0")
      .update(artifact).update("\0").digest("hex");
    const releaseDir = path.join(policy.release_root, targetSha);
    await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(releaseDir, "control.txt"), artifact, { mode: 0o400 });
    const manifest = { schema_version: 1, sha: targetSha, built_at: "2026-09-29T00:00:00Z" };
    const manifestPath = path.join(releaseDir, "release-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
    await fs.chmod(releaseDir, 0o500);
    const releaseDigest = createHash("sha256").update("f\0control.txt\0").update(artifact).update("\0")
      .update("f\0release-manifest.json\0").update(JSON.stringify({ ...manifest, built_at: null })).update("\0").digest("hex");
    await fs.writeFile(path.join(policy.control_root, "policy.json"), artifact, { mode: 0o600 });
    const agents = path.join(root, "Library/LaunchAgents");
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(path.join(agents, "dev.dona.updater.plist"), artifact, { mode: 0o600 });
    const dispatcherPlist = path.join(agents, "dev.dona.dispatcher.plist");
    await fs.writeFile(dispatcherPlist, artifact, { mode: 0o600 });
    const controlBackup = path.join(attemptDir, "updater.previous.sqlite3");
    await fs.writeFile(controlBackup, artifact, { mode: 0o600 });
    const rehearsal = { schema_version: 1, backup_sha256: digest, old_schema: 7, new_schema: 8,
      rollback: "restore_backup_required", old_binary_restored_backup_readable: true,
      old_database_module_sha256: digest, new_database_module_sha256: digest };
    const rehearsalBytes = Buffer.from(`${JSON.stringify(rehearsal)}\n`);
    await fs.writeFile(path.join(attemptDir, "restore-rehearsal.json"), rehearsalBytes, { mode: 0o600 });
    const rehearsalDigest = createHash("sha256").update(rehearsalBytes).digest("hex");
    const attempt = { schema_version: 1, phase: "verified", old_build_sha: "b".repeat(40),
      new_build_sha: targetSha, new_policy_sha256: digest, new_plist_sha256: digest,
      new_dispatcher_plist_sha256: digest,
      db_backup_sha256: digest, release_tree_sha256: releaseDigest, restore_rehearsal_sha256: rehearsalDigest };
    const attemptBytes = Buffer.from(`${JSON.stringify(attempt)}\n`);
    await fs.writeFile(path.join(attemptDir, "attempt.json"), attemptBytes, { mode: 0o600 });
    const receipt = { schema_version: 1, build_sha: targetSha,
      schema_migration_capability: "dispatcher_v2_to_v3_online_backup_v1", attempt_id: attemptId,
      attempt_sha256: createHash("sha256").update(attemptBytes).digest("hex"),
      old_build_sha: attempt.old_build_sha, policy_sha256: digest, plist_sha256: digest,
      dispatcher_plist_sha256: digest,
      db_backup_sha256: digest, release_tree_sha256: releaseDigest, restore_rehearsal_sha256: rehearsalDigest,
      control_updater_tree_sha256: controlTreeDigest, old_updater_tree_sha256: controlTreeDigest };
    const receiptPath = path.join(policy.control_root, "control-plane-receipt.json");
    await fs.writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: true, build_sha: targetSha });
    await fs.writeFile(dispatcherPlist, "tampered", { mode: 0o600 });
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.writeFile(dispatcherPlist, artifact, { mode: 0o600 });
    await fs.writeFile(controlBackup, "tampered", { mode: 0o600 });
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.writeFile(controlBackup, artifact, { mode: 0o600 });
    await fs.chmod(oldModule, 0o600);
    await fs.writeFile(oldModule, "tampered");
    await fs.chmod(oldModule, 0o400);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.chmod(oldModule, 0o600);
    await fs.writeFile(oldModule, artifact);
    await fs.chmod(oldModule, 0o400);
    await fs.chmod(currentModule, 0o600);
    await fs.writeFile(currentModule, "tampered");
    await fs.chmod(currentModule, 0o400);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.chmod(currentModule, 0o600);
    await fs.writeFile(currentModule, artifact);
    await fs.chmod(currentModule, 0o400);
    await fs.chmod(releaseDir, 0o700);
    await fs.chmod(path.join(releaseDir, "control.txt"), 0o600);
    await fs.writeFile(path.join(releaseDir, "control.txt"), "tampered");
    await fs.chmod(path.join(releaseDir, "control.txt"), 0o400);
    await fs.chmod(releaseDir, 0o500);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.chmod(releaseDir, 0o700);
    await fs.chmod(path.join(releaseDir, "control.txt"), 0o600);
    await fs.writeFile(path.join(releaseDir, "control.txt"), artifact);
    await fs.chmod(path.join(releaseDir, "control.txt"), 0o400);
    await fs.chmod(releaseDir, 0o500);
    await fs.chmod(releaseDir, 0o700);
    await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, sha: "c".repeat(40) }));
    await fs.chmod(manifestPath, 0o400);
    await fs.chmod(releaseDir, 0o500);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.chmod(releaseDir, 0o700);
    await fs.chmod(manifestPath, 0o600);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.chmod(manifestPath, 0o400);
    await fs.chmod(releaseDir, 0o500);
    await fs.writeFile(path.join(policy.control_root, "policy.json"), "changed", { mode: 0o600 });
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
    await fs.writeFile(path.join(attemptDir, "attempt.json"), `${JSON.stringify({ ...attempt, phase: "restore_required" })}\n`);
    assert.deepEqual(await runtime.schemaMigrationCapability(receipt.schema_migration_capability), { ready: false, build_sha: targetSha });
  } finally {
    if (previousSha === undefined) delete process.env.DONA_UPDATER_BUILD_SHA;
    else process.env.DONA_UPDATER_BUILD_SHA = previousSha;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.chmod(path.join(policy.release_root, targetSha), 0o700).catch(() => undefined);
    await fs.chmod(path.join(attemptDir, "updater.previous", "dist"), 0o700).catch(() => undefined);
    await fs.chmod(path.join(policy.control_root, "updater", "dist"), 0o700).catch(() => undefined);
    await removeTree(root);
  }
});

test("Dispatcher registration read distinguishes bootout from an ambiguous launchctl failure", async () => {
  const { root, policy } = await tempPolicy();
  try {
    const recording = new RecordingRunner();
    const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
    assert.equal(await runtime.dispatcherRegistered(), true);
    recording.result = { ...ok, exit_code: 113, stderr: "Could not find service" };
    assert.equal(await runtime.dispatcherRegistered(), false);
    await runtime.startDispatcher();
    recording.result = { ...ok, exit_code: 1, stderr: "permission denied" };
    await assert.rejects(runtime.dispatcherRegistered(), /dispatcher_registration_unverified/);
    const uid = process.getuid!();
    assert.deepEqual(recording.calls.map(call => call.args), [
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library/LaunchAgents/dev.dona.dispatcher.plist")],
      ["print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
    ]);
  } finally { await removeTree(root); }
});

test("runtime inventory hashes live classes without exposing identifiers or payloads", async () => {
  const { root, policy } = await tempPolicy();
  const previousBuild = process.env.DONA_UPDATER_BUILD_SHA;
  process.env.DONA_UPDATER_BUILD_SHA = targetSha;
  try {
    await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
    await fs.mkdir(policy.control_root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(policy.control_root, "control-plane-receipt.json"), JSON.stringify({
      schema_version: 1, build_sha: targetSha,
      schema_migration_capability: "dispatcher_v2_to_v3_online_backup_v1",
    }), { mode: 0o600 });
    const agents = path.join(root, "LaunchAgents");
    await fs.mkdir(agents);
    for (const label of [policy.launchd.dispatcher_label, policy.launchd.slack_label]) {
      await fs.writeFile(path.join(agents, `${label}.plist`), `<plist><string>${label}</string></plist>`, { mode: 0o600 });
    }
    const dbPath = path.join(root, "Dona", "dona.sqlite3");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE events(event_id TEXT,status TEXT,schema_version INTEGER,source TEXT,updated_at TEXT);
      CREATE TABLE jobs(job_id TEXT,status TEXT,source TEXT,steer_state TEXT,attempt_count INTEGER,
        herdr_workspace_id TEXT,completion_event_id TEXT,last_error_code TEXT,updated_at TEXT);
      PRAGMA user_version = 2;`);
    const controlEventId = "evt_01M1ES03XY5CF8D9PM5CWX4SRV";
    db.prepare("INSERT INTO events VALUES (?,'waiting_agent',1,'slack','2026-09-29T00:00:00Z')").run(controlEventId);
    db.prepare("INSERT INTO jobs VALUES ('job_secret','running','dona_job',NULL,1,'private_worker',NULL,NULL,'2026-09-29T00:00:00Z')").run();
    db.close();
    await fs.chmod(dbPath, 0o600);
    const runner = new RecordingRunner();
    let schemaVersion = 2;
    let servicesRegistered = true;
    runner.run = async (_executable, args, _options) => args[0]?.endsWith("app-schema-inspect-cli.js")
      ? { ...ok, stdout: JSON.stringify({ schema_version: 1, user_version: schemaVersion, integrity_ok: true, foreign_key_violations: 0 }) }
      : !servicesRegistered && args[0] === "print" ? { ...ok, exit_code: 113, stderr: "Could not find service" } : ok;
    const runtime = new RealRuntime(policy, runner as unknown as ProcessRunner, agents);
    const inventory = await runtime.runtimeInventory();
    servicesRegistered = false;
    assert.deepEqual(await runtime.runtimeInventory([], true), inventory);
    await assert.rejects(runtime.runtimeInventory(), /runtime_inventory_unavailable/);
    servicesRegistered = true;
    await assert.rejects(runtime.runtimeInventory([], true), /runtime_inventory_unavailable/);
    assert.equal(inventory.pending.events, 1);
    assert.equal((await runtime.runtimeInventory([controlEventId])).pending.events, 0);
    assert.equal(inventory.pending.jobs, 1);
    assert.equal(inventory.workers.classes["running:worker:protocol_unknown:epoch_unknown:result_capability_unknown"], 1);
    assert.equal(JSON.stringify(inventory).includes("secret"), false);
    const changed = new Database(dbPath);
    changed.prepare("UPDATE jobs SET status='completed' WHERE job_id='job_secret'").run();
    changed.close();
    assert.notEqual((await runtime.runtimeInventory()).pending.digest, inventory.pending.digest);
    await fs.writeFile(path.join(agents, `${policy.launchd.dispatcher_label}.plist`),
      "<plist><string>changed registration</string></plist>", { mode: 0o600 });
    assert.notEqual((await runtime.runtimeInventory()).launchd.identity_digest, inventory.launchd.identity_digest);
    const v3 = new Database(dbPath);
    v3.exec(`CREATE TABLE schedules(schedule_id TEXT,state TEXT,revision INTEGER,next_due TEXT,updated_at TEXT);
      CREATE TABLE schedule_revisions(schedule_id TEXT,revision INTEGER,recurrence_hash TEXT,policy_json TEXT,
        policy_version INTEGER,timezone TEXT,tzdb_version TEXT,authorization_revision INTEGER,expires_at TEXT,
        action TEXT,content_scope TEXT,content_hash TEXT,target_json TEXT);
      CREATE TABLE schedule_runs(run_id TEXT,status TEXT,revision INTEGER,event_id TEXT,job_id TEXT,reason TEXT);
      CREATE TABLE connector_outbox(outbox_id TEXT,status TEXT,kind TEXT,run_id TEXT,content_hash TEXT,receipt_id TEXT,updated_at TEXT);
      CREATE TABLE job_groups(source_event_id TEXT,notification_mode TEXT,attention_event_id TEXT,all_terminal_event_id TEXT,updated_at TEXT);
      PRAGMA user_version = 3;`);
    v3.prepare("INSERT INTO schedules VALUES ('sched_secret','active',1,NULL,'2026-09-29T00:00:00Z')").run();
    v3.prepare("INSERT INTO schedule_revisions VALUES ('sched_secret',1,'hash','{}',1,'Asia/Tokyo','v1',1,'2099-01-01T00:00:00Z','work.read_only','fixed_objective_redacted_result','hash','{}')").run();
    v3.prepare("INSERT INTO connector_outbox VALUES ('out_secret','pending','slack.work_result.post','run_secret','hash',NULL,'2026-09-29T00:00:00Z')").run();
    v3.prepare("INSERT INTO job_groups VALUES ('evt_secret','grouped',NULL,NULL,'2026-09-29T00:00:00Z')").run();
    v3.close();
    schemaVersion = 3;
    const expanded = await runtime.runtimeInventory();
    assert.equal(expanded.pending.schedules, 1);
    assert.equal(expanded.pending.notifications, 2);
    assert.equal(JSON.stringify(expanded).includes("secret"), false);
  } finally {
    if (previousBuild === undefined) delete process.env.DONA_UPDATER_BUILD_SHA;
    else process.env.DONA_UPDATER_BUILD_SHA = previousBuild;
    await removeTree(root);
  }
});

function agentResponse(cwd: string, sessionId: string | null, interactiveReady = true): string {
  return JSON.stringify({
    result: {
      type: "agent_info",
      agent: {
        terminal_id: "term-1",
        agent_status: "idle",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
        focused: false,
        revision: 1,
        agent: "codex",
        name: "dona-main",
        cwd,
        foreground_cwd: cwd,
        interactive_ready: interactiveReady,
        launch_pending: false,
        ...(sessionId ? { agent_session: { source: "codex", agent: "codex", kind: "id", value: sessionId } } : {}),
      },
    },
  });
}

function paneResponse(cwd: string): string {
  return JSON.stringify({
    result: {
      type: "pane_info",
      pane: {
        terminal_id: "term-1",
        agent_status: "unknown",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
        cwd,
        foreground_cwd: cwd,
      },
    },
  });
}

class AgentRunner extends RecordingRunner {
  running = true;
  cwd: string;
  sessionId: string | null = "session-old";
  omitSessionOnStart = false;
  interactiveReady = true;
  becomeReadyOnNextGet = false;
  ignoreCwdChange = false;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  override async run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ executable, args, options });
    if (args[0] === "--version") return { ...ok, stdout: "herdr 0.8.2\n" };
    if (args.includes("wait")) return { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) };
    if (args.includes("send-keys")) {
      this.running = false;
      return { ...ok, stdout: JSON.stringify({ result: { type: "ok" } }) };
    }
    if (args.includes("pane") && args.includes("run")) {
      const command = String(args.at(-1));
      const match = /^cd -- '(.*)'$/.exec(command);
      if (!match) return { ...ok, exit_code: 1, stderr: JSON.stringify({ error: { code: "invalid_request" } }) };
      if (!this.ignoreCwdChange) this.cwd = match[1]!.replaceAll(`'\\''`, "'");
      return { ...ok, stdout: JSON.stringify({ result: { type: "ok" } }) };
    }
    if (args.includes("pane") && args.includes("get")) {
      return { ...ok, stdout: paneResponse(this.cwd) };
    }
    if (args.includes("get")) {
      if (this.becomeReadyOnNextGet) {
        this.becomeReadyOnNextGet = false;
        this.interactiveReady = true;
      }
      return this.running
        ? { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) }
        : { ...ok, exit_code: 1, stderr: JSON.stringify({ error: { code: "agent_not_found", message: "missing" } }) };
    }
    if (args.includes("start")) {
      this.sessionId = this.omitSessionOnStart ? null : "session-new";
      this.running = true;
      return { ...ok, stdout: agentResponse(this.cwd, this.sessionId, this.interactiveReady) };
    }
    return ok;
  }
}

async function listen(
  socketPath: string,
  service: "dispatcher" | "slack_adapter",
  requests: unknown[],
  pendingDrainResponses = 0,
): Promise<http.Server> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  let remainingPending = pendingDrainResponses;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health/version") {
      const body = JSON.stringify({
        schema_version: 1,
        status: "ready",
        service,
        build_sha: targetSha,
        protocol: 1,
        app_schema: 2,
        app_schema_read_min: 2,
        app_schema_read_max: 3,
        app_schema_write: 2,
        config: 1,
        ...(service === "slack_adapter" ? { workspaces_ready: true } : {}),
      });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    const drained = remainingPending === 0;
    remainingPending = Math.max(0, remainingPending - 1);
    const body = JSON.stringify({
      schema_version: 1,
      protocol: 1,
      service,
      quiescing: true,
      drained,
      in_flight: drained ? 0 : 1,
      unsafe_states: drained ? [] : ["events.waiting_agent:1"],
    });
    response.writeHead(drained ? 200 : 202, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

test("RealRuntime uses typed UDS handshakes and fixed launchctl argv without live process access", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const dispatcherDatabasePath = path.join(root, "Dona", "dona.sqlite3");
  const dispatcherDatabase = new Database(dispatcherDatabasePath);
  dispatcherDatabase.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  dispatcherDatabase.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  dispatcherDatabase.exec("ALTER TABLE jobs ADD COLUMN job_id TEXT");
  dispatcherDatabase.prepare("INSERT INTO jobs (status,job_id) VALUES ('completed','old-terminal')").run();
  dispatcherDatabase.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('old-terminal','2026-09-25T00:00:00Z')").run();
  dispatcherDatabase.close();
  await fs.chmod(dispatcherDatabasePath, 0o600);
  const requests: unknown[] = [];
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests, 1);
  const slack = await listen(policy.slack_socket, "slack_adapter", requests);
  const recording = new RecordingRunner();
  const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.quiesceSlack("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    assert.equal((await runtime.quiesceDispatcher("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha)).drained, true);
    const dispatcherHealth = await runtime.dispatcherHealth();
    assert.equal(dispatcherHealth.build_sha, targetSha);
    assert.equal(dispatcherHealth.app_schema_read_max, 3);
    assert.equal((await runtime.slackHealth()).workspaces_ready, true);
    await runtime.stopSlack();
    await runtime.stopDispatcher();
    await runtime.startDispatcher();
    await runtime.startSlack();
    assert.deepEqual(requests, [
      { schema_version: 1, protocol: 1, operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", target_sha: targetSha },
      { schema_version: 1, protocol: 1, operation_id: "upd_01m1es03xy5cf8d9pm5cwx4srv", target_sha: targetSha },
    ]);
    const uid = process.getuid!();
    assert.deepEqual(recording.calls.map(({ executable, args }) => [executable, ...args]), [
      [policy.executables.launchctl, "bootout", `gui/${uid}/${policy.launchd.slack_label}`],
      [policy.executables.launchctl, "bootout", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "print", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.dispatcher_label}`],
      [policy.executables.launchctl, "print", `gui/${uid}/${policy.launchd.slack_label}`],
      [policy.executables.launchctl, "kickstart", "-k", `gui/${uid}/${policy.launchd.slack_label}`],
    ]);
    assert.equal(Object.values(recording.calls[0]!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await Promise.all([new Promise<void>((resolve) => dispatcher.close(() => resolve())), new Promise<void>((resolve) => slack.close(() => resolve()))]);
    await removeTree(root);
  }
});

test("RealRuntime refuses a legacy drained response while a durable worker remains active", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.prepare("INSERT INTO jobs (status,herdr_workspace_id) VALUES ('running','private-agent')").run();
  database.prepare("INSERT INTO jobs (status,last_error_code) VALUES ('retryable_failed','stale_preparing')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const requests: unknown[] = [];
  const dispatcher = await listen(policy.dispatcher_socket, "dispatcher", requests);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    const snapshot = await runtime.quiesceDispatcher("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha);
    assert.equal(snapshot.drained, false);
    assert.deepEqual(snapshot.unsafe_states, ["jobs.handoff_unavailable:2"]);
    assert.equal(JSON.stringify(snapshot).includes("private-agent"), false);
  } finally {
    await new Promise<void>((resolve) => dispatcher.close(() => resolve()));
    await removeTree(root);
  }
});

test("RealRuntime counts terminal legacy agents until durable stop", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (job_id TEXT, status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  database.prepare("INSERT INTO jobs (job_id,status) VALUES ('legacy-terminal','failed')").run();
  database.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('legacy-terminal',NULL)").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE legacy_job_agents_to_stop SET stopped_at='2026-09-25T00:00:00Z'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally { await removeTree(root); }
});

test("RealRuntime treats a matching operator assertion ledger as separate terminal evidence", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec(`CREATE TABLE jobs (job_id TEXT, status TEXT NOT NULL, updated_at TEXT,
    steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT,
    last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT);
    CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT);
    CREATE TABLE job_operator_assertion_recoveries (job_id TEXT, final_status TEXT, final_updated_at TEXT)`);
  database.prepare("INSERT INTO jobs (job_id,status,updated_at,herdr_workspace_id) VALUES ('legacy','failed','t1','agent')").run();
  database.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('legacy',NULL)").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).safe, false);
    const recorded = new Database(databasePath);
    recorded.prepare("INSERT INTO job_operator_assertion_recoveries VALUES ('legacy','failed','t1')").run();
    recorded.close();
    assert.equal((await runtime.workerSafety()).safe, true);
    const changed = new Database(databasePath);
    changed.prepare("UPDATE jobs SET updated_at='t2' WHERE job_id='legacy'").run();
    changed.close();
    assert.equal((await runtime.workerSafety()).safe, false);
  } finally { await removeTree(root); }
});

test("RealRuntime counts a reconciled terminal schedule worker without stop proof", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  for (const code of ["schedule_reconcile_worker_unverified", "terminal_steer_worker_unverified",
    "cancel_worker_unverified"]) {
    database.prepare("INSERT INTO jobs (status,last_error_code) VALUES ('failed',?)").run(code);
  }
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 3);
  } finally { await removeTree(root); }
});

test("RealRuntime distinguishes unresolved steer from definite retryable agent absence", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.prepare("INSERT INTO jobs (status,steer_state) VALUES ('completed','dispatching')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const settled = new Database(databasePath);
    settled.prepare("UPDATE jobs SET steer_state='accepted'").run();
    settled.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const retryable = new Database(databasePath);
    retryable.prepare("UPDATE jobs SET status='retryable_failed',herdr_workspace_id='recorded',last_error_code='agent_not_found'").run();
    retryable.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    const uncertain = new Database(databasePath);
    uncertain.prepare("UPDATE jobs SET last_error_code='stale_preparing'").run();
    uncertain.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const terminalCancel = new Database(databasePath);
    terminalCancel.prepare("UPDATE jobs SET status='completed',steer_state=NULL,last_error_code=NULL,herdr_workspace_id='recorded'").run();
    terminalCancel.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const proof = new Database(databasePath);
    proof.exec("ALTER TABLE jobs ADD COLUMN job_id TEXT");
    proof.prepare("UPDATE jobs SET job_id='terminal-job'").run();
    proof.exec("CREATE TABLE job_terminal_worker_stop_proofs(job_id TEXT PRIMARY KEY,stopped_at TEXT NOT NULL)");
    proof.prepare("INSERT INTO job_terminal_worker_stop_proofs VALUES('terminal-job',?)").run(new Date().toISOString());
    proof.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE jobs SET last_error_code='agent_not_found'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally { await removeTree(root); }
});

test("RealRuntime excludes only a proven pre-prepare result collision", async () => {
  const { root, policy } = await tempPolicy();
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  const databasePath = path.join(root, "Dona", "dona.sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE jobs (job_id TEXT, status TEXT NOT NULL, steer_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, herdr_workspace_id TEXT, last_error_code TEXT, dispatch_started_at TEXT, prompt_accepted_at TEXT)");
  database.exec("CREATE TABLE legacy_job_agents_to_stop (job_id TEXT, stopped_at TEXT)");
  database.prepare("INSERT INTO jobs (job_id,status,last_error_code) VALUES ('collision-job','needs_review','result_path_exists')").run();
  database.close();
  await fs.chmod(databasePath, 0o600);
  const runtime = new RealRuntime(policy, new RecordingRunner() as unknown as ProcessRunner);
  try {
    assert.equal((await runtime.workerSafety()).safe, true);
    const retried = new Database(databasePath);
    retried.prepare("UPDATE jobs SET attempt_count=1").run();
    retried.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const firstAttempt = new Database(databasePath);
    firstAttempt.prepare("UPDATE jobs SET attempt_count=0").run();
    firstAttempt.close();
    const guarded = new Database(databasePath);
    guarded.prepare("UPDATE jobs SET herdr_workspace_id='possible-worker'").run();
    guarded.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 1);
    const stopped = new Database(databasePath);
    stopped.prepare("UPDATE jobs SET last_error_code='invalid_result_agent_stopped'").run();
    stopped.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    for (const code of ["agent_not_found", "agent_not_running", "steer_acceptance_unknown"]) {
      const state = new Database(databasePath);
      state.prepare("UPDATE jobs SET last_error_code=?").run(code);
      state.close();
      assert.equal((await runtime.workerSafety()).active_worker_count,
        code === "steer_acceptance_unknown" ? 1 : 0);
    }
    const legacy = new Database(databasePath);
    legacy.prepare("UPDATE jobs SET last_error_code='legacy_agent_sandbox_unknown'").run();
    legacy.prepare("INSERT INTO legacy_job_agents_to_stop VALUES ('collision-job',?)")
      .run(new Date().toISOString());
    legacy.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
    const invalid = new Database(databasePath);
    invalid.prepare("UPDATE jobs SET last_error_code='invalid_result'").run();
    invalid.close();
    assert.equal((await runtime.workerSafety()).active_worker_count, 0);
  } finally {
    await removeTree(root);
  }
});

test("RealRuntime migrates only the owner-private Dispatcher database selected by dispatcher.env", async () => {
  const { root, policy } = await tempPolicy();
  const configuredDatabase = path.join(root, "custom", "dispatcher.sqlite3");
  await fs.mkdir(path.dirname(configuredDatabase), { recursive: true });
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  const database = new Database(configuredDatabase);
  database.pragma("user_version = 2");
  database.close();
  await fs.chmod(configuredDatabase, 0o600);
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), `DONA_DATABASE_PATH=${configuredDatabase} # custom path\n`, { mode: 0o600 });
  const recording = new RecordingRunner();
  const runtime = new RealRuntime(policy, recording as unknown as ProcessRunner);
  await runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true });
  assert.equal(recording.calls[0]?.args[1], configuredDatabase);
  assert.equal(recording.calls[0]?.args[2], path.join(
    policy.control_root, "schema-backups", "dispatcher-v2-to-v3", "dispatcher-v2.sqlite3",
  ));
  assert.equal(recording.calls[0]?.args[3], path.join(
    policy.control_root, "schema-backups", "dispatcher-v2-to-v3", "migration-receipt.json",
  ));
  recording.result = {
    ...ok,
    stdout: '{"schema_version":1,"user_version":2,"integrity_ok":true,"foreign_key_violations":0}\n',
  };
  assert.deepEqual(await runtime.appSchemaState(), {
    user_version: 2,
    integrity_ok: true,
    foreign_key_violations: 0,
  });
  assert.equal(path.basename(recording.calls[1]!.args[0]!), "app-schema-inspect-cli.js");
  assert.equal(recording.calls[1]!.args[1], configuredDatabase);
  await fs.chmod(configuredDatabase, 0o644);
  assert.throws(() => runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true }), /database_identity_invalid/);
  await fs.chmod(configuredDatabase, 0o600);
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "DONA_DATABASE_PATH=relative/dispatcher.sqlite3\n", { mode: 0o600 });
  assert.throws(() => runtime.migrateAppSchema("upd_01m1es03xy5cf8d9pm5cwx4srv", targetSha,
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 2, rollback_safe: true },
    { protocol: 1, config: 1, app_schema_read_min: 2, app_schema_read_max: 3, app_schema_write: 3, rollback_safe: true }), /path_must_be_absolute/);
  await removeTree(root);
});

test("RealRuntime restarts the exact idle dona-main pane from the immutable target release", async () => {
  const { root, policy } = await tempPolicy();
  const currentRelease = path.join(policy.release_root, "1".repeat(40));
  const targetRelease = path.join(policy.release_root, targetSha);
  await fs.mkdir(path.join(targetRelease, ".codex"), { recursive: true });
  await fs.mkdir(policy.config_root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(targetRelease, ".codex", "config.toml"), "[mcp_servers.test]\ncommand = \"true\"\n");
  await fs.writeFile(path.join(policy.config_root, "dispatcher.env"), "", { mode: 0o600 });
  await fs.writeFile(path.join(policy.config_root, "slack.env"), "SLACK_WORKSPACES=test\n", { mode: 0o600 });
  const canonicalTargetRelease = await fs.realpath(targetRelease);
  const canonicalConfigRoot = await fs.realpath(policy.config_root);
  const dispatcherMcpEnvironment = `mcp_servers.dona_dispatcher.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "dispatcher.env"))}, "DONA_RELEASE_MANIFEST_PATH" = ${JSON.stringify(path.join(policy.current_pointer, "release-manifest.json"))}, "DONA_UPDATER_SOCKET_PATH" = ${JSON.stringify(path.join(policy.control_root, "updater.sock"))}, "DONA_UPDATE_INTERNAL_TOKEN_PATH" = ${JSON.stringify(policy.dispatcher_internal_token_file)}, "DONA_HERDR_PATH" = ${JSON.stringify(policy.executables.herdr)}, "DONA_CODEX_PATH" = ${JSON.stringify(policy.executables.codex)}, "DONA_GH_PATH" = ${JSON.stringify(policy.executables.gh)}, "DONA_GIT_PATH" = ${JSON.stringify(policy.executables.git)} }`;
  const slackMcpEnvironment = `mcp_servers.dona_slack.env = { "DOTENV_CONFIG_PATH" = ${JSON.stringify(path.join(canonicalConfigRoot, "slack.env"))}, "DONA_UPDATE_INTERNAL_TOKEN_PATH" = ${JSON.stringify(policy.dispatcher_internal_token_file)} }`;
  const runner = new AgentRunner(currentRelease);
  const runtime = new RealRuntime(policy, runner as unknown as ProcessRunner);
  try {
    runner.interactiveReady = false;
    const idle = await runtime.waitForMainAgentIdle();
    assert.equal(idle.status, "idle");
    assert.equal(idle.session_id, "session-old");
    assert.equal(idle.interactive_ready, false);
    runner.sessionId = "session-replaced";
    assert.equal((await runtime.stopMainAgent(idle)).outcome, "rejected");
    runner.sessionId = "session-old";
    assert.deepEqual(await runtime.stopMainAgent(idle), { outcome: "stopped", pane_id: "w1:p1", error_code: null });
    runner.interactiveReady = true;
    const started = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(started.outcome, "started");
    assert.equal(started.observation.matches_release, true);
    assert.equal(started.observation.session_id, "session-new");
    assert.deepEqual(runner.calls.map(({ executable, args }) => [executable, ...args]), [
      [policy.executables.herdr, "--version"],
      [policy.executables.herdr, "--session", "dona", "agent", "wait", "dona-main", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "100"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "dona-main"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "dona-main"],
      [policy.executables.herdr, "--session", "dona", "agent", "send-keys", "w1:p1", "ctrl+c"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "w1:p1"],
      [policy.executables.herdr, "--session", "dona", "agent", "get", "w1:p1"],
      [policy.executables.herdr, "--session", "dona", "pane", "run", "w1:p1", `cd -- '${canonicalTargetRelease}'`],
      [policy.executables.herdr, "--session", "dona", "pane", "get", "w1:p1"],
      [
        policy.executables.herdr, "--session", "dona", "agent", "start", "dona-main", "--kind", "codex",
        "--pane", "w1:p1", "--timeout", "100", "--", "-C", canonicalTargetRelease, "-c",
        `projects = { ${JSON.stringify(canonicalTargetRelease)} = { trust_level = "trusted" } }`,
        "-c", dispatcherMcpEnvironment, "-c", slackMcpEnvironment,
        "--model", "gpt-6-sol", "-c", 'model_reasoning_effort="medium"',
        "-c", "check_for_update_on_startup=false",
        "起動確認です。外部操作、ファイル変更、プロセス操作は行わず、READYとだけ返してください。",
      ],
    ]);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.sessionId = "session-old";
    runner.interactiveReady = false;
    runner.becomeReadyOnNextGet = true;
    const delayedReady = await runtime.startMainAgent("w1:p1", targetRelease, "session-old");
    assert.equal(delayedReady.outcome, "started");
    assert.equal(delayedReady.observation.interactive_ready, true);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.omitSessionOnStart = true;
    assert.equal((await runtime.startMainAgent("w1:p1", targetRelease)).outcome, "accepted_unknown");
    const busyCallCount = runner.calls.length;
    const busy = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(busy.outcome, "rejected");
    assert.equal(busy.error_code, "agent_pane_busy");
    assert.equal(runner.calls.length, busyCallCount + 1);
    assert.deepEqual(runner.calls.at(-1)!.args, ["--session", "dona", "agent", "get", "w1:p1"]);
    runner.running = false;
    runner.cwd = currentRelease;
    runner.ignoreCwdChange = true;
    const unchangedCwdCallCount = runner.calls.length;
    const unchangedCwd = await runtime.startMainAgent("w1:p1", targetRelease);
    assert.equal(unchangedCwd.outcome, "accepted_unknown");
    assert.equal(unchangedCwd.error_code, "main_agent_pane_cwd_change_unknown");
    assert.equal(runner.calls.slice(unchangedCwdCallCount).some(({ args }) => args.includes("start")), false);
    runner.ignoreCwdChange = false;
    const callCount = runner.calls.length;
    await fs.chmod(path.join(policy.config_root, "slack.env"), 0o644);
    assert.equal((await runtime.startMainAgent("w1:p1", targetRelease)).outcome, "rejected");
    assert.equal(runner.calls.length, callCount);
    assert.equal(Object.values(runner.calls.at(-1)!.options.env ?? {}).some((value) => /token|secret/i.test(value)), false);
  } finally {
    await removeTree(root);
  }
});

test("保守bridgeは通常main adapterを通して世代固有MCPを必須接続で起動する", async () => {
  const bridgeUrl = new URL('../../scripts/maintenance/main_bridge.mjs', import.meta.url).href;
  const {operate} = await import(bridgeUrl);
  const {root,policy} = await tempPolicy();
  try {
    const release = path.join(policy.release_root,targetSha);
    await fs.mkdir(path.join(release,'.codex'),{recursive:true});
    await fs.writeFile(path.join(release,'.codex/config.toml'),'');
    await fs.mkdir(policy.config_root,{recursive:true,mode:0o700});
    for (const name of ['dispatcher','slack']) await fs.writeFile(path.join(policy.config_root,`${name}.env`),'',{mode:0o600});
    const oldRelease=path.join(policy.release_root,'1'.repeat(40));
    const recorder=new AgentRunner(oldRelease);
    class BridgeProcess { run(executable:string,args:readonly string[],options:RunOptions) { return recorder.run(executable,args,options); } }
    const old=await operate({action:'status',release:oldRelease},policy,RealRuntime,BridgeProcess);
    assert.equal(old.session_id,'session-old');
    assert.equal((await operate({action:'stop',expected:old},policy,RealRuntime,BridgeProcess)).outcome,'stopped');
    const started=await operate({action:'start',release,pane:old.pane_id,previous_session:old.session_id},policy,RealRuntime,BridgeProcess);
    assert.equal(started.outcome,'started');
    assert.equal(started.observation.session_id,'session-new');
    const call=recorder.calls.find(c=>c.args[2]==='agent'&&c.args[3]==='start')!;
    for (const [server,name] of [['dona_dispatcher','dispatcher'],['dona_slack','slack']]) {
      assert.ok(call.args.includes(`mcp_servers.${server}.required=true`));
      assert.ok(call.args.includes(`mcp_servers.${server}.args=${JSON.stringify([path.join(policy.config_root,`mcp-${name}.mjs`)])}`));
      assert.ok(call.args.includes(`mcp_servers.${server}.command=${JSON.stringify(policy.executables.node)}`));
    }
    assert.equal(recorder.calls.filter(c=>c.args[3]==='start').length,1);
    assert.equal(recorder.calls.some(c=>c.args.includes('session')&&c.args.includes('kill')),false);
  } finally { await removeTree(root); }
});
