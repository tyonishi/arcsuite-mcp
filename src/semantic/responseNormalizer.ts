import type { AdapterRepositoryObject, AttributeValue, NormalizedDocument } from "../arcsuite/types.ts";
import type { SemanticAttributeConfig } from "./scopeRegistry.ts";

function getAttr(obj: AdapterRepositoryObject, name: string): AttributeValue | undefined {
  return obj.attributes[`rep:${name}`] ?? obj.attributes[name];
}

function getAttributeById(obj: AdapterRepositoryObject, ns: string, name: string): AttributeValue | undefined {
  return obj.attributes[`${ns}:${name}`] ?? getAttr(obj, name);
}

function asString(value: AttributeValue | undefined): string | undefined {
  if (!value) return undefined;
  if (value.type === "string" || value.type === "datetime" || value.type === "id") return value.value;
  if (value.type === "i18n") return value.label ?? value.name;
  if (value.type === "rmsObject") return value.label ?? value.dn;
  if (value.type === "int" || value.type === "long" || value.type === "double" || value.type === "boolean") return String(value.value);
  return undefined;
}

function asInt(value: AttributeValue | undefined): number | undefined {
  if (!value) return undefined;
  if (value.type === "int" || value.type === "long") return Number(value.value);
  const text = asString(value);
  if (text && /^-?\d+$/.test(text)) return Number(text);
  return undefined;
}

function asPublicValue(value: AttributeValue | undefined): string | number | boolean | null {
  if (!value) return null;
  if (value.type === "string" || value.type === "datetime" || value.type === "id") return value.value;
  if (value.type === "int" || value.type === "long" || value.type === "double" || value.type === "boolean") return value.value;
  if (value.type === "i18n") return value.label ?? value.name;
  if (value.type === "rmsObject") return value.label ?? value.dn ?? null;
  if (value.type === "i18n[]") return value.values.map((v) => v.label ?? v.name).join(", ");
  return null;
}

function contentLabels(value: AttributeValue | undefined): string[] {
  if (!value) return [];
  if (value.type === "i18n[]") return value.values.map((v) => v.name);
  if (value.type === "i18n") return [value.name];
  const one = asString(value);
  return one ? [one] : [];
}

export function normalizeDocument(obj: AdapterRepositoryObject, semanticAttributes: Record<string, SemanticAttributeConfig> = {}): NormalizedDocument {
  const name = asString(getAttr(obj, "system:name"));
  const labels = contentLabels(getAttr(obj, "system:contentlabellist"));
  const rawPath = obj.pathObjects?.map((p) => p.name).filter((v): v is string => Boolean(v));
  const path = rawPath?.length ? [...rawPath].reverse() : undefined;
  return {
    document_id: obj.id,
    object_class: obj.objectClass,
    name,
    path,
    revision_number: asInt(getAttr(obj, "system:revisionnumber")),
    current_revision_number: asInt(getAttr(obj, "system:currentrevisionnumber")),
    modified_at: asString(getAttr(obj, "system:modifiedon")),
    status: asString(getAttr(obj, "system:status")),
    content_labels: labels,
    content_available: labels.length > 0,
    semantic_attributes: Object.fromEntries(Object.entries(semanticAttributes).map(([name, cfg]) => [name, asPublicValue(getAttributeById(obj, cfg.attr_id.ns, cfg.attr_id.name))]))
  };
}
