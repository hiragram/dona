import { spawnSync } from "node:child_process";

/** Numeric-only process sample. Never persist argv, environment, or process paths. */
export function observeProcessTree(rootPid: number | undefined): string {
  if (!rootPid || !Number.isSafeInteger(rootPid)) return "process_tree=unavailable";
  try {
    const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,stat=,%cpu=,rss=,etime="], {
      encoding: "utf8", timeout: 500, maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    if (result.error || result.status !== 0) return "process_tree=unavailable";
    const rows = result.stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>?]{1,16})\s+([\d.]+)\s+(\d+)\s+([\d:]+)\s*$/.exec(line);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3]!,
        cpu: match[4]!, rss: match[5]!, elapsed: match[6]! }];
    });
    const selected = new Set([rootPid]);
    for (let depth = 0; depth < 8; depth++) {
      let added = false;
      for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid); added = true;
      }
      if (!added) break;
    }
    const members = rows.filter((row) => selected.has(row.pid));
    return `process_tree=observed total=${members.length} shown=${Math.min(members.length, 32)} ` +
      members.slice(0, 32).map((row) =>
        `pid=${row.pid},ppid=${row.ppid},state=${row.stat},cpu_pct=${row.cpu},rss_kib=${row.rss},elapsed=${row.elapsed}`,
      ).join(" ");
  } catch {
    return "process_tree=unavailable";
  }
}
