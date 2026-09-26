import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundledValidator = fileURLToPath(new URL("../dist/job-result-validate.bundle.mjs", import.meta.url));
let libraryDirectories: readonly string[] | undefined;
function nodeLibraryDirectories(): readonly string[] {
  if (!libraryDirectories) {
    // report本文は出力・保存しない。ロード済みnative libraryの実体ディレクトリだけを使う。
    const report = process.report.getReport() as { sharedObjects?: string[] };
    libraryDirectories = Object.freeze([...new Set((report.sharedObjects ?? [])
      .filter(value => value.startsWith("/") && /(?:\.dylib|\.so(?:\.\d+)*)$/.test(value)
        && !value.startsWith("/usr/lib/") && !value.startsWith("/System/") && !value.startsWith("/lib/"))
      .map(value => {
        const directory = path.dirname(realpathSync(value));
        if (!/^lib(?:32|64)?$/.test(path.basename(directory))) throw new Error("Scheduled Node library directory is unsupported");
        return directory;
      }))]);
  }
  return libraryDirectories;
}

export function jobResultValidationCommand(scheduled: boolean): string[] {
  if (scheduled) {
    // dyldのHomebrew opt symlink走査はroot denyで拒否されるため、許可した実体からロードする。
    const loader = process.platform === "darwin" && nodeLibraryDirectories().length
      ? ["/usr/bin/env", `DYLD_LIBRARY_PATH=${nodeLibraryDirectories().join(":")}`] : [];
    return [...loader, process.execPath, "--openssl-config=/dev/null", bundledValidator];
  }
  const sourceMode = import.meta.url.endsWith(".ts");
  return [process.execPath, ...(sourceMode ? ["--import", fileURLToPath(import.meta.resolve("tsx"))] : []),
    fileURLToPath(new URL(sourceMode ? "./job-result-validate.ts" : "./job-result-validate.js", import.meta.url))];
}

export function jobResultValidationReadPaths(): readonly string[] {
  return [...new Set([process.execPath, realpathSync(process.execPath), bundledValidator, ...nodeLibraryDirectories()])];
}
