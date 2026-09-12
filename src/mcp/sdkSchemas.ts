import { z } from "zod";

const documentId = z.string().min(5).max(2048).regex(/^rep:/);
const scope = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const limit = z.number().int().min(1).max(50).optional();
const contentLabel = z.literal("system:primary").optional();
const pagingCursor = z.string().min(1).max(4096).optional();

export const toolInputSchemas = {
  arcsuite_describe_capabilities: z.object({}).strict(),
  arcsuite_search_documents: z.object({
    scope,
    query: z.string().min(1).max(200).optional(),
    query_mode: z.enum(["and", "or"]).optional(),
    filters: z.record(z.string(), z.string().min(1).max(255)).optional(),
    limit,
    include_path: z.boolean().optional(),
    cursor: pagingCursor
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
