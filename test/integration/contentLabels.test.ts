import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

const DOCUMENT_A = "rep:mock:EXAMPLE_CABINET:1001";
const DOCUMENT_B = "rep:mock:EXAMPLE_CABINET:1002";

async function runtime(scopeFile = resolve("config/scopes.mock.yaml")) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-s2-"));
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopeFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true"
  });
  return { rt, dir };
}

async function runtimeWithRoot() {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-root-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic rooted document scope
    enabled: true
    arcsuite:
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: "rep:mock:EXAMPLE_CABINET"
      root_object_id: "rep:mock:EXAMPLE_CABINET:root-001"
      resolve_references: true
    allowed_object_types: [document]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
`);
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopeFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true"
  });
  return { rt, dir };
}

function profile(allowedScopes = ["example_documents"], clientProfileId = "dev-profile") {
  return {
    clientProfileId,
    allowedScopes,
    allowedTools: [
      "arcsuite_describe_capabilities",
      "arcsuite_search_documents",
      "arcsuite_get_document",
      "arcsuite_get_documents",
      "arcsuite_list_folder",
      "arcsuite_list_document_revisions",
      "arcsuite_get_document_content_info",
      "arcsuite_read_document"
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  } as any;
}

test("content label discovery exposes semantic aliases and preview content is cache-isolated", async () => {
  const { rt } = await runtime();
  const p = profile();
  const discovery: any = (await rt.tools.call(p, "arcsuite_describe_capabilities", {})).structuredContent;
  assert.deepEqual(discovery.scopes[0].content_labels, ["system:primary", "preview"]);
  assert.equal(JSON.stringify(discovery).includes("EXAMPLE_PREVIEW"), false);

  const previewInfo: any = (await rt.tools.call(p, "arcsuite_get_document_content_info", {
    document_id: DOCUMENT_A,
    content_label: "preview"
  })).structuredContent;
  assert.equal(previewInfo.content_label, "preview");
  assert.equal(previewInfo.label, "preview");
  assert.equal(previewInfo.file_name, "mock-document-preview.txt");
  assert.equal(previewInfo.cached, false);

  const primaryInfo: any = (await rt.tools.call(p, "arcsuite_get_document_content_info", {
    document_id: DOCUMENT_A
  })).structuredContent;
  assert.equal(primaryInfo.content_label, "system:primary");
  assert.equal(primaryInfo.file_name, "mock-document.txt");
  assert.equal(primaryInfo.cached, false, "primary must not reuse the preview snapshot");

  const explicitPrimaryInfo: any = (await rt.tools.call(p, "arcsuite_get_document_content_info", {
    document_id: DOCUMENT_A,
    content_label: "system:primary"
  })).structuredContent;
  assert.equal(explicitPrimaryInfo.content_label, "system:primary");
  assert.equal(explicitPrimaryInfo.file_name, "mock-document.txt");

  const previewRead: any = (await rt.tools.call(p, "arcsuite_read_document", {
    document_id: DOCUMENT_A,
    content_label: "preview",
    max_chars: 1000
  })).structuredContent;
  assert.equal(previewRead.content_label, "preview");
  assert.match(previewRead.content, /Synthetic ArcSuite preview content/);
  assert.doesNotMatch(previewRead.content, /Synthetic ArcSuite document\n/);

  const audit = await readFile(rt.config.auditLogPath, "utf8");
  assert.equal(audit.includes("user:EXAMPLE_PREVIEW"), false);
  assert.equal(audit.includes("Preview-only line"), false);
});

test("custom aliases are authorized by the inferred scope and raw physical labels are rejected", async () => {
  const { rt } = await runtime();
  const p = profile();
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_get_document_content_info", { document_id: DOCUMENT_A, content_label: "unknown" }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "content_label_not_allowed"
  );
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_get_document_content_info", { document_id: DOCUMENT_A, content_label: "user:EXAMPLE_PREVIEW" }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "content_label_not_allowed"
  );
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_get_document_content_info", {
      document_id: DOCUMENT_A,
      content_label: { ns: "rep", name: "user:EXAMPLE_PREVIEW" }
    }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );

  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-s2-scope-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic example scope
    enabled: true
    arcsuite:
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: rep:mock:EXAMPLE_CABINET
      root_object_id: null
      resolve_references: true
    content_labels:
      preview:
        ns: rep
        name: user:EXAMPLE_PREVIEW
    allowed_object_types: [document]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
  other_documents:
    description: Synthetic other scope
    enabled: true
    arcsuite:
      cabinet_alias: OTHER_CABINET
      cabinet_id: rep:mock:OTHER_CABINET
      root_object_id: null
      resolve_references: true
    content_labels:
      other_preview:
        ns: rep
        name: user:OTHER_PREVIEW
    allowed_object_types: [document]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
`);
  const otherRuntime = await runtime(scopeFile);
  const bothScopes = profile(["example_documents", "other_documents"]);
  await assert.rejects(
    () => otherRuntime.rt.tools.call(bothScopes, "arcsuite_get_document_content_info", { document_id: DOCUMENT_A, content_label: "other_preview" }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "content_label_not_allowed"
  );
});

