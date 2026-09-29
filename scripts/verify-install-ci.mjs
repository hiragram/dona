#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const required = ["Verify dispatcher", "Verify sources/slack", "Verify updater", "Verify self-hosted macOS"];

export function trustedInstallRunId(checks, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha) || !checks || typeof checks !== "object" ||
      !Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length ||
      checks.check_runs.length > 100) return null;
  let runId = null;
  for (const name of required) {
    const matched = checks.check_runs.filter(run => run.name === name);
    if (matched.length !== 1) return null;
    const check = matched[0];
    const url = typeof check.details_url === "string"
      ? check.details_url.match(/^https:\/\/github\.com\/hiragram\/dona\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/)
      : null;
    const id = url ? Number(url[1]) : null;
    if (!Number.isSafeInteger(id) || check.head_sha !== sha || check.status !== "completed" ||
        check.conclusion !== "success" || check.app?.slug !== "github-actions" ||
        (runId !== null && runId !== id)) return null;
    runId = id;
  }
  return runId;
}

export function trustedInstallWorkflow(run, runId, sha) {
  return run?.id === runId && run.event === "push" && run.head_branch === "main" &&
    run.head_sha === sha && run.status === "completed" && run.conclusion === "success" && run.name === "CI";
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [mode, file, sha, idText] = process.argv.slice(2);
    if (mode === "checks" && file && sha && idText === undefined) {
      const id = trustedInstallRunId(JSON.parse(fs.readFileSync(file, "utf8")), sha);
      if (id === null) throw new Error("trusted main push checks were not proven");
      process.stdout.write(`${id}\n`);
    } else if (mode === "workflow" && file && sha && /^[1-9]\d*$/.test(idText ?? "")) {
      if (!trustedInstallWorkflow(JSON.parse(fs.readFileSync(file, "utf8")), Number(idText), sha)) {
        throw new Error("trusted main push workflow was not proven");
      }
    } else throw new Error("invalid install CI verification arguments");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
