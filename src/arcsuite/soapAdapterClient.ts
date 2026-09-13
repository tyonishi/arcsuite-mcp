import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterContentRequest,
  AdapterContentResult,
  AdapterGetManyRequest,
  AdapterGetManyResult,
  AdapterGetRequest,
  AdapterListIdsRequest,
  AdapterListRequest,
  AdapterRepositoryObject,
  AdapterRevisionsRequest,
  AdapterSchemaValidationRequest,
  AdapterSchemaValidationResult,
  AdapterSearchIdsRequest,
  AdapterSearchRequest,
  PhysicalContentLabel
} from "./types.ts";
import { ArcSuiteAdapterError } from "./errors.ts";
import { readResponseText } from "../util/http.ts";

const MAX_ADAPTER_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ArcSuiteAdapterClient {
  health(): Promise<boolean>;
  version(): Promise<{ minVersion?: string; curVersion?: string }>;
  login(clientProfileId: string): Promise<void>;
  logout(clientProfileId: string): Promise<void>;
  validateSchema(request: AdapterSchemaValidationRequest): Promise<AdapterSchemaValidationResult>;
  search(request: AdapterSearchRequest): Promise<AdapterRepositoryObject[]>;
  searchIds(request: AdapterSearchIdsRequest): Promise<string[]>;
  list(request: AdapterListRequest): Promise<AdapterRepositoryObject[]>;
  listIds(request: AdapterListIdsRequest): Promise<string[]>;
  get(request: AdapterGetRequest): Promise<AdapterRepositoryObject>;
  getMany(request: AdapterGetManyRequest): Promise<AdapterGetManyResult>;
  revisions(request: AdapterRevisionsRequest): Promise<AdapterRepositoryObject[]>;
  content(request: AdapterContentRequest): Promise<AdapterContentResult>;
}

