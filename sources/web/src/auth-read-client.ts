import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { encodeAuthReadInput, signServiceRequest, verifyServiceResponse, serviceScopeSchema, WebServiceError,
  webAuthReadHost, webAuthReadPath, maximumServiceBodyBytes,
  type ServiceScope, type AuthReadInput, type AuthReadResult, type WebServiceCredential, type WebServiceCredentialLookup } from "./read-auth.js";

function socketIdentity(socketPath: string): { dev: number; ino: number } {
  const uid = process.getuid?.(), parent = path.dirname(socketPath);
  if (uid === undefined || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
    || socketPath.includes("\0") || fs.realpathSync(parent) !== parent) throw new WebServiceError();
  const directory = fs.lstatSync(parent), socket = fs.lstatSync(socketPath);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700
    || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600 || socket.nlink !== 1) throw new WebServiceError();
  return { dev: socket.dev, ino: socket.ino };
}
function responseLength(response: http.IncomingMessage): number {
  const headers = new Map<string, string>();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]!.toLowerCase(), value = response.rawHeaders[i + 1]!;
    if (!["content-type", "content-length", "connection", "date"].includes(name) || headers.has(name)) throw new WebServiceError();
    headers.set(name, value);
  }
  const length = headers.get("content-length");
  if (response.statusCode !== 200 || headers.get("content-type") !== "application/vnd.dona.web-auth-read-response"
    || headers.get("connection") !== "close" || !length || !/^[1-9][0-9]{0,4}$/.test(length)
    || Number(length) > maximumServiceBodyBytes) throw new WebServiceError();
  return Number(length);
}

/** Internal BFF read client with no cache, redirects, or retries. Projections
 * are preparation data only; callers must still perform fresh IdP validation
 * and Dispatcher session/resource confirmation before any protected action. */
export class WebAuthReadClient {
  private readonly scope: ServiceScope;
  constructor(private readonly socketPath: string, scope: ServiceScope, private readonly signingCredential: () => WebServiceCredential,
    private readonly credentials: WebServiceCredentialLookup, private readonly now: () => string, private readonly deadlineMs = 5000) {
    this.scope = serviceScopeSchema.parse(scope);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw new WebServiceError();
  }
  async read(input: AuthReadInput): Promise<AuthReadResult> {
    try {
      const started = performance.now();
      const body = encodeAuthReadInput(input), before = socketIdentity(this.socketPath);
      const proof = signServiceRequest(body, this.scope, this.signingCredential(), this.now());
      if (performance.now() - started >= this.deadlineMs) throw new WebServiceError();
      return await new Promise<AuthReadResult>((resolve, reject) => {
        let settled = false; let request: http.ClientRequest | undefined; let received: http.IncomingMessage | undefined;
        const finish = (value?: AuthReadResult) => {
          if (settled) return; settled = true; clearTimeout(timer); received?.destroy(); request?.destroy();
          value === undefined || performance.now() - started >= this.deadlineMs ? reject(new WebServiceError()) : resolve(value);
        };
        const timer = setTimeout(() => finish(), Math.max(1, this.deadlineMs - (performance.now() - started)));
        try {
          request = http.request({ socketPath: this.socketPath, path: webAuthReadPath, method: "POST", agent: false, maxHeaderSize: 2048,
            headers: { host: webAuthReadHost, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
              connection: "close", "x-dona-service-proof": proof } }, response => {
            received = response; const chunks: Buffer[] = []; let size = 0; let length: number;
            try { length = responseLength(response); } catch { finish(); return; }
            response.on("data", (chunk: Buffer) => {
              size += chunk.length; if (size > length || size > maximumServiceBodyBytes) { finish(); return; } chunks.push(chunk);
            });
            response.once("aborted", () => finish()); response.once("error", () => finish());
            response.once("end", () => {
              try {
                if (!response.complete || size !== length || response.rawTrailers.length) throw new WebServiceError();
                const after = socketIdentity(this.socketPath);
                if (after.dev !== before.dev || after.ino !== before.ino) throw new WebServiceError();
                const result = verifyServiceResponse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), proof, body,
                  this.scope, this.credentials, this.now());
                finish(result);
              } catch { finish(); }
            });
            response.once("close", () => { if (!response.complete) finish(); });
          });
          request.once("error", () => finish()); request.once("upgrade", (_response, socket) => { socket.destroy(); finish(); });
          request.end(body);
        } catch { finish(); }
      });
    } catch { throw new WebServiceError(); }
  }
}