test("membership is checked with namespace and exact revision metadata before content dispatch", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalGet = adapter.get.bind(adapter);
  let contentCalls = 0;
  adapter.content = async (request: any) => { contentCalls += 1; return request; };
  adapter.get = async (request: any) => {
    const object = await originalGet(request);
    object.attributes["rep:system:contentlabellist"] = {
      type: "i18n[]",
      values: request.revisionNumber === 2
        ? [{ ns: "rep", name: "system:primary" }]
        : [
            { ns: "rep", name: "system:primary" },
            { ns: "other", name: "user:EXAMPLE_PREVIEW" }
          ]
    };
    return object;
  };

  const info: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info", {
    document_id: DOCUMENT_A,
    content_label: "preview"
  })).structuredContent;
  assert.equal(info.extractable, false);
  assert.equal(info.reason, "CONTENT_LABEL_NOT_FOUND");
  assert.equal(info.content_label, "preview");
  assert.equal(contentCalls, 0);

  const revisionInfo: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info", {
    document_id: DOCUMENT_A,
    revision_number: 2,
    content_label: "preview"
  })).structuredContent;
  assert.equal(revisionInfo.reason, "CONTENT_LABEL_NOT_FOUND");
  assert.equal(contentCalls, 0, "an absent revision label must not dispatch content retrieval");

  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, content_label: "preview" }),
    (error: any) => error?.stableCode === "ARCSUITE_NOT_AVAILABLE" && error?.category === "content_label_not_found"
  );
  assert.equal(contentCalls, 0);
});

test("resolved effective identity and its own root path authorize content", async () => {
  const rootId = "rep:mock:EXAMPLE_CABINET:root-001";
  const sourceId = DOCUMENT_A;
  const cases = [
    { label: "ordinary document inside root", effectiveId: sourceId, pathIds: [rootId], succeeds: true },
    { label: "reference to target inside root", effectiveId: "rep:mock:EXAMPLE_CABINET:target-001", pathIds: [rootId], succeeds: true },
    { label: "reference to target outside root", effectiveId: "rep:mock:EXAMPLE_CABINET:outside-001", pathIds: ["rep:mock:EXAMPLE_CABINET:outside-001"], error: "root_scope" },
    { label: "reference to target in another cabinet", effectiveId: "rep:mock:OTHER_CABINET:outside-001", pathIds: ["rep:mock:OTHER_CABINET:outside-001"], error: "cabinet_scope" }
  ];

  for (const scenario of cases) {
    const { rt } = await runtimeWithRoot();
    const adapter: any = rt.adapter;
    const originalGet = adapter.get.bind(adapter);
    const originalContent = adapter.content.bind(adapter);
    let contentCalls = 0;
    adapter.get = async (request: any) => {
      const object = await originalGet(request);
      if (!request.resolveRef) return object;
      return {
        ...object,
        id: scenario.effectiveId,
        pathObjects: scenario.pathIds.map((id) => ({ id }))
      };
    };
    adapter.content = async (request: any) => {
      contentCalls += 1;
      return originalContent(request);
    };

    if (scenario.succeeds) {
      const info: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: sourceId })).structuredContent;
      assert.equal(info.extractable, true, scenario.label);
      assert.equal(contentCalls, 1, scenario.label);
    } else {
      await assert.rejects(
        () => rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: sourceId }),
        (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === scenario.error,
        scenario.label
      );
      assert.equal(contentCalls, 0, `${scenario.label} must fail before content dispatch`);
    }
  }
});

