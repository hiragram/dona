import { loadStoredSlackBotToken } from "./credentials.js";
import type { KeychainStore } from "./keychain.js";
import type { SlackLogger } from "./logger.js";
import {
  SlackWebApiClient,
  type SlackApiClient,
  type SlackWorkspaceIdentity,
} from "./slack-api.js";

export interface SlackWorkspaceConnection extends SlackWorkspaceIdentity {
  alias: string;
  client: SlackApiClient;
}

export type SlackApiClientFactory = (botToken: string, logger: SlackLogger) => SlackApiClient;

export class SlackWorkspaceRegistry {
  private constructor(private readonly connections: Map<string, SlackWorkspaceConnection>) {}

  static async load(
    aliases: string[],
    keychain: KeychainStore,
    logger: SlackLogger,
    createClient: SlackApiClientFactory = (token, clientLogger) =>
      new SlackWebApiClient(token, clientLogger),
  ): Promise<SlackWorkspaceRegistry> {
    const connections = new Map<string, SlackWorkspaceConnection>();
    const teamAliases = new Map<string, string>();

    for (const alias of aliases) {
      const botToken = await loadStoredSlackBotToken(alias, keychain);
      const client = createClient(botToken, logger);
      const identity = await client.authenticate();
      const existingAlias = teamAliases.get(identity.teamId);
      if (existingAlias) {
        throw new Error(
          `SLACK_WORKSPACESの「${existingAlias}」と「${alias}」が同じSlack workspace (${identity.teamId}) を指しています`,
        );
      }
      teamAliases.set(identity.teamId, alias);
      connections.set(alias, { alias, client, ...identity });
      logger.info("Slack MCP workspace authenticated", {
        workspace: alias,
        workspace_id: identity.teamId,
      });
    }

    return new SlackWorkspaceRegistry(connections);
  }

  get(alias: string): SlackWorkspaceConnection {
    const connection = this.connections.get(alias);
    if (connection) return connection;
    throw new Error(
      `Unknown Slack workspace alias: ${alias}. Available aliases: ${this.list()
        .map(({ alias: available }) => available)
        .join(", ")}`,
    );
  }

  getByTeamId(teamId: string): SlackWorkspaceConnection {
    const connection = [...this.connections.values()].find((candidate) => candidate.teamId === teamId);
    if (connection) return connection;
    throw new Error(`Unknown Slack workspace ID: ${teamId}`);
  }

  list(): Omit<SlackWorkspaceConnection, "client">[] {
    return [...this.connections.values()].map(({ client: _client, ...identity }) => identity);
  }
}
