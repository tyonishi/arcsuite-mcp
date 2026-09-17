import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenProfile } from "../config.ts";
import type { SemanticScope } from "../semantic/scopeRegistry.ts";
import type { CanonicalSemanticPredicate } from "../semantic/attributeMapper.ts";
import type { AppliedQuery } from "./appliedQuery.ts";
import { McpToolError } from "./errors.ts";

export const OPAQUE_HANDLE_LIMITS = Object.freeze({
  maxEncodedLength: 1024,
  maxBodyLength: 768,
  locatorBytes: 32,
  minKeyBytes: 32,
  maxKeyBytes: 64,
  maxValidationKeys: 2,
  maxTtlSeconds: 86_400,
  maxCapacity: 10_000
});

export type OpaqueHandleKind = "search" | "continuation" | "result";

export type HandleKeyConfig = Readonly<{
  kid: string;
  secret: Buffer;
}>;

export type OpaqueHandleConfig = Readonly<{
  activeKid: string;
  keys: readonly HandleKeyConfig[];
  ttlSeconds: number;
  capacity: number;
  capacityPerProfile: number;
  contractGeneration: number;
  credentialContextGeneration: number;
}>;

export type HandlePolicyContext = Readonly<{
  profile: TokenProfile;
  scopeId: string;
  scope: SemanticScope;
}>;

export type CanonicalSearchAuthority = Readonly<{
  scopeId: string;
  appliedQuery: AppliedQuery;
  includePath: boolean;
  pageSize: number;
}>;

export type ContinuationPageAuthority = Readonly<{
  authorityId: string;
  offset: number;
  expiresAt: number;
}>;

type CommonHandleRecord = Readonly<{
  kid: string;
  issuedAt: number;
  expiresAt: number;
  contractGeneration: number;
  policyFingerprint: string;
}>;

export type SearchHandleRecord = CommonHandleRecord & Readonly<{
  kind: "search";
  authority: CanonicalSearchAuthority;
}>;

export type ContinuationHandleRecord = CommonHandleRecord & Readonly<{
  kind: "continuation";
  searchAuthority: CanonicalSearchAuthority;
  cursor?: string;
  pageAuthority?: ContinuationPageAuthority;
}>;

export type ResultHandleRecord = CommonHandleRecord & Readonly<{
  kind: "result";
  scopeId: string;
  documentId: string;
  objectClass: string;
  verificationPlan?: readonly CanonicalSemanticPredicate[];
}>;

export type OpaqueHandleRecord = SearchHandleRecord | ContinuationHandleRecord | ResultHandleRecord;

export type OpaqueHandleIssue = Readonly<
  | { kind: "search"; authority: CanonicalSearchAuthority; maxExpiresAt?: number }
  | {
      kind: "continuation";
      input: Readonly<{ searchAuthority: CanonicalSearchAuthority; cursor?: string; pageAuthority?: ContinuationPageAuthority }>;
      maxExpiresAt?: number;
    }
  | {
      kind: "result";
      input: Readonly<{ documentId: string; objectClass: string; verificationPlan?: readonly CanonicalSemanticPredicate[] }>;
      maxExpiresAt?: number;
    }
>;

export interface HandleStore<T> {
  put(index: string, record: T, expiresAtMs: number, ownerProfileId: string): void;
  putMany(ownerProfileId: string, entries: readonly HandleStorePut<T>[]): void;
  get(index: string): T | undefined;
  delete(index: string): void;
  prune(): void;
  readonly size: number;
}

export type HandleStorePut<T> = Readonly<{
  index: string;
  record: T;
  expiresAtMs: number;
}>;

type StoredEntry<T> = {
  record: T;
  ownerProfileId: string;
  expiresAtMs: number;
  lastAccessSequence: number;
  insertionSequence: number;
};

export class InMemoryHandleStore<T> implements HandleStore<T> {
  private readonly entries = new Map<string, StoredEntry<T>>();
  private sequence = 0;
  private readonly capacity: number;
  private readonly capacityPerProfile: number;
  private readonly clock: () => number;

