import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AttributeId, AdapterSchemaValidationRequest, AttributeSchemaInfo } from "../arcsuite/types.ts";
import type { ArcSuiteAdapterClient } from "../arcsuite/soapAdapterClient.ts";
import { DEFAULT_ATTRS } from "../arcsuite/constants.ts";

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
  search?: {
    full_text_modes?: FullTextSearchMode[];
  };
  ui?: {
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
      validateSearchConfiguration(scope.search, name);
      if (scope.ui !== undefined) {
        if (!scope.ui || typeof scope.ui !== "object" || Array.isArray(scope.ui)) throw new Error(`Scope ${name} ui must be an object`);
        if (scope.ui.document_url_template !== undefined) validateDocumentUrlTemplate(scope.ui.document_url_template, name);
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
        ui_deep_link: Boolean(scope.ui?.document_url_template)
      });
    }
    return out;
  }

  documentUrl(scope: SemanticScope, objectId: string): string | undefined {
    const template = scope.ui?.document_url_template;
    if (!template) return undefined;
    try {
      const replaced = template.replace("{document_id}", encodeURIComponent(objectId));
      const parsed = new URL(replaced);
      const templateUrl = new URL(template.replace("{document_id}", "example"));
      if (parsed.origin !== templateUrl.origin || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return undefined;
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
    return typeof objectClass === "string" && scope.allowed_object_types.includes(objectClass);
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

function fullTextModes(scope: SemanticScope): FullTextSearchMode[] {
  return [...(scope.search?.full_text_modes ?? ["none"])] as FullTextSearchMode[];
}

function validateEnumConfiguration(values: Record<string, SemanticEnumValueConfig> | undefined, scopeId: string, semanticName: string): void {
  if (!values || typeof values !== "object" || Array.isArray(values) || !Object.keys(values).length) {
    throw new Error(`Enum semantic attribute ${scopeId}.${semanticName} requires non-empty values`);
  }
  for (const [alias, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(alias)) throw new Error(`Invalid enum alias ${scopeId}.${semanticName}.${alias}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid enum mapping ${scopeId}.${semanticName}.${alias}`);
    const hasPhysicalId = typeof value.ns === "string" || typeof value.name === "string";
    const hasLiteral = typeof value.value === "string";
    if (hasPhysicalId === hasLiteral || (hasPhysicalId && (!safeConfigString(value.ns, 128) || !safeConfigString(value.name, 256))) || (hasLiteral && !safeLiteralString(value.value, 4096))) {
      throw new Error(`Enum mapping ${scopeId}.${semanticName}.${alias} must contain either ns/name or value`);
    }
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
        for (const value of Object.values(cfg.values ?? {})) if (!("value" in value) || typeof value.value !== "string") return "enum_mapping_requires_string_value";
        return undefined;
      }
      return `schema_type_mismatch:${dataType ?? "missing"}`;
  }
}

function validateDocumentUrlTemplate(value: unknown, scopeId: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new Error(`Scope ${scopeId} has invalid document_url_template`);
  if ((value.match(/\{document_id\}/g) ?? []).length !== 1 || /\{[^}]+\}/.test(value.replace("{document_id}", ""))) {
    throw new Error(`Scope ${scopeId} document_url_template must contain exactly one {document_id} placeholder`);
  }
  let parsed: URL;
  try { parsed = new URL(value.replace("{document_id}", "example")); }
  catch { throw new Error(`Scope ${scopeId} document_url_template must be an absolute URL`); }
  if (parsed.protocol !== "https:") throw new Error(`Scope ${scopeId} document_url_template must use https`);
  if (parsed.username || parsed.password) throw new Error(`Scope ${scopeId} document_url_template must not contain credentials`);
  if (parsed.hash) throw new Error(`Scope ${scopeId} document_url_template must not contain a fragment`);
  const authority = /^\s*https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority?.includes("{document_id}")) throw new Error(`Scope ${scopeId} document_url_template must keep {document_id} out of the URL authority`);
}
