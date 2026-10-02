import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/check-secret-readability.sh");
const variables = ["ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE", "MCP_CURSOR_HMAC_SECRET_FILE", "ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE", "ARCSUITE_PASSWORD_FILE", "MCP_OPAQUE_REF_KEYS_JSON_FILE"];

test("secret preflight checks service-specific files without exposing paths or content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-secret-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "synthetic-private-path");
  await writeFile(file, "synthetic-private-content");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const variable of variables) env[variable] = file;
  function run(role: string, overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync("sh", [script, role], { env: { ...env, ...overrides }, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal((result.stdout + result.stderr).includes(dir), false);
    assert.equal((result.stdout + result.stderr).includes("synthetic-private"), false);
    return result;
  }
  assert.equal(run("gateway").status, 0);
  assert.equal(run("adapter").status, 0);
  const stdinScript = await readFile(script, "utf8");
  for (const role of ["gateway", "adapter"]) {
    const stdin = spawnSync("sh", ["-s", "--", role], { input: stdinScript, env, encoding: "utf8" });
    assert.equal(stdin.status, 0, stdin.stderr);
    assert.match(stdin.stdout, new RegExp(`service=${role} `));
    const extra = spawnSync("sh", ["-s", "--", "check-secret-readability", role], { input: stdinScript, env, encoding: "utf8" });
    assert.equal(extra.status, 2, "A dummy argument would violate the one-role contract for sh -s");
  }

  assert.equal(run("gateway", { ARCSUITE_PASSWORD_FILE: undefined }).status, 0);
  assert.equal(run("adapter", { MCP_CURSOR_HMAC_SECRET_FILE: undefined }).status, 0);
  for (const role of ["gateway", "adapter"]) {
    assert.equal(run(role, { ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE: undefined }).status, 1);
    assert.equal(run(role, { ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE: dir }).status, 1);
    assert.equal(run(role, { ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE: join(dir, "missing") }).status, 1);
  }
  const missing = run("gateway", { MCP_CURSOR_HMAC_SECRET_FILE: undefined });
  assert.match(missing.stderr, /variable=MCP_CURSOR_HMAC_SECRET_FILE/);
  assert.equal(run("gateway", { MCP_OPAQUE_REFS_ENABLED: "true" }).status, 0);
  assert.equal(run("gateway", { MCP_OPAQUE_REFS_ENABLED: "true", MCP_OPAQUE_REF_KEYS_JSON_FILE: undefined }).status, 1);
  assert.equal(run("gateway", { MCP_OPAQUE_REFS_ENABLED: "invalid" }).status, 1);
  assert.equal(run("unknown").status, 2);
});

test("documented preflight uses actual service identity before startup", async () => {
  const doc = await readFile("docs/deployment.md", "utf8");
  const gateway = doc.indexOf("--entrypoint /bin/sh mcp-gateway -s -- gateway < scripts/check-secret-readability.sh");
  const adapter = doc.indexOf("--entrypoint /bin/sh arcsuite-adapter -s -- adapter < scripts/check-secret-readability.sh");
  const up = doc.indexOf("docker compose --env-file .env -f docker-compose.yml up -d");
  assert.ok(gateway > 0 && adapter > gateway && up > adapter);
  const commands = doc.slice(doc.lastIndexOf("docker compose", gateway), up);
  assert.equal(commands.includes("--user"), false);
  assert.ok(commands.includes("--no-deps -T"));
});
