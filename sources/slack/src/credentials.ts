import type { KeychainStore } from "./keychain.js";
import type { SecretPrompt } from "./prompt.js";

export interface SlackTokens {
  appToken: string;
  botToken: string;
}

interface TokenDefinition {
  key: keyof SlackTokens;
  accountSuffix: string;
  displayName: string;
  prefix: "xapp-" | "xoxb-";
}

const tokenDefinitions: readonly TokenDefinition[] = [
  {
    key: "appToken",
    accountSuffix: "slack-app-token",
    displayName: "App-Level Token",
    prefix: "xapp-",
  },
  {
    key: "botToken",
    accountSuffix: "slack-bot-token",
    displayName: "Bot User OAuth Token",
    prefix: "xoxb-",
  },
];

const botTokenDefinition = tokenDefinitions[1];

export function keychainAccount(workspace: string, accountSuffix: string): string {
  return `${workspace}.${accountSuffix}`;
}

async function resolveToken(
  workspace: string,
  definition: TokenDefinition,
  keychain: KeychainStore,
  prompt: SecretPrompt,
): Promise<string> {
  const account = keychainAccount(workspace, definition.accountSuffix);
  const stored = await keychain.get(account);
  if (stored?.startsWith(definition.prefix)) return stored;

  let message = stored
    ? `[${workspace}] Keychainの${definition.displayName}が不正です。${definition.prefix}で始まる値を貼り付けてEnter`
    : `[${workspace}] ${definition.displayName}（${definition.prefix}...）を貼り付けてEnter`;
  while (true) {
    const value = await prompt({ message, prefix: definition.prefix });
    if (!value.startsWith(definition.prefix)) {
      message = `[${workspace}] ${definition.prefix}で始まる${definition.displayName}を貼り付けてEnter`;
      continue;
    }
    await keychain.set(account, value);
    return value;
  }
}

export async function resolveSlackTokens(
  workspace: string,
  keychain: KeychainStore,
  prompt: SecretPrompt,
): Promise<SlackTokens> {
  const result = {} as SlackTokens;
  for (const definition of tokenDefinitions) {
    result[definition.key] = await resolveToken(workspace, definition, keychain, prompt);
  }
  return result;
}

export async function loadStoredSlackBotToken(
  workspace: string,
  keychain: KeychainStore,
): Promise<string> {
  if (!botTokenDefinition) throw new Error("Bot token definition is missing");
  const account = keychainAccount(workspace, botTokenDefinition.accountSuffix);
  const stored = await keychain.get(account);
  if (stored?.startsWith(botTokenDefinition.prefix)) return stored;

  const reason = stored ? "保存値の形式が不正です" : "保存されていません";
  throw new Error(
    `[${workspace}] Bot User OAuth TokenがKeychainに${reason}。対話可能なターミナルでSlack Adapterを一度起動し、xoxb-で始まるtokenを登録してください`,
  );
}
