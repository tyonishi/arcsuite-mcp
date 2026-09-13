import { z } from "zod";

const documentId = z.string().min(5).max(2048).regex(/^rep:/);
const scope = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const limit = z.number().int().min(1).max(50).optional();
// Keep this profile schema generic so malformed or scope-disallowed aliases
// reach the tool registry's stable runtime error path. Physical `{ns,name}`
// objects remain rejected here, while alias grammar and scope authorization
// are enforced by the semantic registry.
const contentLabel = z.string().min(1).max(256).optional();
const pagingCursor = z.string().min(1).max(4096).optional();
const semanticFilterOperator = z.enum(["eq", "like", "gte", "lte"]);
const semanticFilterScalar = z.union([z.string().min(1).max(255), z.number().finite(), z.boolean()]);
const semanticFilterValue = z.union([
  semanticFilterScalar,
  z.object({ operator: semanticFilterOperator, value: semanticFilterScalar }).strict()
]);

export const toolInputSchemas = {
  arcsuite_describe_capabilities: z.object({}).strict(),
  arcsuite_search_documents: z.object({
    scope,
    query: z.string().min(1).max(200).optional(),
    query_mode: z.enum(["and", "or"]).optional(),
    filters: z.record(z.string(), semanticFilterValue).optional(),
    limit,
    include_path: z.boolean().optional(),
    cursor: pagingCursor,
    text_search_mode: z.enum(["none", "stemming", "thesaurus"]).optional()
  }).strict(),
  arcsuite_get_document: z.object({
    document_id: documentId,
    revision_number: z.number().int().min(1).optional(),
    include_path: z.boolean().optional()
  }).strict(),
  arcsuite_get_documents: z.object({
    scope,
    document_ids: z.array(documentId).min(1).max(100),
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
    if (value.cursor !== undefined && value.limit !== undefined) {
      context.addIssue({ code: "custom", message: "limit cannot be combined with cursor", path: ["limit"] });
    }
  }),
  arcsuite_list_document_revisions: z.object({ document_id: documentId, limit }).strict(),
  arcsuite_get_document_content_info: z.object({
    document_id: documentId,
    revision_number: z.number().int().min(1).optional(),
    content_label: contentLabel
  }).strict(),
  arcsuite_read_document: z.object({
    document_id: documentId,
    revision_number: z.number().int().min(1).optional(),
    content_label: contentLabel,
    start_page: z.number().int().min(1).optional(),
    end_page: z.number().int().min(1).optional(),
    cursor: z.string().max(4096).optional(),
    max_chars: z.number().int().min(1000).max(50000).optional()
  }).strict()
} as const;

export type ToolInputName = keyof typeof toolInputSchemas;

export function toolInputSchemaForProfile(name: ToolInputName, allowedScopes: string[]) {
  const schema = toolInputSchemas[name];
  if (!isScopeTool(name)) return schema;
  if (!allowedScopes.length) return (schema as any).extend({ scope: z.never() });
  const scopeEnum = z.enum(allowedScopes as [string, ...string[]]);
  return (schema as any).extend({ scope: scopeEnum });
}

function isScopeTool(name: ToolInputName): name is "arcsuite_search_documents" | "arcsuite_get_documents" | "arcsuite_list_folder" {
  return name === "arcsuite_search_documents" || name === "arcsuite_get_documents" || name === "arcsuite_list_folder";
}
