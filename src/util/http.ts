import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const declared = req.headers["content-length"];
  const declaredText = Array.isArray(declared) ? declared.join(",") : declared;
  if (declaredText !== undefined) {
    const declaredBytes = Number(declaredText);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) throw new Error("INVALID_CONTENT_LENGTH");
    if (declaredBytes > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(b);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) throw new Error("INVALID_RESPONSE_LENGTH");
    if (declaredBytes > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(data.length));
  res.end(data);
}

export function textResponse(res: ServerResponse, status: number, text: string): void {
  const data = Buffer.from(text, "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("content-length", String(data.length));
  res.end(data);
}
