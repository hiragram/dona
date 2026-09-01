import keytar from "@github/keytar";

export const KEYCHAIN_SERVICE = "dona.slack-source";

export interface KeychainStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
}

export interface KeytarAdapter {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

function keychainError(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${action}に失敗しました: ${detail}`, { cause: error });
}

export class MacOSKeychainStore implements KeychainStore {
  constructor(
    private readonly service = KEYCHAIN_SERVICE,
    private readonly keyring: KeytarAdapter = keytar,
  ) {}

  async get(account: string): Promise<string | undefined> {
    try {
      const value = await this.keyring.getPassword(this.service, account);
      return value || undefined;
    } catch (error) {
      throw keychainError(`Keychain項目 ${account} の読み込み`, error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    if (!value) throw new Error("空のTokenはKeychainへ保存できません");

    try {
      await this.keyring.setPassword(this.service, account, value);
    } catch (error) {
      throw keychainError(`Keychain項目 ${account} の保存`, error);
    }
  }
}
