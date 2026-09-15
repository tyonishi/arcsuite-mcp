import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AttributeId, AdapterSchemaValidationRequest, AttributeSchemaInfo, PhysicalContentLabel } from "../arcsuite/types.ts";
import type { ArcSuiteAdapterClient } from "../arcsuite/soapAdapterClient.ts";
import { DEFAULT_ATTRS } from "../arcsuite/constants.ts";
import {
  contentLabelAliasesForScope,
  contentLabelsForScope,
  validateContentLabelConfiguration,
  type ContentLabelConfiguration
} from "./contentLabels.ts";

export type SemanticType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "enum";
export type SemanticOperator = "eq" | "like" | "gte" | "lte";
export type FullTextSearchMode = "none" | "stemming" | "thesaurus";
export type SemanticEnumValueConfig =
  | { ns: string; name: string; value?: never }
  | { value: string; ns?: never; name?: never };

export type SemanticAttributeConfig = {
  attr_id: AttributeId;
  type: SemanticType;
  operators: SemanticOperator[];
  allow_wildcards?: boolean;
  max_length?: number;
  values?: Record<string, SemanticEnumValueConfig>;
};

export type SemanticScope = {
  description: string;
  enabled: boolean;
  arcsuite: {
    service_dn?: string;
    cabinet_alias: string;
    cabinet_id: string;
    root_object_id: string | null;
    resolve_references: boolean;
  };
  content_labels?: ContentLabelConfiguration;
  relationships?: {
    hard_references?: boolean;
  };
  integrity?: {
    enabled?: boolean;
    allow_evidence?: boolean;
  };
  search?: {
    full_text_modes?: FullTextSearchMode[];
  };
  ui?: {
    allow_http?: boolean;
    document_url_template?: string;
  };
  allowed_object_types: string[];
  default_attr_ids: AttributeId[];
  semantic_attributes: Record<string, SemanticAttributeConfig>;
};

export type ScopeRegistryData = { version: number; scopes: Record<string, SemanticScope> };

export type PublicScopeDescription = {
  id: string;
  description: string;
  object_types: string[];
  filters: Array<{
    name: string;
    type: SemanticAttributeConfig["type"];
    operators: SemanticAttributeConfig["operators"];
    allow_wildcards: boolean;
    max_length?: number;
    values?: string[];
  }>;
  full_text_modes: FullTextSearchMode[];
  ui_deep_link: boolean;
  content_labels: string[];
  relationships: string[];
  integrity?: { validation: true; evidence: boolean };
};

export const SEMANTIC_OPERATOR_MATRIX: Record<SemanticType, readonly SemanticOperator[]> = {
  string: ["eq", "like"],
  integer: ["eq", "gte", "lte"],
  number: ["eq", "gte", "lte"],
  boolean: ["eq"],
  date: ["eq", "gte", "lte"],
  datetime: ["eq", "gte", "lte"],
  enum: ["eq"]
};

export const FULL_TEXT_SEARCH_MODES: readonly FullTextSearchMode[] = ["none", "stemming", "thesaurus"];

export class ScopeRegistry {
  readonly data: ScopeRegistryData;
  private readonly validatedSchemas = new Map<string, AttributeSchemaInfo>();

