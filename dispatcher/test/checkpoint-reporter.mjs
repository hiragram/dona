import process from "node:process";
import { Transform } from "node:stream";

const nonce = process.env.DONA_PROCESS_METRICS_NONCE;
if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("DONA_PROCESS_METRICS_NONCE must be a bounded nonce");

export default function checkpointReporter() {
  const reporter = new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      let output = "";
      if (event.type === "test:stderr") {
        const message = typeof event.data?.message === "string" ? event.data.message : "";
        for (const line of message.split(/\r?\n/)) {
          if (new RegExp(`^\\[dispatcher-test:${nonce}\\] metrics scope=2;node=\\d+\/\\d+,git=\\d+\/\\d+,shell=\\d+\/\\d+,other=\\d+\/\\d+;active=\\d+;overhead_us=\\d+$`).test(line)) output += `\n${line}\n`;
        }
      }
      callback(null, output);
    },
  });
  return reporter;
}
