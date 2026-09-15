import { createHmac, timingSafeEqual } from "node:crypto";
import { CONTENT_LABEL_PRIMARY_ALIAS, isSemanticContentLabelAlias } from "../semantic/contentLabels.ts";

export type ReadCursorPayload = {
  /** Cursor format version; v2 binds the current effective identity. */
  version: 2;
  trace_id: string;
  client_profile_id?: string;
  scope_id?: string;
  document_id: string;
  revision_number?: number;
  /** Semantic label carried by the signed cursor; v2 cursors always set it. */
  content_label?: string;
  content_hash: string;
  offset: number;
  extractor: string;
  start_page?: number;
  end_page?: number;
  /** HMAC-derived opaque binding; the effective repository ID is never exposed. */
  effective_identity_binding: string;
  expires_at: number;
};

export type ContentAuthorityBindingInput = {
  clientProfileId: string;
  scopeId: string;
  requestedDocumentId: string;
  effectiveDocumentId: string;
  wireDocumentId: string;
  requestedRevisionNumber?: number;
  provenRevisionNumber: number;
  contentLabel: string;
  physicalContentLabel: { ns: string; name: string };
  cabinetId: string;
  rootObjectId: string | null;
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
    const contentLabel = payload.content_label ?? CONTENT_LABEL_PRIMARY_ALIAS;
    if (!isSemanticContentLabelAlias(contentLabel)) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (payload.version !== 2 || typeof payload.effective_identity_binding !== "string" || !payload.effective_identity_binding) {
      throw new Error("INVALID_CURSOR_PAYLOAD");
    }
    const full: ReadCursorPayload = {
      ...payload,
      content_label: contentLabel,
      expires_at: Math.floor(Date.now() / 1000) + this.ttlSeconds
    };
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
    if (parsed.version !== 2 || typeof parsed.effective_identity_binding !== "string" || !parsed.effective_identity_binding
      || !parsed.document_id || !parsed.content_hash || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("INVALID_CURSOR_PAYLOAD");
    }
    if (!Number.isSafeInteger(parsed.expires_at) || parsed.expires_at < 1) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.content_label !== undefined && !isSemanticContentLabelAlias(parsed.content_label)) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.start_page !== undefined && (!Number.isInteger(parsed.start_page) || parsed.start_page < 1)) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.end_page !== undefined && (!Number.isInteger(parsed.end_page) || parsed.end_page < (parsed.start_page ?? 1))) throw new Error("INVALID_CURSOR_PAYLOAD");
    if (parsed.expires_at < Math.floor(Date.now() / 1000)) throw new Error("CURSOR_EXPIRED");
    return parsed;
  }

  /**
   * Bind a cursor/cache entry to the complete current authority context.  The
   * effective ArcSuite ID is an HMAC input only and never appears in a token.
   */
  bindEffectiveIdentity(input: ContentAuthorityBindingInput): string {
    const canonical = JSON.stringify([
      input.clientProfileId,
      input.scopeId,
      input.requestedDocumentId,
      input.effectiveDocumentId,
      input.wireDocumentId,
      input.requestedRevisionNumber ?? "current-request",
      input.provenRevisionNumber,
      input.contentLabel,
      input.physicalContentLabel.ns,
      input.physicalContentLabel.name,
      input.cabinetId,
      input.rootObjectId
    ]);
    return createHmac("sha256", this.secret).update("arcsuite-content-authority-v2\u0000").update(canonical).digest("base64url");
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}
