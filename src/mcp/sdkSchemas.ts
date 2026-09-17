import { z } from "zod";
import { MAX_PAGE_NUMBER, MAX_REVISION_NUMBER, MIN_REVISION_NUMBER } from "../arcsuite/constants.ts";

const documentId = z.string().min(5).max(2048).regex(/^rep:/);
const scope = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
export const TOOL_SCHEMA_HARD_LIMITS = Object.freeze({
  searchMaxLimit: 50,
  batchMaxIds: 100,
  readMaxChars: 50_000
});
export type ToolSchemaLimits = Readonly<{
  searchMaxLimit: number;
  batchMaxIds: number;
  readMaxChars: number;
}>;
// Keep this profile schema generic so malformed or scope-disallowed aliases
// reach the tool registry's stable runtime error path. Physical `{ns,name}`
// objects remain rejected here, while alias grammar and scope authorization
// are enforced by the semantic registry.
const contentLabel = z.string().min(1).max(256).optional();
const pagingCursor = z.string().min(1).max(4096).optional();
const opaqueRef = z.string().min(1).max(1024);
const semanticFilterOperator = z.enum(["eq", "like", "gte", "lte"]);
const semanticFilterScalar = z.union([z.string().min(1).max(255), z.number().finite(), z.boolean()]);
const semanticFilterValue = z.union([
  semanticFilterScalar,
  z.object({ operator: semanticFilterOperator, value: semanticFilterScalar }).strict()
]);

// Keep root schemas as objects so MCP clients can discover their parameters.
// Zod refinements remain the runtime authority; metadata mirrors the
// cross-field rules that JSON Schema can express without a root union.
const readPagingJsonSchema = {
  allOf: [
    {
      if: { required: ["cursor"] },
      then: { not: { anyOf: [{ required: ["start_page"] }, { required: ["end_page"] }] } }
    },
    {
      if: { required: ["end_page"] },
      then: { required: ["start_page"] }
    }
  ]
};

const hardReferencePagingJsonSchema = {
  allOf: [{
    if: { required: ["cursor"] },
    then: { not: { required: ["limit"] } }
  }]
};

function readPagingIssue(value: { start_page?: number; end_page?: number; cursor?: string }): string | undefined {
  if (value.cursor !== undefined && value.start_page !== undefined) return "cursor and start_page cannot both be specified";
  if (value.cursor !== undefined && value.end_page !== undefined) return "cursor and end_page cannot both be specified";
  if (value.end_page !== undefined && value.start_page === undefined) return "end_page requires start_page";
  if (value.end_page !== undefined && value.start_page !== undefined && value.end_page < value.start_page) {
    return "end_page must be >= start_page";
  }
  return undefined;
}

function createToolInputSchemas(limits: ToolSchemaLimits) {
  const limit = z.number().int().min(1).max(limits.searchMaxLimit).optional();
  const revisionNumber = z.number().int().min(MIN_REVISION_NUMBER).max(MAX_REVISION_NUMBER).optional();
  const pageNumber = z.number().int().min(1).max(MAX_PAGE_NUMBER).optional();
  const maxChars = z.number().int().min(1000).max(limits.readMaxChars).optional();
  const search = z.object({
    scope,
    query: z.string().min(1).max(200).optional(),
    query_mode: z.enum(["and", "or"]).optional(),
    filters: z.record(z.string(), semanticFilterValue).optional(),
    limit,
    include_path: z.boolean().optional(),
    cursor: pagingCursor,
    text_search_mode: z.enum(["none", "stemming", "thesaurus"]).optional(),
    response_contract: z.enum(["legacy", "opaque_refs_v1"])
      .optional()
      .describe("Initial searches only. Omit for the exact legacy response; cannot be combined with cursor.")
  }).strict().refine((value) => value.cursor === undefined || value.response_contract === undefined, {
    message: "response_contract cannot be combined with cursor"
  });
  const refReadCommon = {
    result_ref: opaqueRef,
    revision_number: revisionNumber,
    content_label: contentLabel,
    max_chars: maxChars
  };
  return {
    arcsuite_describe_capabilities: z.object({}).strict(),
    arcsuite_validate_document_integrity: z.object({
      document_id: documentId,
      include_evidence: z.boolean().default(false)
    }).strict(),
    arcsuite_search_documents: search,
    arcsuite_continue_search: z.object({ continuation_ref: opaqueRef }).strict(),
    arcsuite_replay_search: z.object({ search_ref: opaqueRef, target_scope: scope }).strict(),
    arcsuite_get_document: z.object({
      document_id: documentId,
      revision_number: revisionNumber,
      include_path: z.boolean().optional()
    }).strict(),
    arcsuite_get_documents: z.object({
      scope,
      document_ids: z.array(documentId).min(1).max(limits.batchMaxIds),
      include_path: z.boolean().optional()
    }).strict(),
    arcsuite_get_document_by_ref: z.object({
      result_ref: opaqueRef,
      revision_number: revisionNumber,
      include_path: z.boolean().optional()
    }).strict(),
    arcsuite_get_documents_by_ref: z.object({
      result_refs: z.array(opaqueRef).min(1).max(limits.batchMaxIds),
      include_path: z.boolean().optional()
    }).strict(),
    arcsuite_list_folder: z.object({
      scope,
      folder_id: documentId.optional(),
      limit,
      include_path: z.boolean().optional(),
      cursor: pagingCursor
    }).strict(),
    arcsuite_list_hard_references: z.object({
      document_id: documentId,
      limit,
      cursor: pagingCursor
    }).strict().superRefine((value, context) => {
      if (value.limit !== undefined && value.cursor !== undefined) {
        context.addIssue({ code: "custom", message: "limit cannot be combined with cursor" });
      }
    }).meta(hardReferencePagingJsonSchema),
    arcsuite_list_document_revisions: z.object({ document_id: documentId, limit }).strict(),
    arcsuite_list_document_revisions_by_ref: z.object({ result_ref: opaqueRef, limit }).strict(),
    arcsuite_get_document_content_info: z.object({
      document_id: documentId,
      revision_number: revisionNumber,
      content_label: contentLabel
    }).strict(),
    arcsuite_get_document_content_info_by_ref: z.object({
      result_ref: opaqueRef,
      revision_number: revisionNumber,
      content_label: contentLabel
    }).strict(),
    arcsuite_read_document: z.object({
      document_id: documentId,
      revision_number: revisionNumber,
      content_label: contentLabel,
      start_page: pageNumber,
      end_page: pageNumber,
      cursor: pagingCursor,
      max_chars: maxChars
    }).strict().superRefine((value, context) => {
      const issue = readPagingIssue(value);
      if (issue) context.addIssue({ code: "custom", message: issue });
    }).meta(readPagingJsonSchema),
    arcsuite_read_document_by_ref: z.object({
      ...refReadCommon,
      start_page: pageNumber,
      end_page: pageNumber,
      cursor: pagingCursor
    }).strict().superRefine((value, context) => {
      const issue = readPagingIssue(value);
      if (issue) context.addIssue({ code: "custom", message: issue });
    }).meta(readPagingJsonSchema)
  } as const;
}

