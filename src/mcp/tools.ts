import { randomUUID } from "node:crypto";
import type { TokenProfile, AppConfig } from "../config.ts";
import type { ArcSuiteAdapterClient } from "../arcsuite/soapAdapterClient.ts";
import type { AdapterRepositoryObject, NormalizedDocument } from "../arcsuite/types.ts";
import { AdapterSessionManager } from "../arcsuite/sessionManager.ts";
import { DEFAULT_ATTRS, CONTENT_LABEL_PRIMARY } from "../arcsuite/constants.ts";
import { ScopeRegistry, type SemanticScope } from "../semantic/scopeRegistry.ts";
import { mapFilter, type SemanticFilterInput } from "../semantic/attributeMapper.ts";
import { normalizeDocument } from "../semantic/responseNormalizer.ts";
import { ContentBridge } from "../content/contentBridge.ts";
import { AuditLogger } from "../audit/auditLogger.ts";
import { PagingSnapshotStore } from "./paging.ts";
import { McpToolError, toMcpToolError } from "./errors.ts";
import { assertExactKeys, assertObject, boolValue, enumValue, intValue, optionalInt, optionalString, stringValue } from "../util/json.ts";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

const RAW_ARCSUITE_KEYS = /^(cabinet|cabinetId|cabinet_id|attr|attribute|attributes|attrId|attr_id|endpoint|baseUrl|serviceDn|service_dn|session|Session|sessionId|SearchCondition|operation|operations|option|options|soap|wsdl|raw)$/i;

export class ToolRegistry {
  private readonly config: AppConfig;
  private readonly scopes: ScopeRegistry;
  private readonly adapter: ArcSuiteAdapterClient;
  private readonly sessions: AdapterSessionManager;
  private readonly contentBridge: ContentBridge;
  private readonly audit: AuditLogger;
  private readonly paging: PagingSnapshotStore;

  constructor(
    config: AppConfig,
    scopes: ScopeRegistry,
    adapter: ArcSuiteAdapterClient,
    sessions: AdapterSessionManager,
    contentBridge: ContentBridge,
    audit: AuditLogger
  ) {
    this.config = config;
    this.scopes = scopes;
    this.adapter = adapter;
    this.sessions = sessions;
    this.contentBridge = contentBridge;
    this.audit = audit;
    this.paging = new PagingSnapshotStore(
      config.cursorSecret,
      config.pagingTtlSeconds,
      config.pagingSnapshotMaxIds,
      config.pagingSnapshotMaxSnapshots,
      config.pagingSnapshotMaxSnapshotsPerClient,
      config.pagingSnapshotMaxTotalIds
    );
  }

  list(profile: TokenProfile): ToolDefinition[] {
    return buildDefinitions(profile, this.scopes, this.config).filter((tool) => profile.allowedTools.includes(tool.name));
  }

