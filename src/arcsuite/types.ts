export type AttributeId = { ns: string; name: string };

export type PhysicalContentLabel = { ns: string; name: string };

export type AttributeValue =
  | { type: "string"; value: string }
  | { type: "int"; value: number }
  | { type: "long"; value: number }
  | { type: "double"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: string }
  | { type: "datetime"; value: string }
  | { type: "i18n"; ns: string; name: string; label?: string }
  | { type: "i18n[]"; values: Array<{ ns: string; name: string; label?: string }> }
  | { type: "rmsObject"; dn?: string; label?: string }
  | { type: "id"; value: string }
  | { type: "unknown"; rawType: string; value?: string };

export type AdapterRepositoryObject = {
  id: string;
  objectClass: string;
  attributes: Record<string, AttributeValue>;
  pathObjects?: Array<{ id: string; name?: string; objectClass?: string }>;
  fullPath?: boolean;
};

export type AdapterSearchCondition = {
  attrId: AttributeId;
  operator: "EQUAL" | "LIKE" | "GREATER_EQUAL" | "LESS_EQUAL";
  value:
    | { type: "string"; value: string }
    | { type: "int"; value: number }
    | { type: "long"; value: number }
    | { type: "double"; value: number }
    | { type: "boolean"; value: boolean }
    | { type: "date"; value: string }
    | { type: "datetime"; value: string }
    | { type: "i18n"; ns: string; name: string };
};

export type AdapterSearchRequest = {
  clientProfileId: string;
  attributeConditions: AdapterSearchCondition[];
  text?: { words: string[]; operator: "AND" | "OR" };
  mode: "AND" | "OR";
  searchRegionIds: string[];
  depth: number;
  textSearchMode: "NONE" | "STEMMING" | "THESAURUS";
  order: Array<{ attrId: AttributeId; descending: boolean }>;
  limit: number;
  attrIds: AttributeId[];
  options: string[];
};

export type AdapterSearchIdsRequest = Omit<AdapterSearchRequest, "attrIds">;

export type AdapterListRequest = {
  clientProfileId: string;
  locationId: string;
  latestOnly: boolean;
  order: Array<{ attrId: AttributeId; descending: boolean }>;
  limit: number;
  attrIds: AttributeId[];
  options: string[];
};

export type AdapterListIdsRequest = Omit<AdapterListRequest, "attrIds">;

export type AdapterGetRequest = {
  clientProfileId: string;
  id: string;
  revisionNumber?: number;
  resolveRef: boolean;
  includePath: boolean;
  attrIds: AttributeId[];
  options: string[];
};

export type AdapterBatchFailure = {
  index: number;
  code: string;
  upstreamCode?: string;
};

export type AdapterGetManyRequest = {
  clientProfileId: string;
  ids: string[];
  resolveRef: boolean;
  attrIds: AttributeId[];
  options: string[];
};

export type AdapterGetManyResult = {
  objects: AdapterRepositoryObject[];
  failures: AdapterBatchFailure[];
};

export type AdapterHardReferencesRequest = {
  clientProfileId: string;
  id: string;
  maxResults: number;
};

/** Private Hard Reference object IDs; never return this shape through MCP. */
export type AdapterHardReferencesResult = { ids: string[] };

export type AdapterRevisionsRequest = {
  clientProfileId: string;
  id: string;
  attrIds: AttributeId[];
  options: string[];
};

export type AdapterContentRequest = {
  clientProfileId: string;
  id: string;
  revisionNumber?: number;
  contentLabel: PhysicalContentLabel;
  options: string[];
  traceId: string;
};

export type AdapterContentResult = {
  id: string;
  revisionNumber?: number;
  /** Exact physical label returned by ArcSuite; never exposed directly by MCP. */
  label: PhysicalContentLabel;
  /** Effective object identity after adapter-side reference/revision resolution. */
  effectiveId?: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  filePath: string;
};

export type AttributeSchemaInfo = {
  ns: string;
  name: string;
  dataType?: string;
  nativeDataType?: string;
  multiValued?: boolean;
  required?: boolean;
  enumerated?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  modifiable?: boolean;
  minLength?: number;
  maxLength?: number;
  minCount?: number;
  maxCount?: number;
  minIntegralValue?: number | string;
  maxIntegralValue?: number | string;
  minFloatingValue?: number;
  maxFloatingValue?: number;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  pattern?: string;
  enumLabels?: Array<{ ns?: string; name: string; label?: string }>;
};

export type AdapterSchemaValidationRequest = {
  clientProfileId: string;
  cabinetId: string;
  attributes: Array<{
    attrId: AttributeId;
    requireSearchable?: boolean;
    requireSortable?: boolean;
  }>;
};

export type AdapterSchemaValidationResult = {
  ok: boolean;
  version: { minVersion?: string; curVersion?: string };
  cabinet: { id?: string; label?: string; hasRecycleBin?: boolean };
  attributes: AttributeSchemaInfo[];
  errors: string[];
};

export type NormalizedDocument = {
  document_id: string;
  object_class: string;
  name?: string;
  path?: string[];
  revision_number?: number;
  current_revision_number?: number;
  modified_at?: string;
  status?: string;
  content_labels: string[];
  content_available: boolean;
  semantic_attributes?: Record<string, string | number | boolean | null>;
  open_url?: string;
};