  constructor(
    capacity: number,
    capacityPerProfile: number,
    clock: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > OPAQUE_HANDLE_LIMITS.maxCapacity) {
      throw new Error(`Handle store capacity must be 1..${OPAQUE_HANDLE_LIMITS.maxCapacity}`);
    }
    if (!Number.isSafeInteger(capacityPerProfile) || capacityPerProfile < 1 || capacityPerProfile > capacity) {
      throw new Error("Handle store per-profile capacity must be 1..global capacity");
    }
    this.capacity = capacity;
    this.capacityPerProfile = capacityPerProfile;
    this.clock = clock;
  }

  get size(): number { return this.entries.size; }

  put(index: string, record: T, expiresAtMs: number, ownerProfileId: string): void {
    this.putMany(ownerProfileId, [{ index, record, expiresAtMs }]);
  }

  putMany(ownerProfileId: string, entries: readonly HandleStorePut<T>[]): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ownerProfileId) || !entries.length) {
      throw new Error("Invalid handle store owner or empty batch");
    }
    const now = this.clock();
    const indexes = new Set<string>();
    const prepared = entries.map((entry) => {
      if (!entry.index || indexes.has(entry.index)
        || !Number.isSafeInteger(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        throw new Error("Invalid handle store entry");
      }
      indexes.add(entry.index);
      return { ...entry, record: deepFreezeClone(entry.record) };
    });

    this.prune();
    for (const entry of prepared) {
      const existing = this.entries.get(entry.index);
      if (existing && existing.ownerProfileId !== ownerProfileId) throw new Error("Handle store owner mismatch");
    }
    const newEntryCount = prepared.filter((entry) => !this.entries.has(entry.index)).length;
    const ownerEntries = [...this.entries.entries()]
      .filter(([, entry]) => entry.ownerProfileId === ownerProfileId);
    const profileEvictions = Math.max(0, ownerEntries.length + newEntryCount - this.capacityPerProfile);
    const globalEvictions = Math.max(0, this.entries.size + newEntryCount - this.capacity);
    const requiredEvictions = Math.max(profileEvictions, globalEvictions);
    const evictionCandidates = ownerEntries
      .filter(([index]) => !indexes.has(index))
      .sort((left, right) => left[1].lastAccessSequence - right[1].lastAccessSequence
        || left[1].insertionSequence - right[1].insertionSequence
        || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    if (evictionCandidates.length < requiredEvictions) throw new HandleStoreCapacityError();

    for (const [index] of evictionCandidates.slice(0, requiredEvictions)) this.entries.delete(index);
    for (const entry of prepared) {
      const sequence = ++this.sequence;
      this.entries.set(entry.index, {
        record: entry.record,
        ownerProfileId,
        expiresAtMs: entry.expiresAtMs,
        lastAccessSequence: sequence,
        insertionSequence: sequence
      });
    }
  }

  get(index: string): T | undefined {
    const entry = this.entries.get(index);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock()) {
      this.entries.delete(index);
      return undefined;
    }
    entry.lastAccessSequence = ++this.sequence;
    return deepFreezeClone(entry.record);
  }

  delete(index: string): void { this.entries.delete(index); }

  prune(): void {
    const now = this.clock();
    for (const [index, entry] of this.entries) if (entry.expiresAtMs <= now) this.entries.delete(index);
  }

  hasIndex(index: string): boolean { return this.entries.has(index); }

}

class HandleStoreCapacityError extends Error {
  constructor() { super("Handle store capacity unavailable"); }
}

type DerivedKey = Readonly<{
  kid: string;
  envelopeAuthentication: Buffer;
  storeIndex: Buffer;
  policyFingerprint: Buffer;
}>;

type PublicEnvelope = Readonly<{
  v: 1;
  k: OpaqueHandleKind;
  kid: string;
  loc: string;
  iat: number;
  exp: number;
  gen: number;
}>;