function assertToolSchemaLimits(limits: ToolSchemaLimits): void {
  if (!Number.isSafeInteger(limits.searchMaxLimit) || limits.searchMaxLimit < 1 || limits.searchMaxLimit > TOOL_SCHEMA_HARD_LIMITS.searchMaxLimit
    || !Number.isSafeInteger(limits.batchMaxIds) || limits.batchMaxIds < 1 || limits.batchMaxIds > TOOL_SCHEMA_HARD_LIMITS.batchMaxIds
    || !Number.isSafeInteger(limits.readMaxChars) || limits.readMaxChars < 1000 || limits.readMaxChars > TOOL_SCHEMA_HARD_LIMITS.readMaxChars) {
    throw new Error("Effective MCP tool schema limits exceed the configured hard bounds");
  }
}

const hardLimitSchemas = createToolInputSchemas(TOOL_SCHEMA_HARD_LIMITS);

// Keep this generic hard-bound schema for tool-name validation and direct schema tests.
// The actual HTTP registration uses schemas built from the loaded AppConfig.
export const toolInputSchemas = hardLimitSchemas;

/*
 * The public schema limits are dynamic because loadConfig can lower them per
 * deployment. Keep the hard ceilings above this builder so a caller cannot
 * advertise or accept a larger bound than config permits.
 */
const schemaCache = new WeakMap<object, ReturnType<typeof createToolInputSchemas>>();

function schemasForLimits(limits: ToolSchemaLimits): ReturnType<typeof createToolInputSchemas> {
  assertToolSchemaLimits(limits);
  const cached = schemaCache.get(limits as object);
  if (cached) return cached;
  const schemas = createToolInputSchemas(limits);
  schemaCache.set(limits as object, schemas);
  return schemas;
}

export type ToolInputName = keyof typeof toolInputSchemas;

export function toolInputSchemaForProfile(name: ToolInputName, allowedScopes: string[], limits: ToolSchemaLimits = TOOL_SCHEMA_HARD_LIMITS) {
  const schema = schemasForLimits(limits)[name];
  if (name === "arcsuite_replay_search") {
    if (!allowedScopes.length) return (schema as any).safeExtend({ target_scope: z.never() });
    return (schema as any).safeExtend({ target_scope: z.enum(allowedScopes as [string, ...string[]]) });
  }
  if (!isScopeTool(name)) return schema;
  if (!allowedScopes.length) return (schema as any).safeExtend({ scope: z.never() });
  const scopeEnum = z.enum(allowedScopes as [string, ...string[]]);
  return (schema as any).safeExtend({ scope: scopeEnum });
}

function isScopeTool(name: ToolInputName): name is "arcsuite_search_documents" | "arcsuite_get_documents" | "arcsuite_list_folder" {
  return name === "arcsuite_search_documents" || name === "arcsuite_get_documents" || name === "arcsuite_list_folder";
}