  constructor(data: ScopeRegistryData) {
    if (!data || data.version !== 1 || !data.scopes || typeof data.scopes !== "object") {
      throw new Error("Invalid scope registry; expected version=1 and scopes object");
    }
    const names = Object.keys(data.scopes);
    if (!names.length) throw new Error("Scope registry must contain at least one scope");
    for (const [name, scope] of Object.entries(data.scopes)) {
      if (!scope || typeof scope !== "object") throw new Error(`Scope ${name} must be an object`);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid scope name: ${name}`);
      if (!scope.description || typeof scope.description !== "string") throw new Error(`Scope ${name} requires description`);
      if (typeof scope.enabled !== "boolean") throw new Error(`Scope ${name} requires enabled boolean`);
      if (!scope.arcsuite || typeof scope.arcsuite !== "object") throw new Error(`Scope ${name} requires arcsuite configuration`);
      if (typeof scope.arcsuite.cabinet_id !== "string" || !/^rep:\S+$/.test(scope.arcsuite.cabinet_id)) throw new Error(`Scope ${name} requires a valid rep cabinet_id`);
      if (typeof scope.arcsuite.cabinet_alias !== "string" || !safeConfigString(scope.arcsuite.cabinet_alias, 128)) throw new Error(`Scope ${name} requires cabinet_alias`);
      if (typeof scope.arcsuite.resolve_references !== "boolean") throw new Error(`Scope ${name} requires resolve_references boolean`);
      if (scope.arcsuite.root_object_id !== null && (typeof scope.arcsuite.root_object_id !== "string" || !/^rep:\S+$/.test(scope.arcsuite.root_object_id))) {
        throw new Error(`Scope ${name} has invalid root_object_id`);
      }
      if (scope.arcsuite.root_object_id && !scope.arcsuite.root_object_id.startsWith(`${scope.arcsuite.cabinet_id}:`) && scope.arcsuite.root_object_id !== scope.arcsuite.cabinet_id) {
        throw new Error(`Scope ${name} root_object_id is outside its cabinet`);
      }
      validateContentLabelConfiguration(scope.content_labels, name);
      validateRelationshipConfiguration(scope.relationships, name);
      validateIntegrityConfiguration(scope.integrity, name);
      validateSearchConfiguration(scope.search, name);
      if (scope.ui !== undefined) {
        validateUiConfiguration(scope.ui, name);
      }
      if (!Array.isArray(scope.allowed_object_types) || !scope.allowed_object_types.length || scope.allowed_object_types.some((value) => !safeConfigString(value, 128))) {
        throw new Error(`Scope ${name} requires non-empty allowed_object_types`);
      }
      if (!scope.default_attr_ids?.length) throw new Error(`Scope ${name} requires default_attr_ids`);
      for (const attr of scope.default_attr_ids) assertAttrId(attr, `${name}.default_attr_ids`);
      for (const [semanticName, cfg] of Object.entries(scope.semantic_attributes ?? {})) {
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`Semantic attribute ${name}.${semanticName} must be an object`);
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(semanticName)) throw new Error(`Invalid semantic attribute name: ${name}.${semanticName}`);
        assertAttrId(cfg.attr_id, `${name}.semantic_attributes.${semanticName}`);
        if (!Object.hasOwn(SEMANTIC_OPERATOR_MATRIX, cfg.type)) throw new Error(`Unsupported semantic type ${String(cfg.type)} for ${name}.${semanticName}`);
        if (!Array.isArray(cfg.operators) || !cfg.operators.length) throw new Error(`Semantic attribute ${name}.${semanticName} requires operators`);
        if (new Set(cfg.operators).size !== cfg.operators.length) throw new Error(`Semantic attribute ${name}.${semanticName} has duplicate operators`);
        if (cfg.max_length !== undefined && (!Number.isSafeInteger(cfg.max_length) || cfg.max_length < 1 || cfg.max_length > 4096)) {
          throw new Error(`Semantic attribute ${name}.${semanticName} has invalid max_length`);
        }
        if (cfg.max_length !== undefined && cfg.type !== "string" && cfg.type !== "enum") {
          throw new Error(`Semantic attribute ${name}.${semanticName} max_length is only valid for string or enum types`);
        }
        if (cfg.allow_wildcards !== undefined && typeof cfg.allow_wildcards !== "boolean") {
          throw new Error(`Semantic attribute ${name}.${semanticName} has invalid allow_wildcards`);
        }
        if (cfg.allow_wildcards && cfg.type !== "string") {
          throw new Error(`Semantic attribute ${name}.${semanticName} can only allow wildcards for string types`);
        }
        for (const operator of cfg.operators) {
          if (!SEMANTIC_OPERATOR_MATRIX[cfg.type].includes(operator)) throw new Error(`Unsupported operator ${operator} for ${name}.${semanticName}`);
        }
        if (cfg.type === "enum") {
          validateEnumConfiguration(cfg.values, name, semanticName);
        } else if (cfg.values !== undefined) {
          throw new Error(`Semantic attribute ${name}.${semanticName} values are only valid for enum types`);
        }
      }
    }
    const enabled = names.filter((name) => data.scopes[name].enabled);
    for (let i = 0; i < enabled.length; i += 1) {
      for (let j = i + 1; j < enabled.length; j += 1) {
        const left = data.scopes[enabled[i]].arcsuite.cabinet_id;
        const right = data.scopes[enabled[j]].arcsuite.cabinet_id;
        if (left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`)) {
          throw new Error(`Enabled scopes ${enabled[i]} and ${enabled[j]} have overlapping cabinet mappings`);
        }
      }
    }
    this.data = data;
  }

  static load(path: string): ScopeRegistry {
    const raw = readFileSync(path, "utf8");
    return new ScopeRegistry(parseYaml(raw) as ScopeRegistryData);
  }

  get(scopeId: string): SemanticScope {
    const scope = this.data.scopes[scopeId];
    if (!scope || !scope.enabled) throw new Error(`Unknown or disabled scope: ${scopeId}`);
    return scope;
  }

  allowedScope(scopeId: string, allowedScopes: string[]): SemanticScope {
    if (!allowedScopes.includes(scopeId)) throw new Error(`Scope not allowed: ${scopeId}`);
    return this.get(scopeId);
  }

  schemaFor(scopeId: string, semanticName: string): AttributeSchemaInfo | undefined {
    return this.validatedSchemas.get(`${scopeId}:${semanticName}`);
  }

  contentLabels(scope: SemanticScope): Map<string, PhysicalContentLabel> {
    return contentLabelsForScope(scope.content_labels);
  }

  resolveContentLabel(scope: SemanticScope, alias: string): PhysicalContentLabel | undefined {
    const label = this.contentLabels(scope).get(alias);
    return label ? { ...label } : undefined;
  }

  contentLabelAliases(scope: SemanticScope): Map<string, string> {
    return contentLabelAliasesForScope(scope.content_labels);
  }

  describe(allowedScopes: string[]): PublicScopeDescription[] {
    const out: PublicScopeDescription[] = [];
    for (const id of allowedScopes) {
      const scope = this.data.scopes[id];
      if (!scope?.enabled) continue;
      out.push({
        id,
        description: scope.description,
        object_types: [...scope.allowed_object_types],
        filters: Object.entries(scope.semantic_attributes).map(([name, cfg]) => ({
          name,
          type: cfg.type,
          operators: [...cfg.operators],
          allow_wildcards: Boolean(cfg.allow_wildcards),
          max_length: cfg.max_length,
          values: cfg.type === "enum" ? Object.keys(cfg.values ?? {}) : undefined
        })),
        full_text_modes: fullTextModes(scope),
        ui_deep_link: Boolean(scope.ui?.document_url_template),
        content_labels: [...this.contentLabels(scope).keys()],
        relationships: scope.relationships?.hard_references ? ["hard_reference_incoming"] : [],
        ...(scope.integrity?.enabled === true
          ? { integrity: { validation: true as const, evidence: scope.integrity.allow_evidence === true } }
          : {})
      });
    }
    return out;
  }

  documentUrl(scope: SemanticScope, objectId: string): string | undefined {
    const template = scope.ui?.document_url_template;
    if (!template) return undefined;
    const templateInfo = inspectDocumentUrlTemplate(template, scope.ui?.allow_http);
    if (!templateInfo.ok || !isSemanticDocumentId(objectId)) return undefined;
    const replacementSource = templateInfo.placeholder === "{document_id}"
      ? objectId
      : objectId.slice("rep:".length);
    if (!replacementSource) return undefined;
    try {
      const replaced = template.replace(templateInfo.placeholder, encodeURIComponent(replacementSource));
      const parsed = new URL(replaced);
      if (parsed.origin !== templateInfo.origin || parsed.protocol !== templateInfo.protocol || parsed.username || parsed.password || parsed.hash) return undefined;
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  inferScopeFromObjectId(objectId: string, allowedScopes: string[]): { id: string; scope: SemanticScope } | undefined {
    let match: { id: string; scope: SemanticScope } | undefined;
    for (const id of allowedScopes) {
      const scope = this.data.scopes[id];
      if (!scope?.enabled) continue;
      const cabinet = scope.arcsuite.cabinet_id;
      if (objectId === cabinet || objectId.startsWith(`${cabinet}:`)) {
        if (!match || cabinet.length > match.scope.arcsuite.cabinet_id.length) match = { id, scope };
      }
    }
    return match;
  }

  isAllowedObjectType(scope: SemanticScope, objectClass: unknown): boolean {
    return typeof objectClass === "string" && objectClass !== "unknown" && scope.allowed_object_types.includes(objectClass);
  }

  async validateAgainstAdapter(adapter: ArcSuiteAdapterClient, clientProfileId: string): Promise<void> {
    this.validatedSchemas.clear();
    const validated = new Map<string, AttributeSchemaInfo>();
    for (const [scopeId, scope] of Object.entries(this.data.scopes)) {
      if (!scope.enabled) continue;
      if (/SET_|YOUR_|<service>|<cabinet>/i.test(scope.arcsuite.cabinet_id)) {
        throw new Error(`Scope ${scopeId} has placeholder cabinet_id`);
      }
      const attrs = new Map<string, AdapterSchemaValidationRequest["attributes"][number]>();
      for (const attr of scope.default_attr_ids) {
        attrs.set(key(attr), { attrId: attr });
      }
      for (const cfg of Object.values(scope.semantic_attributes ?? {})) {
        const current = attrs.get(key(cfg.attr_id)) ?? { attrId: cfg.attr_id };
        current.requireSearchable = true;
        attrs.set(key(cfg.attr_id), current);
      }
      for (const sortAttr of [DEFAULT_ATTRS.modifiedOn, DEFAULT_ATTRS.name]) {
        if (!scope.default_attr_ids.some((a) => key(a) === key(sortAttr))) continue;
        const current: AdapterSchemaValidationRequest["attributes"][number] = attrs.get(key(sortAttr)) ?? { attrId: sortAttr };
        current.requireSortable = true;
        attrs.set(key(sortAttr), current);
      }
      const result = await adapter.validateSchema({
        clientProfileId,
        cabinetId: scope.arcsuite.cabinet_id,
        attributes: [...attrs.values()]
      });
      const errors = [...result.errors];
      const byKey = new Map(result.attributes.map((attribute) => [key(attribute), attribute]));
      for (const [semanticName, cfg] of Object.entries(scope.semantic_attributes ?? {})) {
        const schema = byKey.get(key(cfg.attr_id));
        if (!schema) {
          errors.push(`missing_attribute:${key(cfg.attr_id)}`);
          continue;
        }
        if (schema.searchable !== true) errors.push(`not_searchable:${key(cfg.attr_id)}`);
        const typeError = validateSemanticSchema(cfg, schema);
        if (typeError) errors.push(`${semanticName}:${typeError}`);
        else validated.set(`${scopeId}:${semanticName}`, schema);
      }
      if (!result.ok || errors.length) throw new Error(`Scope ${scopeId} validation failed: ${errors.join("; ")}`);
    }
    this.validatedSchemas.clear();
    for (const [name, schema] of validated) this.validatedSchemas.set(name, schema);
  }
}

function key(attr: AttributeId): string {
  return `${attr.ns}:${attr.name}`;
}

function assertAttrId(attr: AttributeId, label: string): void {
  if (!attr || typeof attr.ns !== "string" || typeof attr.name !== "string" || !attr.name) {
    throw new Error(`Invalid AttributeId in ${label}`);
  }
}

function safeConfigString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength && !/[\u0000-\u001f\u007f\s]/.test(value);
}