const HANDLE_PREFIX = "arh1";
const CONTRACT_BINDING_SCHEMA_VERSION = 1;
const OPERATION_BY_KIND: Readonly<Record<OpaqueHandleKind, string>> = Object.freeze({
  search: "search.replay",
  continuation: "search.continue",
  result: "result.read"
});

export class OpaqueHandleService {
  private readonly keys = new Map<string, DerivedKey>();
  private readonly store: HandleStore<OpaqueHandleRecord>;
  private readonly config: OpaqueHandleConfig;
  private readonly clock: () => number;

  constructor(
    config: OpaqueHandleConfig,
    store?: HandleStore<OpaqueHandleRecord>,
    clock: () => number = Date.now
  ) {
    validateServiceConfig(config);
    this.config = config;
    this.clock = clock;
    for (const item of config.keys) this.keys.set(item.kid, deriveKeys(item));
    this.store = store ?? new InMemoryHandleStore<OpaqueHandleRecord>(config.capacity, config.capacityPerProfile, clock);
  }

  issueSearch(context: HandlePolicyContext, authority: CanonicalSearchAuthority, maxExpiresAt?: number): string {
    return this.issueMany(context, [{ kind: "search", authority, maxExpiresAt }])[0];
  }

  issueContinuation(
    context: HandlePolicyContext,
    input: Readonly<{ searchAuthority: CanonicalSearchAuthority; cursor?: string; pageAuthority?: ContinuationPageAuthority }>,
    maxExpiresAt?: number
  ): string {
    return this.issueMany(context, [{ kind: "continuation", input, maxExpiresAt }])[0];
  }

  issueResult(
    context: HandlePolicyContext,
    input: Readonly<{ documentId: string; objectClass: string; verificationPlan?: readonly CanonicalSemanticPredicate[] }>,
    maxExpiresAt?: number
  ): string {
    return this.issueMany(context, [{ kind: "result", input, maxExpiresAt }])[0];
  }

  issueMany(context: HandlePolicyContext, requests: readonly OpaqueHandleIssue[]): string[] {
    if (!requests.length) throw new Error("Opaque handle issue batch must not be empty");
    const prepared = requests.map((request) => this.prepareIssue(context, request));
    try {
      this.store.putMany(context.profile.clientProfileId, prepared.map(({ index, record, expiresAtMs }) => ({
        index, record, expiresAtMs
      })));
    } catch (error) {
      if (error instanceof HandleStoreCapacityError) {
        throw new McpToolError("ARCSUITE_NOT_AVAILABLE", "opaque_ref_capacity", false);
      }
      throw error;
    }
    return prepared.map((entry) => entry.ref);
  }

  resolve(ref: string, expectedKind: OpaqueHandleKind, context: HandlePolicyContext): OpaqueHandleRecord {
    return this.resolveInternal(ref, expectedKind, () => context);
  }

  resolveBound(
    ref: string,
    expectedKind: OpaqueHandleKind,
    profile: TokenProfile,
    resolveScope: (scopeId: string) => SemanticScope
  ): OpaqueHandleRecord {
    return this.resolveInternal(ref, expectedKind, (record) => {
      const scopeId = record.kind === "search"
        ? record.authority.scopeId
        : record.kind === "continuation"
          ? record.searchAuthority.scopeId
          : record.scopeId;
      return { profile, scopeId, scope: resolveScope(scopeId) };
    });
  }

