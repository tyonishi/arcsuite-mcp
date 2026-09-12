import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AttributeId, AdapterSchemaValidationRequest } from "../arcsuite/types.ts";
import type { ArcSuiteAdapterClient } from "../arcsuite/soapAdapterClient.ts";
import { DEFAULT_ATTRS } from "../arcsuite/constants.ts";

export type SemanticAttributeConfig = {
  attr_id: AttributeId;
  type: "string" | "datetime";
  operators: Array<"eq" | "like" | "gte" | "lte">;
  allow_wildcards?: boolean;
  max_length?: number;
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
  allowed_object_types: string[];
  default_attr_ids: AttributeId[];
  semantic_attributes: Record<string, SemanticAttributeConfig>;
};

export type ScopeRegistryData = { version: number; scopes: Record<string, SemanticScope> };

export class ScopeRegistry {
  readonly data: ScopeRegistryData;

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
      if (!Array.isArray(scope.allowed_object_types) || !scope.allowed_object_types.length || scope.allowed_object_types.some((value) => !safeConfigString(value, 128))) {
        throw new Error(`Scope ${name} requires non-empty allowed_object_types`);
      }
      if (!scope.default_attr_ids?.length) throw new Error(`Scope ${name} requires default_attr_ids`);
      for (const attr of scope.default_attr_ids) assertAttrId(attr, `${name}.default_attr_ids`);
      for (const [semanticName, cfg] of Object.entries(scope.semantic_attributes ?? {})) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(semanticName)) throw new Error(`Invalid semantic attribute name: ${name}.${semanticName}`);
        assertAttrId(cfg.attr_id, `${name}.semantic_attributes.${semanticName}`);
        if (!Array.isArray(cfg.operators) || !cfg.operators.length) throw new Error(`Semantic attribute ${name}.${semanticName} requires operators`);
        if (cfg.max_length !== undefined && (!Number.isSafeInteger(cfg.max_length) || cfg.max_length < 1 || cfg.max_length > 4096)) {
          throw new Error(`Semantic attribute ${name}.${semanticName} has invalid max_length`);
        }
        for (const operator of cfg.operators) {
          if (!["eq", "like", "gte", "lte"].includes(operator)) throw new Error(`Unsupported operator ${operator} for ${name}.${semanticName}`);
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
      // v1 search/list sorts by modified date and/or name. Verify this assumption against the live schema.
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
      if (!result.ok) throw new Error(`Scope ${scopeId} validation failed: ${result.errors.join("; ")}`);
    }
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