function validateSearchConfiguration(search: SemanticScope["search"], scopeId: string): void {
  if (search === undefined) return;
  if (!search || typeof search !== "object" || Array.isArray(search)) throw new Error(`Scope ${scopeId} search must be an object`);
  if (search.full_text_modes === undefined) return;
  if (!Array.isArray(search.full_text_modes) || !search.full_text_modes.length) throw new Error(`Scope ${scopeId} full_text_modes must be a non-empty array`);
  if (new Set(search.full_text_modes).size !== search.full_text_modes.length) throw new Error(`Scope ${scopeId} full_text_modes contains duplicates`);
  for (const mode of search.full_text_modes) {
    if (!FULL_TEXT_SEARCH_MODES.includes(mode)) throw new Error(`Unsupported full-text mode ${String(mode)} for scope ${scopeId}`);
  }
  if (!search.full_text_modes.includes("none")) throw new Error(`Scope ${scopeId} full_text_modes must include none`);
}

function validateRelationshipConfiguration(relationships: SemanticScope["relationships"], scopeId: string): void {
  if (relationships === undefined) return;
  if (!relationships || typeof relationships !== "object" || Array.isArray(relationships)) {
    throw new Error(`Scope ${scopeId} relationships must be an object`);
  }
  for (const key of Object.keys(relationships)) {
    if (key !== "hard_references") throw new Error(`Scope ${scopeId} has unknown relationship key ${key}`);
  }
  if (relationships.hard_references !== undefined && typeof relationships.hard_references !== "boolean") {
    throw new Error(`Scope ${scopeId} relationships.hard_references must be a boolean`);
  }
}

