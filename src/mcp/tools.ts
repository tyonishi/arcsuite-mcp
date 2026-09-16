import { randomUUID } from "node:crypto";
import type { TokenProfile, AppConfig } from "../config.ts";
import type { ArcSuiteAdapterClient } from "../arcsuite/soapAdapterClient.ts";
import type {
  AdapterContentRequest,
  AdapterContentResult,
  AdapterGetManyResult,
  AdapterIntegrityCertificateResult,
  AdapterIntegrityValidationResult,
  AdapterRepositoryObject,
  NormalizedDocument,
  PhysicalContentLabel
} from "../arcsuite/types.ts";
import { ArcSuiteAdapterError } from "../arcsuite/errors.ts";
import { AdapterSessionManager } from "../arcsuite/sessionManager.ts";
import { ARCSUITE_OBJECT_CLASS_NS, ARCSUITE_SEMANTIC_OBJECT_CLASSES, DEFAULT_ATTRS, MAX_PAGE_NUMBER, MAX_REVISION_NUMBER, MIN_REVISION_NUMBER } from "../arcsuite/constants.ts";
import { ScopeRegistry, type SemanticScope } from "../semantic/scopeRegistry.ts";
import { attrKey, canonicalizeFilter, SemanticVerificationError, verifySemanticPredicate, type CanonicalSemanticPredicate, type SemanticFilterInput } from "../semantic/attributeMapper.ts";
import { contentLabelMembership, normalizeDocument } from "../semantic/responseNormalizer.ts";
import { ContentBridge, type ContentInfo } from "../content/contentBridge.ts";
import type { ContentCacheContext } from "../content/snapshotCache.ts";
import { AuditLogger } from "../audit/auditLogger.ts";
import { PagingSnapshotStore } from "./paging.ts";
import { buildAppliedQuery, type AppliedQuery } from "./appliedQuery.ts";
import { McpToolError, toMcpToolError } from "./errors.ts";
import { assertExactKeys, assertObject, boolValue, enumValue, intValue, optionalInt, optionalString, stringValue } from "../util/json.ts";
import { CONTENT_LABEL_PRIMARY_ALIAS, isSemanticContentLabelAlias, samePhysicalContentLabel } from "../semantic/contentLabels.ts";
import {
  OpaqueHandleService,
  type CanonicalSearchAuthority,
  type ContinuationHandleRecord,
  type ContinuationPageAuthority,
  type HandlePolicyContext,
  type ResultHandleRecord,
  type SearchHandleRecord
} from "./opaqueHandles.ts";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

const RAW_ARCSUITE_KEYS = /^(cabinet|cabinetId|cabinet_id|attr|attribute|attributes|attrId|attr_id|certificate|certificateId|certId|certAttribute|certAttributes|endpoint|baseUrl|serviceDn|service_dn|session|Session|sessionId|SearchCondition|operation|operations|option|options|soap|wsdl|raw)$/i;

const MAX_INTEGRITY_CERTIFICATES = 64;
const MAX_INTEGRITY_EVIDENCE = 64;

const P2_TOOL_NAMES = new Set([
  "arcsuite_continue_search",
  "arcsuite_replay_search",
  "arcsuite_get_document_by_ref",
  "arcsuite_get_documents_by_ref",
  "arcsuite_list_document_revisions_by_ref",
  "arcsuite_get_document_content_info_by_ref",
  "arcsuite_read_document_by_ref"
]);

class ContentLabelNotFoundError extends Error {
  constructor() { super("CONTENT_LABEL_NOT_FOUND"); }
}

type ContentMembershipProof = {
  requestedDocumentId: string;
  effectiveDocumentId: string;
  wireDocumentId: string;
  cabinetId: string;
  rootObjectId: string | null;
  provenRevisionNumber: number;
  requestedRevisionNumber?: number;
  present: boolean;
};

type AuthorizedHardReference = {
  id: string;
  publicResult: Record<string, unknown>;
};

type SearchOutcome = NonNullable<import("../audit/auditLogger.ts").AuditRecord["search_outcome"]>;

class SearchOutcomeError extends Error {
  readonly outcome: SearchOutcome;

  constructor(outcome: SearchOutcome, message: string = outcome) {
    super(message);
    this.name = "SearchOutcomeError";
    this.outcome = outcome;
  }
}

export class ToolRegistry {
  private readonly config: AppConfig;
  private readonly scopes: ScopeRegistry;
  private readonly adapter: ArcSuiteAdapterClient;
  private readonly sessions: AdapterSessionManager;
  private readonly contentBridge: ContentBridge;
  private readonly audit: AuditLogger;
  private readonly paging: PagingSnapshotStore;
  private readonly handles: OpaqueHandleService | null;

  constructor(
    config: AppConfig,
    scopes: ScopeRegistry,
    adapter: ArcSuiteAdapterClient,
    sessions: AdapterSessionManager,
    contentBridge: ContentBridge,
    audit: AuditLogger,
    handles: OpaqueHandleService | null = null
  ) {
    this.config = config;
    this.scopes = scopes;
    this.adapter = adapter;
    this.sessions = sessions;
    this.contentBridge = contentBridge;
    this.audit = audit;
    this.handles = handles;
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
    return buildDefinitions(profile, this.scopes, this.config).filter((tool) => profile.allowedTools.includes(tool.name)
      && (this.handles !== null || !P2_TOOL_NAMES.has(tool.name)));
  }

