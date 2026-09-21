import http from "node:http";
import fs from "node:fs/promises";

import { signSlackPrincipalProof } from "./principal-proof.js";

export interface DispatcherResponse {
  statusCode: number;
  body: string;
}

export interface DispatcherClientOptions {
  socketPath: string;
  connectTimeoutMs: number;
  timeoutMs: number;
  internalTokenPath?: string;
  ingressTokenPath?: string;
}

export class DispatcherClient {
  constructor(private readonly options: DispatcherClientOptions) {}

  async postEvent(envelope: unknown, attempt = 1): Promise<DispatcherResponse> {
    const token = await this.readPrivateIngressToken();
    const signed = signSlackPrincipalProof(envelope as Record<string, unknown>, attempt, token);
    const body = Buffer.from(JSON.stringify(envelope));
    return this.request("POST", "/v1/events", body, undefined, {
      "x-dona-slack-principal-proof": signed.proof,
      "x-dona-slack-principal-signature": signed.signature,
    });
  }

  private async readPrivateIngressToken(): Promise<string> {
    const tokenPath = this.options.ingressTokenPath;
    if (!tokenPath) throw new Error("Slack principal proof key is unavailable");
    try {
      const stats = await fs.lstat(tokenPath);
      const uid = process.getuid?.();
      if (!stats.isFile() || stats.isSymbolicLink() || uid === undefined || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
        throw new Error("Slack principal proof key is unavailable");
      }
      const token = (await fs.readFile(tokenPath, "utf8")).trim();
      if (token.length < 32) throw new Error("Slack principal proof key is unavailable");
      return token;
    } catch (error) {
      if (error instanceof Error && error.message === "Slack principal proof key is unavailable") throw error;
      throw new Error("Slack principal proof key is unavailable");
    }
  }

  healthReady(): Promise<boolean> {
    return this.request("GET", "/health/ready").then(
      (response) => response.statusCode === 200,
      () => false,
    );
  }

  async resolveJobProgress(progressId: string, deliveryToken: string): Promise<unknown> {
    try {
      const token = this.options.internalTokenPath ? (await fs.readFile(this.options.internalTokenPath, "utf8")).trim() : "";
      const response = await this.request("GET", `/v1/internal/job-progress?progress_id=${encodeURIComponent(progressId)}&delivery_token=${encodeURIComponent(deliveryToken)}`, undefined, token);
      if (response.statusCode !== 200) throw Object.assign(new Error(`Dispatcher rejected progress resolution with HTTP ${response.statusCode}`), response.statusCode===403||response.statusCode===425||response.statusCode>=500 ? {progressRetryable:true} : {progressPermanent:true});
      return JSON.parse(response.body);
    } catch (error) {
      const tagged=error as Error & {progressRetryable?:boolean;progressPermanent?:boolean};
      if(tagged.progressRetryable||tagged.progressPermanent)throw tagged;
      throw Object.assign(error instanceof Error?error:new Error(String(error)),{progressRetryable:true});
    }
  }

  private request(method: "GET" | "POST", path: string, body?: Buffer, internalToken?: string, extraHeaders: Record<string, string> = {}): Promise<DispatcherResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      const finish = (
        outcome: { response: DispatcherResponse } | { error: Error },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (connectTimer) clearTimeout(connectTimer);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.response);
      };
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          method,
          path,
          headers: {
            ...(body ? {
                "content-type": "application/json",
                "content-length": body.length,
              } : {}),
            ...(internalToken ? { "x-dona-update-token":internalToken } : {}),
            ...extraHeaders,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 1_048_576) chunks.push(chunk);
          });
          response.on("end", () => {
            finish({
              response: {
                statusCode: response.statusCode ?? 500,
                body: Buffer.concat(chunks).toString("utf8"),
              },
            });
          });
          response.once("error", (error) => finish({ error }));
        },
      );
      const totalTimer = setTimeout(
        () => request.destroy(new Error("Dispatcher request timeout")),
        this.options.timeoutMs,
      );
      request.once("socket", (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => request.destroy(new Error("Dispatcher connect timeout")), this.options.connectTimeoutMs);
        socket.once("connect", () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
      });
      request.once("error", (error) => {
        finish({ error });
      });
      request.end(body);
    });
  }
}
