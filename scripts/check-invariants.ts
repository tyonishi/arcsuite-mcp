import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertOperationAllowlistSafe, V1_SOAP_OPERATION_ALLOWLIST } from "../src/arcsuite/operationAllowlist.ts";

assertOperationAllowlistSafe();
const forbiddenCallTokens = [
  "enableAdministratorMode(",
  "assertPrivilege(",
  "getRepositoryObjectContentForPrint(",
  "changeRepositoryObjectAcl(",
  "changeRepositoryObjectDefaultAcl(",
  "deleteRepositoryObject(",
  "deleteRepositoryObjects(",
  "terminateProcess(",
  "terminateProcesses(",
  "executeDelegatedAction(",
  "executeDelegatedActionByName("
];
for (const root of [join(process.cwd(), "src"), join(process.cwd(), "adapter-java", "src", "main", "java")]) {
  if (!existsSync(root)) continue;
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    for (const needle of forbiddenCallTokens) {
      if (text.includes(needle)) throw new Error(`Forbidden call-like token '${needle}' found in ${file}`);
    }
    if (/administratorMode\s*[=:]\s*true/.test(text) || /administratorMode=["']true["']/.test(text)) {
      throw new Error(`administratorMode=true found in ${file}`);
    }
  }
}
if (V1_SOAP_OPERATION_ALLOWLIST.size !== 21) throw new Error(`Unexpected v1 SOAP allowlist size: ${V1_SOAP_OPERATION_ALLOWLIST.size}`);

const javaSoapSourcePath = join(process.cwd(), "adapter-java", "src", "main", "java", "biz", "capricornus", "arcsuite", "mcp", "adapter", "ArcSuiteSoapClient.java");
if (existsSync(javaSoapSourcePath)) {
  const javaSoapSource = readFileSync(javaSoapSourcePath, "utf8");
  const javaAllowlist = javaSoapSource.match(/READ_ONLY_OPERATIONS\s*=\s*Set\.of\(([^]*?)\);/);
  if (!javaAllowlist) throw new Error("Java SOAP read-only allowlist is missing");
  const javaOperations = [...javaAllowlist[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const javaSet = new Set(javaOperations);
  const missingInJava = [...V1_SOAP_OPERATION_ALLOWLIST].filter((operation) => !javaSet.has(operation));
  const missingInTypeScript = [...javaSet].filter((operation) => !V1_SOAP_OPERATION_ALLOWLIST.has(operation));
  if (missingInJava.length || missingInTypeScript.length) {
    throw new Error(`TypeScript/Java SOAP allowlists diverge: missingInJava=${missingInJava.join(",")}; missingInTypeScript=${missingInTypeScript.join(",")}`);
  }
}

const toolSource = readFileSync(join(process.cwd(), "src", "mcp", "tools.ts"), "utf8");
const requiredTools = [
  "arcsuite_search_documents",
  "arcsuite_get_document",
  "arcsuite_list_folder",
  "arcsuite_list_document_revisions",
  "arcsuite_get_document_content_info",
  "arcsuite_read_document"
];
for (const tool of requiredTools) {
  if (!toolSource.includes(`name: "${tool}"`)) throw new Error(`Required v1 tool missing: ${tool}`);
}
if (/name:\s*["']arcsuite_find_/i.test(toolSource)) throw new Error("Organization-specific find tool leaked into core tool registry");
if (!/structuredContent\s*:\s*data/.test(toolSource)) throw new Error("Tool results are not structurally bounded at the semantic registry");
for (const guard of ["assertRepositoryObjectsInScope", "assertRepositoryObjectInScope", "assertObjectIdInScope", "verifyReturnedRootScope"]) {
  if (!toolSource.includes(guard)) throw new Error(`Scope response guard is missing: ${guard}`);
}
for (const containerfile of [join(process.cwd(), "Containerfile"), join(process.cwd(), "adapter-java", "Containerfile")]) {
  const containerSource = readFileSync(containerfile, "utf8");
  for (const match of containerSource.matchAll(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?\s*$/gim)) {
    if (!/@sha256:[0-9a-f]{64}$/i.test(match[1])) throw new Error(`Container base image is not digest-pinned: ${containerfile}`);
  }
}
const adapterDockerignorePath = join(process.cwd(), "adapter-java", ".dockerignore");
if (!existsSync(adapterDockerignorePath)) throw new Error("Java adapter build context is missing adapter-java/.dockerignore");
const adapterDockerignore = new Set(readFileSync(adapterDockerignorePath, "utf8").split(/\r?\n/).map((line) => line.trim()));
for (const pattern of ["*.wsdl", "*.xsd", "*.jar", "*.msg", "*.docx", "*.pptx", "*.pdf", "vendor/", "vendor-material/", "local-secrets/", "*.pem", "*.key", "*.p12", "*.pfx", "*.soap", "*.trace"]) {
  if (!adapterDockerignore.has(pattern)) throw new Error(`Java adapter build context does not exclude ${pattern}`);
}
const podmanScriptPath = join(process.cwd(), "podman", "podman-run.example.sh");
if (process.platform !== "win32" && (statSync(podmanScriptPath).mode & 0o111) === 0) {
  throw new Error("Podman example script must be executable");
}
const podmanScript = readFileSync(podmanScriptPath, "utf8");
if (podmanScript.includes("config/tokens.json")) {
  throw new Error("Podman example must not require or mount ignored config/tokens.json; use the mcp_tokens secret");
}
if (!podmanScript.includes("--secret mcp_tokens,type=mount,target=/run/secrets/mcp_tokens")) {
  throw new Error("Podman example must mount the mcp_tokens secret");
}
if (!podmanScript.includes("-v arcsuite-mcp-logs:/var/log/arcsuite-mcp:rw") ||
    !podmanScript.includes("MCP_AUDIT_LOG_PATH=/var/log/arcsuite-mcp/audit.jsonl")) {
  throw new Error("Podman audit volume must align with the non-root Containerfile log directory");
}
const rootContainerfile = readFileSync(join(process.cwd(), "Containerfile"), "utf8");
if (!rootContainerfile.includes("/var/log/arcsuite-mcp")) {
  throw new Error("Root Containerfile must provision the audit log directory");
}
const workflowsDir = join(process.cwd(), ".github", "workflows");
if (existsSync(workflowsDir)) {
  for (const file of walkAll(workflowsDir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = readFileSync(file, "utf8");
    for (const match of workflow.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)) {
      if (!/^[0-9a-f]{40}$/i.test(match[1])) throw new Error(`GitHub Action is not pinned to a full commit SHA: ${file}`);
    }
  }
}
console.log("Security invariant source check: PASS");

function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|js|java)$/.test(name)) out.push(path);
  }
  return out;
}

function walkAll(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkAll(path));
    else out.push(path);
  }
  return out;
}
