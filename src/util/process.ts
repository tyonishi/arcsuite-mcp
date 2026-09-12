import { spawn } from "node:child_process";

export type ProcessResult = { stdout: Buffer; stderr: Buffer; code: number };

export async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number; cwd?: string } = {}
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
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxStdoutBytes) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${command} stdout exceeded ${maxStdoutBytes} bytes`));
        }
        return;
      }
      stdout.push(chunk);
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
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 };
      if (result.code !== 0) {
        reject(new Error(`${command} exited ${result.code}: ${result.stderr.toString("utf8").slice(0, 1000)}`));
      } else resolve(result);
    });
  });
}