  private resolveInternal(
    ref: string,
    expectedKind: OpaqueHandleKind,
    contextFor: (record: OpaqueHandleRecord) => HandlePolicyContext
  ): OpaqueHandleRecord {
    try {
      const { envelope, key } = this.authenticateEnvelope(ref);
      if (envelope.k !== expectedKind || envelope.gen !== this.config.contractGeneration) throw new Error("unavailable");
      const nowSeconds = Math.floor(this.clock() / 1000);
      if (envelope.iat > nowSeconds || envelope.exp <= nowSeconds
        || envelope.exp - envelope.iat > OPAQUE_HANDLE_LIMITS.maxTtlSeconds) throw new Error("unavailable");
      const record = this.store.get(storeIndex(key.storeIndex, envelope.kid, envelope.loc));
      if (!record || record.kind !== expectedKind || record.kid !== envelope.kid
        || record.issuedAt !== envelope.iat || record.expiresAt !== envelope.exp
        || record.contractGeneration !== envelope.gen) throw new Error("unavailable");
      const expectedPolicy = this.policyFingerprint(key, expectedKind, contextFor(record));
      if (!constantTimeTextEqual(record.policyFingerprint, expectedPolicy)) throw new Error("unavailable");
      return deepFreezeClone(record);
    } catch {
      throw refUnavailable();
    }
  }

  delete(ref: string): void {
    try {
      const { envelope, key } = this.authenticateEnvelope(ref);
      this.store.delete(storeIndex(key.storeIndex, envelope.kid, envelope.loc));
    } catch {
      // Deletion is best effort and intentionally oracle-free.
    }
  }

