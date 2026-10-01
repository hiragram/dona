import { parse, stringify } from "smol-toml";

// run専用コピーの値だけを変える。元ファイルの表記形式・コメントには依存しない。
export function herdrNoResumeConfig(source: string): string {
  const config = parse(source);
  const session = config.session ?? {};
  if (typeof session !== "object" || session === null || Array.isArray(session) || session instanceof Date) {
    throw new Error("invalid_herdr_session_config");
  }
  config.session = { ...session, resume_agents_on_restore: false };
  return stringify(config);
}
