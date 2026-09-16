import type { CanonicalSemanticPredicate } from "../semantic/attributeMapper.ts";
import type { FullTextSearchMode, SemanticOperator, SemanticType } from "../semantic/scopeRegistry.ts";

export type AppliedPredicate = Readonly<{
  name: string;
  type: SemanticType;
  operator: SemanticOperator;
  value: string | number | boolean;
}>;

export type AppliedQuery = Readonly<{
  operator: "and" | "or";
  filters: Readonly<{
    operator: "and";
    predicates: readonly AppliedPredicate[];
  }>;
  text: Readonly<{
    terms: readonly string[];
    operator: "and" | "or";
    mode: FullTextSearchMode;
  }> | null;
}>;

export function buildAppliedQuery(
  canonicalPredicates: readonly CanonicalSemanticPredicate[],
  terms: readonly string[],
  queryOperator: "and" | "or",
  textSearchMode: FullTextSearchMode
): AppliedQuery {
  const predicates = canonicalPredicates.map(({ semanticName, semanticType, operator, semanticValue }) => ({
    name: semanticName,
    type: semanticType,
    operator,
    value: semanticValue
  }));
  const text = terms.length
    ? { terms: [...terms], operator: queryOperator, mode: textSearchMode }
    : null;
  return {
    operator: predicates.length && text ? "and" : queryOperator,
    filters: { operator: "and", predicates },
    text
  };
}
