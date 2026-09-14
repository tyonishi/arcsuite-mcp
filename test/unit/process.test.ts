import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../../src/util/process.ts";

test("runProcess can retain a bounded leading stdout prefix when truncation is explicit", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('0123456789'.repeat(100))"], {
    maxStdoutBytes: 17,
    truncateStdout: true
  });
  assert.equal(result.stdout.toString("ascii"), "01234567890123456");
  assert.equal(result.stdout.length, 17);
  assert.equal(result.stdoutTruncated, true);
});