test("content cache and cursors are rejected after effective identity retargeting", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalGet = adapter.get.bind(adapter);
  const originalContent = adapter.content.bind(adapter);
  let effectiveId = DOCUMENT_A;
  let contentCalls = 0;
  adapter.get = async (request: any) => {
    const object = await originalGet(request);
    if (!request.resolveRef) return object;
    return { ...object, id: effectiveId };
  };
  adapter.content = async (request: any) => {
    contentCalls += 1;
    const result = await originalContent(request);
    const text = effectiveId === DOCUMENT_A ? "A".repeat(3000) : "B".repeat(3000);
    await writeFile(result.filePath, text, "utf8");
    return { ...result, effectiveId, sizeBytes: Buffer.byteLength(text) };
  };

  const first: any = (await rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 })).structuredContent;
  assert.equal(first.content, "A".repeat(1000));
  assert.equal(typeof first.next_cursor, "string");
  assert.equal(contentCalls, 1);

  effectiveId = DOCUMENT_B;
  const retargeted: any = (await rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 })).structuredContent;
  assert.equal(retargeted.content, "B".repeat(1000));
  assert.equal(retargeted.cached, false);
  assert.equal(contentCalls, 2, "a cache entry for A must not serve after R is retargeted to B");
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, cursor: first.next_cursor, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
  assert.equal(contentCalls, 2, "a retargeted cursor must fail before content dispatch");
});

test("current revision proof changes the content cache authority", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalGet = adapter.get.bind(adapter);
  const originalContent = adapter.content.bind(adapter);
  let revision = 3;
  let contentCalls = 0;
  adapter.get = async (request: any) => {
    const object = await originalGet(request);
    if (request.id === DOCUMENT_A) {
      object.attributes["rep:system:revisionnumber"] = { type: "int", value: revision };
      object.attributes["rep:system:currentrevisionnumber"] = { type: "int", value: revision };
    }
    return object;
  };
  adapter.content = async (request: any) => {
    contentCalls += 1;
    const result = await originalContent(request);
    const text = `revision-${revision}`;
    await writeFile(result.filePath, text, "utf8");
    return { ...result, revisionNumber: request.revisionNumber, sizeBytes: Buffer.byteLength(text) };
  };

  const first: any = (await rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 })).structuredContent;
  assert.equal(first.content, "revision-3");
  assert.equal(contentCalls, 1);

  revision = 4;
  const second: any = (await rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 })).structuredContent;
  assert.equal(second.content, "revision-4");
  assert.equal(second.cached, false);
  assert.equal(contentCalls, 2, "a current-revision change must not reuse the old snapshot");
});

test("cached content is not served after the current effective object leaves the configured root", async () => {
  const { rt } = await runtimeWithRoot();
  const adapter: any = rt.adapter;
  const originalGet = adapter.get.bind(adapter);
  const originalContent = adapter.content.bind(adapter);
  const rootId = "rep:mock:EXAMPLE_CABINET:root-001";
  let effectiveId = DOCUMENT_A;
  let contentCalls = 0;
  adapter.get = async (request: any) => {
    const object = await originalGet(request);
    if (!request.resolveRef) return object;
    const id = effectiveId;
    return { ...object, id, pathObjects: [{ id: effectiveId === DOCUMENT_A ? rootId : effectiveId }] };
  };
  adapter.content = async (request: any) => {
    contentCalls += 1;
    return originalContent(request);
  };
  await rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 });
  assert.equal(contentCalls, 1);
  effectiveId = "rep:mock:EXAMPLE_CABINET:outside-001";
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "root_scope"
  );
  assert.equal(contentCalls, 1, "root migration must be rejected before content dispatch");
});

