import type { AdapterSearchCondition, AttributeId, AttributeSchemaInfo, AttributeValue } from "../arcsuite/types.ts";
import type { SemanticAttributeConfig, SemanticOperator, SemanticScope } from "./scopeRegistry.ts";

export type SemanticFilterPredicate = {
  operator: SemanticOperator;
  value: string | number | boolean;
};

export type SemanticFilterInput = string | number | boolean | SemanticFilterPredicate;

export type CanonicalSemanticPredicate = {
  semanticName: string;
  semanticType: SemanticAttributeConfig["type"];
  operator: SemanticOperator;
  condition: AdapterSearchCondition;
  verification: "deterministic" | "provider";
};

export type SemanticVerificationFailure = "attribute_missing" | "malformed_attribute" | "predicate_mismatch";

export class SemanticVerificationError extends Error {
  readonly reason: SemanticVerificationFailure;

  constructor(reason: SemanticVerificationFailure, message: string) {
    super(message);
    this.name = "SemanticVerificationError";
    this.reason = reason;
  }
}

const OPERATOR_WIRE_NAMES: Record<SemanticOperator, AdapterSearchCondition["operator"]> = {
  eq: "EQUAL",
  like: "LIKE",
  gte: "GREATER_EQUAL",
  lte: "LESS_EQUAL"
};

export function canonicalizeFilter(
  scope: SemanticScope,
  semanticName: string,
  input: SemanticFilterInput,
  schema?: AttributeSchemaInfo
): CanonicalSemanticPredicate {
  const cfg = scope.semantic_attributes[semanticName];
  if (!cfg) throw new TypeError(`Unsupported semantic filter: ${semanticName}`);

  const explicit = isPredicate(input);
  const predicate = explicit ? input : { operator: legacyOperator(cfg, semanticName, input), value: input };
  if (!cfg.operators.includes(predicate.operator)) throw new TypeError(`${semanticName} does not allow ${predicate.operator}`);
  if (!schema && (explicit || (cfg.type !== "string" && cfg.type !== "datetime"))) {
    throw new TypeError(`${semanticName} requires validated schema metadata`);
  }

  const condition = (() => {
    switch (cfg.type) {
    case "string":
        return stringCondition(cfg, semanticName, predicate, schema);
    case "integer":
        return integerCondition(cfg, semanticName, predicate, schema);
    case "number":
        return numberCondition(cfg, semanticName, predicate, schema);
    case "boolean":
        return booleanCondition(cfg, semanticName, predicate, schema);
    case "date":
        return dateCondition(cfg, semanticName, predicate, schema);
    case "datetime":
        return datetimeCondition(cfg, semanticName, predicate, schema, explicit);
    case "enum":
        return enumCondition(cfg, semanticName, predicate, schema);
    }
  })();
  return Object.freeze({
    semanticName,
    semanticType: cfg.type,
    operator: predicate.operator,
    condition: freezeCondition(condition),
    verification: predicate.operator === "like" ? "provider" : "deterministic"
  });
}

export function mapFilter(
  scope: SemanticScope,
  semanticName: string,
  input: SemanticFilterInput,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  return canonicalizeFilter(scope, semanticName, input, schema).condition;
}

export function verifySemanticPredicate(
  predicate: CanonicalSemanticPredicate,
  attributes: Record<string, AttributeValue>
): void {
  if (predicate.verification === "provider") return;
  const key = attrKey(predicate.condition.attrId);
  const actual = attributes[key];
  if (!actual) throw new SemanticVerificationError("attribute_missing", `${predicate.semanticName} authoritative attribute is missing`);
  if (!hasAuthoritativeShape(predicate.condition.value, actual)) {
    throw new SemanticVerificationError("malformed_attribute", `${predicate.semanticName} authoritative attribute is malformed`);
  }
  if (!matchesCondition(predicate.condition, actual)) {
    throw new SemanticVerificationError("predicate_mismatch", `${predicate.semanticName} authoritative value does not satisfy the search predicate`);
  }
}

function freezeCondition(condition: AdapterSearchCondition): AdapterSearchCondition {
  const value = { ...condition.value } as AdapterSearchCondition["value"];
  const attrId = { ...condition.attrId };
  Object.freeze(value);
  Object.freeze(attrId);
  return Object.freeze({ ...condition, attrId, value });
}

