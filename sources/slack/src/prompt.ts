import password from "@inquirer/password";

export interface SecretPromptOptions {
  message: string;
  prefix: string;
}

export type SecretPrompt = (options: SecretPromptOptions) => Promise<string>;

/** ペースト可能で、入力内容を * だけで表示するTokenプロンプト。 */
export const promptSecret: SecretPrompt = async ({ message, prefix }) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "KeychainにTokenがなく、現在の環境では対話入力できません。TTYから一度起動してTokenを登録してください",
    );
  }

  const value = await password({
    message,
    mask: "*",
    toggleMask: false,
    validate(input) {
      if (!input.trim()) return "Tokenを入力してください";
      if (!input.trim().startsWith(prefix)) {
        return `${prefix}で始まるTokenを入力してください`;
      }
      return true;
    },
  });

  return value.trim();
};
