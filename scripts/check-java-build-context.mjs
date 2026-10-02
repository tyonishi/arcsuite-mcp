#!/usr/bin/env node
/** Validate the real Docker ignore matcher with tracked Java sources and synthetic markers only. */
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** Execute a bounded local build command, never interpolating a shell command. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Build-context verification command failed: ${command}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

const repo = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "arcsuite-build-context-"));
try {
  const context = join(temporary, "context");
  const output = join(temporary, "output");
  await mkdir(context);
  const tracked = run("git", ["ls-files", "-z", "--", "adapter-java"], repo).split("\0").filter(Boolean);
  assert.ok(tracked.includes("adapter-java/.dockerignore"));
  for (const source of tracked) {
    assert.ok(source.startsWith("adapter-java/") && !source.includes(".."));
    const target = join(context, source.slice("adapter-java/".length));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(repo, source), target);
    await chmod(target, (await stat(resolve(repo, source))).mode & 0o777);
  }
  // These files contain harmless labels, never genuine credentials or vendor material.
  const excluded = [".env", ".env" + ".local", ".env.compose.example", "nested/.env", "nested/.env.test", "synthetic.pem", "synthetic.secret", "synthetic.wsdl", "synthetic.trace"];
  for (const name of excluded) {
    await mkdir(dirname(join(context, name)), { recursive: true });
    await writeFile(join(context, name), "SYNTHETIC_BUILD_CONTEXT_MARKER\n");
  }
  const probe = join(temporary, "probe.Containerfile");
  await writeFile(probe, "FROM scratch\nCOPY . /\n");
  // No RUN instructions or base-image pull; this exercises Docker's own ignore implementation.
  run("docker", ["buildx", "build", "--network=none", "--progress=plain", "--file", probe,
    "--output", `type=local,dest=${output}`, context], repo);
  for (const name of excluded) {
    await assert.rejects(stat(join(output, name)), { code: "ENOENT" });
  }
  for (const name of await readdir(output, { recursive: true })) {
    const path = join(output, name);
    if ((await stat(path)).isFile()) {
      assert.equal((await readFile(path)).includes(Buffer.from("SYNTHETIC_BUILD_CONTEXT_MARKER")), false, "Synthetic exclusion marker reached builder output");
    }
  }
  for (const source of tracked.filter((path) => path.includes("/src/") || /\/(?:compile\.sh|build\.gradle|settings\.gradle)$/.test(path))) {
    const relative = source.slice("adapter-java/".length);
    assert.deepEqual(await readFile(join(output, relative)), await readFile(resolve(repo, source)), `Required build source changed: ${relative}`);
  }
  // Compile the exported source, not the original checkout: verifies necessary inputs survived.
  run("sh", ["./compile.sh"], output);
  assert.ok((await stat(join(output, "build/classes/biz/capricornus/arcsuite/mcp/adapter/Main.class"))).isFile());
  console.log("Java build-context exclusion and staged-source compilation: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