test("content result must state the effective identity proven by membership lookup", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalContent = adapter.content.bind(adapter);
  adapter.content = async (request: any) => {
    const result = await originalContent(request);
    return { ...result, effectiveId: undefined };
  };
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: DOCUMENT_A }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "content_effective_identity_missing"
  );
});

test("returned physical label mismatch fails closed and cleans the adapter file", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalContent = adapter.content.bind(adapter);
  adapter.content = async (request: any) => ({
    ...await originalContent(request),
    label: { ns: "rep", name: "system:primary" }
  });
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: DOCUMENT_A, content_label: "preview" }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "content_label_mismatch"
  );
  assert.deepEqual(await readdir(rt.config.sharedTempDir), []);
});

test("read cursors bind to preview, preserve it when omitted, and reject cross-label/profile reuse", async () => {
  const { rt } = await runtime();
  const p = profile();
  const first: any = (await rt.tools.call(p, "arcsuite_read_document", {
    document_id: DOCUMENT_A,
    content_label: "preview",
    max_chars: 1000
  })).structuredContent;
  assert.equal(first.content_label, "preview");
  assert.equal(typeof first.next_cursor, "string");
  const [body] = first.next_cursor.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  assert.equal(payload.content_label, "preview");

  const continued: any = (await rt.tools.call(p, "arcsuite_read_document", {
    document_id: DOCUMENT_A,
    cursor: first.next_cursor,
    max_chars: 1000
  })).structuredContent;
  assert.equal(continued.content_label, "preview");
  assert.equal(continued.cached, true);
  assert.match(continued.content, /Preview-only line/);

  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_read_document", { document_id: DOCUMENT_A, content_label: "system:primary", cursor: first.next_cursor, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "content_label_cursor_mismatch"
  );
  await assert.rejects(
    () => rt.tools.call({ ...p, clientProfileId: "other-profile" }, "arcsuite_read_document", { document_id: DOCUMENT_A, cursor: first.next_cursor, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
  const otherScopePayload = { ...payload, scope_id: "other_documents" };
  const otherScopeBody = Buffer.from(JSON.stringify(otherScopePayload), "utf8").toString("base64url");
  const otherScopeCursor = `${otherScopeBody}.${createHmac("sha256", rt.config.cursorSecret).update(otherScopeBody).digest("base64url")}`;
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_read_document", { document_id: DOCUMENT_A, cursor: otherScopeCursor, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "invalid_cursor"
  );
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_read_document", { document_id: DOCUMENT_A, cursor: `${first.next_cursor}x`, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
});

test("pre-v2 cursors fail cleanly after the effective-identity binding format bump", async () => {
  const { rt } = await runtime();
  const adapter: any = rt.adapter;
  const originalContent = adapter.content.bind(adapter);
  adapter.content = async (request: any) => {
    const content = await originalContent(request);
    if (request.contentLabel.name === "system:primary") {
      const text = `${"Synthetic primary content\n"}${"Primary-only line.\n".repeat(160)}`;
      await writeFile(content.filePath, text, "utf8");
      return { ...content, sizeBytes: Buffer.byteLength(text) };
    }
    return content;
  };
  const p = profile();
  const first: any = (await rt.tools.call(p, "arcsuite_read_document", { document_id: DOCUMENT_A, max_chars: 1000 })).structuredContent;
  assert.equal(typeof first.next_cursor, "string");
  const [body] = first.next_cursor.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  delete payload.content_label;
  delete payload.version;
  delete payload.effective_identity_binding;
  const legacyBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const legacy = `${legacyBody}.${createHmac("sha256", rt.config.cursorSecret).update(legacyBody).digest("base64url")}`;
  await assert.rejects(
    () => rt.tools.call(p, "arcsuite_read_document", { document_id: DOCUMENT_A, cursor: legacy, max_chars: 1000 }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
});