function matchesCondition(condition: AdapterSearchCondition, actual: AttributeValue): boolean {
  if (condition.value.type === "string") {
    if (actual.type !== "string") return false;
    return compareText(actual.value, condition.value.value, condition.operator);
  }
  if (condition.value.type === "int" || condition.value.type === "long") {
    if (actual.type !== condition.value.type || !isAuthoritativeInteger(actual.value, condition.value.type)) return false;
    return compareNumber(actual.value, condition.value.value, condition.operator);
  }
  if (condition.value.type === "double") {
    if (actual.type !== "double" || !Number.isFinite(actual.value)) return false;
    return compareNumber(actual.value, condition.value.value, condition.operator);
  }
  if (condition.value.type === "boolean") {
    return actual.type === "boolean" && condition.operator === "EQUAL" && actual.value === condition.value.value;
  }
  if (condition.value.type === "date") {
    if (actual.type !== "date") return false;
    const left = parseDateValue(actual.value);
    const right = parseDateValue(condition.value.value);
    return left !== undefined && right !== undefined && compareNumber(left, right, condition.operator);
  }
  if (condition.value.type === "datetime") {
    if (actual.type !== "datetime") return false;
    const left = parseDateTimeValue(actual.value);
    const right = parseDateTimeValue(condition.value.value);
    return left !== undefined && right !== undefined && compareDateTime(left, right, condition.operator);
  }
  if (condition.value.type === "i18n") {
    return actual.type === "i18n"
      && condition.operator === "EQUAL"
      && actual.ns === condition.value.ns
      && actual.name === condition.value.name;
  }
  return false;
}

function hasAuthoritativeShape(expected: AdapterSearchCondition["value"], actual: AttributeValue): boolean {
  if (!actual || typeof actual !== "object") return false;
  if (expected.type === "string") return actual.type === "string" && typeof actual.value === "string";
  if (expected.type === "int" || expected.type === "long") {
    return actual.type === expected.type && isAuthoritativeInteger(actual.value, expected.type);
  }
  if (expected.type === "double") return actual.type === "double" && typeof actual.value === "number" && Number.isFinite(actual.value);
  if (expected.type === "boolean") return actual.type === "boolean" && typeof actual.value === "boolean";
  if (expected.type === "date") return actual.type === "date" && typeof actual.value === "string" && parseDateValue(actual.value) !== undefined;
  if (expected.type === "datetime") return actual.type === "datetime" && typeof actual.value === "string" && parseDateTimeValue(actual.value) !== undefined;
  return expected.type === "i18n"
    && actual.type === "i18n"
    && typeof actual.ns === "string"
    && typeof actual.name === "string";
}

function isAuthoritativeInteger(value: unknown, type: "int" | "long"): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return type === "long" || (value >= -2_147_483_648 && value <= 2_147_483_647);
}

function compareText(actual: string, expected: string, operator: AdapterSearchCondition["operator"]): boolean {
  return operator === "EQUAL" && actual === expected;
}

function compareNumber(actual: number, expected: number, operator: AdapterSearchCondition["operator"]): boolean {
  if (operator === "EQUAL") return actual === expected;
  if (operator === "GREATER_EQUAL") return actual >= expected;
  if (operator === "LESS_EQUAL") return actual <= expected;
  return false;
}

type ParsedDateTime = { seconds: bigint; fraction: string };

function compareDateTime(actual: ParsedDateTime, expected: ParsedDateTime, operator: AdapterSearchCondition["operator"]): boolean {
  const comparison = actual.seconds < expected.seconds ? -1 : actual.seconds > expected.seconds ? 1 : compareFraction(actual.fraction, expected.fraction);
  if (operator === "EQUAL") return comparison === 0;
  if (operator === "GREATER_EQUAL") return comparison >= 0;
  if (operator === "LESS_EQUAL") return comparison <= 0;
  return false;
}

