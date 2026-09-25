# ADR 0008: Trusted Semantic Guidance Manifest

- Status: accepted
- Date: 2026-09-25

## Context

`arcsuite_describe_capabilities` already describes profile-allowed semantic
scopes and filters, including canonical names, types, operators, and supported
constraints. Those names alone do not always tell an LLM when to choose a
scope, how a business concept is commonly phrased, or how similarly named
semantic attributes differ.

Keeping ArcSuite-specific vocabulary only in a Dify system prompt would
duplicate knowledge outside the MCP semantic contract and allow the two
configurations to drift. The MCP server should be self-describing at its
semantic layer while continuing to hide physical ArcSuite implementation
details.

## Decision

Add a trusted, operator-configured Semantic Guidance Manifest to scope and
semantic-attribute configuration. Scope guidance describes the semantic scope,
not its physical cabinet. The existing scope `description` remains the
authoritative business description; no second scope-description field is
introduced.

Both a scope and a semantic attribute may have a `guidance` object with these
optional string arrays:

- `aliases`: natural-language vocabulary hints;
- `use_when`: situations in which the semantic concept may be selected;
- `not_for`: distinctions from similar concepts that should not be selected;
- `examples`: illustrative natural-language user intents.

A semantic attribute may also have an optional `description` explaining what
that canonical semantic concept means. Scope and attribute descriptions and
guidance are returned by `arcsuite_describe_capabilities` only when configured
and only for scopes allowed by the authenticated token profile.

For example, `部品番号` may help an LLM select the canonical semantic filter
`part_number`. It does not become an executable filter name: a search request
with `filters: {"部品番号": "PART-001"}` remains invalid. Search accepts only
configured canonical semantic keys.

## Guidance metadata bounds

The bounded-prose rules apply to newly introduced semantic-attribute
descriptions and guidance entries. Each semantic-attribute description is
limited to 512 characters; guidance arrays contain at most eight entries, each
limited to 256 characters. For aggregate bounds, a semantic attribute's
description and all four guidance arrays total at most 2,048 characters;
scope-level guidance totals at most 4,096 characters; and all new guidance
metadata under one scope totals at most 32,768 characters. These totals include
semantic-attribute descriptions and every guidance array, but exclude the
pre-existing scope `description`.

The required scope `description` retains its previous non-empty string
validation and is not subject to the new prose or aggregate bounds. Counts use
JavaScript string-length units.

## Guidance authoring evidence

ArcSuite `AttributeSchema` metadata, including physical `displayNames`, MAY be
used as trusted evidence by operators when authoring semantic descriptions and
guidance. Physical display names are evidence, not semantic authority: they
MUST NOT be automatically copied into public descriptions, guidance aliases,
or executable semantic mappings. `arcsuite_describe_capabilities` MUST NOT
automatically expose physical `displayNames`; public descriptions and guidance
remain explicitly operator-configured.

When an attribute's business meaning is ambiguous, operators MUST qualify it
against representative data and/or with the relevant business domain before
publishing semantic guidance. Physical Attribute IDs and raw
`AttributeSchema` metadata remain private. This authoring allowance does not
change the public capability contract.

## Trusted-source and authority boundary

Guidance is explanatory metadata, advisory, and never authoritative. It is
accepted only from trusted server/operator configuration. The server does not
derive it from ArcSuite document content, retrieved text, user prompts, model
output, WSDL contents, or arbitrary remote sources. This keeps retrieved and
user-controlled text out of the trusted guidance channel.

Guidance cannot:

- expand token-profile `allowedScopes` or change token profiles;
- add tools, semantic attributes, or operators;
- change semantic cardinality, physical Attribute IDs, or cabinet/root
  selection;
- bypass root, path, object-type, or scope membership checks;
- become an alias resolver or participate in filter parsing, canonicalization,
  operator selection, scope resolution, or physical Attribute selection;
- expose credentials, tokens, sessions, or physical ArcSuite configuration.

The public capability response must not include `cabinet_id`,
`root_object_id`, physical `attr_id`, service endpoints, session IDs,
credentials, tokens, or SOAP/WSDL implementation details. Search execution
continues to map canonical semantic keys through the existing deterministic
semantic configuration to internal physical attributes. Result projection
continues to expose only configured semantic attributes.

## Compatibility and exclusions

This is an additive metadata change. Clients that ignore the optional fields
continue to work. Search and result authority do not change, and the public
capability version remains `1.2` because no repository versioning rule
requires a bump for this addition.

This decision does not add semantic alias execution, automatic scope routing,
model-driven policy, Dify workflow/prompt/planner/formatter/token changes,
token-profile scope changes, SOAP operations, WSDL changes, search algorithm
changes, physical Attribute mapping changes, `default_attr_ids` changes,
automatic skill generation, document-derived guidance, or 3D enablement. No
Java adapter change is required. The expected SOAP operation delta is none.

## Consequences

Configuration validation bounds the newly introduced semantic-attribute
descriptions and guidance entries, enforces their aggregate limits, and rejects
malformed guidance at startup. The manifest provides a deterministic LLM-facing
semantic description that can be inspected without using model behavior as a
test oracle. Production vocabulary authoring, qualification of ambiguous
business semantics, and any later Dify characterization remain separate
operator tasks.
