import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ServiceScope, WebServiceCredential, WebServiceCredentialLookup } from "./service-auth.js";
import { maximumWebCommandBodyBytes, sealWebCommandInput, signWebCommandProof, verifyWebCommandResponse,
  webCommandServiceHost, webCommandServicePath, WebCommandWireError, type WebCommandInput, type WebCommandResult } from "./command-wire.js";

function socketIdentity(socketPath: string): { dev: number; ino: number } {
  const uid = process.getuid?.(), parent = path.dirname(socketPath);
  if (uid === undefined || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
    || socketPath.includes("\0") || fs.realpathSync(parent) !== parent) throw new WebCommandWireError();
  const directory = fs.lstatSync(parent), socket = fs.lstatSync(socketPath);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700
    || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600 || socket.nlink !== 1) throw new WebCommandWireError();
  return { dev: socket.dev, ino: socket.ino };
}

export class WebCommandClient {
  constructor(private readonly socketPath: string, private readonly scope: ServiceScope,
    private readonly signing: () => WebServiceCredential, private readonly credentials: WebServiceCredentialLookup,
    private readonly now: () => string, private readonly deadlineMs = 5000) {}
  execute(input: WebCommandInput): Promise<WebCommandResult> {
    let raw: string, proof: string, before: { dev: number; ino: number };
    try { const credential = this.signing(); raw = sealWebCommandInput(input, credential);
      proof = signWebCommandProof(raw, this.scope, credential, this.now()); before = socketIdentity(this.socketPath); }
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
            try { if (response.statusCode !== 200 || !response.complete) throw Error(); const after = socketIdentity(this.socketPath);
              if (after.dev !== before.dev || after.ino !== before.ino) throw Error();
              const result = verifyWebCommandResponse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), proof, raw,
                this.scope, this.credentials, this.now()); finish(result); } catch { finish(); }
          });
        });
        request.once("error", () => finish()); request.end(raw);
      } catch { finish(); }
    });
  }
}
