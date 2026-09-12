import { createHash } from "node:crypto";

// Keep only digests and lengths in the public tree. This lets the hygiene gate
// detect known private PoC markers without republishing those marker strings.
// To add a marker, calculate SHA-256 over its lowercase UTF-8 form and record
// the digest and UTF-16 length here; do not commit the plaintext marker.
const FORBIDDEN_MARKERS = Object.freeze([
  { id: "private-company-token", length: 7, digest: "7b989fe5889d6645056f3124f6992096225bb949894c59e50fba3ef42a8b8fde" },
  { id: "private-java-namespace", length: 13, digest: "0bccb975b21ad056dfd82b93b2107de032e169edda090a6884829d8973d38f73" },
  { id: "private-default-a", length: 8, digest: "8c14e042a86185d2ba1ec956fbbe86ed13f35b7d0407925f8e30a21d5f14ebbf" },
  { id: "private-example-id-a", length: 10, digest: "cde1d3570285b5cab5c80c6036658c2c13cc29797d83487b7e745b3b516b5353" },
  { id: "private-example-id-b", length: 10, digest: "a30d94804c51c676b17952443851e67b30005134140cf97bcda254f95e54f726" },
  { id: "private-attribute-a", length: 14, digest: "f8e808e204f14b02d4aa7b0a307dee25b4f2e459aa04ef6f03ec073187459d6e" },
  { id: "private-hostname", length: 11, digest: "49c4140e2a86ee06811ec1f0bd152bba396b5ce1b153528b9d977df903b01af7" },
  { id: "organization-specific-tool", length: 21, digest: "a72a621e8aaf60e34f70b0647604fe1e6a54af8f4474d46658aea42b637e3df1" },
  { id: "organization-specific-schema-a", length: 16, digest: "e32af4197c73b64cf82d6e7000d52d2d215971f982b2c7e502fd0b1792b7b68c" },
  { id: "organization-specific-schema-b", length: 14, digest: "58a3370e6bd3625a1690c407a822dda3b1f984789e2b507088c9ddef47d0e4fb" }
]);

export function findForbiddenMarker(text) {
  const lower = text.toLowerCase();
  for (const marker of FORBIDDEN_MARKERS) {
    for (let offset = 0; offset + marker.length <= lower.length; offset += 1) {
      const digest = createHash("sha256").update(lower.slice(offset, offset + marker.length), "utf8").digest("hex");
      if (digest === marker.digest) return marker.id;
    }
  }
  return undefined;
}
