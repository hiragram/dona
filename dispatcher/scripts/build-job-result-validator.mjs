import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// 同じreader/schemaをbundle化し、schedule sandboxへrelease全体のreadを与えない。
await build({
  entryPoints: [fileURLToPath(new URL("../src/job-result-validate.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/job-result-validate.bundle.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
});
