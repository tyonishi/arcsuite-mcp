import type { AdapterSearchCondition, AttributeId } from "../arcsuite/types.ts";
import type { SemanticScope } from "./scopeRegistry.ts";

export function mapFilter(scope: SemanticScope, semanticName: string, value: string): AdapterSearchCondition {
  const cfg = scope.semantic_attributes[semanticName];
  if (!cfg) throw new TypeError(`Unsupported semantic filter: ${semanticName}`);
  if (cfg.max_length && value.length > cfg.max_length) throw new TypeError(`${semanticName} exceeds max length ${cfg.max_length}`);
  const hasWildcard = /[*?]/.test(value);
  if (hasWildcard && !cfg.allow_wildcards) throw new TypeError(`Wildcards are not allowed for ${semanticName}`);
  if (cfg.type === "datetime") {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) throw new TypeError(`${semanticName} must be an ISO date-time`);
    const semanticOperator = semanticName.endsWith("_after") ? "gte" : semanticName.endsWith("_before") ? "lte" : "eq";
    if (!cfg.operators.includes(semanticOperator)) throw new TypeError(`${semanticName} does not allow ${semanticOperator}`);
    const operator = semanticOperator === "gte" ? "GREATER_EQUAL" : semanticOperator === "lte" ? "LESS_EQUAL" : "EQUAL";
    return { attrId: cfg.attr_id, operator, value: { type: "datetime", value: date.toISOString() } };
  }
  const semanticOperator = hasWildcard ? "like" : "eq";
  if (!cfg.operators.includes(semanticOperator)) throw new TypeError(`${semanticName} does not allow ${semanticOperator}`);
  const operator = semanticOperator === "like" ? "LIKE" : "EQUAL";
  return { attrId: cfg.attr_id, operator, value: { type: "string", value } };
}

export function attrKey(attr: AttributeId): string {
  return `${attr.ns}:${attr.name}`;
}
