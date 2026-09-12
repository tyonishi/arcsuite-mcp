#!/usr/bin/env node
/**
 * Public-tree hygiene gate.
 *
 * Keep this list explicit and review it when private prototypes, licensed
 * vendor material, or environment-specific fixtures change. The checker is
 * intentionally repository-local so the same rule runs before every commit
 * and in CI without access to private project history.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findForbiddenMarker } from "./markerHashes.mjs";

const root = process.cwd();
const roots = [
  "README.md", "LICENSE", "NOTICE.md", "SECURITY.md", "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md", "CHANGELOG.md", "ROADMAP.md", "AGENTS.md",
  "package.json", "package-lock.json", "tsconfig.json", "Containerfile",
  ".editorconfig", ".gitignore", ".dockerignore", "config", "src", "adapter-java", "docs",
  "examples", "test", "scripts", "podman", ".github"
].map((item) => resolve(root, item));

const forbiddenFileExtensions = new Set([".wsdl", ".xsd", ".jar", ".war", ".ear", ".msg", ".docx", ".pptx", ".pdf"]);
const forbiddenPathParts = /(^|\/)(vendor|vendor-material|private|production-dump)(\/|$)/i;
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /(?:password|passwd|secret|token)\s*[:=]\s*["'](?!\$|REPLACE|CHANGE|YOUR|SET|TEST|0123456789abcdef|example|<)[^"']{16,}["']/i
];

const violations = [];
for (const start of roots) {
  if (!existsSync(start)) continue;
  for (const file of walk(start)) inspect(file);
}

const docsDir = resolve(root, "docs");
if (existsSync(docsDir)) {
  for (const file of walk(docsDir)) {
    if (!file.endsWith(".md")) violations.push(`${relative(root, file)}: documentation must be Markdown`);
  }
}

if (existsSync(resolve(root, "src"))) {
  for (const file of walk(resolve(root, "src"))) {
    const text = safeText(file);
    if (/dify/i.test(text)) violations.push(`${relative(root, file)}: Dify-specific material is not allowed in core source`);
  }
}

if (violations.length) {
  console.error("Public hygiene check: FAIL");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Public hygiene check: PASS");
}

function walk(path) {
  const stat = lstatSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

function inspect(file) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (rel === "scripts/check-public-hygiene.mjs") return;
  const lower = rel.toLowerCase();
  if (forbiddenPathParts.test(rel)) violations.push(`${rel}: private/vendor path`);
  for (const extension of forbiddenFileExtensions) {
    if (lower.endsWith(extension)) violations.push(`${rel}: prohibited vendor/binary document extension ${extension}`);
  }
  const stat = lstatSync(file);
  if (stat.size > 10 * 1024 * 1024) {
    violations.push(`${rel}: unexpectedly large public file`);
    return;
  }
  const text = safeText(file);
  const marker = findForbiddenMarker(text);
  if (marker) violations.push(`${rel}: forbidden private marker ${marker}`);
  if (/\b[a-z0-9-]+\.(?:corp|internal|intra|lan|local)\b/i.test(text)) {
    violations.push(`${rel}: private/internal hostname`);
  }
  if (/(?:@|mailto:)[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*(?:corp|internal|intra|local)\b/i.test(text)) {
    violations.push(`${rel}: private email domain`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) violations.push(`${rel}: possible credential/secret pattern`);
  }
  if (/Content-ID:\s*</i.test(text) && /multipart\/related/i.test(text) && !/SelfTest|synthetic|fixture/i.test(text)) {
    violations.push(`${rel}: possible production SOAP/MTOM dump`);
  }
}

function safeText(file) {
  try {
    const data = readFileSync(file);
    if (data.includes(0)) return "";
    return data.toString("utf8");
  } catch {
    return "";
  }
}
