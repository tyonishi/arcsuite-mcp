import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalizeFilter } from "../../src/semantic/attributeMapper.ts";
import { ScopeRegistry, type ScopeRegistryData } from "../../src/semantic/scopeRegistry.ts";

const source = parseYaml(readFileSync(resolve("config/scopes.mock.yaml"), "utf8")) as ScopeRegistryData;

function registryData(): ScopeRegistryData {
  return structuredClone(source);
}

function registry(data = registryData()): ScopeRegistry {
  return new ScopeRegistry(data);
}

function addPartNumber(data: ScopeRegistryData): void {
  const scope = data.scopes.example_documents as any;
  scope.semantic_attributes.part_number = {
    attr_id: { ns: "rep", name: "user:example_part_number" },
    type: "string",
    operators: ["eq", "like"],
    guidance: {
      aliases: ["部品番号"],
      use_when: ["The request identifies a component."],
      not_for: ["Do not use this for a document's own identifier."],
      examples: ["Find component PART-001"]
    }
  };
}

function boundedEntries(prefix: string, count: number, length = 256): string[] {
  return Array.from({ length: count }, (_, index) =>
    `${prefix}${String(index).padStart(3, "0")}${"x".repeat(length - prefix.length - 3)}`
  );
}

function addSyntheticAttribute(scope: any, name: string, description: string): void {
  scope.semantic_attributes[name] = {
    attr_id: { ns: "rep", name: `user:${name}` },
    type: "string",
    operators: ["eq"],
    description
  };
}

test("scope guidance and semantic attribute prose remain optional", () => {
  const data = registryData();
  const scope: any = data.scopes.example_documents;
  delete scope.guidance;
  delete scope.semantic_attributes.document_number.description;
  delete scope.semantic_attributes.document_number.guidance;

  const described: any = registry(data).describe(["example_documents"])[0];
  const filter = described.filters.find((item: any) => item.name === "document_number");
  assert.equal(Object.hasOwn(described, "guidance"), false);
  assert.equal(Object.hasOwn(filter, "description"), false);
  assert.equal(Object.hasOwn(filter, "guidance"), false);
});

test("capability descriptions contain configured scope and attribute guidance only", () => {
  const data = registryData();
  const scope: any = data.scopes.example_documents;
  scope.guidance = {
    aliases: ["example repository", "sample document set"],
    use_when: ["The request concerns the synthetic example collection."],
    not_for: ["Do not use this scope for component inventory."],
    examples: ["Find a sample document"]
  };
  scope.semantic_attributes.document_number.description = "Synthetic identifier assigned to an example document.";
  scope.semantic_attributes.document_number.guidance = {
    aliases: ["document number", "document ID"],
    use_when: ["The request identifies one example document."],
    not_for: ["This is not a component or part identifier."],
    examples: ["Find document number DOC-000001"]
  };

  const described: any = registry(data).describe(["example_documents"])[0];
  const filter = described.filters.find((item: any) => item.name === "document_number");
  assert.deepEqual(described.guidance, scope.guidance);
  assert.equal(filter.description, scope.semantic_attributes.document_number.description);
  assert.deepEqual(filter.guidance, scope.semantic_attributes.document_number.guidance);

  const serialized = JSON.stringify(described);
  for (const forbidden of ["attr_id", "cabinet_id", "root_object_id", "EXAMPLE_CABINET", "example_document_number"]) {
    assert.equal(serialized.includes(forbidden), false, `public capability must omit ${forbidden}`);
  }
});

test("capability discovery omits guidance for scopes outside the requested profile", () => {
  const data = registryData();
  const other: any = structuredClone(data.scopes.example_documents);
  other.description = "Synthetic restricted repository";
  other.arcsuite.cabinet_alias = "OTHER_EXAMPLE_CABINET";
  other.arcsuite.cabinet_id = "rep:mock:OTHER_EXAMPLE_CABINET";
  other.guidance = { aliases: ["restricted collection"] };
  data.scopes.other_documents = other;

  const described = registry(data).describe(["example_documents"]);
  assert.deepEqual(described.map((scope) => scope.id), ["example_documents"]);
  assert.equal(JSON.stringify(described).includes("restricted collection"), false);
});

test("legacy scope descriptions retain their previous non-empty string validation", () => {
  const data = registryData();
  (data.scopes.example_documents as any).description = " x ".repeat(200);

  assert.doesNotThrow(() => registry(data));

  const emptyData = registryData();
  (emptyData.scopes.example_documents as any).description = "";
  assert.throws(() => registry(emptyData), /requires description/);
});