export class HttpArcSuiteAdapterClient implements ArcSuiteAdapterClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;
  constructor(baseUrl: string, internalToken: string) { this.baseUrl = baseUrl; this.internalToken = internalToken; }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/healthz`, { headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(10_000) });
      await readResponseText(res, 64 * 1024);
      return res.ok;
    } catch {
      return false;
    }
  }

  version() { return this.request("GET", "/internal/version") as Promise<{ minVersion?: string; curVersion?: string }>; }
  login(clientProfileId: string) { return this.request("POST", "/internal/session/login", { clientProfileId }).then(() => undefined); }
  logout(clientProfileId: string) { return this.request("POST", "/internal/session/logout", { clientProfileId }).then(() => undefined); }
  validateSchema(request: AdapterSchemaValidationRequest) { return this.request("POST", "/internal/schema/validate", request) as Promise<AdapterSchemaValidationResult>; }
  search(request: AdapterSearchRequest) { return this.request("POST", "/internal/repository/search", request) as Promise<AdapterRepositoryObject[]>; }
  searchIds(request: AdapterSearchIdsRequest) { return this.request("POST", "/internal/repository/search-ids", request) as Promise<string[]>; }
  list(request: AdapterListRequest) { return this.request("POST", "/internal/repository/list", request) as Promise<AdapterRepositoryObject[]>; }
  listIds(request: AdapterListIdsRequest) { return this.request("POST", "/internal/repository/list-ids", request) as Promise<string[]>; }
  get(request: AdapterGetRequest) { return this.request("POST", "/internal/repository/get", request) as Promise<AdapterRepositoryObject>; }
  getMany(request: AdapterGetManyRequest) { return this.request("POST", "/internal/repository/get-many", request) as Promise<AdapterGetManyResult>; }
  revisions(request: AdapterRevisionsRequest) { return this.request("POST", "/internal/repository/revisions", request) as Promise<AdapterRepositoryObject[]>; }
  content(request: AdapterContentRequest) { return this.request("POST", "/internal/repository/content", request) as Promise<AdapterContentResult>; }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", "x-internal-token": this.internalToken };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(620_000)
      });
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
      throw new ArcSuiteAdapterError(
        isTimeout ? "ARCSUITE_TIMEOUT" : "ARCSUITE_UPSTREAM_ERROR",
        isTimeout ? "Adapter request timed out" : "Adapter request failed",
        { retryable: isTimeout }
      );
    }
    let text: string;
    try {
      text = await readResponseText(res, MAX_ADAPTER_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message === "RESPONSE_TOO_LARGE") {
        throw new ArcSuiteAdapterError("ARCSUITE_LIMIT_EXCEEDED", "Adapter response exceeds configured maximum size");
      }
      throw new ArcSuiteAdapterError("ARCSUITE_UPSTREAM_ERROR", "Adapter response could not be read");
    }
    let parsed: any = {};
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 500) }; }
    }
    if (!res.ok) {
      const code = typeof parsed.code === "string" ? parsed.code : "ARCSUITE_UPSTREAM_ERROR";
      throw new ArcSuiteAdapterError(code, parsed.message ?? code, { retryable: Boolean(parsed.retryable), upstreamCode: parsed.upstreamCode });
    }
    return parsed;
  }
}

export class MockArcSuiteAdapterClient implements ArcSuiteAdapterClient {
  private readonly docs: AdapterRepositoryObject[];
  private readonly sharedDir: string;

  constructor(sharedDir: string) {
    this.sharedDir = sharedDir;
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 });
    chmodSync(sharedDir, 0o700);
    this.docs = [
      {
        id: "rep:mock:EXAMPLE_CABINET:1001",
        objectClass: "document",
        attributes: {
          "rep:system:name": { type: "string", value: "DOC-000001_example.pdf" },
          "rep:user:example_document_number": { type: "string", value: "DOC-000001" },
          "rep:system:modifiedon": { type: "datetime", value: "2026-09-01T03:00:00Z" },
          "rep:user:page_count": { type: "long", value: 10 },
          "rep:user:approved": { type: "boolean", value: true },
          "rep:user:quality_score": { type: "double", value: 0.95 },
          "rep:user:published_on": { type: "date", value: "2026-09-01" },
          "rep:system:currentrevisionnumber": { type: "int", value: 3 },
          "rep:system:revisionnumber": { type: "int", value: 3 },
          "rep:system:status": { type: "i18n", ns: "rep", name: "ACTIVE", label: "有効" },
          "rep:system:contentlabellist": { type: "i18n[]", values: [
            { ns: "rep", name: "system:primary", label: "プライマリ" },
            { ns: "rep", name: "user:EXAMPLE_PREVIEW", label: "プレビュー" }
          ] }
        },
        pathObjects: [
          { id: "rep:mock:EXAMPLE_CABINET:folder-a", name: "Example folder", objectClass: "folder" },
          { id: "rep:mock:EXAMPLE_CABINET", name: "Example cabinet", objectClass: "cabinet" }
        ],
        fullPath: true
      },
      {
        id: "rep:mock:EXAMPLE_CABINET:1002",
        objectClass: "document",
        attributes: {
          "rep:system:name": { type: "string", value: "DOC-000002_example.txt" },
          "rep:user:example_document_number": { type: "string", value: "DOC-000002" },
          "rep:system:modifiedon": { type: "datetime", value: "2026-08-15T03:00:00Z" },
          "rep:user:page_count": { type: "long", value: 4 },
          "rep:user:approved": { type: "boolean", value: false },
          "rep:user:quality_score": { type: "double", value: 0.75 },
          "rep:user:published_on": { type: "date", value: "2026-08-15" },
          "rep:system:currentrevisionnumber": { type: "int", value: 1 },
          "rep:system:revisionnumber": { type: "int", value: 1 },
          "rep:system:contentlabellist": { type: "i18n[]", values: [{ ns: "rep", name: "system:primary" }] }
        }
      }
    ];
  }

  async health() { return true; }
  async version() { return { minVersion: "4.0.0.0", curVersion: "4.0.0.0" }; }
  async login(_clientProfileId: string) {}
  async logout(_clientProfileId: string) {}
  async validateSchema(request: AdapterSchemaValidationRequest): Promise<AdapterSchemaValidationResult> {
    return {
      ok: request.cabinetId.startsWith("rep:"),
      version: await this.version(),
      cabinet: { id: request.cabinetId, label: "Example cabinet", hasRecycleBin: true },
      attributes: request.attributes.map(({ attrId }) => mockSchema(attrId)),
      errors: []
    };
  }

  async search(request: AdapterSearchRequest): Promise<AdapterRepositoryObject[]> {
    return this.searchBase(request).slice(0, request.limit);
  }

  async searchIds(request: AdapterSearchIdsRequest): Promise<string[]> {
    return this.searchBase(request).map((doc) => doc.id).slice(0, request.limit);
  }

  async list(request: AdapterListRequest): Promise<AdapterRepositoryObject[]> {
    return this.listBase(request.locationId).slice(0, request.limit);
  }

  async listIds(request: AdapterListIdsRequest): Promise<string[]> {
    return this.listBase(request.locationId).map((doc) => doc.id).slice(0, request.limit);
  }

  async get(request: AdapterGetRequest): Promise<AdapterRepositoryObject> {
    const doc = this.docs.find((d) => d.id === request.id);
    if (!doc) throw new ArcSuiteAdapterError("ARCSUITE_NOT_AVAILABLE", "Object not available");
    const copy = structuredClone(doc);
    if (request.revisionNumber !== undefined) {
      copy.attributes["rep:system:revisionnumber"] = { type: "int", value: request.revisionNumber };
    }
    if (!request.includePath) delete copy.pathObjects;
    return copy;
  }

  async getMany(request: AdapterGetManyRequest): Promise<AdapterGetManyResult> {
    const objects: AdapterRepositoryObject[] = [];
    const failures: AdapterGetManyResult["failures"] = [];
    request.ids.forEach((id, index) => {
      const doc = this.docs.find((item) => item.id === id);
      if (!doc) {
        failures.push({ index, code: "ARCSUITE_NOT_AVAILABLE" });
      } else {
        const copy = structuredClone(doc);
        delete copy.pathObjects;
        objects.push(copy);
      }
    });
    return { objects, failures };
  }

  async revisions(request: AdapterRevisionsRequest): Promise<AdapterRepositoryObject[]> {
    const base = await this.get({ clientProfileId: request.clientProfileId, id: request.id, resolveRef: true, includePath: false, attrIds: request.attrIds, options: request.options });
    const current: any = base.attributes["rep:system:currentrevisionnumber"];
    const n = Number(current?.value ?? 1);
    return Array.from({ length: n }, (_, index) => {
      const copy = structuredClone(base);
      copy.attributes["rep:system:revisionnumber"] = { type: "int", value: n - index };
      return copy;
    });
  }

  async content(request: AdapterContentRequest): Promise<AdapterContentResult> {
    const document = await this.get({
      clientProfileId: request.clientProfileId,
      id: request.id,
      revisionNumber: request.revisionNumber,
      resolveRef: true,
      includePath: false,
      attrIds: [],
      options: []
    });
    const labels = document.attributes["rep:system:contentlabellist"];
    if (labels?.type !== "i18n[]" || !labels.values.some((label) => label.ns === request.contentLabel.ns && label.name === request.contentLabel.name)) {
      throw new ArcSuiteAdapterError("ARCSUITE_NOT_AVAILABLE", "Content label not available");
    }
    const preview = request.contentLabel.ns === "rep" && request.contentLabel.name === "user:EXAMPLE_PREVIEW";
    const path = join(this.sharedDir, `${request.traceId}.txt`);
    const text = preview
      ? `Synthetic ArcSuite preview content\nDocument ID: ${request.id}\nThis text is provided for local MCP testing.\n${"Preview-only line.\n".repeat(160)}`
      : `Synthetic ArcSuite document\nDocument ID: ${request.id}\nThis text is provided for local MCP testing.\n`;
    writeFileSync(path, text, "utf8");
    const label: PhysicalContentLabel = { ns: request.contentLabel.ns, name: request.contentLabel.name };
    return {
      id: request.id,
      effectiveId: document.id,
      revisionNumber: request.revisionNumber,
      label,
      fileName: preview ? "mock-document-preview.txt" : "mock-document.txt",
      contentType: "text/plain",
      sizeBytes: Buffer.byteLength(text),
      filePath: path
    };
  }

  private searchBase(request: AdapterSearchIdsRequest | AdapterSearchRequest): AdapterRepositoryObject[] {
    let docs = [...this.docs];
    for (const condition of request.attributeConditions) {
      const key = `${condition.attrId.ns}:${condition.attrId.name}`;
      docs = docs.filter((doc) => {
        const v: any = doc.attributes[key];
        const text = v?.value ?? v?.name ?? "";
        const target = "value" in condition.value ? condition.value.value : `${condition.value.ns}:${condition.value.name}`;
        if (condition.operator === "EQUAL") return text === target || `${v?.ns ?? ""}:${v?.name ?? ""}` === target;
        if (condition.operator === "LIKE") {
          if (typeof target !== "string") return false;
          const regex = new RegExp(wildcardToRegex(target), "i");
          return regex.test(String(text));
        }
        if (condition.operator === "GREATER_EQUAL") return compareValues(text, target) >= 0;
        if (condition.operator === "LESS_EQUAL") return compareValues(text, target) <= 0;
        return false;
      });
    }
    if (request.text?.words.length) {
      const words = request.text.words.map((w) => w.toLowerCase());
      docs = docs.filter((doc) => {
        const hay = JSON.stringify(doc.attributes).toLowerCase();
        return request.text?.operator === "OR" ? words.some((w) => hay.includes(w)) : words.every((w) => hay.includes(w));
      });
    }
    return docs;
  }

  private listBase(_locationId: string): AdapterRepositoryObject[] {
    return this.docs.filter((d) => d.id.startsWith("rep:mock:EXAMPLE_CABINET:"));
  }
}

function mockSchema(attrId: { ns: string; name: string }) {
  const base = { ...attrId, searchable: true, sortable: true, modifiable: false, multiValued: false, required: false, minInclusive: true, maxInclusive: true };
  if (attrId.name.includes("modified")) return { ...base, dataType: "DATE_TIME_TYPE" };
  if (attrId.name.includes("published_on")) return { ...base, dataType: "DATE_TYPE" };
  if (attrId.name.includes("page_count")) return { ...base, dataType: "LONG_TYPE", minIntegralValue: "0", maxIntegralValue: "9223372036854775807" };
  if (attrId.name.includes("approved")) return { ...base, dataType: "BOOLEAN_TYPE" };
  if (attrId.name.includes("quality_score")) return { ...base, dataType: "DOUBLE_TYPE", minFloatingValue: 0, maxFloatingValue: 1 };
  if (attrId.name.includes("status")) return { ...base, dataType: "I18N_STRING_TYPE", enumerated: true, enumLabels: [{ ns: "rep", name: "ACTIVE", label: "有効" }, { ns: "rep", name: "RETIRED", label: "廃止" }] };
  return { ...base, dataType: "STRING_TYPE", minLength: 1, maxLength: 255 };
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegex(target: string): string {
  let pattern = "^";
  let literalStart = 0;
  for (let index = 0; index < target.length; index += 1) {
    const wildcard = target[index];
    if (wildcard !== "*" && wildcard !== "?") continue;
    pattern += escapeRegex(target.slice(literalStart, index));
    pattern += wildcard === "*" ? ".*" : ".";
    literalStart = index + 1;
  }
  return `${pattern}${escapeRegex(target.slice(literalStart))}$`;
}
