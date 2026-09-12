import { createHmac, timingSafeEqual } from "node:crypto";

export type ReadCursorPayload = {
  trace_id: string;
  client_profile_id?: string;
  scope_id?: string;
  document_id: string;
  revision_number?: number;
  content_hash: string;
  offset: number;
  extractor: string;
  start_page?: number;
  end_page?: number;
  expires_at: number;
};

export class CursorManager {
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  constructor(secret: Buffer, ttlSeconds: number) {
    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
    if (secret.length < 16) throw new Error("Cursor HMAC secret must be at least 16 bytes");
  }

  create(payload: Omit<ReadCursorPayload, "expires_at">): string {
    const full: ReadCursorPayload = { ...payload, expires_at: Math.floor(Date.now() / 1000) + this.ttlSeconds };
    const body = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
    const sig = this.sign(body);
    return `${body}.${sig}`;
  }

  parse(cursor: string): ReadCursorPayload {
    const [body, sig, extra] = cursor.split(".");
    if (!body || !sig || extra) throw new Error("INVALID_CURSOR");
    const expected = this.sign(body);
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("INVALID_CURSOR_SIGNATURE");
    let parsed: ReadCursorPayload;
    try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ReadCursorPayload; }
    catch { throw new Error("INVALID_CURSOR"); }
    if (!parsed.document_id || !parsed.content_hash || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.start_page !== undefined && (!Number.isInteger(parsed.start_page) || parsed.start_page < 1)) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.end_page !== undefined && (!Number.isInteger(parsed.end_page) || parsed.end_page < (parsed.start_page ?? 1))) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.expires_at < Math.floor(Date.now() / 1000)) throw new Error("CURSOR_EXPIRED");
    return parsed;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}