  async call(profile: TokenProfile, name: string, rawArgs: unknown): Promise<ToolCallResult> {
    if (!profile.allowedTools.includes(name)) throw new McpToolError("ARCSUITE_FORBIDDEN", "tool_not_allowed", false);
    if (P2_TOOL_NAMES.has(name) && !this.handles) throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_refs_unavailable", false);
    const traceId = randomUUID();
    const started = Date.now();
    let scopeId: string | undefined;
    let soapOperations: string[] = [];
    let objectIds: string[] = [];
    let resultCount: number | undefined;
    let resultCode = "OK";
    let searchOutcome: SearchOutcome | undefined;

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
          if (parsed.responseContract === "opaque_refs_v1" && !this.handles) {
            throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_refs_unavailable", false);
          }
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
            const verificationPlan = Object.entries(parsed.filters)
              .map(([key, value]) => canonicalizeFilter(scope, key, value, this.scopes.schemaFor(parsed.scope, key)));
            const attrConditions = verificationPlan.map((predicate) => predicate.condition);
            const words = parsed.query ? tokenizeQuery(parsed.query) : [];
            const appliedQuery = buildAppliedQuery(verificationPlan, words, parsed.queryMode, parsed.textSearchMode);
            const searchAuthority: CanonicalSearchAuthority = {
              scopeId: parsed.scope,
              appliedQuery,
              includePath: parsed.includePath,
              pageSize: parsed.limit
            };
            const snapshotLimit = this.config.pagingSnapshotMaxIds;
            this.recordSoapOperation(soapOperations, "searchRepositoryObjectIds");
            const ids = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.searchIds({
              clientProfileId: profile.clientProfileId,
              attributeConditions: attrConditions,
              text: appliedQuery.text
                ? { words: [...appliedQuery.text.terms], operator: appliedQuery.text.operator.toUpperCase() as "AND" | "OR" }
                : undefined,
              mode: appliedQuery.operator.toUpperCase() as "AND" | "OR",
              searchRegionIds: [scope.arcsuite.root_object_id ?? scope.arcsuite.cabinet_id],
              depth: 0,
              textSearchMode: (appliedQuery.text?.mode ?? "none").toUpperCase() as "NONE" | "STEMMING" | "THESAURUS",
              order: [
                { attrId: DEFAULT_ATTRS.modifiedOn, descending: true },
                { attrId: DEFAULT_ATTRS.name, descending: false }
              ],
              limit: snapshotLimit + 1,
              options: []
            }));
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
              throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "search_ids_shape", false);
            }
            for (const id of ids) this.assertObjectIdInScope(scope, id);
            page = this.paging.create({
              clientProfileId: profile.clientProfileId,
              scopeId: parsed.scope,
              kind: "search",
              ids,
              pageSize: parsed.limit,
              context: {
                includePath: parsed.includePath,
                searchVerificationPlan: verificationPlan,
                searchAppliedQuery: appliedQuery,
                responseContract: parsed.responseContract,
                ...(parsed.responseContract === "opaque_refs_v1" ? { searchAuthority } : {})
              },
              upstreamLimited: ids.length > snapshotLimit
            });
          }
          const verificationPlan = page.context.searchVerificationPlan;
          const appliedQuery = page.context.searchAppliedQuery;
          if (!verificationPlan || !appliedQuery) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "upstream_error", false);
          const pageData = await this.fetchObjectsByIds(profile, scope, page.ids, page.context.includePath, soapOperations, verificationPlan);
          objectIds = pageData.results.map((item) => item.document_id);
          resultCount = pageData.results.length;
          searchOutcome = pageData.failures.length && pageData.results.length === 0
            ? "hydration_failure"
            : pageData.results.length ? "matches" : "zero";
          const legacyData: Record<string, unknown> = {
            scope: parsed.scope,
            count: pageData.results.length,
            limit: page.pageSize,
            truncated: Boolean(page.nextCursor) || page.snapshotLimited,
            snapshot_limited: page.snapshotLimited,
            next_cursor: page.nextCursor,
            applied_query: appliedQuery,
            failures: pageData.failures,
            results: pageData.results
          };
          const responseContract = page.context.responseContract ?? "legacy";
          if (responseContract === "opaque_refs_v1") {
            if (!this.handles || !page.context.searchAuthority) {
              throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_refs_unavailable", false);
            }
            const policyContext: HandlePolicyContext = { profile, scopeId: parsed.scope, scope };
            const results = pageData.results.map((result) => ({
              ...result,
              result_ref: this.handles!.issueResult(policyContext, {
                documentId: result.document_id,
                objectClass: result.object_class,
                verificationPlan
              })
            }));
            const continuationAuthority = page.nextCursor
              ? this.paging.continuationAuthority(page.nextCursor, { clientProfileId: profile.clientProfileId, scopeId: parsed.scope })
              : undefined;
            data = {
              ...legacyData,
              results,
              search_ref: this.handles.issueSearch(policyContext, page.context.searchAuthority),
              continuation_ref: page.nextCursor
                ? this.handles.issueContinuation(policyContext, {
                    searchAuthority: page.context.searchAuthority,
                    cursor: page.nextCursor,
                    pageAuthority: continuationAuthority
                  }, continuationAuthority?.expiresAt)
                : null
            };
          } else {
            data = legacyData;
          }
          break;
        }
        case "arcsuite_continue_search": {
          const parsed = parseContinueSearchArgs(args);
          const record = this.resolveBoundHandle(profile, parsed.continuationRef, "continuation") as ContinuationHandleRecord;
          const pageAuthority = record.pageAuthority;
          if (!pageAuthority) throw refUnavailable();
          scopeId = record.searchAuthority.scopeId;
          const scope = this.allowedScope(profile, scopeId);
          let resolvedPage;
          try {
            resolvedPage = this.paging.resolveContinuationAuthority(pageAuthority, {
              clientProfileId: profile.clientProfileId,
              scopeId
            });
          } catch {
            throw refUnavailable();
          }
          const verificationPlan = resolvedPage.page.context.searchVerificationPlan;
          const retainedSearchAuthority = resolvedPage.page.context.searchAuthority;
          if (!verificationPlan || !retainedSearchAuthority
            || JSON.stringify(retainedSearchAuthority) !== JSON.stringify(record.searchAuthority)) throw refUnavailable();
          const pageData = await this.fetchObjectsByIds(
            profile,
            scope,
            resolvedPage.page.ids,
            record.searchAuthority.includePath,
            soapOperations,
            verificationPlan
          );
          resultCount = pageData.results.length;
          data = this.refNativeSearchResponse(profile, scopeId, scope, record.searchAuthority, pageData, {
            snapshotLimited: resolvedPage.page.snapshotLimited,
            nextAuthority: resolvedPage.nextAuthority,
            verificationPlan,
            expiresAt: Math.min(record.expiresAt, pageAuthority.expiresAt)
          });
          break;
        }
        case "arcsuite_replay_search": {
          const parsed = parseReplaySearchArgs(args);
          const record = this.resolveBoundHandle(profile, parsed.searchRef, "search") as SearchHandleRecord;
          this.allowedScope(profile, record.authority.scopeId);
          scopeId = parsed.targetScope;
          const targetScope = this.allowedScope(profile, parsed.targetScope);
          const recanonicalized = this.recanonicalizeReplay(record.authority, parsed.targetScope, targetScope);
          const snapshotLimit = this.config.pagingSnapshotMaxIds;
          this.recordSoapOperation(soapOperations, "searchRepositoryObjectIds");
          const ids = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.searchIds({
            clientProfileId: profile.clientProfileId,
            attributeConditions: recanonicalized.verificationPlan.map((predicate) => predicate.condition),
            text: recanonicalized.appliedQuery.text
              ? { words: [...recanonicalized.appliedQuery.text.terms], operator: recanonicalized.appliedQuery.text.operator.toUpperCase() as "AND" | "OR" }
              : undefined,
            mode: recanonicalized.appliedQuery.operator.toUpperCase() as "AND" | "OR",
            searchRegionIds: [targetScope.arcsuite.root_object_id ?? targetScope.arcsuite.cabinet_id],
            depth: 0,
            textSearchMode: (recanonicalized.appliedQuery.text?.mode ?? "none").toUpperCase() as "NONE" | "STEMMING" | "THESAURUS",
            order: [
              { attrId: DEFAULT_ATTRS.modifiedOn, descending: true },
              { attrId: DEFAULT_ATTRS.name, descending: false }
            ],
            limit: snapshotLimit + 1,
            options: []
          }));
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
            throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "search_ids_shape", false);
          }
          for (const id of ids) this.assertObjectIdInScope(targetScope, id);
          const searchAuthority: CanonicalSearchAuthority = {
            scopeId: parsed.targetScope,
            appliedQuery: recanonicalized.appliedQuery,
            includePath: record.authority.includePath,
            pageSize: record.authority.pageSize
          };
          const page = this.paging.create({
            clientProfileId: profile.clientProfileId,
            scopeId: parsed.targetScope,
            kind: "search",
            ids,
            pageSize: record.authority.pageSize,
            context: {
              includePath: record.authority.includePath,
              searchVerificationPlan: recanonicalized.verificationPlan,
              searchAppliedQuery: recanonicalized.appliedQuery,
              responseContract: "opaque_refs_v1",
              searchAuthority
            },
            upstreamLimited: ids.length > snapshotLimit
          });
          const pageData = await this.fetchObjectsByIds(
            profile,
            targetScope,
            page.ids,
            record.authority.includePath,
            soapOperations,
            recanonicalized.verificationPlan
          );
          const nextAuthority = page.nextCursor
            ? this.paging.continuationAuthority(page.nextCursor, { clientProfileId: profile.clientProfileId, scopeId: parsed.targetScope })
            : undefined;
          resultCount = pageData.results.length;
          data = this.refNativeSearchResponse(profile, parsed.targetScope, targetScope, searchAuthority, pageData, {
            snapshotLimited: page.snapshotLimited,
            nextAuthority,
            verificationPlan: recanonicalized.verificationPlan,
            expiresAt: nextAuthority?.expiresAt
          });
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
          const normalized = this.decorateDocument(scope, normalizeDocument(result, scope.semantic_attributes, this.scopes.contentLabelAliases(scope)));
          if (!parsed.includePath) delete normalized.path;
          objectIds = [normalized.document_id];
          resultCount = 1;
          data = normalized as unknown as Record<string, unknown>;
          break;
        }
        case "arcsuite_get_document_by_ref": {
          const parsed = parseGetDocumentByRefArgs(args);
          const authority = this.resolveResultAuthority(profile, parsed.resultRef);
          scopeId = authority.record.scopeId;
          const current = await this.hydrateResultAuthority(profile, authority, parsed.revisionNumber, parsed.includePath, soapOperations);
          const normalized = this.decorateDocument(authority.scope, normalizeDocument(
            current,
            authority.scope.semantic_attributes,
            this.scopes.contentLabelAliases(authority.scope)
          ));
          if (!parsed.includePath) delete normalized.path;
          resultCount = 1;
          data = { ...withoutDocumentIdentity(normalized), result_ref: parsed.resultRef };
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
        case "arcsuite_get_documents_by_ref": {
          const parsed = parseGetDocumentsByRefArgs(args, this.config);
          const authorities = parsed.resultRefs.map((ref) => this.resolveResultAuthority(profile, ref));
          if (new Set(parsed.resultRefs).size !== parsed.resultRefs.length) throw new TypeError("result_refs must not contain duplicates");
          const boundScopeId = authorities[0]?.record.scopeId;
          if (!boundScopeId || authorities.some((authority) => authority.record.scopeId !== boundScopeId)) {
            throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "mixed_ref_scopes", false);
          }
          if (new Set(authorities.map((authority) => authority.record.documentId)).size !== authorities.length) {
            throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "duplicate_ref_identity", false);
          }
          scopeId = boundScopeId;
          const scope = authorities[0].scope;
          const batch = await this.fetchObjectsByIds(
            profile,
            scope,
            authorities.map((authority) => authority.record.documentId),
            parsed.includePath,
            soapOperations,
            undefined,
            new Map(authorities.map((authority) => [authority.record.documentId, authority.record.verificationPlan!]))
          );
          if (batch.failures.length || batch.results.length !== authorities.length) {
            throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "ref_target_unavailable", false);
          }
          for (const [index, result] of batch.results.entries()) {
            if (result.document_id !== authorities[index].record.documentId
              || result.object_class !== authorities[index].record.objectClass) {
              throw new McpToolError("ARCSUITE_FORBIDDEN", "object_identity", false);
            }
          }
          resultCount = batch.results.length;
          data = {
            scope: boundScopeId,
            requested_count: parsed.resultRefs.length,
            count: batch.results.length,
            failures: [],
            results: batch.results.map((result, index) => ({
              ...withoutDocumentIdentity(result),
              result_ref: parsed.resultRefs[index]
            }))
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
        case "arcsuite_list_hard_references": {
          const parsed = parseHardReferencesArgs(args, this.config);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          const scope = scopeMatch.scope;
          if (!scope.relationships?.hard_references) {
            throw new McpToolError("ARCSUITE_FORBIDDEN", "relationship_not_allowed", false);
          }
          await this.authorizeHardReferenceTarget(profile, scope, parsed.documentId, soapOperations);
          objectIds = [parsed.documentId];

          let page;
          let initiallyAuthorizedResults: Map<string, Record<string, unknown>> | undefined;
          if (parsed.cursor !== undefined) {
            page = this.paging.next(parsed.cursor, {
              clientProfileId: profile.clientProfileId,
              scopeId: scopeMatch.id,
              kind: "hard_reference",
              targetDocumentId: parsed.documentId
            });
          } else {
            this.recordSoapOperation(soapOperations, "listRepositoryObjectHardReferences");
            const candidates = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.hardReferences({
              clientProfileId: profile.clientProfileId,
              id: parsed.documentId,
              maxResults: this.config.hardReferenceMaxCandidates
            }));
            const candidateIds = validateHardReferenceCandidates(candidates, this.config.hardReferenceMaxCandidates);
            const sameCabinetIds = candidateIds.filter((id) => isObjectIdWithinCabinet(scope, id));
            const authorized = await this.loadAuthorizedHardReferenceObjects(profile, scope, sameCabinetIds, soapOperations);
            initiallyAuthorizedResults = new Map(authorized.map((item) => [item.id, item.publicResult]));
            page = this.paging.create({
              clientProfileId: profile.clientProfileId,
              scopeId: scopeMatch.id,
              kind: "hard_reference",
              ids: authorized.map((item) => item.id),
              pageSize: parsed.limit,
              context: { includePath: false, targetDocumentId: parsed.documentId }
            });
          }

          const results = initiallyAuthorizedResults
            ? page.ids.map((id) => {
                const result = initiallyAuthorizedResults?.get(id);
                if (!result) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_snapshot_identity", false);
                return result;
              })
            : (await this.loadAuthorizedHardReferenceObjects(profile, scope, page.ids, soapOperations)).map((item) => item.publicResult);
          resultCount = results.length;
          data = {
            document_id: parsed.documentId,
            relationship: "hard_reference_incoming",
            count: results.length,
            limit: page.pageSize,
            truncated: Boolean(page.nextCursor),
            next_cursor: page.nextCursor,
            results
          };
          break;
        }
        case "arcsuite_validate_document_integrity": {
          const parsed = parseIntegrityArgs(args);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          objectIds = [parsed.documentId];
          const scope = scopeMatch.scope;
          if (scope.integrity?.enabled !== true) {
            throw new McpToolError("ARCSUITE_FORBIDDEN", "integrity_not_allowed", false);
          }
          if (parsed.includeEvidence && scope.integrity?.allow_evidence !== true) {
            throw new McpToolError("ARCSUITE_FORBIDDEN", "integrity_evidence_not_allowed", false);
          }

          await this.authorizeIntegrityTarget(profile, scope, parsed.documentId, soapOperations);

          soapOperations.push("validateCertificate");
          const rawValidation = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.validateIntegrity({
            clientProfileId: profile.clientProfileId,
            id: parsed.documentId
          }));
          const validation = normalizeIntegrityValidation(rawValidation);
          const certificates = validation.certificates;
          let status: "valid" | "invalid_or_unverifiable" | "validation_failed";
          const warnings: string[] = [];
          if (validation.failure === "per_id") {
            status = "validation_failed";
          } else if (certificates.length === 0) {
            status = "invalid_or_unverifiable";
            warnings.push("NO_VALIDATION_ELEMENTS");
          } else {
            const hasFalseResult = certificates.some((certificate) => certificate.result === false);
            const hasException = certificates.some((certificate) => certificate.exceptionPresent);
            status = !hasFalseResult && !hasException ? "valid" : "invalid_or_unverifiable";
            if (hasFalseResult) warnings.push("VALIDATION_NOT_PROVEN");
            if (hasException) warnings.push("VALIDATION_ELEMENT_EXCEPTION");
          }

          data = {
            document_id: parsed.documentId,
            status,
            certificate_count: certificates.length,
            warnings
          };
          if (parsed.includeEvidence) {
            if (validation.failure === "per_id") {
              data.evidence = [];
            } else {
              soapOperations.push("getCertificateEvidence");
              const rawEvidence = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.certificateEvidence({
                clientProfileId: profile.clientProfileId,
                id: parsed.documentId
              }));
              const evidenceIds = normalizeCertificateEvidence(rawEvidence, certificates);
              data.evidence = [...new Set(certificates.map((certificate) => certificate.certId))].map((certId) => ({
                cert_id: certId,
                evidence_available: evidenceIds.has(certId)
              }));
            }
          }
          resultCount = certificates.length;
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
          const normalized = result.map((item) => this.decorateDocument(scopeMatch.scope, normalizeDocument(item, scopeMatch.scope.semantic_attributes, this.scopes.contentLabelAliases(scopeMatch.scope)))).slice(0, parsed.limit);
          objectIds = [parsed.documentId];
          resultCount = normalized.length;
          data = { document_id: parsed.documentId, count: normalized.length, limit: parsed.limit, truncated: result.length > parsed.limit, revisions: normalized };
          break;
        }
        case "arcsuite_list_document_revisions_by_ref": {
          const parsed = parseRevisionsByRefArgs(args, this.config);
          const authority = this.resolveResultAuthority(profile, parsed.resultRef);
          scopeId = authority.record.scopeId;
          await this.hydrateResultAuthority(profile, authority, undefined, false, soapOperations);
          this.recordSoapOperation(soapOperations, "listRepositoryObjectRevisions");
          const result = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.revisions({
            clientProfileId: profile.clientProfileId,
            id: authority.record.documentId,
            attrIds: authority.scope.default_attr_ids,
            options: []
          }));
          this.assertRepositoryObjectsInScope(authority.scope, result);
          this.assertAllowedObjectTypes(authority.scope, result);
          await this.verifyReturnedRootScope(profile, authority.scope, result);
          for (const item of result) {
            const revisionNumber = repositoryObjectRevisionNumber(item);
            if (revisionNumber === undefined
              || !revisionMetadataIdentityMatches(authority.record.documentId, item.id, revisionNumber)
              || item.objectClass !== authority.record.objectClass) {
              throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "revision_identity", false);
            }
          }
          const normalized = result.map((item) => withoutDocumentIdentity(this.decorateDocument(
            authority.scope,
            normalizeDocument(item, authority.scope.semantic_attributes, this.scopes.contentLabelAliases(authority.scope))
          ))).slice(0, parsed.limit);
          resultCount = normalized.length;
          data = {
            result_ref: parsed.resultRef,
            count: normalized.length,
            limit: parsed.limit,
            truncated: result.length > parsed.limit,
            revisions: normalized
          };
          break;
        }
        case "arcsuite_get_document_content_info": {
          const parsed = parseContentInfoArgs(args);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          const semanticLabel = this.resolveContentLabel(scopeMatch.scope, parsed.contentLabel ?? CONTENT_LABEL_PRIMARY_ALIAS);
          let info: ContentInfo | undefined;
          try {
            // Re-prove current authority before even consulting a private
            // snapshot.  Cache state is an optimization, never an authority.
            const membership = await this.proveContentLabelMembership(profile, scopeMatch.scope, parsed.documentId, parsed.revisionNumber, semanticLabel.physical, soapOperations);
            if (!membership.present) throw new ContentLabelNotFoundError();
            const cacheContext = this.contentCacheContext(profile, scopeMatch.id, scopeMatch.scope, parsed.documentId, semanticLabel.alias, semanticLabel.physical, membership.proof);
            info = await this.contentBridge.infoCachedOrLoad(cacheContext, async () => this.loadContent(profile, scopeMatch.scope, {
                clientProfileId: profile.clientProfileId,
                requestedId: membership.proof.requestedDocumentId,
                effectiveId: membership.proof.effectiveDocumentId,
                revisionNumber: membership.proof.provenRevisionNumber,
                contentWireId: membership.proof.wireDocumentId,
                contentLabel: semanticLabel.physical,
                options: contentOptions(scopeMatch.scope),
                traceId
              }, membership.proof, semanticLabel.physical, membership.proof.provenRevisionNumber, soapOperations));
          } catch (error) {
            if (!(error instanceof ContentLabelNotFoundError)) throw error;
          }
          objectIds = [parsed.documentId];
          resultCount = 1;
          data = info
            ? { document_id: parsed.documentId, revision_number: parsed.revisionNumber, content_label: semanticLabel.alias, ...info }
            : {
                document_id: parsed.documentId,
                revision_number: parsed.revisionNumber,
                content_label: semanticLabel.alias,
                label: semanticLabel.alias,
                extractable: false,
                reason: "CONTENT_LABEL_NOT_FOUND"
              };
          break;
        }
        case "arcsuite_get_document_content_info_by_ref": {
          const parsed = parseContentInfoByRefArgs(args);
          const authority = this.resolveResultAuthority(profile, parsed.resultRef);
          scopeId = authority.record.scopeId;
          await this.hydrateResultAuthority(profile, authority, undefined, false, soapOperations);
          const semanticLabel = this.resolveContentLabel(authority.scope, parsed.contentLabel ?? CONTENT_LABEL_PRIMARY_ALIAS);
          let info: ContentInfo | undefined;
          try {
            const membership = await this.proveContentLabelMembership(
              profile,
              authority.scope,
              authority.record.documentId,
              parsed.revisionNumber,
              semanticLabel.physical,
              soapOperations
            );
            if (!membership.present) throw new ContentLabelNotFoundError();
            const cacheContext = this.contentCacheContext(
              profile,
              authority.record.scopeId,
              authority.scope,
              authority.record.documentId,
              semanticLabel.alias,
              semanticLabel.physical,
              membership.proof
            );
            info = await this.contentBridge.infoCachedOrLoad(cacheContext, async () => this.loadContent(profile, authority.scope, {
              clientProfileId: profile.clientProfileId,
              requestedId: membership.proof.requestedDocumentId,
              effectiveId: membership.proof.effectiveDocumentId,
              revisionNumber: membership.proof.provenRevisionNumber,
              contentWireId: membership.proof.wireDocumentId,
              contentLabel: semanticLabel.physical,
              options: contentOptions(authority.scope),
              traceId
            }, membership.proof, semanticLabel.physical, membership.proof.provenRevisionNumber, soapOperations));
          } catch (error) {
            if (!(error instanceof ContentLabelNotFoundError)) throw error;
          }
          resultCount = 1;
          data = info
            ? { result_ref: parsed.resultRef, revision_number: parsed.revisionNumber, content_label: semanticLabel.alias, ...info }
            : {
                result_ref: parsed.resultRef,
                revision_number: parsed.revisionNumber,
                content_label: semanticLabel.alias,
                label: semanticLabel.alias,
                extractable: false,
                reason: "CONTENT_LABEL_NOT_FOUND"
              };
          break;
        }
        case "arcsuite_read_document": {
          const parsed = parseReadArgs(args, this.config);
          const scopeMatch = this.requireScopeForObject(parsed.documentId, profile);
          scopeId = scopeMatch.id;
          const cursorLabel = parsed.cursor ? this.contentBridge.resolveCursorContentLabel(parsed.cursor) : undefined;
          if (parsed.contentLabel !== undefined && cursorLabel !== undefined && parsed.contentLabel !== cursorLabel) {
            throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "content_label_cursor_mismatch", false);
          }
          const semanticLabel = this.resolveContentLabel(scopeMatch.scope, parsed.contentLabel ?? cursorLabel ?? CONTENT_LABEL_PRIMARY_ALIAS);
          // The membership proof is deliberately outside ContentBridge: this
          // makes every initial read and cursor continuation re-authorize the
          // current requested/effective identity before cache lookup.
          const membership = await this.proveContentLabelMembership(profile, scopeMatch.scope, parsed.documentId, parsed.revisionNumber, semanticLabel.physical, soapOperations);
          if (!membership.present) throw new ContentLabelNotFoundError();
          const cacheContext = this.contentCacheContext(profile, scopeMatch.id, scopeMatch.scope, parsed.documentId, semanticLabel.alias, semanticLabel.physical, membership.proof);
          const read = await this.contentBridge.readCachedOrLoad(cacheContext, {
            traceId,
            documentId: parsed.documentId,
            revisionNumber: parsed.revisionNumber,
            startPage: parsed.startPage,
            endPage: parsed.endPage,
            cursor: parsed.cursor,
            contentLabel: semanticLabel.alias,
            maxChars: parsed.maxChars
          }, async () => this.loadContent(profile, scopeMatch.scope, {
              clientProfileId: profile.clientProfileId,
              requestedId: membership.proof.requestedDocumentId,
              effectiveId: membership.proof.effectiveDocumentId,
              revisionNumber: membership.proof.provenRevisionNumber,
              contentWireId: membership.proof.wireDocumentId,
              contentLabel: semanticLabel.physical,
              options: contentOptions(scopeMatch.scope),
              traceId
            }, membership.proof, semanticLabel.physical, membership.proof.provenRevisionNumber, soapOperations));
          objectIds = [parsed.documentId];
          resultCount = 1;
          data = read as unknown as Record<string, unknown>;
          break;
        }
        case "arcsuite_read_document_by_ref": {
          const parsed = parseReadByRefArgs(args, this.config);
          const authority = this.resolveResultAuthority(profile, parsed.resultRef);
          scopeId = authority.record.scopeId;
          await this.hydrateResultAuthority(profile, authority, undefined, false, soapOperations);
          const cursorLabel = parsed.cursor ? this.contentBridge.resolveCursorContentLabel(parsed.cursor) : undefined;
          if (parsed.contentLabel !== undefined && cursorLabel !== undefined && parsed.contentLabel !== cursorLabel) {
            throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "content_label_cursor_mismatch", false);
          }
          const semanticLabel = this.resolveContentLabel(authority.scope, parsed.contentLabel ?? cursorLabel ?? CONTENT_LABEL_PRIMARY_ALIAS);
          const membership = await this.proveContentLabelMembership(
            profile,
            authority.scope,
            authority.record.documentId,
            parsed.revisionNumber,
            semanticLabel.physical,
            soapOperations
          );
          if (!membership.present) throw new ContentLabelNotFoundError();
          const cacheContext = this.contentCacheContext(
            profile,
            authority.record.scopeId,
            authority.scope,
            authority.record.documentId,
            semanticLabel.alias,
            semanticLabel.physical,
            membership.proof
          );
          const read = await this.contentBridge.readCachedOrLoad(cacheContext, {
            traceId,
            documentId: authority.record.documentId,
            revisionNumber: parsed.revisionNumber,
            startPage: parsed.startPage,
            endPage: parsed.endPage,
            cursor: parsed.cursor,
            contentLabel: semanticLabel.alias,
            maxChars: parsed.maxChars
          }, async () => this.loadContent(profile, authority.scope, {
            clientProfileId: profile.clientProfileId,
            requestedId: membership.proof.requestedDocumentId,
            effectiveId: membership.proof.effectiveDocumentId,
            revisionNumber: membership.proof.provenRevisionNumber,
            contentWireId: membership.proof.wireDocumentId,
            contentLabel: semanticLabel.physical,
            options: contentOptions(authority.scope),
            traceId
          }, membership.proof, semanticLabel.physical, membership.proof.provenRevisionNumber, soapOperations));
          resultCount = 1;
          data = { ...withoutDocumentIdentity(read as unknown as Record<string, unknown>), result_ref: parsed.resultRef };
          break;
        }
        default:
          throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "unknown_tool", false, `Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: shortSummary(name, data) }], structuredContent: data };
    } catch (error) {
      const mapped = toMcpToolError(error);
      resultCode = mapped.stableCode;
      if (name === "arcsuite_search_documents") {
        if (error instanceof SearchOutcomeError) searchOutcome = error.outcome;
        else if (mapped.stableCode !== "ARCSUITE_INVALID_ARGUMENT"
          && (mapped.stableCode !== "ARCSUITE_FORBIDDEN" || soapOperations.length > 0)) searchOutcome = "provider_failure";
      }
      throw mapped;
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
        ...(name === "arcsuite_search_documents" && searchOutcome ? { search_outcome: searchOutcome } : {}),
        latency_ms: Date.now() - started
      }).catch(() => undefined);
    }
  }

  private resolveBoundHandle(profile: TokenProfile, ref: string, kind: "search" | "continuation" | "result") {
    if (!this.handles) throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_refs_unavailable", false);
    return this.handles.resolveBound(ref, kind, profile, (boundScopeId) => this.scopes.get(boundScopeId));
  }

  private resolveResultAuthority(profile: TokenProfile, ref: string): { record: ResultHandleRecord; scope: SemanticScope } {
    const record = this.resolveBoundHandle(profile, ref, "result");
    if (record.kind !== "result" || !Array.isArray(record.verificationPlan)) throw refUnavailable();
    return { record, scope: this.allowedScope(profile, record.scopeId) };
  }

  private async hydrateResultAuthority(
    profile: TokenProfile,
    authority: { record: ResultHandleRecord; scope: SemanticScope },
    revisionNumber: number | undefined,
    includePath: boolean,
    operations: string[]
  ): Promise<AdapterRepositoryObject> {
    const { record, scope } = authority;
    this.assertObjectIdInScope(scope, record.documentId);
    const attrIds: typeof scope.default_attr_ids = [];
    const seen = new Set<string>();
    for (const attr of [
      ...scope.default_attr_ids,
      ...record.verificationPlan!.filter((predicate) => predicate.verification === "deterministic").map((predicate) => predicate.condition.attrId)
    ]) {
      const key = attrKey(attr);
      if (!seen.has(key)) {
        seen.add(key);
        attrIds.push({ ...attr });
      }
    }
    this.recordSoapOperation(operations, revisionNumber === undefined ? "getRepositoryObject" : "getRepositoryObjectByRevisionNumber");
    if (includePath || scope.arcsuite.root_object_id) this.recordSoapOperation(operations, "getRepositoryObjectPath");
    const current = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: record.documentId,
      revisionNumber,
      resolveRef: false,
      includePath: includePath || Boolean(scope.arcsuite.root_object_id),
      attrIds,
      options: []
    }));
    this.assertRepositoryObjectInScope(scope, current);
    const identityMatches = revisionNumber === undefined
      ? current.id === record.documentId
      : revisionMetadataIdentityMatches(record.documentId, current.id, revisionNumber);
    if (!identityMatches || current.objectClass !== record.objectClass) {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "object_identity", false);
    }
    this.assertAllowedObjectType(scope, current);
    this.assertRootScope(current, scope);
    for (const predicate of record.verificationPlan!) {
      try {
        verifySemanticPredicate(predicate, current.attributes);
      } catch {
        throw new McpToolError("ARCSUITE_FORBIDDEN", "scope_predicate", false);
      }
    }
    return current;
  }

  private recanonicalizeReplay(
    authority: CanonicalSearchAuthority,
    targetScopeId: string,
    targetScope: SemanticScope
  ): { verificationPlan: CanonicalSemanticPredicate[]; appliedQuery: AppliedQuery } {
    try {
      if (!Number.isSafeInteger(authority.pageSize) || authority.pageSize < 1 || authority.pageSize > this.config.searchMaxLimit) {
        throw new Error("page_size");
      }
      const verificationPlan = authority.appliedQuery.filters.predicates.map((predicate) => {
        const target = targetScope.semantic_attributes[predicate.name];
        if (!target || target.type !== predicate.type || !target.operators.includes(predicate.operator)) {
          throw new Error("predicate");
        }
        return canonicalizeFilter(
          targetScope,
          predicate.name,
          { operator: predicate.operator, value: predicate.value },
          this.scopes.schemaFor(targetScopeId, predicate.name)
        );
      });
      const text = authority.appliedQuery.text;
      const textMode = text?.mode ?? "none";
      if (!(targetScope.search?.full_text_modes ?? ["none"]).includes(textMode)) throw new Error("text_mode");
      const appliedQuery = buildAppliedQuery(
        verificationPlan,
        text ? [...text.terms] : [],
        text?.operator ?? authority.appliedQuery.operator,
        textMode
      );
      if (JSON.stringify(appliedQuery) !== JSON.stringify(authority.appliedQuery)) throw new Error("semantic_drift");
      return { verificationPlan, appliedQuery };
    } catch {
      throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "invalid_argument", false, "ARCSUITE_INVALID_ARGUMENT", "replay_query_incompatible");
    }
  }

  private refNativeSearchResponse(
    profile: TokenProfile,
    scopeId: string,
    scope: SemanticScope,
    searchAuthority: CanonicalSearchAuthority,
    pageData: { results: NormalizedDocument[]; failures: Array<{ index: number; document_id: string; code: string }> },
    continuation: {
      snapshotLimited: boolean;
      nextAuthority?: ContinuationPageAuthority;
      verificationPlan: readonly CanonicalSemanticPredicate[];
      expiresAt?: number;
    }
  ): Record<string, unknown> {
    if (!this.handles) throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_refs_unavailable", false);
    const policyContext: HandlePolicyContext = { profile, scopeId, scope };
    const maxExpiresAt = continuation.expiresAt;
    const results = pageData.results.map((result) => ({
      ...withoutDocumentIdentity(result),
      result_ref: this.handles!.issueResult(policyContext, {
        documentId: result.document_id,
        objectClass: result.object_class,
        verificationPlan: continuation.verificationPlan
      }, maxExpiresAt)
    }));
    const nextPageAuthority = continuation.nextAuthority;
    if (nextPageAuthority && !maxExpiresAt) throw refUnavailable();
    return {
      scope: scopeId,
      count: results.length,
      limit: searchAuthority.pageSize,
      truncated: Boolean(nextPageAuthority) || continuation.snapshotLimited,
      snapshot_limited: continuation.snapshotLimited,
      applied_query: searchAuthority.appliedQuery,
      failures: pageData.failures.map(({ index, code }) => ({ index, code })),
      results,
      search_ref: this.handles.issueSearch(policyContext, searchAuthority, maxExpiresAt),
      continuation_ref: nextPageAuthority
        ? this.handles.issueContinuation(policyContext, {
            searchAuthority,
            pageAuthority: nextPageAuthority
          }, maxExpiresAt)
        : null
    };
  }

  private allowedScope(profile: TokenProfile, scopeId: string): SemanticScope {
    if (!profile.allowedScopes.includes(scopeId)) throw new McpToolError("ARCSUITE_FORBIDDEN", "scope_not_allowed", false);
    try { return this.scopes.get(scopeId); }
    catch { throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "unknown_scope", false); }
  }

  private async authorizeIntegrityTarget(
    profile: TokenProfile,
    scope: SemanticScope,
    objectId: string,
    operations: string[]
  ): Promise<void> {
    this.assertObjectIdInScope(scope, objectId);
    const includePath = Boolean(scope.arcsuite.root_object_id);
    operations.push("getRepositoryObject");
    if (includePath) operations.push("getRepositoryObjectPath");
    const target = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: objectId,
      resolveRef: false,
      includePath,
      attrIds: [],
      options: []
    }));
    if (!isRepositoryObject(target)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_target_shape", false);
    this.assertRepositoryObjectInScope(scope, target);
    this.assertObjectIdInScope(scope, target.id, objectId);
    this.assertAllowedObjectType(scope, target);
    if (target.objectClass !== "document") {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "integrity_document_only", false);
    }
    this.assertRootScope(target, scope);
  }

  private requireScopeForObject(objectId: string, profile: TokenProfile): { id: string; scope: SemanticScope } {
    if (!/^rep:/.test(objectId)) throw new TypeError("document_id must start with rep:");
    const match = this.scopes.inferScopeFromObjectId(objectId, profile.allowedScopes);
    if (!match) throw new McpToolError("ARCSUITE_FORBIDDEN", "scope_not_proven", false);
    return match;
  }

  private resolveContentLabel(scope: SemanticScope, alias: string): { alias: string; physical: PhysicalContentLabel } {
    if (!isSemanticContentLabelAlias(alias)) {
      throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "content_label_not_allowed", false);
    }
    const physical = this.scopes.resolveContentLabel(scope, alias);
    if (!physical) throw new McpToolError("ARCSUITE_INVALID_ARGUMENT", "content_label_not_allowed", false);
    return { alias, physical };
  }

  private contentCacheContext(
    profile: TokenProfile,
    scopeId: string,
    scope: SemanticScope,
    requestedDocumentId: string,
    contentLabel: string,
    physicalContentLabel: PhysicalContentLabel,
    proof: ContentMembershipProof
  ): ContentCacheContext {
    return {
      clientProfileId: profile.clientProfileId,
      scopeId,
      documentId: requestedDocumentId,
      effectiveDocumentId: proof.effectiveDocumentId,
      wireDocumentId: proof.wireDocumentId,
      cabinetId: scope.arcsuite.cabinet_id,
      rootObjectId: scope.arcsuite.root_object_id,
      provenRevisionNumber: proof.provenRevisionNumber,
      requestedRevisionNumber: proof.requestedRevisionNumber,
      contentLabel,
      physicalContentLabel
    };
  }

  private async verifyObjectScope(
    profile: TokenProfile,
    scope: SemanticScope,
    objectId: string,
    options: { revisionNumber?: number; resolveRef?: boolean } = {}
  ): Promise<void> {
    if (!objectId.startsWith(`${scope.arcsuite.cabinet_id}:`) && objectId !== scope.arcsuite.cabinet_id) {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "cabinet_scope", false);
    }
    if (!scope.arcsuite.root_object_id) return;
    const obj = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: objectId,
      revisionNumber: options.revisionNumber,
      resolveRef: options.resolveRef ?? false,
      includePath: true,
      attrIds: [DEFAULT_ATTRS.name],
      options: []
    }));
    this.assertRepositoryObjectInScope(scope, obj);
    this.assertAllowedObjectType(scope, obj);
    this.assertRootScope(obj, scope);
  }

  private async authorizeHardReferenceTarget(
    profile: TokenProfile,
    scope: SemanticScope,
    targetId: string,
    operations: string[]
  ): Promise<void> {
    this.recordSoapOperation(operations, "getRepositoryObject");
    this.recordSoapOperation(operations, "getRepositoryObjectPath");
    const target = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: targetId,
      resolveRef: false,
      includePath: true,
      attrIds: scope.default_attr_ids,
      options: []
    }));
    this.assertRepositoryObjectInScope(scope, target);
    this.assertObjectIdInScope(scope, target.id, targetId);
    this.assertAllowedObjectType(scope, target);
    this.assertRootScope(target, scope);
  }

  private async loadAuthorizedHardReferenceObjects(
    profile: TokenProfile,
    scope: SemanticScope,
    ids: string[],
    operations: string[]
  ): Promise<AuthorizedHardReference[]> {
    if (!ids.length) return [];
    const authorized: AuthorizedHardReference[] = [];
    for (const id of ids) this.assertObjectIdInScope(scope, id);
    for (let offset = 0; offset < ids.length; offset += this.config.batchMaxIds) {
      const chunk = ids.slice(offset, offset + this.config.batchMaxIds);
      const objects = await this.getHardReferenceBatch(profile, scope, chunk, operations);
      for (const item of objects) {
        const authorizedCandidate = await this.authorizeHardReferenceCandidate(profile, scope, item, operations);
        if (authorizedCandidate) authorized.push(authorizedCandidate);
      }
    }
    return authorized;
  }

  private async getHardReferenceBatch(
    profile: TokenProfile,
    scope: SemanticScope,
    ids: string[],
    operations: string[]
  ): Promise<AdapterRepositoryObject[]> {
    this.recordSoapOperation(operations, "getRepositoryObjects");
    const root = scope.arcsuite.root_object_id;
    const options = root ? ["getRepositoryObjects.searchMode", `getRepositoryObjects.searchMode.searchRegion=${root}`] : [];
    const batch = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.getMany({
      clientProfileId: profile.clientProfileId,
      ids,
      resolveRef: false,
      attrIds: scope.default_attr_ids,
      options
    }));
    return validateHardReferenceBatch(ids, batch);
  }

  private async authorizeHardReferenceCandidate(
    profile: TokenProfile,
    scope: SemanticScope,
    candidate: AdapterRepositoryObject,
    operations: string[]
  ): Promise<AuthorizedHardReference | undefined> {
    // Relationship records have their own ArcSuite class contract. They are
    // not ordinary document results and must not be filtered by the scope's
    // document object-type allowlist.
    if (!isHardReferenceObject(candidate)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_class", false);
    }
    this.recordSoapOperation(operations, "getRepositoryObject");
    this.recordSoapOperation(operations, "getRepositoryObjectPath");
    let pathObject: AdapterRepositoryObject;
    try {
      pathObject = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
        clientProfileId: profile.clientProfileId,
        id: candidate.id,
        resolveRef: false,
        includePath: true,
        attrIds: [DEFAULT_ATTRS.name],
        options: []
      }));
    } catch (error) {
      if (isInvisibleHardReference(error)) return undefined;
      throw error;
    }

    if (!isRepositoryObject(pathObject) || pathObject.id !== candidate.id) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_path_identity", false);
    }
    if (!isHardReferenceObject(pathObject) || pathObject.objectClass !== candidate.objectClass) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_class", false);
    }
    if (!isPathWithinCabinet(scope, pathObject.pathObjects)) return undefined;
    const root = scope.arcsuite.root_object_id;
    if (root && pathObject.id !== root && !pathObject.pathObjects?.some((part) => part.id === root)) return undefined;

    const combined: AdapterRepositoryObject = {
      ...candidate,
      attributes: { ...candidate.attributes, ...pathObject.attributes },
      pathObjects: pathObject.pathObjects,
      fullPath: pathObject.fullPath
    };
    const normalized = normalizeDocument(combined, scope.semantic_attributes, this.scopes.contentLabelAliases(scope));
    return { id: candidate.id, publicResult: hardReferencePublicResult(normalized) };
  }

  private async proveContentLabelMembership(
    profile: TokenProfile,
    scope: SemanticScope,
    objectId: string,
    revisionNumber: number | undefined,
    expected: PhysicalContentLabel,
    operations: string[]
  ): Promise<{ proof: ContentMembershipProof; present: boolean }> {
    // Resolve the caller-selected identity first.  A historical lookup is
    // always performed against the resulting effective identity, never the
    // mutable reference identity supplied by the caller.
    const resolveRef = scope.arcsuite.resolve_references;
    this.recordSoapOperation(operations, "getRepositoryObject");
    const currentObject = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
      clientProfileId: profile.clientProfileId,
      id: objectId,
      revisionNumber: undefined,
      resolveRef,
      includePath: Boolean(scope.arcsuite.root_object_id),
      attrIds: [
        DEFAULT_ATTRS.name,
        DEFAULT_ATTRS.objectType,
        DEFAULT_ATTRS.revisionNumber,
        DEFAULT_ATTRS.currentRevisionNumber,
        DEFAULT_ATTRS.contentLabelList
      ],
      options: []
    }));
    this.assertRepositoryObjectInScope(scope, currentObject);
    this.assertAllowedObjectType(scope, currentObject);
    this.assertRootScope(currentObject, scope);
    if (!resolveRef && currentObject.id !== objectId) throw new McpToolError("ARCSUITE_FORBIDDEN", "object_identity", false);
    const effectiveId = currentObject.id;
    let object = currentObject;
    if (revisionNumber !== undefined) {
      this.recordSoapOperation(operations, "getRepositoryObjectByRevisionNumber");
      object = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
        clientProfileId: profile.clientProfileId,
        id: effectiveId,
        revisionNumber,
        resolveRef: false,
        includePath: Boolean(scope.arcsuite.root_object_id),
        attrIds: [
          DEFAULT_ATTRS.name,
          DEFAULT_ATTRS.objectType,
          DEFAULT_ATTRS.revisionNumber,
          DEFAULT_ATTRS.currentRevisionNumber,
          DEFAULT_ATTRS.contentLabelList
        ],
        options: []
      }));
      this.assertRepositoryObjectInScope(scope, object);
      this.assertAllowedObjectType(scope, object);
      this.assertRootScope(object, scope);
      if (!revisionMetadataIdentityMatches(effectiveId, object.id, revisionNumber)) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_revision_identity", false);
      }
    }
    const provenRevisionNumber = repositoryObjectRevisionNumber(object);
    if (provenRevisionNumber === undefined) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_revision_missing", false);
    }
    if (revisionNumber !== undefined && provenRevisionNumber !== revisionNumber) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_revision_mismatch", false);
    }
    const wireDocumentId = revisionWireId(effectiveId, provenRevisionNumber);
    const membership = contentLabelMembership(object, expected);
    if (membership === "unproven") {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_label_membership_unproven", false);
    }
    return {
      proof: {
        requestedDocumentId: objectId,
        effectiveDocumentId: effectiveId,
        wireDocumentId,
        cabinetId: scope.arcsuite.cabinet_id,
        rootObjectId: scope.arcsuite.root_object_id,
        provenRevisionNumber,
        requestedRevisionNumber: revisionNumber,
        present: membership === "present"
      },
      present: membership === "present"
    };
  }

  private assertContentResult(
    scope: SemanticScope,
    content: {
      id: string;
      effectiveId: string;
      revisionNumber: number;
      wireId: string;
      label: PhysicalContentLabel;
    },
    requestedId: string,
    proof: ContentMembershipProof,
    expectedLabel: PhysicalContentLabel,
    expectedRevision?: number
  ): void {
    this.assertObjectIdInScope(scope, content.id, requestedId);
    if (typeof content.effectiveId !== "string" || !content.effectiveId) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_effective_identity_missing", false);
    }
    const effectiveId = content.effectiveId;
    this.assertObjectIdInScope(scope, effectiveId);
    if (requestedId !== proof.requestedDocumentId || effectiveId !== proof.effectiveDocumentId) {
      throw new McpToolError("ARCSUITE_FORBIDDEN", "object_identity", false);
    }
    if (typeof content.wireId !== "string" || content.wireId !== proof.wireDocumentId) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_wire_identity", false);
    }
    if (content.revisionNumber !== proof.provenRevisionNumber
      || (expectedRevision !== undefined && content.revisionNumber !== expectedRevision)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_revision_mismatch", false);
    }
    const returnedLabel = content.label;
    if (!returnedLabel || typeof returnedLabel !== "object" || Array.isArray(returnedLabel)
      || typeof returnedLabel.ns !== "string" || typeof returnedLabel.name !== "string"
      || !returnedLabel.ns || !returnedLabel.name
      || !samePhysicalContentLabel(returnedLabel, expectedLabel)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_label_mismatch", false);
    }
  }

  private async loadContent(
    profile: TokenProfile,
    scope: SemanticScope,
    request: AdapterContentRequest,
    proof: ContentMembershipProof,
    expectedLabel: PhysicalContentLabel,
    expectedRevision: number | undefined,
    operations: string[]
  ): Promise<AdapterContentResult> {
    // The Java adapter independently revalidates this revision and uses the
    // supplied wire identity for the actual content SOAP request.
    this.recordSoapOperation(operations, "getRepositoryObjectByRevisionNumber");
    this.recordSoapOperation(operations, "getRepositoryObjectContentWithOptions");
    let content: AdapterContentResult | undefined;
    try {
      content = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.content(request));
      this.assertContentResult(scope, content, request.requestedId, proof, expectedLabel, expectedRevision);
      return content;
    } catch (error) {
      if (content) await this.contentBridge.discard(content).catch(() => undefined);
      throw error;
    }
  }

  private recordSoapOperation(operations: string[], operation: string): void {
    if (!operations.includes(operation)) operations.push(operation);
  }

  private async fetchObjectsByIds(
    profile: TokenProfile,
    scope: SemanticScope,
    ids: string[],
    includePath: boolean,
    operations: string[],
    verificationPlan?: readonly CanonicalSemanticPredicate[],
    verificationPlansById?: ReadonlyMap<string, readonly CanonicalSemanticPredicate[]>
  ): Promise<{ results: NormalizedDocument[]; failures: Array<{ index: number; document_id: string; code: string }> }> {
    if (!ids.length) return { results: [], failures: [] };
    for (const id of ids) this.assertObjectIdInScope(scope, id);
    const root = scope.arcsuite.root_object_id;
    const options = root ? ["getRepositoryObjects.searchMode", `getRepositoryObjects.searchMode.searchRegion=${root}`] : [];
    const attrIds: typeof scope.default_attr_ids = [];
    const attrIdentities = new Map<string, string>();
    const addAttribute = (attr: { ns: string; name: string }): void => {
      const wireKey = attrKey(attr);
      const identity = JSON.stringify([attr.ns, attr.name]);
      const existing = attrIdentities.get(wireKey);
      if (existing !== undefined && existing !== identity) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "ambiguous_attribute_identity", false);
      }
      if (existing !== undefined) return;
      attrIdentities.set(wireKey, identity);
      attrIds.push({ ...attr });
    };
    for (const attr of scope.default_attr_ids) addAttribute(attr);
    const allVerificationPredicates = verificationPlansById
      ? [...verificationPlansById.values()].flatMap((plan) => [...plan])
      : [...(verificationPlan ?? [])];
    for (const predicate of allVerificationPredicates) {
      if (predicate.verification !== "deterministic") continue;
      addAttribute(predicate.condition.attrId);
    }
    this.recordSoapOperation(operations, "getRepositoryObjects");
    const batch = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.getMany({
      clientProfileId: profile.clientProfileId,
      ids,
      // Metadata and its path must describe the selected/requested ID.  Path
      // enrichment is a separate exact-identity proof below.
      resolveRef: false,
      attrIds,
      options
    }));
    if (!batch || !Array.isArray(batch.objects) || !Array.isArray(batch.failures)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_shape", false);
    }
    const requestedIndexById = new Map<string, number>();
    for (const [index, id] of ids.entries()) requestedIndexById.set(id, index);
    if (requestedIndexById.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
    const coveredIndexes = new Set<number>();
    const returnedIds = new Set<string>();
    for (const object of batch.objects) {
      if (!isRepositoryObject(object)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "repository_object_shape", false);
      const index = requestedIndexById.get(object.id);
      if (index === undefined || returnedIds.has(object.id)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
      returnedIds.add(object.id);
      coveredIndexes.add(index);
    }
    for (const failure of batch.failures) {
      if (!failure || typeof failure !== "object" || !Number.isSafeInteger(failure.index) || failure.index < 0 || failure.index >= ids.length) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_failure_index", false);
      }
      if (typeof failure.code !== "string" || !failure.code.trim()) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_failure_code", false);
      }
      if (coveredIndexes.has(failure.index)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_identity", false);
      coveredIndexes.add(failure.index);
    }
    if (coveredIndexes.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_coverage", false);
    const requiresDeterministicVerification = allVerificationPredicates.some((predicate) => predicate.verification === "deterministic");
    if (requiresDeterministicVerification && batch.failures.length) {
      throw new SearchOutcomeError("hydration_failure", "Search hydration returned per-ID failures");
    }
    this.assertRepositoryObjectsInScope(scope, batch.objects);
    this.assertAllowedObjectTypes(scope, batch.objects);
    if (includePath || scope.arcsuite.root_object_id) await this.attachRawPaths(profile, scope, batch.objects, operations);
    for (const object of batch.objects) {
      const objectVerificationPlan = verificationPlansById?.get(object.id) ?? verificationPlan ?? [];
      for (const predicate of objectVerificationPlan) {
        try {
          verifySemanticPredicate(predicate, object.attributes);
        } catch (error) {
          if (error instanceof SemanticVerificationError) {
            throw new SearchOutcomeError(error.reason === "predicate_mismatch" ? "predicate_mismatch" : "metadata_unverifiable");
          }
          if (error instanceof McpToolError) throw error;
          throw new SearchOutcomeError("metadata_unverifiable");
        }
      }
    }
    const normalized = batch.objects.map((item) => this.decorateDocument(scope, normalizeDocument(item, scope.semantic_attributes, this.scopes.contentLabelAliases(scope))));
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
    if (!isRepositoryObject(object)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "repository_object_shape", false);
    this.assertObjectIdInScope(scope, object.id);
    for (const pathObject of object.pathObjects ?? []) {
      if (pathObject.objectClass !== undefined && (!pathObject.nativeObjectClass
        || semanticObjectClass(pathObject.nativeObjectClass) !== pathObject.objectClass)) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "repository_path_class_shape", false);
      }
      this.assertObjectIdInScope(scope, pathObject.id);
    }
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

  private async attachRawPaths(profile: TokenProfile, scope: SemanticScope, objects: AdapterRepositoryObject[], operations: string[]): Promise<void> {
    for (const object of objects) {
      if (object.pathObjects?.length) {
        this.assertRepositoryObjectInScope(scope, object);
        this.assertAllowedObjectType(scope, object);
        this.assertRootScope(object, scope);
        continue;
      }
      const obj = await this.sessions.executeRead(profile.clientProfileId, () => this.adapter.get({
        clientProfileId: profile.clientProfileId,
        id: object.id,
        resolveRef: false,
        includePath: true,
        attrIds: [DEFAULT_ATTRS.name],
        options: []
      }));
      if (!isRepositoryObject(obj) || obj.id !== object.id) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_path_identity", false);
      }
      if (obj.objectClass !== object.objectClass) {
        throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "batch_path_class", false);
      }
      this.assertRepositoryObjectInScope(scope, obj);
      this.assertAllowedObjectType(scope, obj);
      this.assertRootScope(obj, scope);
      object.pathObjects = obj.pathObjects;
      object.fullPath = obj.fullPath;
    }
    if (objects.length && !operations.includes("getRepositoryObjectPath")) operations.push("getRepositoryObjectPath");
  }

  private decorateDocument(scope: SemanticScope, doc: NormalizedDocument): NormalizedDocument {
    const openUrl = this.scopes.documentUrl(scope, doc.document_id);
    if (openUrl) doc.open_url = openUrl;
    return doc;
  }
}

function contentOptions(scope: SemanticScope): string[] {
  // Reference resolution is completed and authorized by the membership
  // proof. Passing resolveRef here would allow the content operation to
  // retarget the caller-selected identity after that proof.
  return ["errorOnOfflineContent"];
}

function repositoryObjectRevisionNumber(object: AdapterRepositoryObject): number | undefined {
  const value = object.attributes["rep:system:revisionnumber"];
  if ((value?.type === "int" || value?.type === "long")
    && Number.isSafeInteger(value.value) && value.value >= MIN_REVISION_NUMBER && value.value <= MAX_REVISION_NUMBER) return value.value;
  return undefined;
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
  assertExactKeys(args, ["scope", "query", "query_mode", "filters", "limit", "include_path", "cursor", "text_search_mode", "response_contract"], "search arguments");
  const scope = stringValue(args.scope, "scope", 1, 100);
  const cursor = optionalString(args.cursor, "cursor", 4096);
  if (cursor) {
    for (const key of ["query", "query_mode", "filters", "limit", "include_path", "text_search_mode", "response_contract"]) if (args[key] !== undefined) throw new TypeError(`${key} cannot be combined with cursor`);
    return { scope, cursor, query: undefined, queryMode: "and" as const, filters: {} as Record<string, SemanticFilterInput>, textSearchMode: "none" as const, limit: config.searchDefaultLimit, includePath: false, responseContract: "legacy" as const };
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
  const responseContract = enumValue(args.response_contract, ["legacy", "opaque_refs_v1"] as const, "legacy");
  return { scope, cursor: undefined, query, queryMode, filters, textSearchMode, limit, includePath: boolValue(args.include_path, false), responseContract };
}

function parseContinueSearchArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["continuation_ref"], "continue search arguments");
  return { continuationRef: stringValue(args.continuation_ref, "continuation_ref", 1, 1024) };
}

function parseReplaySearchArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["search_ref", "target_scope"], "replay search arguments");
  return {
    searchRef: stringValue(args.search_ref, "search_ref", 1, 1024),
    targetScope: stringValue(args.target_scope, "target_scope", 1, 64)
  };
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
    revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER),
    includePath: boolValue(args.include_path, true)
  };
}

function parseGetDocumentByRefArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["result_ref", "revision_number", "include_path"], "get document by ref arguments");
  return {
    resultRef: stringValue(args.result_ref, "result_ref", 1, 1024),
    revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER),
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

function parseGetDocumentsByRefArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["result_refs", "include_path"], "get documents by ref arguments");
  if (!Array.isArray(args.result_refs) || !args.result_refs.length || args.result_refs.length > config.batchMaxIds) {
    throw new TypeError(`result_refs must contain 1..${config.batchMaxIds} items`);
  }
  return {
    resultRefs: args.result_refs.map((value, index) => stringValue(value, `result_refs[${index}]`, 1, 1024)),
    includePath: boolValue(args.include_path, false)
  };
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

function parseHardReferencesArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["document_id", "limit", "cursor"], "Hard Reference arguments");
  const documentId = repId(args.document_id, "document_id");
  const cursor = optionalString(args.cursor, "cursor", 4096);
  if (cursor !== undefined && args.limit !== undefined) throw new TypeError("limit cannot be combined with cursor");
  if (cursor !== undefined && !cursor.length) throw new TypeError("cursor must not be empty");
  const limit = cursor !== undefined || args.limit === undefined
    ? config.searchDefaultLimit
    : intValue(args.limit, "limit", 1, config.searchMaxLimit);
  return { documentId, cursor, limit };
}

function parseIntegrityArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["document_id", "include_evidence"], "document integrity arguments");
  return {
    documentId: repId(args.document_id, "document_id"),
    includeEvidence: boolValue(args.include_evidence, false)
  };
}

function normalizeIntegrityValidation(value: unknown): AdapterIntegrityValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, ["certificates", "failure"]) || !Array.isArray(value.certificates)) {
    throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_validation_shape", false);
  }
  if (value.certificates.length > MAX_INTEGRITY_CERTIFICATES) {
    throw new McpToolError("ARCSUITE_LIMIT_EXCEEDED", "integrity_certificate_limit", false);
  }

  if (value.failure === "per_id") {
    if (value.certificates.length !== 0) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_validation_accounting", false);
    }
    return { certificates: [], failure: "per_id" };
  }
  if (value.failure !== null) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_validation_failure", false);

  const certificates: AdapterIntegrityCertificateResult[] = [];
  const seenCertificateIds = new Set<number>();
  for (const certificate of value.certificates) {
    if (!isRecord(certificate) || !hasExactKeys(certificate, ["certId", "result", "exceptionPresent"]) ||
        !Number.isSafeInteger(certificate.certId) || typeof certificate.result !== "boolean" ||
        typeof certificate.exceptionPresent !== "boolean") {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_certificate_shape", false);
    }
    const certId = certificate.certId as number;
    if (seenCertificateIds.has(certId)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_certificate_duplicate", false);
    }
    seenCertificateIds.add(certId);
    certificates.push({
      certId,
      result: certificate.result,
      exceptionPresent: certificate.exceptionPresent
    });
  }
  return { certificates, failure: null };
}

function normalizeCertificateEvidence(
  value: unknown,
  certificates: AdapterIntegrityCertificateResult[]
): Set<number> {
  if (!isRecord(value) || !hasExactKeys(value, ["certIds"]) || !Array.isArray(value.certIds)) {
    throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_evidence_shape", false);
  }
  if (value.certIds.length > MAX_INTEGRITY_EVIDENCE) {
    throw new McpToolError("ARCSUITE_LIMIT_EXCEEDED", "integrity_evidence_limit", false);
  }
  const validatedIds = new Set(certificates.map((certificate) => certificate.certId));
  const evidenceIds = new Set<number>();
  for (const certId of value.certIds) {
    if (!Number.isSafeInteger(certId) || evidenceIds.has(certId as number) || !validatedIds.has(certId as number)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "integrity_evidence_identity", false);
    }
    evidenceIds.add(certId as number);
  }
  return evidenceIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseRevisionsArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["document_id", "limit"], "revision arguments");
  return { documentId: repId(args.document_id, "document_id"), limit: args.limit === undefined ? config.searchDefaultLimit : intValue(args.limit, "limit", 1, config.searchMaxLimit) };
}

function parseRevisionsByRefArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["result_ref", "limit"], "revision by ref arguments");
  return {
    resultRef: stringValue(args.result_ref, "result_ref", 1, 1024),
    limit: args.limit === undefined ? config.searchDefaultLimit : intValue(args.limit, "limit", 1, config.searchMaxLimit)
  };
}

function parseContentInfoArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["document_id", "revision_number", "content_label"], "content info arguments");
  const contentLabel = optionalString(args.content_label, "content_label", 256);
  return {
    documentId: repId(args.document_id, "document_id"),
    revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER),
    contentLabel
  };
}

function parseContentInfoByRefArgs(args: Record<string, unknown>) {
  assertExactKeys(args, ["result_ref", "revision_number", "content_label"], "content info by ref arguments");
  return {
    resultRef: stringValue(args.result_ref, "result_ref", 1, 1024),
    revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER),
    contentLabel: optionalString(args.content_label, "content_label", 256)
  };
}

function parseReadArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["document_id", "revision_number", "content_label", "start_page", "end_page", "cursor", "max_chars"], "read arguments");
  const contentLabel = optionalString(args.content_label, "content_label", 256);
  const cursor = optionalString(args.cursor, "cursor", 4096);
  const startPage = optionalInt(args.start_page, "start_page", 1, MAX_PAGE_NUMBER);
  const endPage = optionalInt(args.end_page, "end_page", 1, MAX_PAGE_NUMBER);
  if (cursor !== undefined && !cursor.length) throw new TypeError("cursor must not be empty");
  if (cursor !== undefined && startPage !== undefined) throw new TypeError("cursor and start_page cannot both be specified");
  if (cursor !== undefined && endPage !== undefined) throw new TypeError("cursor and end_page cannot both be specified");
  if (endPage !== undefined && startPage === undefined) throw new TypeError("end_page requires start_page");
  if (endPage !== undefined && startPage !== undefined && endPage < startPage) throw new TypeError("end_page must be >= start_page");
  const maxChars = args.max_chars === undefined ? config.readDefaultMaxChars : intValue(args.max_chars, "max_chars", 1000, config.readMaxChars);
  return { documentId: repId(args.document_id, "document_id"), revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER), contentLabel, startPage, endPage, cursor, maxChars };
}

function parseReadByRefArgs(args: Record<string, unknown>, config: AppConfig) {
  assertExactKeys(args, ["result_ref", "revision_number", "content_label", "start_page", "end_page", "cursor", "max_chars"], "read by ref arguments");
  const contentLabel = optionalString(args.content_label, "content_label", 256);
  const cursor = optionalString(args.cursor, "cursor", 4096);
  const startPage = optionalInt(args.start_page, "start_page", 1, MAX_PAGE_NUMBER);
  const endPage = optionalInt(args.end_page, "end_page", 1, MAX_PAGE_NUMBER);
  if (cursor !== undefined && !cursor.length) throw new TypeError("cursor must not be empty");
  if (cursor !== undefined && startPage !== undefined) throw new TypeError("cursor and start_page cannot both be specified");
  if (cursor !== undefined && endPage !== undefined) throw new TypeError("cursor and end_page cannot both be specified");
  if (endPage !== undefined && startPage === undefined) throw new TypeError("end_page requires start_page");
  if (endPage !== undefined && startPage !== undefined && endPage < startPage) throw new TypeError("end_page must be >= start_page");
  return {
    resultRef: stringValue(args.result_ref, "result_ref", 1, 1024),
    revisionNumber: optionalInt(args.revision_number, "revision_number", MIN_REVISION_NUMBER, MAX_REVISION_NUMBER),
    contentLabel,
    startPage,
    endPage,
    cursor,
    maxChars: args.max_chars === undefined ? config.readDefaultMaxChars : intValue(args.max_chars, "max_chars", 1000, config.readMaxChars)
  };
}

function repId(value: unknown, label: string): string {
  const id = stringValue(value, label, 5, 2048);
  if (!id.startsWith("rep:")) throw new TypeError(`${label} must start with rep:`);
  return id;
}

function validateHardReferenceCandidates(value: unknown, maxResults: number): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { ids?: unknown }).ids)) {
    throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_candidate_shape", false);
  }
  const ids = (value as { ids: unknown[] }).ids;
  if (ids.length > maxResults) throw new McpToolError("ARCSUITE_LIMIT_EXCEEDED", "hard_reference_candidate_limit", false);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isRepositoryObjectId(id) || seen.has(id)) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_candidate_identity", false);
    }
    seen.add(id);
  }
  return [...ids] as string[];
}

function validateHardReferenceBatch(ids: string[], batch: AdapterGetManyResult): AdapterRepositoryObject[] {
  if (!batch || !Array.isArray(batch.objects) || !Array.isArray(batch.failures)) {
    throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_shape", false);
  }
  const requestedIndexes = new Map(ids.map((id, index) => [id, index]));
  if (requestedIndexes.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_request", false);
  const objects = new Map<string, AdapterRepositoryObject>();
  const covered = new Set<number>();
  for (const object of batch.objects) {
    if (!isRepositoryObject(object)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_object", false);
    const index = requestedIndexes.get(object.id);
    if (index === undefined || covered.has(index)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_identity", false);
    objects.set(object.id, object);
    covered.add(index);
  }
  for (const failure of batch.failures) {
    if (!failure || !Number.isSafeInteger(failure.index) || failure.index < 0 || failure.index >= ids.length || typeof failure.code !== "string" || !failure.code) {
      throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_failure", false);
    }
    if (covered.has(failure.index)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_identity", false);
    covered.add(failure.index);
    if (failure.code !== "ARCSUITE_NOT_AVAILABLE" && failure.code !== "ARCSUITE_FORBIDDEN") {
      const stableCodes = new Set([
        "ARCSUITE_INVALID_ARGUMENT", "ARCSUITE_SESSION_EXPIRED", "ARCSUITE_LIMIT_EXCEEDED",
        "ARCSUITE_CONFLICT", "ARCSUITE_TIMEOUT", "ARCSUITE_UPSTREAM_ERROR"
      ]);
      const code = stableCodes.has(failure.code) ? failure.code : "ARCSUITE_UPSTREAM_ERROR";
      throw new McpToolError(code, "hard_reference_hydration_failed", false);
    }
  }
  if (covered.size !== ids.length) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_batch_coverage", false);
  return ids.flatMap((id) => {
    const object = objects.get(id);
    return object ? [object] : [];
  });
}

function isRepositoryObject(value: unknown): value is AdapterRepositoryObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Partial<AdapterRepositoryObject>;
  if (!isRepositoryObjectId(object.id) || typeof object.objectClass !== "string" || !object.objectClass
    || !object.nativeObjectClass || typeof object.nativeObjectClass !== "object" || Array.isArray(object.nativeObjectClass)
    || semanticObjectClass(object.nativeObjectClass) !== object.objectClass
    || !object.attributes || typeof object.attributes !== "object" || Array.isArray(object.attributes)) return false;
  if (object.pathObjects !== undefined) {
    if (!Array.isArray(object.pathObjects)) return false;
    for (const part of object.pathObjects) {
      if (!part || !isRepositoryObjectId(part.id)) return false;
      if (part.objectClass !== undefined && (!part.nativeObjectClass
        || semanticObjectClass(part.nativeObjectClass) !== part.objectClass)) return false;
    }
  }
  return true;
}

function isHardReferenceObject(object: AdapterRepositoryObject): boolean {
  return object.objectClass === "hardReference"
    && semanticObjectClass(object.nativeObjectClass) === "hardReference";
}

function semanticObjectClass(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const native = value as Partial<{ ns: unknown; name: unknown }>;
  if (native.ns !== ARCSUITE_OBJECT_CLASS_NS || typeof native.name !== "string" || !native.name) return undefined;
  return ARCSUITE_SEMANTIC_OBJECT_CLASSES[`${native.ns}:${native.name}`] ?? "unknown";
}

function revisionWireId(baseId: string, revisionNumber: number): string {
  if (!isRepositoryObjectId(baseId)
    || !Number.isSafeInteger(revisionNumber)
    || revisionNumber < MIN_REVISION_NUMBER
    || revisionNumber > MAX_REVISION_NUMBER) {
    throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "content_revision_identity", false);
  }
  return `${baseId}:${revisionNumber}`;
}

function revisionMetadataIdentityMatches(baseId: string, returnedId: string, revisionNumber: number): boolean {
  if (!isRepositoryObjectId(returnedId)) return false;
  // ArcSuite deployments may echo the base RepositoryObject.id from the
  // metadata call.  That form is accepted only with the separately proven
  // revision attribute; content itself always uses the qualified A:N wire ID.
  return returnedId === baseId || returnedId === revisionWireId(baseId, revisionNumber);
}

function isRepositoryObjectId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 2048 && /^rep:[^\s\u0000-\u001f\u007f]+$/.test(value);
}

function isObjectIdWithinCabinet(scope: SemanticScope, id: string): boolean {
  return id === scope.arcsuite.cabinet_id || id.startsWith(`${scope.arcsuite.cabinet_id}:`);
}

function isPathWithinCabinet(scope: SemanticScope, pathObjects: AdapterRepositoryObject["pathObjects"]): boolean {
  if (pathObjects === undefined) return true;
  if (!Array.isArray(pathObjects)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_path_shape", false);
  for (const part of pathObjects) {
    if (!part || !isRepositoryObjectId(part.id)) throw new McpToolError("ARCSUITE_UPSTREAM_ERROR", "hard_reference_path_identity", false);
    if (!isObjectIdWithinCabinet(scope, part.id)) return false;
  }
  return true;
}

function isInvisibleHardReference(error: unknown): boolean {
  return error instanceof ArcSuiteAdapterError && (error.code === "ARCSUITE_NOT_AVAILABLE" || error.code === "ARCSUITE_FORBIDDEN");
}

function hardReferencePublicResult(document: NormalizedDocument): Record<string, unknown> {
  const result: Record<string, unknown> = {
    relationship: "hard_reference_incoming",
    // Preserve the established public semantic value. The internal document
    // remains hardReference and its native class is never exposed.
    object_class: "reference"
  };
  if (document.name !== undefined) result.name = document.name;
  if (document.path !== undefined) result.path = [...document.path];
  if (document.modified_at !== undefined) result.modified_at = document.modified_at;
  if (document.status !== undefined) result.status = document.status;
  const semanticAttributes = Object.fromEntries(Object.entries(document.semantic_attributes ?? {}).filter(([, value]) => value !== null));
  if (Object.keys(semanticAttributes).length) result.semantic_attributes = semanticAttributes;
  return result;
}

function tokenizeQuery(query: string): string[] {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= 10) return words;
  throw new TypeError("query contains more than 10 terms");
}

function withoutDocumentIdentity<T extends object>(value: T): Omit<T, "document_id"> {
  const { document_id: _documentId, ...rest } = value as T & { document_id?: unknown };
  return rest;
}

function refUnavailable(): McpToolError {
  return new McpToolError("ARCSUITE_REF_UNAVAILABLE", "ref_unavailable", false, "ARCSUITE_REF_UNAVAILABLE", "search_again");
}

function shortSummary(name: string, data: Record<string, unknown>): string {
  if (name === "arcsuite_read_document" || name === "arcsuite_read_document_by_ref") {
    const content = String(data.content ?? "");
    return `ArcSuite document content (${String(data.file_name ?? "unknown")}; truncated=${String(data.truncated ?? false)})\n\n${content}`;
  }
  return `ArcSuite MCP ${name} result:\n${JSON.stringify(data)}`;
}

function readDocumentJsonSchema(
  documentId: Record<string, unknown>,
  contentLabel: Record<string, unknown>,
  config: AppConfig
): Record<string, unknown> {
  const common = {
    document_id: documentId,
    revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER },
    content_label: contentLabel,
    max_chars: { type: "integer", minimum: 1000, maximum: config.readMaxChars, default: config.readDefaultMaxChars }
  };
  const page = { type: "integer", minimum: 1, maximum: MAX_PAGE_NUMBER };
  const cursor = { type: "string", minLength: 1, maxLength: 4096 };
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...common, start_page: page, end_page: page, cursor },
    anyOf: [
      { required: ["document_id"], properties: common, not: { anyOf: [{ required: ["start_page"] }, { required: ["end_page"] }, { required: ["cursor"] }] } },
      { required: ["document_id", "start_page"], properties: { ...common, start_page: page }, not: { anyOf: [{ required: ["end_page"] }, { required: ["cursor"] }] } },
      { required: ["document_id", "start_page", "end_page"], properties: { ...common, start_page: page, end_page: page }, not: { required: ["cursor"] } },
      { required: ["document_id", "cursor"], properties: { ...common, cursor }, not: { anyOf: [{ required: ["start_page"] }, { required: ["end_page"] }] } }
    ]
  };
}

function readDocumentByRefJsonSchema(
  resultRef: Record<string, unknown>,
  contentLabel: Record<string, unknown>,
  config: AppConfig
): Record<string, unknown> {
  const common = {
    result_ref: resultRef,
    revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER },
    content_label: contentLabel,
    max_chars: { type: "integer", minimum: 1000, maximum: config.readMaxChars, default: config.readDefaultMaxChars }
  };
  const page = { type: "integer", minimum: 1, maximum: MAX_PAGE_NUMBER };
  const cursor = { type: "string", minLength: 1, maxLength: 4096 };
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...common, start_page: page, end_page: page, cursor },
    anyOf: [
      { required: ["result_ref"], properties: common, not: { anyOf: [{ required: ["start_page"] }, { required: ["end_page"] }, { required: ["cursor"] }] } },
      { required: ["result_ref", "start_page"], properties: { ...common, start_page: page }, not: { anyOf: [{ required: ["end_page"] }, { required: ["cursor"] }] } },
      { required: ["result_ref", "start_page", "end_page"], properties: { ...common, start_page: page, end_page: page }, not: { required: ["cursor"] } },
      { required: ["result_ref", "cursor"], properties: { ...common, cursor }, not: { anyOf: [{ required: ["start_page"] }, { required: ["end_page"] }] } }
    ]
  };
}

function buildDefinitions(profile: TokenProfile, scopes: ScopeRegistry, config: AppConfig): ToolDefinition[] {
  const descriptions = scopes.describe(profile.allowedScopes);
  const scopeValues = descriptions.map((item) => item.id);
  const scopeSummary = descriptions.map((item) => `${item.id} [${item.filters.map((filter) => `${filter.name}:${filter.type}(${filter.operators.join(",")})`).join(", ") || "no semantic filters"}; text=${item.full_text_modes.join(",")}]`).join("; ");
  const scope = { type: "string", enum: scopeValues };
  const documentId = { type: "string", pattern: "^rep:", minLength: 5, maxLength: 2048 };
  const opaqueRef = { type: "string", minLength: 1, maxLength: 1024 };
  const limit = { type: "integer", minimum: 1, maximum: config.searchMaxLimit, default: config.searchDefaultLimit };
  const contentLabelValues = [...new Set(descriptions.flatMap((item) => item.content_labels))];
  const contentLabel = {
    type: "string",
    enum: contentLabelValues.length ? contentLabelValues : [CONTENT_LABEL_PRIMARY_ALIAS],
    default: CONTENT_LABEL_PRIMARY_ALIAS
  };
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
      inputSchema: { type: "object", additionalProperties: false, required: ["scope"], properties: { scope, query: { type: "string", minLength: 1, maxLength: 200 }, query_mode: { type: "string", enum: ["and", "or"], default: "and" }, filters: { type: "object", additionalProperties: filterValue }, limit, include_path: { type: "boolean", default: false }, cursor: { type: "string", maxLength: 4096 }, text_search_mode: { type: "string", enum: ["none", "stemming", "thesaurus"], default: "none" }, response_contract: { type: "string", enum: ["legacy", "opaque_refs_v1"], default: "legacy" } }, allOf: [{ if: { required: ["cursor"] }, then: { not: { required: ["response_contract"] } } }] }
    },
    {
      name: "arcsuite_get_document",
      description: "Get semantic metadata for a document in an allowed scope. Use arcsuite_read_document for bounded text content.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER }, include_path: { type: "boolean", default: true } } }
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
      description: "Inspect configured semantic content-label metadata and extraction support. A short-lived private extracted-content snapshot may be warmed for a subsequent read; binary content is never returned.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER }, content_label: contentLabel } }
    },
    {
      name: "arcsuite_read_document",
      description: "Read a configured semantic content label through the ArcSuite adapter, reuse a private bounded snapshot when available, and return bounded text with a signed cursor. Binary/base64 content is never returned.",
      inputSchema: readDocumentJsonSchema(documentId, contentLabel, config)
    },
    {
      name: "arcsuite_list_hard_references",
      description: "List one page of incoming Hard Reference relationships for a target document in its authorized semantic scope. Continue with document_id and cursor; physical relationship object IDs are not returned.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, limit, cursor: { type: "string", maxLength: 4096 } } }
    },
    {
      name: "arcsuite_validate_document_integrity",
      description: "Read ArcSuite's validation result for one authorized document and optionally report already-calculated evidence availability. Valid means only that the reported validation elements succeeded; false or missing results are reported as invalid or unverifiable.",
      inputSchema: { type: "object", additionalProperties: false, required: ["document_id"], properties: { document_id: documentId, include_evidence: { type: "boolean", default: false } } }
    },
    {
      name: "arcsuite_continue_search",
      description: "Continue a previously verified search using only continuation_ref. Current authentication, tool permission, scope permission, and result verification are rechecked.",
      inputSchema: { type: "object", additionalProperties: false, required: ["continuation_ref"], properties: { continuation_ref: opaqueRef } }
    },
    {
      name: "arcsuite_replay_search",
      description: "Apply the exact verified semantic search represented by search_ref to an explicitly selected authorized target scope.",
      inputSchema: { type: "object", additionalProperties: false, required: ["search_ref", "target_scope"], properties: { search_ref: opaqueRef, target_scope: scope } }
    },
    {
      name: "arcsuite_get_document_by_ref",
      description: "Get semantic metadata for a previously verified result using result_ref; do not provide or reconstruct document_id.",
      inputSchema: { type: "object", additionalProperties: false, required: ["result_ref"], properties: { result_ref: opaqueRef, revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER }, include_path: { type: "boolean", default: true } } }
    },
    {
      name: "arcsuite_get_documents_by_ref",
      description: `Get semantic metadata for a bounded same-scope batch of previously verified result refs. Maximum batch size: ${config.batchMaxIds}.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["result_refs"], properties: { result_refs: { type: "array", minItems: 1, maxItems: config.batchMaxIds, items: opaqueRef }, include_path: { type: "boolean", default: false } } }
    },
    {
      name: "arcsuite_list_document_revisions_by_ref",
      description: "List current provider revision metadata for a previously verified result using result_ref.",
      inputSchema: { type: "object", additionalProperties: false, required: ["result_ref"], properties: { result_ref: opaqueRef, limit } }
    },
    {
      name: "arcsuite_get_document_content_info_by_ref",
      description: "Inspect semantic content metadata for a previously verified result using result_ref after fresh authorization and identity verification.",
      inputSchema: { type: "object", additionalProperties: false, required: ["result_ref"], properties: { result_ref: opaqueRef, revision_number: { type: "integer", minimum: MIN_REVISION_NUMBER, maximum: MAX_REVISION_NUMBER }, content_label: contentLabel } }
    },
    {
      name: "arcsuite_read_document_by_ref",
      description: "Read bounded text for a previously verified result using result_ref; do not provide or reconstruct document_id.",
      inputSchema: readDocumentByRefJsonSchema(opaqueRef, contentLabel, config)
    }
  ];
}