  private prepareIssue(
    context: HandlePolicyContext,
    request: OpaqueHandleIssue
  ): { ref: string; index: string; record: OpaqueHandleRecord; expiresAtMs: number } {
    const kind = request.kind;
    let maxExpiresAt = request.maxExpiresAt;
    let build: (common: CommonHandleRecord) => OpaqueHandleRecord;
    if (request.kind === "search") {
      if (request.authority.scopeId !== context.scopeId) throw new Error("Search authority scope mismatch");
      build = (common) => ({ ...common, kind: "search", authority: deepFreezeClone(request.authority) });
    } else if (request.kind === "continuation") {
      const input = request.input;
      if (input.searchAuthority.scopeId !== context.scopeId
        || (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
        || (!input.cursor && !input.pageAuthority)) {
        throw new Error("Invalid continuation authority");
      }
      if (input.pageAuthority) validateContinuationPageAuthority(input.pageAuthority, input.searchAuthority.pageSize);
      maxExpiresAt ??= input.pageAuthority?.expiresAt;
      build = (common) => ({
        ...common,
        kind: "continuation",
        searchAuthority: deepFreezeClone(input.searchAuthority),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.pageAuthority ? { pageAuthority: deepFreezeClone(input.pageAuthority) } : {})
      });
    } else {
      const input = request.input;
      if (!input.documentId.startsWith("rep:") || !input.objectClass) throw new Error("Invalid result authority");
      build = (common) => ({
        ...common,
        kind: "result",
        scopeId: context.scopeId,
        documentId: input.documentId,
        objectClass: input.objectClass,
        ...(input.verificationPlan ? { verificationPlan: deepFreezeClone(input.verificationPlan) } : {})
      });
    }
    const key = this.keys.get(this.config.activeKid);
    if (!key) throw new Error("Active handle key unavailable");
    const issuedAt = Math.floor(this.clock() / 1000);
    const expiresAt = Math.min(issuedAt + this.config.ttlSeconds, maxExpiresAt ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new Error("Invalid handle expiry lineage");
    const locator = randomBytes(OPAQUE_HANDLE_LIMITS.locatorBytes).toString("base64url");
    const common: CommonHandleRecord = {
      kid: key.kid,
      issuedAt,
      expiresAt,
      contractGeneration: this.config.contractGeneration,
      policyFingerprint: this.policyFingerprint(key, kind, context)
    };
    const envelope: PublicEnvelope = {
      v: 1,
      k: kind,
      kid: key.kid,
      loc: locator,
      iat: issuedAt,
      exp: expiresAt,
      gen: this.config.contractGeneration
    };
    const body = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    const tag = envelopeTag(key.envelopeAuthentication, body);
    const ref = `${HANDLE_PREFIX}.${body}.${tag}`;
    if (ref.length > OPAQUE_HANDLE_LIMITS.maxEncodedLength) throw new Error("Encoded handle exceeds bound");
    return {
      ref,
      index: storeIndex(key.storeIndex, key.kid, locator),
      record: build(common),
      expiresAtMs: expiresAt * 1000
    };
  }

  private authenticateEnvelope(ref: string): { envelope: PublicEnvelope; key: DerivedKey } {
    if (typeof ref !== "string" || ref.length < 1 || ref.length > OPAQUE_HANDLE_LIMITS.maxEncodedLength) throw new Error("unavailable");
    const [prefix, body, tag, extra] = ref.split(".");
    if (prefix !== HANDLE_PREFIX || !body || !tag || extra
      || body.length > OPAQUE_HANDLE_LIMITS.maxBodyLength
      || tag.length !== 43
      || !/^[A-Za-z0-9_-]+$/.test(body)
      || !/^[A-Za-z0-9_-]+$/.test(tag)) throw new Error("unavailable");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { throw new Error("unavailable"); }
    const envelope = parseEnvelope(value);
    const knownKey = this.keys.get(envelope.kid);
    const key = knownKey ?? this.keys.get(this.config.activeKid);
    if (!key) throw new Error("unavailable");
    const expectedTag = envelopeTag(key.envelopeAuthentication, body);
    const authentic = constantTimeTextEqual(tag, expectedTag);
    if (!knownKey || !authentic) throw new Error("unavailable");
    return { envelope, key };
  }

  private policyFingerprint(key: DerivedKey, kind: OpaqueHandleKind, context: HandlePolicyContext): string {
    const tokenSha256 = context.profile.tokenSha256;
    if (typeof tokenSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(tokenSha256)) {
      throw new Error("Authenticated token authority is unavailable");
    }
    const policy = canonicalStringify({
      binding_schema_version: CONTRACT_BINDING_SCHEMA_VERSION,
      contract_generation: this.config.contractGeneration,
      credential_context_generation: this.config.credentialContextGeneration,
      permitted_operation: OPERATION_BY_KIND[kind],
      handle_kind: kind,
      client_profile_id: context.profile.clientProfileId,
      token_sha256: tokenSha256.toLowerCase(),
      allowed_scopes: [...context.profile.allowedScopes].sort(),
      allowed_tools: [...context.profile.allowedTools].sort(),
      selected_scope_id: context.scopeId,
      selected_scope_policy: canonicalScopePolicy(context.scope)
    });
    return createHmac("sha256", key.policyFingerprint)
      .update("arcsuite-mcp-policy-fingerprint-v1\0")
      .update(policy, "utf8")
      .digest("base64url");
  }
}

function validateServiceConfig(config: OpaqueHandleConfig): void {
  if (!Number.isSafeInteger(config.ttlSeconds) || config.ttlSeconds < 1 || config.ttlSeconds > OPAQUE_HANDLE_LIMITS.maxTtlSeconds) throw new Error("Invalid opaque handle TTL");
  if (!Number.isSafeInteger(config.capacity) || config.capacity < 1 || config.capacity > OPAQUE_HANDLE_LIMITS.maxCapacity) throw new Error("Invalid opaque handle capacity");
  if (!Number.isSafeInteger(config.capacityPerProfile) || config.capacityPerProfile < 1 || config.capacityPerProfile > config.capacity) throw new Error("Invalid opaque handle per-profile capacity");
  if (!Number.isSafeInteger(config.contractGeneration) || config.contractGeneration < 1) throw new Error("Invalid handle contract generation");
  if (!Number.isSafeInteger(config.credentialContextGeneration) || config.credentialContextGeneration < 1) throw new Error("Invalid credential context generation");
  if (!Array.isArray(config.keys) || config.keys.length < 1 || config.keys.length > OPAQUE_HANDLE_LIMITS.maxValidationKeys) throw new Error("Invalid opaque handle key count");
  const kids = new Set<string>();
  for (const key of config.keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key.kid)) throw new Error("Invalid opaque handle kid");
    if (kids.has(key.kid)) throw new Error("Duplicate opaque handle kid");
    kids.add(key.kid);
    if (!Buffer.isBuffer(key.secret) || key.secret.length < OPAQUE_HANDLE_LIMITS.minKeyBytes || key.secret.length > OPAQUE_HANDLE_LIMITS.maxKeyBytes) throw new Error("Invalid opaque handle key length");
  }
  if (!kids.has(config.activeKid)) throw new Error("Active opaque handle kid is missing");
}