function validateIntegrityConfiguration(integrity: SemanticScope["integrity"], scopeId: string): void {
  if (integrity === undefined) return;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw new Error(`Scope ${scopeId} integrity must be an object`);
  }
  for (const key of Object.keys(integrity)) {
    if (key !== "enabled" && key !== "allow_evidence") throw new Error(`Scope ${scopeId} has unknown integrity key ${key}`);
  }
  if (integrity.enabled !== undefined && typeof integrity.enabled !== "boolean") {
    throw new Error(`Scope ${scopeId} integrity.enabled must be a boolean`);
  }
  if (integrity.allow_evidence !== undefined && typeof integrity.allow_evidence !== "boolean") {
    throw new Error(`Scope ${scopeId} integrity.allow_evidence must be a boolean`);
  }
  if (integrity.allow_evidence === true && integrity.enabled !== true) {
    throw new Error(`Scope ${scopeId} integrity.allow_evidence requires integrity.enabled=true`);
  }
}

function validateUiConfiguration(ui: SemanticScope["ui"], scopeId: string): void {
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) throw new Error(`Scope ${scopeId} ui must be an object`);
  for (const key of Object.keys(ui)) {
    if (key !== "allow_http" && key !== "document_url_template") throw new Error(`Scope ${scopeId} has unknown ui key ${key}`);
  }
  if (ui.allow_http !== undefined && typeof ui.allow_http !== "boolean") {
    throw new Error(`Scope ${scopeId} ui.allow_http must be a boolean`);
  }
  if (ui.document_url_template !== undefined) validateDocumentUrlTemplate(ui.document_url_template, ui.allow_http, scopeId);
}