test("guidance aliases remain hints and are not executable filter keys or operators", () => {
  const data = registryData();
  addPartNumber(data);
  const scope = registry(data).get("example_documents");

  assert.throws(
    () => canonicalizeFilter(scope, "部品番号", "PART-001"),
    /Unsupported semantic filter: 部品番号/
  );
  assert.throws(
    () => canonicalizeFilter(scope, "part_number", { operator: "gte", value: "PART-001" }),
    /part_number does not allow gte/
  );
  const canonical = canonicalizeFilter(scope, "part_number", "PART-001");
  assert.deepEqual(canonical.condition.attrId, { ns: "rep", name: "user:example_part_number" });
});

const invalidGuidance: Array<[string, (scope: any) => void]> = [
  ["a non-object guidance value", (scope) => { scope.guidance = []; }],
  ["a null guidance value", (scope) => { scope.guidance = null; }],
  ["an unknown guidance key", (scope) => { scope.guidance = { synonyms: ["sample"] }; }],
  ["a non-array guidance field", (scope) => { scope.guidance = { aliases: "document number" }; }],
  ["a non-string array member", (scope) => { scope.guidance = { aliases: ["document number", 1] }; }],
  ["an empty-after-trimming member", (scope) => { scope.guidance = { aliases: ["   "] }; }],
  ["an overlong member", (scope) => { scope.guidance = { aliases: ["x".repeat(257)] }; }],
  ["an array with more than eight entries", (scope) => { scope.guidance = { aliases: Array.from({ length: 9 }, (_, i) => `alias ${i}`) }; }],
  ["duplicate entries", (scope) => { scope.guidance = { aliases: ["document number", "document number"] }; }],
  ["a control character in prose", (scope) => { scope.guidance = { examples: ["first\nsecond"] }; }],
  ["an overlong semantic description", (scope) => { scope.semantic_attributes.document_number.description = "x".repeat(513); }],
  ["a non-string semantic description", (scope) => { scope.semantic_attributes.document_number.description = 12; }]
];

for (const [caseName, configure] of invalidGuidance) {
  test(`scope registry rejects ${caseName}`, () => {
    const data = registryData();
    configure(data.scopes.example_documents as any);
    assert.throws(() => registry(data));
  });
}

test("all supported guidance arrays accept bounded prose", () => {
  const data = registryData();
  const scope: any = data.scopes.example_documents;
  scope.guidance = {
    aliases: ["sample repository"],
    use_when: ["The request is about a sample document."],
    not_for: ["The request is about a component."],
    examples: ["Find a sample document"]
  };
  scope.semantic_attributes.document_number.description = "Synthetic example document identifier.";
  scope.semantic_attributes.document_number.guidance = {
    aliases: ["document number"],
    use_when: ["The user supplies a document number."],
    not_for: ["The identifier belongs to a component."],
    examples: ["Find document number DOC-000001"]
  };

  assert.doesNotThrow(() => registry(data));
});

test("guidance aggregate bounds accept values exactly at every limit", () => {
  const data = registryData();
  const scope: any = data.scopes.example_documents;
  scope.guidance = {
    aliases: boundedEntries("s", 8),
    use_when: boundedEntries("t", 8)
  };

  const documentNumber = scope.semantic_attributes.document_number;
  documentNumber.description = "d".repeat(512);
  documentNumber.guidance = { aliases: boundedEntries("a", 6) };

  for (let index = 0; index < 52; index += 1) {
    const name = `aggregate_${index}`;
    addSyntheticAttribute(scope, name, "m".repeat(512));
  }

  assert.doesNotThrow(() => registry(data));
});

test("semantic attribute description and guidance reject aggregate text over 2048 characters", () => {
  const data = registryData();
  const attribute: any = (data.scopes.example_documents as any).semantic_attributes.document_number;
  attribute.description = "d".repeat(512);
  attribute.guidance = { aliases: [...boundedEntries("a", 6), "z"] };

  assert.throws(() => registry(data), /2048/);
});

test("scope guidance rejects aggregate text over 4096 characters", () => {
  const data = registryData();
  (data.scopes.example_documents as any).guidance = {
    aliases: boundedEntries("a", 8),
    use_when: boundedEntries("u", 8),
    not_for: ["z"]
  };

  assert.throws(() => registry(data), /4096/);
});

test("scope guidance manifest rejects aggregate text over 32768 characters", () => {
  const data = registryData();
  const scope: any = data.scopes.example_documents;
  scope.guidance = { aliases: ["g"] };
  for (let index = 0; index < 64; index += 1) {
    const name = `aggregate_${index}`;
    addSyntheticAttribute(scope, name, "m".repeat(512));
  }

  assert.throws(() => registry(data), /32768/);
});
