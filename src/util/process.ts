import { spawn } from "node:child_process";

export type ProcessResult = { stdout: Buffer; stderr: Buffer; code: number; stdoutTruncated: boolean };

export async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number; cwd?: string; truncateStdout?: boolean } = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 32 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 4 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let stdoutTruncated = false;
    let stdoutKillIssued = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutSize + chunk.length > maxStdoutBytes) {
        if (options.truncateStdout) {
          const remaining = Math.max(0, maxStdoutBytes - stdoutSize);
          if (remaining > 0) {
            stdout.push(chunk.subarray(0, remaining));
            stdoutSize += remaining;
          }
          stdoutTruncated = true;
          if (!stdoutKillIssued) {
            stdoutKillIssued = true;
            child.kill("SIGKILL");
          }
          return;
        }
        stdoutSize += chunk.length;
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${command} stdout exceeded ${maxStdoutBytes} bytes`));
        }
        return;
      }
      stdout.push(chunk);
      stdoutSize += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= maxStderrBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1, stdoutTruncated };
      if (result.code !== 0 && !result.stdoutTruncated) {
        reject(new Error(`${command} exited ${result.code}: ${result.stderr.toString("utf8").slice(0, 1000)}`));
      } else resolve(result);
    });
  });
}
