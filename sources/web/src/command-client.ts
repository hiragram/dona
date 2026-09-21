import fs from "node:fs";
import http from "node:http";
import type { ServiceScope, WebServiceCredential, WebServiceCredentialLookup } from "./service-auth.js";
import { encodeWebCommandInput, maximumWebCommandBodyBytes, signWebCommandProof, webCommandResultSchema,
  webCommandServiceHost, webCommandServicePath, WebCommandWireError, type WebCommandInput, type WebCommandResult } from "./command-wire.js";

export class WebCommandClient {
  constructor(private readonly socketPath: string, private readonly scope: ServiceScope,
    private readonly signing: () => WebServiceCredential, private readonly credentials: WebServiceCredentialLookup,
    private readonly now: () => string, private readonly deadlineMs = 5000) {}
  execute(input: WebCommandInput): Promise<WebCommandResult> {
    let raw: string, proof: string, before: fs.Stats;
    try { raw = encodeWebCommandInput(input); proof = signWebCommandProof(raw, this.scope, this.signing(), this.now()); before = fs.statSync(this.socketPath); }
    catch { return Promise.reject(new WebCommandWireError()); }
    return new Promise((resolve, reject) => {
      let settled = false, request: http.ClientRequest | undefined; const finish = (result?: WebCommandResult) => {
        if (settled) return; settled = true; clearTimeout(timer); request?.destroy(); result ? resolve(result) : reject(new WebCommandWireError()); };
      const timer = setTimeout(() => finish(), this.deadlineMs);
      try {
        request = http.request({ socketPath: this.socketPath, path: webCommandServicePath, method: "POST", agent: false,
          headers: { host: webCommandServiceHost, "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)),
            connection: "close", "x-dona-service-proof": proof } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximumWebCommandBodyBytes) finish(); else chunks.push(chunk); });
          response.once("error", () => finish()); response.once("end", () => {
            try { if (response.statusCode !== 200 || !response.complete) throw Error(); const after = fs.statSync(this.socketPath);
              if (after.dev !== before.dev || after.ino !== before.ino) throw Error();
              const result = webCommandResultSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
              void this.credentials; finish(result); } catch { finish(); }
          });
        });
        request.once("error", () => finish()); request.end(raw);
      } catch { finish(); }
    });
  }
}
