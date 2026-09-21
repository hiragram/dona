import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const channelLimitBytes = 1024 * 1024;

export async function createCaseCheckpointChannel({ nonce, file, onMarker = (marker) => process.stderr.write(`${marker}\n`) }) {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file)) {
    throw new Error("invalid case checkpoint channel identity");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dona-case-checkpoint-"));
  await fs.chmod(directory, 0o700);
  const eventsPath = path.join(directory, "events");
  const acknowledgementPath = path.join(directory, "ack");
  await fs.writeFile(eventsPath, "", { mode: 0o600 });
  await fs.writeFile(acknowledgementPath, "", { mode: 0o600 });
  const events = await fs.open(eventsPath, "r");
  let offset = 0;
  let remainder = "";
  let expectedSequence = 1;
  let failure;
  let draining;
  let drainRequested = false;
  const markerPattern = new RegExp(`^\\[dispatcher-test:${nonce}\\] case-(?:start|finish|fail|terminal) ${file.replaceAll(".", "\\.")}:[a-f0-9]{12}#\\d+(?: elapsed_ms=\\d{1,9})?$`);

  const drain = async () => {
    if (failure) return;
    try {
      const stats = await events.stat();
      if (stats.size > channelLimitBytes) throw new Error("case checkpoint channel exceeded its bounded size");
      if (stats.size < offset) throw new Error("case checkpoint channel was truncated");
      const additionSize = stats.size - offset;
      const additionBuffer = Buffer.alloc(additionSize);
      let bytesRead = 0;
      while (bytesRead < additionSize) {
        const result = await events.read(additionBuffer, bytesRead, additionSize - bytesRead, offset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      const addition = additionBuffer.subarray(0, bytesRead).toString("utf8");
      offset += bytesRead;
      const lines = `${remainder}${addition}`.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      if (Buffer.byteLength(remainder) > 512) throw new Error("case checkpoint record is oversized");
      for (const line of lines) {
        const separator = line.indexOf("\t");
        const sequence = Number(line.slice(0, separator));
        const marker = line.slice(separator + 1);
        if (separator < 1 || sequence !== expectedSequence || !markerPattern.test(marker)) {
          throw new Error("case checkpoint record failed validation");
        }
        onMarker(marker);
        if (marker.includes(" case-start ")) await fs.writeFile(acknowledgementPath, String(sequence), { mode: 0o600 });
        expectedSequence += 1;
      }
    } catch (error) {
      failure = error;
    }
  };
  const scheduleDrain = () => {
    drainRequested = true;
    if (draining) return;
    draining = (async () => {
      while (drainRequested) {
        drainRequested = false;
        await drain();
      }
    })().finally(() => { draining = undefined; });
  };
  const timer = setInterval(scheduleDrain, 2);

  return {
    directory,
    async close() {
      clearInterval(timer);
      scheduleDrain();
      await draining;
      await events.close();
      await fs.rm(directory, { recursive: true, force: true });
      if (failure) throw failure;
    },
  };
}