function fullTextModes(scope: SemanticScope): FullTextSearchMode[] {
  return [...(scope.search?.full_text_modes ?? ["none"])] as FullTextSearchMode[];
}

export function semanticEnumPhysicalKey(value: SemanticEnumValueConfig): string {
  if ("value" in value) return JSON.stringify(["string", value.value]);
  return JSON.stringify(["i18n", value.ns, value.name]);
}

function validateEnumConfiguration(values: Record<string, SemanticEnumValueConfig> | undefined, scopeId: string, semanticName: string): void {
  if (!values || typeof values !== "object" || Array.isArray(values) || !Object.keys(values).length) {
    throw new Error(`Enum semantic attribute ${scopeId}.${semanticName} requires non-empty values`);
  }
  const physicalValues = new Set<string>();
  for (const [alias, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(alias)) throw new Error(`Invalid enum alias ${scopeId}.${semanticName}.${alias}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid enum mapping ${scopeId}.${semanticName}.${alias}`);
    const hasPhysicalId = typeof value.ns === "string" || typeof value.name === "string";
    const hasLiteral = typeof value.value === "string";
    if (hasPhysicalId === hasLiteral || (hasPhysicalId && (!safeConfigString(value.ns, 128) || !safeConfigString(value.name, 256))) || (hasLiteral && !safeLiteralString(value.value, 4096))) {
      throw new Error(`Enum mapping ${scopeId}.${semanticName}.${alias} must contain either ns/name or value`);
    }
    const physicalKey = semanticEnumPhysicalKey(value);
    if (physicalValues.has(physicalKey)) throw new Error(`Enum semantic attribute ${scopeId}.${semanticName} must use unique physical enum values`);
    physicalValues.add(physicalKey);
  }
}

