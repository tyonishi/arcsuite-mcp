import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readJsonBody, readResponseText } from "../../src/util/http.ts";

test("JSON request body rejects an oversized declared Content-Length", async () => {
  const request = Readable.from([Buffer.from("{}")]) as Readable & { headers: Record<string, string> };
  request.headers = { "content-length": "1025" };
  await assert.rejects(readJsonBody(request as unknown as IncomingMessage, 1024), /REQUEST_TOO_LARGE/);
});

test("JSON request body rejects an oversized chunked body", async () => {
  const request = Readable.from([Buffer.from("x".repeat(1025))]) as Readable & { headers: Record<string, string> };
  request.headers = {};
  await assert.rejects(readJsonBody(request as unknown as IncomingMessage, 1024), /REQUEST_TOO_LARGE/);
});

test("adapter response reader bounds streaming responses without a length header", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
      controller.close();
    }
  });
  await assert.rejects(readResponseText(new Response(body), 7), /RESPONSE_TOO_LARGE/);
});

test("adapter response reader accepts a bounded response", async () => {
  assert.equal(await readResponseText(new Response("bounded"), 7), "bounded");
});