  async call(profile: TokenProfile, name: string, rawArgs: unknown): Promise<ToolCallResult> {
    if (!profile.allowedTools.includes(name)) throw new McpToolError("ARCSUITE_FORBIDDEN", "tool_not_allowed", false);
    const traceId = randomUUID();
    const started = Date.now();
    let scopeId: string | undefined;
    let soapOperations: string[] = [];
    let objectIds: string[] = [];
    let resultCount: number | undefined;
    let resultCode = "OK";

    try {
      const args = assertObject(rawArgs ?? {}, "arguments");
      rejectRawArcSuiteFields(args);
      let data: Record<string, unknown>;

      switch (name) {
        case "arcsuite_describe_capabilities": {
          assertExactKeys(args, [], "describe capabilities arguments");
          data = {
            version: "1.2",
            read_only: true,
            allowed_tools: this.list(profile).map((tool) => tool.name),
            scopes: this.scopes.describe(profile.allowedScopes)
          };
          resultCount = this.scopes.describe(profile.allowedScopes).length;
          break;
        }
        case "arcsuite_search_documents": {
          const parsed = parseSearchArgs(args, this.config);
          scopeId = parsed.scope;
          const scope = this.allowedScope(profile, parsed.scope);
          if (parsed.textSearchMode !== "none" && !parsed.query) throw new TypeError("text_search_mode requires a text query");
          const allowedTextSearchModes = scope.search?.full_text_modes ?? ["none"];
          if (!allowedTextSearchModes.includes(parsed.textSearchMode)) {
            throw new TypeError(`text_search_mode ${parsed.textSearchMode} is not allowed for scope ${parsed.scope}`);
          }
          let page;
          if (parsed.cursor) {
            page = this.paging.next(parsed.cursor, { clientProfileId: profile.clientProfileId, scopeId: parsed.scope, kind: "search" });
          } else {
            const attrConditions = Object.entries(parsed.filters).map(([key, value]) => mapFilter(scope, key, value, this.scopes.schemaFor(parsed.scope, key)));
            const words = parsed.query ? tokenizeQuery(parsed.query) : [];
            const snapshotLimit = this.config.pagingSnapshotMaxIds;
            const ids = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.searchIds({
              clientProfileId: profile.clientProfileId,
              attributeConditions: attrConditions,
              text: words.length ? { words, operator: parsed.queryMode.toUpperCase() as "AND" | "OR" } : undefined,
              mode: attrConditions.length && words.length ? "AND" : parsed.queryMode.toUpperCase() as "AND" | "OR",
              searchRegionIds: [scope.arcsuite.root_object_id ?? scope.arcsuite.cabinet_id],
              depth: 0,
              textSearchMode: parsed.textSearchMode.toUpperCase() as "NONE" | "STEMMING" | "THESAURUS",
              order: [
                { attrId: DEFAULT_ATTRS.modifiedOn, descending: true },
                { attrId: DEFAULT_ATTRS.name, descending: false }
              ],
              limit: snapshotLimit + 1,
              options: []
            }));
            soapOperations.push("searchRepositoryObjectIds");
            for (const id of ids) this.assertObjectIdInScope(scope, id);
            page = this.paging.create({
              clientProfileId: profile.clientProfileId,
              scopeId: parsed.scope,
              kind: "search",
              ids,
              pageSize: parsed.limit,
              context: { includePath: parsed.includePath },
              upstreamLimited: ids.length > snapshotLimit
            });
          }
          const pageData = await this.fetchObjectsByIds(profile, scope, page.ids, page.context.includePath, soapOperations);
          objectIds = pageData.results.map((item) => item.document_id);
          resultCount = pageData.results.length;
          data = {
            scope: parsed.scope,
            count: pageData.results.length,
            limit: page.pageSize,
            truncated: Boolean(page.nextCursor) || page.snapshotLimited,
            snapshot_limited: page.snapshotLimited,
            next_cursor: page.nextCursor,
            failures: pageData.failures,
            results: pageData.results
          };
          break;
        }
        case "arcsuite_get_document": {
          const parsed = parseGetDocumentArgs(args);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          const scope = scopeMatch.scope;
          const result = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
            clientProfileId: profile.clientProfileId,
            id: parsed.documentId,
            revisionNumber: parsed.revisionNumber,
            resolveRef: scope.arcsuite.resolve_references,
            includePath: parsed.includePath || Boolean(scope.arcsuite.root_object_id),
            attrIds: scope.default_attr_ids,
            options: []
          }));
          this.assertRepositoryObjectInScope(scope, result);
          this.assertAllowedObjectType(scope, result);
          soapOperations = parsed.revisionNumber ? ["getRepositoryObjectByRevisionNumber"] : ["getRepositoryObject"];
          if (parsed.includePath || scope.arcsuite.root_object_id) soapOperations.push("getRepositoryObjectPath");
          this.assertRootScope(result, scope);
          const normalized = this.decorateDocument(scope, normalizeDocument(result, scope.semantic_attributes));
          if (!parsed.includePath) delete normalized.path;
          objectIds = [normalized.document_id];
          resultCount = 1;
          data = normalized as unknown as Record<string, unknown>;
          break;
        }
        case "arcsuite_get_documents": {
          const parsed = parseGetDocumentsArgs(args, this.config);
          scopeId = parsed.scope;
          const scope = this.allowedScope(profile, parsed.scope);
          for (const id of parsed.documentIds) this.assertObjectIdInScope(scope, id);
          const batch = await this.fetchObjectsByIds(profile, scope, parsed.documentIds, parsed.includePath, soapOperations);
          objectIds = batch.results.map((item) => item.document_id);
          resultCount = batch.results.length;
          data = {
            scope: parsed.scope,
            requested_count: parsed.documentIds.length,
            count: batch.results.length,
            failures: batch.failures,
            results: batch.results
          };
          break;
        }
        case "arcsuite_list_folder": {
          const parsed = parseListFolderArgs(args, this.config);
          scopeId = parsed.scope;
          const scope = this.allowedScope(profile, parsed.scope);
          let page;
          if (parsed.cursor) {
            page = this.paging.next(parsed.cursor, { clientProfileId: profile.clientProfileId, scopeId: parsed.scope, kind: "folder" });
          } else {
            const locationId = parsed.folderId ?? scope.arcsuite.root_object_id ?? scope.arcsuite.cabinet_id;
            if (parsed.folderId) await this.verifyObjectScope(profile, scope, parsed.folderId);
            const snapshotLimit = this.config.pagingSnapshotMaxIds;
            const ids = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.listIds({
              clientProfileId: profile.clientProfileId,
              locationId,
              latestOnly: true,
              order: [{ attrId: DEFAULT_ATTRS.name, descending: false }],
              limit: snapshotLimit + 1,
              options: []
            }));
            soapOperations.push("listRepositoryObjectIds");
            for (const id of ids) this.assertObjectIdInScope(scope, id);
            page = this.paging.create({
              clientProfileId: profile.clientProfileId,
              scopeId: parsed.scope,
              kind: "folder",
              ids,
              pageSize: parsed.limit,
              context: { folderId: locationId, includePath: parsed.includePath },
              upstreamLimited: ids.length > snapshotLimit
            });
          }
          const pageData = await this.fetchObjectsByIds(profile, scope, page.ids, page.context.includePath, soapOperations);
          objectIds = pageData.results.map((item) => item.document_id);
          resultCount = pageData.results.length;
          data = {
            scope: parsed.scope,
            folder_id: page.context.folderId,
            count: pageData.results.length,
            limit: page.pageSize,
            truncated: Boolean(page.nextCursor) || page.snapshotLimited,
            snapshot_limited: page.snapshotLimited,
            next_cursor: page.nextCursor,
            failures: pageData.failures,
            results: pageData.results
          };
          break;
        }
        case "arcsuite_list_document_revisions": {
          const parsed = parseRevisionsArgs(args, this.config);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          await this.verifyObjectScope(profile, scopeMatch.scope, parsed.documentId);
          const result = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.revisions({
            clientProfileId: profile.clientProfileId,
            id: parsed.documentId,
            attrIds: scopeMatch.scope.default_attr_ids,
            options: []
          }));
          this.assertRepositoryObjectsInScope(scopeMatch.scope, result);
          this.assertAllowedObjectTypes(scopeMatch.scope, result);
          await this.verifyReturnedRootScope(profile, scopeMatch.scope, result);
          soapOperations = ["listRepositoryObjectRevisions"];
          const normalized = result.map((item) => this.decorateDocument(scopeMatch.scope, normalizeDocument(item, scopeMatch.scope.semantic_attributes))).slice(0, parsed.limit);
          objectIds = [parsed.documentId];
          resultCount = normalized.length;
          data = { document_id: parsed.documentId, count: normalized.length, limit: parsed.limit, truncated: result.length > parsed.limit, revisions: normalized };
          break;
        }
        case "arcsuite_get_document_content_info": {
          const parsed = parseContentInfoArgs(args);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          await this.verifyObjectScope(profile, scopeMatch.scope, parsed.documentId);
          const cacheContext = {
            clientProfileId: profile.clientProfileId,
            scopeId: scopeMatch.id,
            documentId: parsed.documentId,
            revisionNumber: parsed.revisionNumber,
            contentLabel: CONTENT_LABEL_PRIMARY.name
          };
          const info = await this.contentBridge.infoCachedOrLoad(cacheContext, async () => {
            const content = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.content({
              clientProfileId: profile.clientProfileId,
              id: parsed.documentId,
              revisionNumber: parsed.revisionNumber,
              contentLabel: CONTENT_LABEL_PRIMARY,
              options: contentOptions(scopeMatch.scope),
              traceId
            }));
            this.assertObjectIdInScope(scopeMatch.scope, content.id, parsed.documentId);
            return content;
          });
          if (!info.cached) soapOperations = ["getRepositoryObjectContentWithOptions"];
          objectIds = [parsed.documentId];
          resultCount = 1;
          data = { document_id: parsed.documentId, revision_number: parsed.revisionNumber, ...info };
          break;
        }
        case "arcsuite_read_document": {
          const parsed = parseReadArgs(args, this.config);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          await this.verifyObjectScope(profile, scopeMatch.scope, parsed.documentId);
          const cacheContext = {
            clientProfileId: profile.clientProfileId,
            scopeId: scopeMatch.id,
            documentId: parsed.documentId,
            revisionNumber: parsed.revisionNumber,
            contentLabel: CONTENT_LABEL_PRIMARY.name
          };
          const read = await this.contentBridge.readCachedOrLoad(cacheContext, {
            traceId,
            documentId: parsed.documentId,
            revisionNumber: parsed.revisionNumber,
            startPage: parsed.startPage,
            endPage: parsed.endPage,
            cursor: parsed.cursor,
            maxChars: parsed.maxChars
          }, async () => {
            const content = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.content({
              clientProfileId: profile.clientProfileId,
              id: parsed.documentId,
              revisionNumber: parsed.revisionNumber,
              contentLabel: CONTENT_LABEL_PRIMARY,
              options: contentOptions(scopeMatch.scope),
              traceId
            }));
            this.assertObjectIdInScope(scopeMatch.scope, content.id, parsed.documentId);
            return content;
          });
          if (!read.cached) soapOperations = ["getRepositoryObjectContentWithOptions"];
          objectIds = [parsed.documentId];
          resultCount = 1;
          data = read as unknown as Record<string, unknown>;
          break;
        }
        default:
          throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "unknown_tool", false, `Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: shortSummary(name, data) }], structuredContent: data };
    } catch (error) {
      resultCode = toMcpToolError(error).stableCode;
      throw toMcpToolError(error);
    } finally {
      await this.audit.write({
        ts: new Date().toISOString(),
        trace_id: traceId,
        client_profile_id: profile.clientProfileId,
        tool_name: name,
        scope: scopeId,
        soap_operations: soapOperations,
        object_ids: objectIds,
        result_code: resultCode,
        result_count: resultCount,
        latency_ms: Date.now() - started
      }).catch(() => undefined);
    }
  }

  private allowedScope(profile: TokenProfile, scopeId: string): SemanticScope {
    if (!profile.allowedScopes.includes(scopeId)) throw new McpToolError("ARCSUITE_FORBIDDEN", "scope_not_allowed", false);
    try { return this.scopes.get(scopeId); }
    catch { throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "unknown_scope", false); }
  }

  private requireScopeForObject(objectId: string, profile: TokenProfile): { id: string; scope: SemanticScope } {
    if (!/^rep:/.test(objectId)) throw new TypeError("document_id must start with rep:");
    const match = this.scopes.inferScopeFromObjectId(objectId, profile.allowedScopes);
    if (!match) throw new McpToolError("ARCSUITE_FORBIDDEN", "scope_not_proven", false);
    return match;
  }

  private async verifyObjectScope(profile: TokenProfile, scope: SemanticScope, objectId: string): Promise<void> {
    if (!objectId.startsWith(`${scope.arcsuite.cabinet_id}:`) && objectId !== scope.arcsuite.cabinet_id) {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "cabinet_scope", false);
    }
    if (!scope.arcsuite.root_object_id) return;
    const obj = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: objectId,
      resolveRef: false,
      includePath: true,
      attrIds: [DEFAULT_ATTRS.name],
      options: []
    }));
    this.assertRepositoryObjectInScope(scope, obj);
    this.assertAllowedObjectType(scope, obj);
    this.assertRootScope(obj, scope);
  }

  private async fetchObjectsByIds(
    profile: TokenProfile,
    scope: SemanticScope,
    ids: string[],
    includePath: boolean,
    operations: string[]
  ): Promise<{ results: NormalizedDocument[]; failures: Array<{ index: number; document_id: string; code: string }> }> {
    if (!ids.length) return { results: [], failures: [] };
    for (const id of ids) this.assertObjectIdInScope(scope, id);
    const root = scope.arcsuite.root_object_id;
    const options = root ? ["getRepositoryObjects.searchMode", `getRepositoryObjects.searchMode.searchRegion=${root}`] : [];
    const batch = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.getMany({
      clientProfileId: profile.clientProfileId,
      ids,
      resolveRef: scope.arcsuite.resolve_references,
      attrIds: scope.default_attr_ids,
      options
    }));
    if (!operations.includes("getRepositoryObjects")) operations.push("getRepositoryObjects");
    if (!batch || !Array.isArray(batch.objects) || !Array.isArray(batch.failures)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_shape", false);
    }
    const requestedIndexById = new Map<string, number>();
    for (const [index, id] of ids.entries()) requestedIndexById.set(id, index);
    if (requestedIndexById.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
    const coveredIndexes = new Set<number>();
    const returnedIds = new Set<string>();
    for (const object of batch.objects) {
      const index = requestedIndexById.get(object.id);
      if (index === undefined || returnedIds.has(object.id)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
      returnedIds.add(object.id);
      coveredIndexes.add(index);
    }
    for (const failure of batch.failures) {
      if (!Number.isSafeInteger(failure.index) || failure.index < 0 || failure.index >= ids.length) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_failure_index", false);
      }
      if (coveredIndexes.has(failure.index)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
      coveredIndexes.add(failure.index);
    }
    if (coveredIndexes.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_coverage", false);
    this.assertRepositoryObjectsInScope(scope, batch.objects);
    this.assertAllowedObjectTypes(scope, batch.objects);
    const normalized = batch.objects.map((item) => this.decorateDocument(scope, normalizeDocument(item, scope.semantic_attributes)));
    if (includePath || root) await this.attachPaths(profile, scope, normalized, operations);
    if (!includePath) for (const doc of normalized) delete doc.path;
    const failures = batch.failures.map((failure) => {
      if (!Number.isInteger(failure.index) || failure.index < 0 || failure.index >= ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_failure_index", false);
      return { index: failure.index, document_id: ids[failure.index], code: failure.code };
    });
    return { results: normalized, failures };
  }

  private assertAllowedObjectTypes(scope: SemanticScope, objects: AdapterRepositoryObject[]): void {
    for (const object of objects) this.assertAllowedObjectType(scope, object);
  }

  private assertRepositoryObjectsInScope(scope: SemanticScope, objects: AdapterRepositoryObject[]): void {
    for (const object of objects) this.assertRepositoryObjectInScope(scope, object);
  }

  private assertRepositoryObjectInScope(scope: SemanticScope, object: AdapterRepositoryObject): void {
    this.assertObjectIdInScope(scope, object.id);
    for (const pathObject of object.pathObjects ?? []) this.assertObjectIdInScope(scope, pathObject.id);
  }

  private assertObjectIdInScope(scope: SemanticScope, objectId: unknown, expectedObjectId?: string): void {
    if (typeof objectId !== "string" || (!objectId.startsWith(`${scope.arcsuite.cabinet_id}:`) && objectId !== scope.arcsuite.cabinet_id)) {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "cabinet_scope", false);
    }
    if (expectedObjectId !== undefined && objectId !== expectedObjectId) throw new McpToolError("ARCSUITE_FORBIDDEN", "object_identity", false);
  }

  private async verifyReturnedRootScope(profile: TokenProfile, scope: SemanticScope, objects: AdapterRepositoryObject[]): Promise<void> {
    if (!scope.arcsuite.root_object_id) return;
    for (const object of objects) {
      if (object.pathObjects?.length) this.assertRootScope(object, scope);
      else await this.verifyObjectScope(profile, scope, object.id);
    }
  }

  private assertAllowedObjectType(scope: SemanticScope, object: AdapterRepositoryObject): void {
    if (!this.scopes.isAllowedObjectType(scope, object.objectClass)) throw new McpToolError("ARCSUITE_FORBIDDEN", "object_type_not_allowed", false);
  }

  private assertRootScope(obj: { id: string; pathObjects?: Array<{ id: string }> }, scope: SemanticScope): void {
    const root = scope.arcsuite.root_object_id;
    if (!root) return;
    if (obj.id === root) return;
    if (!obj.pathObjects?.some((p) => p.id === root)) throw new McpToolError("ARCSUITE_FORBIDDEN", "root_scope", false);
  }

  private async attachPaths(profile: TokenProfile, scope: SemanticScope, docs: NormalizedDocument[], operations: string[]): Promise<void> {
    for (const doc of docs) {
      if (doc.path?.length) continue;
      const obj = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
        clientProfileId: profile.clientProfileId,
        id: doc.document_id,
        resolveRef: scope.arcsuite.resolve_references,
        includePath: true,
        attrIds: [DEFAULT_ATTRS.name],
        options: []
      }));
      this.assertRepositoryObjectInScope(scope, obj);
      this.assertAllowedObjectType(scope, obj);
      this.assertRootScope(obj, scope);
      doc.path = normalizeDocument(obj, scope.semantic_attributes).path;
    }
    if (docs.length && !operations.includes("getRepositoryObjectPath")) operations.push("getRepositoryObjectPath");
  }

  private decorateDocument(scope: SemanticScope, doc: NormalizedDocument): NormalizedDocument {
    const openUrl = this.scopes.documentUrl(scope, doc.document_id);
    if (openUrl) doc.open_url = openUrl;
    return doc;
  }
}

function contentOptions(scope: SemanticScope): string[] {
  const out = ["errorOnOfflineContent"];
  if (scope.arcsuite.resolve_references) out.unshift("resolveRef");
  return out;
}

function rejectRawArcSuiteFields(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectRawArcSuiteFields(item); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_ARCSUITE_KEYS.test(key)) throw new TypeError(`Raw ArcSuite field is not allowed: ${key}`);
    rejectRawArcSuiteFields(child);
  }
}

function parseSearchArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["scope", "query", "query_mode", "filters", "limit", "include_path", "cursor", "text_search_mode"], "search arguments");
  const scope = stringValue(args.scope, "scope", 1, 100);
  const cursor = optionalString(args.cursor, "cursor", 4096);
  if (cursor) {
    for (const key of ["query", "query_mode", "filters", "limit", "include_path", "text_search_mode"]) if (args[key] !== undefined) throw new TypeError(`${key} cannot be combined with cursor`);
    return { scope, cursor, query: undefined, queryMode: "and" as const, filters: {} as Record<string, SemanticFilterInput>, textSearchMode: "none" as const, limit: config.searchDefaultLimit, includePath: false };
  }
  const queryValue = optionalString(args.query, "query", 200);
  const query = queryValue?.trim() || undefined;
  const queryMode = enumValue(args.query_mode, ["and", "or"] as const, "and");
  const textSearchMode = enumValue(args.text_search_mode, ["none", "stemming", "thesaurus"] as const, "none");
  const filterObj = args.filters === undefined ? {} : assertObject(args.filters, "filters");
  const filters: Record<string, SemanticFilterInput> = {};
  for (const [key, value] of Object.entries(filterObj)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new TypeError(`Invalid semantic filter name: ${key}`);
    filters[key] = parseSemanticFilterInput(value, `filters.${key}`);
  }
  if (!query && !Object.keys(filters).length) throw new TypeError("At least query or one semantic filter is required");
  if (!query && textSearchMode !== "none") throw new TypeError("text_search_mode requires a text query");
  const limit = args.limit === undefined ? config.searchDefaultLimit : intValue(args.limit, "limit", 1, config.searchMaxLimit);
  return { scope, cursor: undefined, query, queryMode, filters, textSearchMode, limit, includePath: boolValue(args.include_path, false) };
}

function parseSemanticFilterInput(value: unknown, label: string): SemanticFilterInput {
  if (typeof value === "string") return stringValue(value, label, 1, 255);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
    return value;
  }
  const predicate = assertObject(value, label);
  assertExactKeys(predicate, ["operator", "value"], `${label} predicate`);
  const operator = enumValue(predicate.operator, ["eq", "like", "gte", "lte"] as const);
  return { operator, value: parseSemanticFilterScalar(predicate.value, `${label}.value`) };
}

function parseSemanticFilterScalar(value: unknown, label: string): string | number | boolean {
  if (typeof value === "string") return stringValue(value, label, 1, 255);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`${label} must be a non-empty string, finite number, or boolean`);
}

function parseGetDocumentArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["document_id", "revision_number", "include_path"], "get document arguments");
  return {
    documentId: repId(args.document_id, "document_id"),
    revisionNumber: optionalInt(args.revision_number, "revision_number", 1, 2_147_483_647),
    includePath: boolValue(args.include_path, true)
  };
}

function parseGetDocumentsArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["scope", "document_ids", "include_path"], "get documents arguments");
  const scope = stringValue(args.scope, "scope", 1, 100);
  if (!Array.isArray(args.document_ids) || !args.document_ids.length || args.document_ids.length > config.batchMaxIds) throw new TypeError(`document_ids must contain 1..${config.batchMaxIds} items`);
  const documentIds = args.document_ids.map((value, index) => repId(value, `document_ids[${index}]`));
  if (new Set(documentIds).size !== documentIds.length) throw new TypeError("document_ids must not contain duplicates");
  return { scope, documentIds, includePath: boolValue(args.include_path, false) };
}

function parseListFolderArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["scope", "folder_id", "limit", "include_path", "cursor"], "list folder arguments");
  const scope = stringValue(args.scope, "scope", 1, 100);
  const cursor = optionalString(args.cursor, "cursor", 4096);
  if (cursor) {
    for (const key of ["folder_id", "limit", "include_path"]) if (args[key] !== undefined) throw new TypeError(`${key} cannot be combined with cursor`);
    return { scope, cursor, folderId: undefined, limit: config.searchDefaultLimit, includePath: false };
  }
  return {
    scope,
    cursor: undefined,
    folderId: args.folder_id === undefined ? undefined : repId(args.folder_id, "folder_id"),
    limit: args.limit === undefined ? config.searchDefaultLimit : intValue(args.limit, "limit", 1, config.searchMaxLimit),
    includePath: boolValue(args.include_path, false)
  };
}

function parseRevisionsArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["document_id", "limit"], "revision arguments");
  return { documentId: repId(args.document_id, "document_id"), limit: args.limit === undefined ? 20 : intValue(args.limit, "limit", 1, config.searchMaxLimit) };
}

function parseContentInfoArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["document_id", "revision_number", "content_label"], "content info arguments");
  const label = optionalString(args.content_label, "content_label", 100) ?? "system:primary";
  if (label !== "system:primary") throw new TypeError("Only system:primary content_label is allowed in v1.1");
  return { documentId: repId(args.document_id, "document_id"), revisionNumber: optionalInt(args.revision_number, "revision_number", 1, 2_147_483_647) };
}

function parseReadArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["document_id", "revision_number", "content_label", "start_page", "end_page", "cursor", "max_chars"], "read arguments");
  const label = optionalString(args.content_label, "content_label", 100) ?? "system:primary";
  if (label !== "system:primary") throw new TypeError("Only system:primary content_label is allowed in v1.1");
  const cursor = optionalString(args.cursor, "cursor", 4096);
  const startPage = optionalInt(args.start_page, "start_page", 1, 1_000_000);
  const endPage = optionalInt(args.end_page, "end_page", 1, 1_000_000);
  if (cursor && startPage !== undefined) throw new TypeError("cursor and start_page cannot both be specified");
  if (cursor && endPage !== undefined) throw new TypeError("cursor and end_page cannot both be specified");
  if (endPage !== undefined && startPage === undefined) throw new TypeError("end_page requires start_page");
  if (endPage !== undefined && startPage !== undefined && endPage < startPage) throw new TypeError("end_page must be >= start_page");
  const maxChars = args.max_chars === undefined ? config.readDefaultMaxChars : intValue(args.max_chars, "max_chars", 1000, config.readMaxChars);
  return { documentId: repId(args.document_id, "document_id"), revisionNumber: optionalInt(args.revision_number, "revision_number", 1, 2_147_483_647), startPage, endPage, cursor, maxChars };
}

function repId(value: unknown, label: string): string {
  const id = stringValue(value, label, 5, 2048);
  if (!id.startsWith("rep:")) throw new TypeError(`${label} must start with rep:`);
  return id;
}

function tokenizeQuery(query: string): string[] {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= 10) return words;
  throw new TypeError("query contains more than 10 terms");
}

function shortSummary(name: string, data: Record<string, unknown>): string {
  if (name === "arcsuite_read_document") {
    const content = String(data.content ?? "");
    return `ArcSuite document content (${String(data.file_name ?? "unknown")}; truncated=${String(data.truncated ?? false)})\n\n${content}`;
  }
  return `ArcSuite MCP ${name} result:\n${JSON.stringify(data)}`;
}

function buildDefinitions(profile: TokenProfile, scopes: ScopeRegistry, config: AppConfig): ToolDefinition[] {
  const descriptions = scopes.describe(profile.allowedScopes);
  const scopeValues = descriptions.map((item) => item.id);
  const scopeSummary = descriptions.map((item) => `${item.id} [${item.filters.map((filter) => `${filter.name}:${filter.type}(${filter.operators.join(",")})`).join(", ") || "no semantic filters"}; text=${item.full_text_modes.join(",")}]`).join("; ");
  const scope = { type: "string", enum: scopeValues };
  const documentId = { type: "string", pattern: "^rep:", minLength: 5, maxLength: 2048 };
  const limit = { type: "integer", minimum: 1, maximum: config.searchMaxLimit, default: config.searchDefaultLimit };
  const contentLabel = { type: "string", enum: ["system:primary"], default: "system:primary" };
  const filterScalar = { oneOf: [{ type: "string", minLength: 1, maxLength: 255 }, { type: "number" }, { type: "boolean" }] };
  const filterValue = { oneOf: [filterScalar, { type: "object", additionalProperties: false, required: ["operator", "value"], properties: { operator: { type: "string", enum: ["eq", "like", "gte", "lte"] }, value: filterScalar } }] };
  return [
    {
      name: "arcsuite_describe_capabilities",
      description: "Describe the semantic ArcSuite scopes, filters, object types, and read-only tools available to the authenticated client profile.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: "arcsuite_search_documents",
      description: `Search an allowed semantic ArcSuite scope. Available scope/filter names: ${scopeSummary || "none"}. Use next_cursor by itself with scope to continue a stable bounded snapshot.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["scope"], properties: { scope, query: { type: "string", minLength: 1, maxLength: 200 }, query_mode: { type: "string", enum: ["and", "or"], default: "and" }, filters: { type: "object", additionalProperties: filterValue }, limit, include_path: { type: "boolean", default: false }, cursor: { type: "string", maxLength: 4096 }, text_search_mode: { type: "string", enum: ["none", "stemming", "thesaurus"], default: "none" } } }
    },
    {
      name: "arcsuite_get_document",
      description: "Get semantic metadata for a document in an allowed scope. Use arcsuite_read_document for bounded text content.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, revision_number: { type: "integer", minimum: 1 }, include_path: { type: "boolean", default: true } } }
    },
    {
      name: "arcsuite_get_documents",
      description: `Get metadata for a bounded batch of document IDs in one allowed semantic scope. Partial failures are returned explicitly. Maximum batch size: ${config.batchMaxIds}.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["scope", "document_ids"], properties: { scope, document_ids: { type: "array", minItems: 1, maxItems: config.batchMaxIds, items: documentId }, include_path: { type: "boolean", default: false } } }
    },
    {
      name: "arcsuite_list_folder",
      description: "List documents and folders below a configured semantic scope or proven folder. Use next_cursor by itself with scope to continue a stable bounded snapshot.",
      inputSchema: { type: "object", additionalProperties: false, required: ["scope"], properties: { scope, folder_id: documentId, limit, include_path: { type: "boolean", default: false }, cursor: { type: "string", maxLength: 4096 } } }
    },
    {
      name: "arcsuite_list_document_revisions",
      description: "List read-only revision metadata for a document in an allowed scope.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, limit } }
    },
    {
      name: "arcsuite_get_document_content_info",
      description: "Inspect primary content metadata and extraction support. A short-lived private extracted-content snapshot may be warmed for a subsequent read; binary content is never returned.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, revision_number: { type: "integer", minimum: 1 }, content_label: contentLabel } }
    },
    {
      name: "arcsuite_read_document",
      description: "Read primary content through the configured ArcSuite adapter, reuse a private bounded snapshot when available, and return bounded text with a signed cursor. Binary/base64 content is never returned.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, revision_number: { type: "integer", minimum: 1 }, content_label: contentLabel, start_page: { type: "integer", minimum: 1 }, end_page: { type: "integer", minimum: 1 }, cursor: { type: "string", maxLength: 4096 }, max_chars: { type: "integer", minimum: 1000, maximum: config.readMaxChars, default: config.readDefaultMaxChars } } }
    }
  ];
}