function safeLiteralString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateSemanticSchema(cfg: SemanticAttributeConfig, schema: AttributeSchemaInfo): string | undefined {
  const dataType = schema.dataType;
  switch (cfg.type) {
    case "string":
      if (dataType !== "STRING_TYPE") return `schema_type_mismatch:${dataType ?? "missing"}`;
      if (schema.enumerated === true) return "enumerated_string_requires_enum_semantic_type";
      return undefined;
    case "integer":
      return dataType === "INT_TYPE" || dataType === "LONG_TYPE" ? undefined : `schema_type_mismatch:${dataType ?? "missing"}`;
    case "number":
      return dataType === "DOUBLE_TYPE" ? undefined : `schema_type_mismatch:${dataType ?? "missing"}`;
    case "boolean":
      return dataType === "BOOLEAN_TYPE" ? undefined : `schema_type_mismatch:${dataType ?? "missing"}`;
    case "date":
      return dataType === "DATE_TYPE" ? undefined : `schema_type_mismatch:${dataType ?? "missing"}`;
    case "datetime":
      return dataType === "DATE_TIME_TYPE" ? undefined : `schema_type_mismatch:${dataType ?? "missing"}`;
    case "enum":
      if (schema.enumerated !== true) return "schema_enum_flag_missing";
      if (dataType === "I18N_STRING_TYPE") {
        if (!Array.isArray(schema.enumLabels) || !schema.enumLabels.length) return "schema_enum_labels_missing";
        for (const value of Object.values(cfg.values ?? {})) {
          if (!("ns" in value) || typeof value.ns !== "string" || typeof value.name !== "string") return "enum_mapping_requires_i18n_id";
          if (!schema.enumLabels.some((label) => label.ns === value.ns && label.name === value.name)) return `enum_value_not_in_schema:${value.ns}:${value.name}`;
        }
        return undefined;
      }
      if (dataType === "STRING_TYPE") {
        for (const value of Object.values(cfg.values ?? {})) {
          if (!("value" in value) || typeof value.value !== "string") return "enum_mapping_requires_string_value";
          const constraintError = validateStringEnumLiteral(value.value, cfg, schema);
          if (constraintError) return constraintError;
        }
        return undefined;
      }
      return `schema_type_mismatch:${dataType ?? "missing"}`;
  }
}

