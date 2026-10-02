import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { AUDIT_LIMITS, type AuditRetention } from "./retention.ts";

const storage = { lstat, open, rename, unlink };
type Storage = typeof storage;
type Segment = { bytes: number; oldest: number; complete: boolean };

/** Fixed reserved slots; callers must serialize all access and own the parent directory. */
export class RotatingAuditFile {
  private readonly path: string;
  private readonly policy: AuditRetention;
  private readonly fs: Storage;
  private readonly now: () => number;

  constructor(path: string, policy: AuditRetention, fs: Storage = storage, now: () => number = Date.now) {
    this.path = path;
    this.policy = policy;
    this.fs = fs;
    this.now = now;
  }

  /** Enforce age and count even while the gateway is idle. No directory scans. */
  async sweep(): Promise<void> {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error("Audit clock unavailable");
    const segments: { path: string; segment: Segment; remove: boolean }[] = [];
    // Preflight every reserved name before deleting anything in this sweep.
    for (let i = 0; i < AUDIT_LIMITS.maxFiles; i++) {
      const path = this.slot(i);
      const segment = await this.inspect(path);
      if (!segment) continue;
      const remove = i >= this.policy.maxFiles || now - segment.oldest >= this.policy.maxAgeSeconds * 1000;
      if (!remove && segment.bytes > this.policy.maxFileBytes) {
        throw new Error("Audit segment exceeds configured bound");
      }
      segments.push({ path, segment, remove });
    }
    for (const entry of segments) if (entry.remove) await this.fs.unlink(entry.path);
  }

  async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.policy.maxRecordBytes || bytes > this.policy.maxFileBytes) throw new Error("Audit record too large");
    const timestamp = Date.parse((JSON.parse(line) as { ts: string }).ts);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid audit timestamp");
    await this.sweep();
    const active = await this.inspect(this.path);
    if (active && active.bytes > 0 && (!active.complete || timestamp < active.oldest || active.bytes + bytes > this.policy.maxFileBytes)) await this.rotate();
    const file = await this.fs.open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      this.checkFile(stat);
      if (stat.size + bytes > this.policy.maxFileBytes) throw new Error("Audit file changed outside writer");
      const data = Buffer.from(line, "utf8");
      let written = 0;
      try {
        while (written < data.length) {
          const result = await file.write(data, written, data.length - written);
          if (result.bytesWritten < 1) throw new Error("Audit write made no progress");
          written += result.bytesWritten;
        }
      } catch (error) {
        // Best-effort rollback of this operation only; a failed rollback remains observable.
        await file.truncate(stat.size);
        throw error;
      }
    } finally {
      await file.close();
    }
  }

  private slot(index: number): string {
    return index === 0 ? this.path : `${this.path}.${index}`;
  }

  private checkFile(stat: Stats): void {
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Unsafe audit file");
    }
  }

  private async inspect(path: string): Promise<Segment | undefined> {
    let stat;
    try { stat = await this.fs.lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    this.checkFile(stat);
    const file = await this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await file.stat();
      this.checkFile(actual);
      if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) throw new Error("Audit file changed outside writer");
      if (actual.size === 0) return { bytes: 0, oldest: actual.mtimeMs, complete: true };
      const buffer = Buffer.alloc(Math.min(actual.size, AUDIT_LIMITS.maxRecordBytes));
      let read = 0;
      let newline = -1;
      while (read < buffer.length && newline < 0) {
        const result = await file.read(buffer, read, Math.min(1024, buffer.length - read), read);
        if (result.bytesRead < 1) throw new Error("Incomplete audit read");
        read += result.bytesRead;
        newline = buffer.subarray(0, read).indexOf(10);
      }
      if (newline < 0) throw new Error("Audit first record incomplete");
      const first: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      const timestamp = first && typeof first === "object" ? (first as { ts?: unknown }).ts : undefined;
      const oldest = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
      if (!Number.isFinite(oldest) || oldest < 0) throw new Error("Invalid audit segment timestamp");
      const last = Buffer.alloc(1);
      if ((await file.read(last, 0, 1, actual.size - 1)).bytesRead !== 1) throw new Error("Incomplete audit tail");
      return { bytes: actual.size, oldest, complete: last[0] === 10 };
    } finally {
      await file.close();
    }
  }

  private async rotate(): Promise<void> {
    const last = this.slot(this.policy.maxFiles - 1);
    if (await this.inspect(last)) await this.fs.unlink(last);
    for (let i = this.policy.maxFiles - 2; i >= 0; i--) {
      const source = this.slot(i);
      if (await this.inspect(source)) await this.fs.rename(source, this.slot(i + 1));
    }
  }
}