function deriveKeys(input: HandleKeyConfig): DerivedKey {
  const derive = (domain: string): Buffer => Buffer.from(hkdfSync(
    "sha256",
    input.secret,
    Buffer.alloc(0),
    Buffer.from(`arcsuite-mcp/opaque-handle/${domain}/v1`, "utf8"),
    32
  ));
  return Object.freeze({
    kid: input.kid,
    envelopeAuthentication: derive("envelope-authentication"),
    storeIndex: derive("store-index"),
    policyFingerprint: derive("policy-fingerprint")
  });
}

function envelopeTag(key: Buffer, body: string): string {
  return createHmac("sha256", key)
    .update("arcsuite-mcp-envelope-authentication-v1\0")
    .update(body, "utf8")
    .digest("base64url");
}

function storeIndex(key: Buffer, kid: string, locator: string): string {
  return `${kid}.${createHmac("sha256", key)
    .update("arcsuite-mcp-store-index-v1\0")
    .update(Buffer.from(locator, "base64url"))
    .digest("base64url")}`;
}

function parseEnvelope(value: unknown): PublicEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unavailable");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "exp,gen,iat,k,kid,loc,v") throw new Error("unavailable");
  if (record.v !== 1 || (record.k !== "search" && record.k !== "continuation" && record.k !== "result")
    || typeof record.kid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.kid)
    || typeof record.loc !== "string" || record.loc.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(record.loc)
    || Buffer.from(record.loc, "base64url").length !== OPAQUE_HANDLE_LIMITS.locatorBytes
    || !Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp) || !Number.isSafeInteger(record.gen)) throw new Error("unavailable");
  return record as PublicEnvelope;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateContinuationPageAuthority(authority: ContinuationPageAuthority, pageSize: number): void {
  if (typeof authority.authorityId !== "string" || !/^[0-9a-f-]{36}$/i.test(authority.authorityId)
    || !Number.isSafeInteger(authority.offset) || authority.offset < 0
    || !Number.isSafeInteger(authority.expiresAt)
    || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Invalid continuation page authority");
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite canonical value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([name, child]) => `${JSON.stringify(name)}:${canonicalStringify(child)}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}

function canonicalScopePolicy(scope: SemanticScope): Record<string, unknown> {
  return {
    arcsuite: {
      service_dn: scope.arcsuite.service_dn,
      cabinet_id: scope.arcsuite.cabinet_id,
      root_object_id: scope.arcsuite.root_object_id,
      resolve_references: scope.arcsuite.resolve_references
    },
    allowed_object_types: [...scope.allowed_object_types].sort(),
    default_attr_ids: scope.default_attr_ids
      .map((attr) => ({ ns: attr.ns, name: attr.name }))
      .sort((left, right) => `${left.ns}\0${left.name}`.localeCompare(`${right.ns}\0${right.name}`)),
    semantic_attributes: Object.fromEntries(Object.entries(scope.semantic_attributes).map(([name, value]) => [name, {
      ...value,
      operators: [...value.operators].sort()
    }])),
    content_labels: scope.content_labels,
    relationships: scope.relationships,
    integrity: scope.integrity,
    search: scope.search?.full_text_modes
      ? { full_text_modes: [...scope.search.full_text_modes].sort() }
      : scope.search
  };
}

function deepFreezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value) as T;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value) as T;
  }
  return value;
}

function refUnavailable(): McpToolError {
  return new McpToolError(
    "ARCSUITE_REF_UNAVAILABLE",
    "ref_unavailable",
    false,
    "ARCSUITE_REF_UNAVAILABLE",
    "search_again"
  );
}