function validateStringEnumLiteral(value: string, cfg: SemanticAttributeConfig, schema: AttributeSchemaInfo): string | undefined {
  if (cfg.max_length !== undefined && value.length > cfg.max_length) return "enum_value_exceeds_semantic_max_length";
  if (schema.minLength !== undefined && value.length < schema.minLength) return "enum_value_shorter_than_schema_minimum";
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return "enum_value_exceeds_schema_maximum";
  if (schema.pattern !== undefined) {
    let pattern: RegExp;
    try { pattern = new RegExp(schema.pattern); } catch { return "schema_pattern_invalid"; }
    if (!pattern.test(value)) return "enum_value_does_not_match_schema_pattern";
  }
  return undefined;
}

type DocumentUrlPlaceholder = "{document_id}" | "{arcsuite_object_id}";

type DocumentUrlTemplateInspection =
  | { ok: true; placeholder: DocumentUrlPlaceholder; origin: string; protocol: "http:" | "https:" }
  | { ok: false; reason: string };

const DOCUMENT_URL_PLACEHOLDER_MARKERS = [
  "arcsuite-document-placeholder-a.invalid",
  "arcsuite-document-placeholder-b.invalid"
] as const;

function validateDocumentUrlTemplate(value: unknown, allowHttp: unknown, scopeId: string): asserts value is string {
  const inspected = inspectDocumentUrlTemplate(value, allowHttp);
  if (!inspected.ok) throw new Error(`Scope ${scopeId} document_url_template ${inspected.reason}`);
}

function inspectDocumentUrlTemplate(value: unknown, allowHttp: unknown): DocumentUrlTemplateInspection {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    return { ok: false, reason: "must be a non-empty string of at most 2048 characters" };
  }
  if (allowHttp !== undefined && typeof allowHttp !== "boolean") {
    return { ok: false, reason: "requires ui.allow_http to be a boolean" };
  }

  const placeholders = value.match(/\{[^{}]*\}/g) ?? [];
  const placeholder = placeholders.length === 1 && isDocumentUrlPlaceholder(placeholders[0]) ? placeholders[0] : undefined;
  const remainder = placeholder ? value.replace(placeholder, "") : value;
  if (!placeholder || remainder.includes("{") || remainder.includes("}")) {
    return { ok: false, reason: "must contain exactly one supported object-ID placeholder and no unknown placeholders" };
  }

  let parsedA: URL;
  let parsedB: URL;
  try {
    parsedA = new URL(value.replace(placeholder, DOCUMENT_URL_PLACEHOLDER_MARKERS[0]));
    parsedB = new URL(value.replace(placeholder, DOCUMENT_URL_PLACEHOLDER_MARKERS[1]));
  } catch {
    return { ok: false, reason: "must be an absolute URL" };
  }
  if (parsedA.protocol !== parsedB.protocol || (parsedA.protocol !== "http:" && parsedA.protocol !== "https:")) {
    return { ok: false, reason: "must use http or https" };
  }
  if (parsedA.origin === "null" || parsedB.origin === "null") {
    return { ok: false, reason: "must be an absolute URL" };
  }
  if (parsedA.protocol === "http:" && allowHttp !== true) {
    return { ok: false, reason: "must use https unless ui.allow_http is true" };
  }
  if (parsedA.username || parsedA.password || parsedA.hash || parsedB.username || parsedB.password || parsedB.hash) {
    return { ok: false, reason: "must not contain credentials or a URL fragment" };
  }
  if (parsedA.hostname !== parsedB.hostname || parsedA.port !== parsedB.port
    || parsedA.username !== parsedB.username || parsedA.password !== parsedB.password) {
    return { ok: false, reason: "must keep the object-ID placeholder out of the URL authority" };
  }

  return { ok: true, placeholder, origin: parsedA.origin, protocol: parsedA.protocol };
}

function isDocumentUrlPlaceholder(value: string): value is DocumentUrlPlaceholder {
  return value === "{document_id}" || value === "{arcsuite_object_id}";
}

function isSemanticDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 2048
    && /^rep:[^\s\u0000-\u001f\u007f]+$/.test(value);
}