function compareFraction(actual: string, expected: string): number {
  const length = Math.max(actual.length, expected.length);
  const left = BigInt((actual || "0").padEnd(length, "0"));
  const right = BigInt((expected || "0").padEnd(length, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseDateValue(value: string): number | undefined {
  if (!isCalendarDate(value)) return undefined;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDateTimeValue(value: string): ParsedDateTime | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return undefined;
  if (match[6] !== "Z" && (Number(match[7]) > 23 || Number(match[8]) > 59 || match[6] === "-00:00")) return undefined;
  const base = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[6]}`);
  if (!Number.isFinite(base) || base % 1000 !== 0) return undefined;
  return { seconds: BigInt(Math.trunc(base / 1000)), fraction: (match[5] ?? "").replace(/0+$/, "") };
}

export function attrKey(attr: AttributeId): string {
  return `${attr.ns}:${attr.name}`;
}

function stringCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  if (schema && schema.dataType !== "STRING_TYPE") throw new TypeError(`${name} schema type is not STRING_TYPE`);
  if (schema?.enumerated === true) throw new TypeError(`${name} schema is enumerated; use enum semantic type`);
  const value = stringValue(predicate.value, name);
  validateStringConstraints(name, value, cfg, schema, predicate.operator === "eq");
  if (predicate.operator === "like" && !cfg.allow_wildcards) throw new TypeError(`Wildcards are not allowed for ${name}`);
  if (predicate.operator !== "eq" && predicate.operator !== "like") throw new TypeError(`${name} does not support ${predicate.operator}`);
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: "string", value } };
}

function integerCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  if (schema && schema.dataType !== "INT_TYPE" && schema.dataType !== "LONG_TYPE") throw new TypeError(`${name} schema type is not INT_TYPE or LONG_TYPE`);
  if (typeof predicate.value !== "number" || !Number.isSafeInteger(predicate.value)) throw new TypeError(`${name} must be a JavaScript safe integer`);
  if (schema?.dataType === "INT_TYPE" && (predicate.value < -2147483648 || predicate.value > 2147483647)) throw new TypeError(`${name} is outside the ArcSuite INT range`);
  validateIntegralConstraints(name, predicate.value, schema);
  const valueType = schema?.dataType === "INT_TYPE" ? "int" : "long";
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: valueType, value: predicate.value } };
}

function numberCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  if (schema && schema.dataType !== "DOUBLE_TYPE") throw new TypeError(`${name} schema type is not DOUBLE_TYPE`);
  if (typeof predicate.value !== "number" || !Number.isFinite(predicate.value)) throw new TypeError(`${name} must be a finite number`);
  validateFloatingConstraints(name, predicate.value, schema);
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: "double", value: predicate.value } };
}

function booleanCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  if (typeof predicate.value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  if (schema && schema.dataType !== "BOOLEAN_TYPE") throw new TypeError(`${name} schema type is not BOOLEAN_TYPE`);
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: "boolean", value: predicate.value } };
}

function dateCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  const value = stringValue(predicate.value, name);
  if (!isCalendarDate(value)) throw new TypeError(`${name} must be an ISO calendar date`);
  if (schema && schema.dataType !== "DATE_TYPE") throw new TypeError(`${name} schema type is not DATE_TYPE`);
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: "date", value } };
}

function datetimeCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema: AttributeSchemaInfo | undefined,
  explicit: boolean
): AdapterSearchCondition {
  const value = stringValue(predicate.value, name);
  const normalized = explicit ? strictDateTime(value, name) : legacyDateTime(value, name);
  if (schema && schema.dataType !== "DATE_TIME_TYPE") throw new TypeError(`${name} schema type is not DATE_TIME_TYPE`);
  return { attrId: cfg.attr_id, operator: OPERATOR_WIRE_NAMES[predicate.operator], value: { type: "datetime", value: normalized } };
}

function enumCondition(
  cfg: SemanticAttributeConfig,
  name: string,
  predicate: SemanticFilterPredicate,
  schema?: AttributeSchemaInfo
): AdapterSearchCondition {
  const alias = stringValue(predicate.value, name);
  const mapping = cfg.values?.[alias];
  if (!mapping) throw new TypeError(`${name} must be one of the configured enum aliases`);
  if (!schema?.dataType || schema.enumerated !== true) throw new TypeError(`${name} requires validated enum schema metadata`);
  if (schema.dataType === "I18N_STRING_TYPE" && "ns" in mapping && typeof mapping.ns === "string" && typeof mapping.name === "string") {
    if (!schema.enumLabels?.some((label) => label.ns === mapping.ns && label.name === mapping.name)) {
      throw new TypeError(`${name} enum alias is not present in the validated schema`);
    }
    return { attrId: cfg.attr_id, operator: "EQUAL", value: { type: "i18n", ns: mapping.ns, name: mapping.name } };
  }
  if (schema.dataType === "STRING_TYPE" && "value" in mapping && typeof mapping.value === "string") {
    validateStringConstraints(name, mapping.value, cfg, schema, true);
    return { attrId: cfg.attr_id, operator: "EQUAL", value: { type: "string", value: mapping.value } };
  }
  throw new TypeError(`${name} enum mapping does not match the validated schema value type`);
}

function legacyOperator(cfg: SemanticAttributeConfig, semanticName: string, input: string | number | boolean): SemanticOperator {
  if (cfg.type === "string" && typeof input === "string" && /[*?]/.test(input)) {
    if (!cfg.allow_wildcards) throw new TypeError(`Wildcards are not allowed for ${semanticName}`);
    return "like";
  }
  if (cfg.type === "datetime" && typeof input === "string") {
    if (semanticName.endsWith("_after")) return "gte";
    if (semanticName.endsWith("_before")) return "lte";
  }
  return "eq";
}

function isPredicate(value: SemanticFilterInput): value is SemanticFilterPredicate {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) throw new TypeError(`${name} must be a non-empty string of at most 255 characters`);
  return value;
}

function validateStringConstraints(name: string, value: string, cfg: SemanticAttributeConfig, schema: AttributeSchemaInfo | undefined, validateSchemaValue: boolean): void {
  if (cfg.max_length !== undefined && value.length > cfg.max_length) throw new TypeError(`${name} exceeds max length ${cfg.max_length}`);
  if (!validateSchemaValue) return;
  if (schema?.minLength !== undefined && value.length < schema.minLength) throw new TypeError(`${name} is shorter than the schema minimum`);
  if (schema?.maxLength !== undefined && value.length > schema.maxLength) throw new TypeError(`${name} exceeds the schema maximum`);
  if (schema?.pattern !== undefined) {
    let pattern: RegExp;
    try { pattern = new RegExp(schema.pattern); } catch { throw new TypeError(`${name} has an invalid schema pattern`); }
    if (!pattern.test(value)) throw new TypeError(`${name} does not match the schema pattern`);
  }
}

function validateIntegralConstraints(name: string, value: number, schema?: AttributeSchemaInfo): void {
  if (!schema) return;
  const min = compareIntegralBound(value, schema.minIntegralValue, name, "minimum");
  const max = compareIntegralBound(value, schema.maxIntegralValue, name, "maximum");
  if (min !== undefined && (min < 0 || (min === 0 && schema.minInclusive === false))) throw new TypeError(`${name} is below the schema minimum`);
  if (max !== undefined && (max > 0 || (max === 0 && schema.maxInclusive === false))) throw new TypeError(`${name} is above the schema maximum`);
}

function validateFloatingConstraints(name: string, value: number, schema?: AttributeSchemaInfo): void {
  if (!schema) return;
  if (schema.minFloatingValue !== undefined && (value < schema.minFloatingValue || (value === schema.minFloatingValue && schema.minInclusive === false))) throw new TypeError(`${name} is below the schema minimum`);
  if (schema.maxFloatingValue !== undefined && (value > schema.maxFloatingValue || (value === schema.maxFloatingValue && schema.maxInclusive === false))) throw new TypeError(`${name} is above the schema maximum`);
}

function compareIntegralBound(value: number, bound: number | string | undefined, name: string, label: string): number | undefined {
  if (bound === undefined) return undefined;
  try {
    if (typeof bound === "number" && !Number.isSafeInteger(bound)) throw new TypeError("unsafe schema bound");
    const actual = BigInt(value);
    const parsed = BigInt(bound);
    return actual < parsed ? -1 : actual > parsed ? 1 : 0;
  } catch {
    throw new TypeError(`${name} schema ${label} is invalid`);
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function strictDateTime(value: string, name: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[5] === "-00:00" || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || (match[5] !== "Z" && (Number(match[6]) > 23 || Number(match[7]) > 59))) {
    throw new TypeError(`${name} must be an unambiguous RFC3339 date-time`);
  }
  return value;
}

function legacyDateTime(value: string, name: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new TypeError(`${name} must be an ISO date-time`);
  return parsed.toISOString();
}
