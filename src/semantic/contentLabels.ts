import { CONTENT_LABEL_PRIMARY } from "../arcsuite/constants.ts";
import type { PhysicalContentLabel } from "../arcsuite/types.ts";

export const CONTENT_LABEL_PRIMARY_ALIAS = "system:primary";
export const SEMANTIC_CONTENT_LABEL_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_CUSTOM_CONTENT_LABELS = 32;
export const MAX_CONTENT_LABEL_NAMESPACE_LENGTH = 128;
export const MAX_CONTENT_LABEL_NAME_LENGTH = 256;

export type ContentLabelConfiguration = Record<string, PhysicalContentLabel>;

export function isSemanticContentLabelAlias(value: unknown): value is string {
  return value === CONTENT_LABEL_PRIMARY_ALIAS || (typeof value === "string" && SEMANTIC_CONTENT_LABEL_ALIAS_PATTERN.test(value));
}

export function physicalContentLabelKey(label: PhysicalContentLabel): string {
  // JSON encoding keeps namespace/name boundaries unambiguous even if an
  // operator uses punctuation that would be meaningful to a delimiter.
  return JSON.stringify([label.ns, label.name]);
}

export function samePhysicalContentLabel(left: PhysicalContentLabel, right: PhysicalContentLabel): boolean {
  return left.ns === right.ns && left.name === right.name;
}

export function validateContentLabelConfiguration(raw: unknown, scopeId: string): ContentLabelConfiguration {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Scope ${scopeId} content_labels must be an object`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_CONTENT_LABELS) {
    throw new Error(`Scope ${scopeId} has too many custom content labels`);
  }

  const configured: ContentLabelConfiguration = {};
  const physicalKeys = new Set([physicalContentLabelKey(CONTENT_LABEL_PRIMARY)]);
  for (const [alias, value] of entries) {
    if (alias === CONTENT_LABEL_PRIMARY_ALIAS || !SEMANTIC_CONTENT_LABEL_ALIAS_PATTERN.test(alias)) {
      throw new Error(`Scope ${scopeId} has an invalid content label alias`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Scope ${scopeId} content label mapping must be an object`);
    }
    const mapping = value as Record<string, unknown>;
    if (Object.keys(mapping).some((key) => key !== "ns" && key !== "name")) {
      throw new Error(`Scope ${scopeId} has an invalid physical content label mapping`);
    }
    const ns = mapping.ns;
    const name = mapping.name;
    if (!safePhysicalPart(ns, MAX_CONTENT_LABEL_NAMESPACE_LENGTH) || !safePhysicalPart(name, MAX_CONTENT_LABEL_NAME_LENGTH)) {
      throw new Error(`Scope ${scopeId} has an invalid physical content label mapping`);
    }
    const physical = { ns, name };
    const physicalKey = physicalContentLabelKey(physical);
    if (physicalKeys.has(physicalKey)) {
      throw new Error(`Scope ${scopeId} has an ambiguous content label mapping`);
    }
    physicalKeys.add(physicalKey);
    configured[alias] = physical;
  }
  return configured;
}

export function contentLabelsForScope(custom: ContentLabelConfiguration | undefined): Map<string, PhysicalContentLabel> {
  const labels = new Map<string, PhysicalContentLabel>();
  labels.set(CONTENT_LABEL_PRIMARY_ALIAS, { ...CONTENT_LABEL_PRIMARY });
  for (const [alias, label] of Object.entries(custom ?? {})) labels.set(alias, { ...label });
  return labels;
}

export function contentLabelAliasesForScope(custom: ContentLabelConfiguration | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [alias, label] of contentLabelsForScope(custom)) aliases.set(physicalContentLabelKey(label), alias);
  return aliases;
}

function safePhysicalPart(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f\s]/.test(value);
}
