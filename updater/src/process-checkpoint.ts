export class ProcessCheckpointTracker {
  private buffer = "";
  private checkpointNonce: string | undefined;
  private currentFile: string | undefined;
  private fileState: string | undefined;
  private lastFinished: string | undefined;
  private metrics: string | undefined;
  private readonly unfinishedCases = new Set<string>();
  private timeoutCheckpoint: string | undefined;

  private readonly marker = /^\[dispatcher-test:([a-f0-9]{32})\] (file-(?:start|finish|fail)) (test\/[A-Za-z0-9._-]+\.test\.ts)(?: elapsed_ms=(\d{1,9}))?(?: load=(\d+\.\d{3}))?$/;
  private readonly caseMarker = /^\[dispatcher-test:([a-f0-9]{32})\] (case-(?:start|finish|fail|terminal)) (test\/[A-Za-z0-9._-]+\.test\.ts:[a-f0-9]{12}#\d+)(?: elapsed_ms=(\d{1,9}))?$/;
  private readonly metricsMarker = /^\[dispatcher-test:([a-f0-9]{32})\] metrics scope=2;(node=\d+\/\d+,git=\d+\/\d+,shell=\d+\/\d+,other=\d+\/\d+;active=\d+;overhead_us=\d+)$/;

  inspect(chunk: Buffer): void {
    const lines = (this.buffer + chunk.toString("utf8")).split(/\r?\n/);
    this.buffer = (lines.pop() ?? "").slice(-256);
    for (const line of lines) {
      const metricsMatch = this.metricsMarker.exec(line);
      if (metricsMatch && metricsMatch[1] === this.checkpointNonce) {
        this.metrics = `metrics=${metricsMatch[2]}`;
        continue;
      }
      const fileMatch = this.marker.exec(line);
      if (fileMatch) {
        const nonce = fileMatch[1];
        const action = fileMatch[2];
        const identity = fileMatch[3];
        if (!nonce || !action || !identity) continue;
        if (!this.checkpointNonce && action === "file-start") this.checkpointNonce = nonce;
        if (nonce !== this.checkpointNonce) continue;
        if (action === "file-start") {
          this.metrics = undefined;
          this.unfinishedCases.clear();
        }
        this.fileState = `${action} ${identity}${fileMatch[4] ? ` elapsed_ms=${fileMatch[4]}` : ""}${fileMatch[5] ? ` load=${fileMatch[5]}` : ""}`;
        if (action === "file-start") this.currentFile = identity;
        else {
          if (!this.lastFinished) this.lastFinished = this.fileState;
          this.currentFile = undefined;
          if (action === "file-finish") this.unfinishedCases.clear();
          this.checkpointNonce = undefined;
        }
        continue;
      }
      const testMatch = this.caseMarker.exec(line);
      const nonce = testMatch?.[1];
      const action = testMatch?.[2];
      const identity = testMatch?.[3];
      if (!nonce || nonce !== this.checkpointNonce || !action || !identity) continue;
      if (action === "case-start") this.unfinishedCases.add(identity);
      else {
        this.unfinishedCases.delete(identity);
        this.lastFinished = `${action} ${identity}${testMatch[4] ? ` elapsed_ms=${testMatch[4]}` : ""}`;
      }
    }
  }

  checkpoint(): string | undefined {
    if (this.timeoutCheckpoint) return this.timeoutCheckpoint;
    if (!this.fileState && !this.lastFinished && this.unfinishedCases.size === 0) return undefined;
    const pending = [...this.unfinishedCases].at(-1);
    const unfinished = pending ?? this.currentFile ?? "none";
    return `file=${this.fileState ?? "none"}; last_finish=${this.lastFinished ?? "none"}; unfinished=${unfinished}${this.metrics ? `; ${this.metrics}` : ""}`;
  }

  freezeTimeout(): string {
    const pending = [...this.unfinishedCases].at(-1);
    const unfinished = pending ?? this.currentFile ?? "none";
    this.timeoutCheckpoint = `file=${this.fileState ?? "none"}; last_finish=${this.lastFinished ?? "none"}; timeout=${unfinished}${this.metrics ? `; ${this.metrics}` : ""}`;
    return this.timeoutCheckpoint;
  }
}
