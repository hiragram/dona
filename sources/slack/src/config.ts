export type SlackLogLevel = "debug" | "info" | "warn" | "error";

export interface SlackRuntimeConfig {
  workspaces: string[];
  logLevel: SlackLogLevel;
  accessReceiptKeyPath: string;
}

const logLevels = new Set<SlackLogLevel>(["debug", "info", "warn", "error"]);
const workspacePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function expandPath(value:string):string {
  if(value==="~") return os.homedir();
  if(value.startsWith("~/")) return path.join(os.homedir(),value.slice(2));
  return path.resolve(value);
}

function parseWorkspaces(value: string | undefined): string[] {
  const workspaces = value
    ?.split(",")
    .map((workspace) => workspace.trim())
    .filter(Boolean);

  if (!workspaces?.length) {
    throw new Error(
      "SLACK_WORKSPACES にワークスペースの別名をカンマ区切りで指定してください（例: company,community）",
    );
  }

  for (const workspace of workspaces) {
    if (!workspacePattern.test(workspace)) {
      throw new Error(
        `ワークスペース別名「${workspace}」は小文字英数字で始め、64文字以内の小文字英数字・_・-で指定してください`,
      );
    }
  }

  if (new Set(workspaces).size !== workspaces.length) {
    throw new Error("SLACK_WORKSPACES に同じワークスペース別名を複数指定できません");
  }

  return workspaces;
}

function parseLogLevel(value: string | undefined): SlackLogLevel {
  const normalized = value?.trim().toLowerCase() || "info";
  if (!logLevels.has(normalized as SlackLogLevel)) {
    throw new Error(
      `SLACK_LOG_LEVEL は debug, info, warn, error のいずれかを指定してください（現在値: ${normalized}）`,
    );
  }
  return normalized as SlackLogLevel;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SlackRuntimeConfig {
  const base = path.join(os.homedir(),"Library","Application Support","Dona");
  return {
    workspaces: parseWorkspaces(env.SLACK_WORKSPACES),
    logLevel: parseLogLevel(env.SLACK_LOG_LEVEL),
    accessReceiptKeyPath: expandPath(env.DONA_UPDATE_INTERNAL_TOKEN_PATH ?? path.join(base,"update-control","dispatcher.token")),
  };
}
import os from "node:os";
import path from "node:path";
