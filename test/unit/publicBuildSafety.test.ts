import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const templates = ["docker-compose.example.yml", ".env.example", ".env.compose.example"];
const syntheticMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "arcsuite-hygiene-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const file of ["check-public-hygiene.mjs", "markerHashes.mjs"]) {
    await copyFile(resolve("scripts", file), join(root, "scripts", file));
  }
  for (const file of templates) await copyFile(resolve(file), join(root, file));
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, ["scripts/check-public-hygiene.mjs"], {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024
  });
}

test("real public placeholders pass the expanded hygiene gate", async (t) => {
  const root = await fixture(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

for (const file of templates) {
  test(`hygiene scans ${file} and still passes after synthetic marker removal`, async (t) => {
    const root = await fixture(t);
    const original = await readFile(join(root, file), "utf8");
    for (const [marker, reason] of [
      [syntheticMarker, "possible credential/secret pattern"],
      [["synthetic", ".internal"].join(""), "private/internal hostname"]
    ]) {
      await writeFile(join(root, file), original + "\n# synthetic test only\n" + marker + "\n");
      const failed = run(root);
      assert.equal(failed.status, 1);
      assert.ok(failed.stderr.includes(file + ": " + reason));
      assert.equal(failed.stderr.includes(marker!), false);
    }
    await writeFile(join(root, file), original);
    assert.equal(run(root).status, 0);
  });

  test(`hygiene rejects missing required public template ${file}`, async (t) => {
    const root = await fixture(t);
    await rm(join(root, file));
    assert.equal(run(root).status, 1);
  });
}

for (const file of [".env.staging.example", ".env.staging.us.example", "docker-compose.extra.example.yaml"]) {
  test(`future public template ${file} is discovered automatically`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, file), syntheticMarker);
    assert.equal(run(root).status, 1);
  });
}

test("local operator environment files remain outside the public-template scan", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".env"), syntheticMarker);
  await writeFile(join(root, ".env" + ".local"), syntheticMarker);
  assert.equal(run(root).status, 0);
});

test("public-template symlinks cannot bypass required coverage", async (t) => {
  const root = await fixture(t);
  await rm(join(root, templates[0]!));
  await symlink(join(root, templates[1]!), join(root, templates[0]!));
  assert.equal(run(root).status, 1);
});

test("existing source scan roots retain coverage", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "synthetic.ts"), "// " + syntheticMarker);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("src/synthetic.ts"));
});

test("both build contexts retain explicit environment and secret exclusions", async () => {
  for (const path of [".dockerignore", "adapter-java/.dockerignore"]) {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).map((line) => line.trim());
    for (const pattern of [".env", ".env.*", "**/.env", "**/.env.*", "*.pem", "*.key", "*.secret", "*.wsdl", "*.trace"]) {
      assert.ok(lines.includes(pattern), `${path} must exclude ${pattern}`);
    }
  }
});
