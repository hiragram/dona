#!/usr/bin/env node

import net from "node:net";
import { pathToFileURL } from "node:url";

const canonicalRemote = "https://github.com/hiragram/dona.git";

export function normalizeCanonicalRemote(remote) {
  if (/^git@github\.com:hiragram\/dona(?:\.git)?$/.test(remote)) return canonicalRemote;

  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return undefined;
  }

  const validProtocolAndIdentity =
    (parsed.protocol === "https:" && parsed.username === "") ||
    (parsed.protocol === "ssh:" && parsed.username === "git");
  if (
    !validProtocolAndIdentity ||
    parsed.password !== "" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/hiragram\/dona(?:\.git)?$/.test(parsed.pathname)
  ) {
    return undefined;
  }
  return canonicalRemote;
}

export function socketIsListening(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function main() {
  const [mode, value] = process.argv.slice(2);
  if (!value) {
    console.error("Usage: self-update-install-preflight.mjs validate-remote <remote> | assert-socket-unused <socket>");
    return 2;
  }
  if (mode === "validate-remote") return normalizeCanonicalRemote(value) ? 0 : 1;
  if (mode === "assert-socket-unused") {
    if (await socketIsListening(value)) {
      console.error("未管理のDispatcherが起動中です。npm run devを停止してから--bootstrapを実行してください。");
      return 1;
    }
    return 0;
  }
  console.error("Unknown preflight mode");
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) process.exitCode = await main();
