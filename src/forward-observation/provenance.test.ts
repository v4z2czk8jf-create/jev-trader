import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { manifest, RULE_COMMIT, MARKET, verifyFrozenRules } from "./config";
import { assertGitIdentity, assertManifestProvenance, readGitIdentity, assertGitBinary, readHostGitPin } from "./provenance";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hash } from "./config";
import { ForwardController } from "./controller";
import { CampaignJournal } from "./journal";

const root = resolve(import.meta.dir, "../.."), runtime = "a".repeat(40), other = "b".repeat(40);
const T = Date.UTC(2026, 8, 21), safe = { dryRun: true, model: "mock", noEnvFile: true };
const make = () => manifest("provenance-fixture", T, safe, runtime);
const git = () => ({ root, head: runtime, status: "" });
// Test-only discovery; production receives the recorded pin, never PATH lookup.
const executable = Bun.which("git")!;
const pin = { gitExecutablePath: executable, gitVersion: execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
  gitSha256: hash(readFileSync(executable)) };

test("rule and runtime provenance are separate, legacy codeCommit keeps its meaning", () => {
  const m = make(); expect(m.ruleSourceCommit).toBe("91e0b07a7638f0c575ceabd8fb770c7e89eda88c");
  expect(m.codeCommit).toBe(RULE_COMMIT); expect(m.runtimeCodeCommit).toBe(runtime);
  expect(m.ruleSourceCommit).not.toBe(m.runtimeCodeCommit);
});
test("offline manifest does not invent an executed runtime commit", () => {
  const m = manifest("offline", T, safe); expect(m.runtimeCodeCommit).toBeNull();
  expect(() => assertManifestProvenance(m, runtime)).toThrow("RUNTIME_COMMIT_MISMATCH");
});
test("malformed runtime commit is refused", () => {
  expect(() => manifest("fixture", T, safe, "HEAD")).toThrow("INVALID_RUNTIME_COMMIT");
});
test("clean actual HEAD must equal the saved runtime commit", () => {
  expect(assertGitIdentity(git(), root, runtime)).toBe(runtime);
  expect(() => assertGitIdentity(git(), root, other)).toThrow("RUNTIME_COMMIT_MISMATCH");
  expect(() => assertManifestProvenance(make(), other)).toThrow("RUNTIME_COMMIT_MISMATCH");
});
test("dirty tracked, staged or untracked tree is refused", () => {
  for (const status of [" M src/file.ts\n", "M  src/file.ts\n", "?? unknown.ts\n"])
    expect(() => assertGitIdentity({ ...git(), status }, root)).toThrow("RUNTIME_WORKTREE_DIRTY");
});
test("wrong repository and invalid HEAD are refused", async () => {
  const otherRoot = await mkdtemp(join(tmpdir(), "forward-provenance-"));
  expect(() => assertGitIdentity(git(), otherRoot)).toThrow("REPOSITORY_MISMATCH");
  expect(() => assertGitIdentity({ ...git(), head: "unknown" }, root)).toThrow("INVALID_GIT_HEAD");
});
test("read-only Git identity uses the real local repository", () => {
  const actual = readGitIdentity(root, pin); expect(actual.head).toMatch(/^[0-9a-f]{40}$/);
  // Contents may be dirty during development; no claim that a dirty runtime is admissible.
  expect(assertGitIdentity({ ...actual, status: "" }, root, actual.head)).toBe(actual.head);
});

test("pinned Git rejects missing, relative, changed binary and wrong version", () => {
  expect(() => assertGitBinary({ ...pin, gitExecutablePath: "git" })).toThrow();
  expect(() => assertGitBinary({ ...pin, gitExecutablePath: join(root, "missing-git.exe") })).toThrow();
  expect(() => assertGitBinary({ ...pin, gitSha256: "0".repeat(64) })).toThrow("GIT_BINARY_PROVENANCE");
  expect(() => readGitIdentity(root, { ...pin, gitVersion: "git version 0" })).toThrow("GIT_VERSION_MISMATCH");
});

test("fixed Git works in a child with empty PATH and explicit repository cwd", () => {
  const code = `import {readGitIdentity} from './src/forward-observation/provenance.ts';
    console.log(JSON.stringify(readGitIdentity(process.cwd(),JSON.parse(process.env.TEST_GIT_PIN!))));`;
  const value = execFileSync(process.execPath, ["--no-env-file", "--eval", code], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, PATH: "", TEST_GIT_PIN: JSON.stringify(pin) } });
  const actual = JSON.parse(value);
  expect(actual).toEqual(readGitIdentity(root, pin));
});

test("runner reloads the host Git pin and rejects mismatched host provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-git-pin-"));
  const file = join(directory, "manifest.json");
  const previous = process.env.FORWARD_HOST_MANIFEST;
  const host = { ...pin, schema: "forward-task-host-v1", mode: "Forward", repoRoot: root,
    ruleCommit: RULE_COMMIT, runtimeCommit: runtime, dryRun: "true", model: "mock", noEnvFile: true };
  try {
    process.env.FORWARD_HOST_MANIFEST = file;
    await writeFile(file, JSON.stringify(host));
    expect(readHostGitPin()).toEqual(host);
    for (const patch of [{ ruleCommit: other }, { runtimeCommit: "HEAD" }, { mode: "Fixture" },
      { noEnvFile: false }, { gitSha256: "0".repeat(64) }]) {
      await writeFile(file, JSON.stringify({ ...host, ...patch }));
      expect(() => readHostGitPin()).toThrow();
    }
  } finally {
    if (previous === undefined) delete process.env.FORWARD_HOST_MANIFEST;
    else process.env.FORWARD_HOST_MANIFEST = previous;
  }
});
test("rule hash mismatch refuses manifest before start", () => {
  const m = make(); m.ruleFilesHash = "0".repeat(64);
  expect(() => assertManifestProvenance(m, runtime)).toThrow("RULE_PROVENANCE");
  expect(() => new ForwardController(m)).toThrow("RULE_PROVENANCE");
});
test("rule commit and individual hash list cannot be silently replaced", () => {
  const m = make(); m.ruleSourceCommit = other;
  expect(() => assertManifestProvenance(m, runtime)).toThrow("RULE_PROVENANCE");
  const n = make(); n.ruleFiles = { ...n.ruleFiles, "src/signals/engine.ts": "0".repeat(64) };
  expect(() => assertManifestProvenance(n, runtime)).toThrow("RULE_PROVENANCE");
  expect(() => new ForwardController(n)).toThrow("RULE_PROVENANCE");
});
test("all11 actual frozen source hashes remain valid", () => {
  expect(Object.keys(verifyFrozenRules().fileHashes)).toHaveLength(11);
  expect(() => assertManifestProvenance(make(), runtime)).not.toThrow();
});
test("disk manifest reread and journal resume preserve original provenance and deadlines", async () => {
  const parent = await mkdtemp(join(tmpdir(), "forward-provenance-"));
  const m = make(), controller = new ForwardController(m);
  const j = await CampaignJournal.create<any>(parent, m.campaignId);
  await j.writeArtifact("run-manifest.json", JSON.stringify({ manifest: m }));
  await j.commit([], { manifest: m, controller: controller.checkpoint() });
  const saved = JSON.parse(await readFile(join(j.directory, "run-manifest.json"), "utf8")).manifest;
  const loaded = (await CampaignJournal.resume<any>(j.directory)).checkpoint();
  assertManifestProvenance(saved, runtime); assertManifestProvenance(loaded.manifest, runtime);
  expect(saved).toEqual(m); expect(loaded.manifest).toEqual(m);
  expect(ForwardController.restore(loaded.manifest, loaded.controller).manifest).toEqual(m);
  expect(() => assertManifestProvenance(loaded.manifest, other)).toThrow("RUNTIME_COMMIT_MISMATCH");
  expect(loaded.manifest.runtimeCodeCommit).toBe(runtime);
});
test("metadata changes preserve configuration hash, variants, Signal and controller state", () => {
  const legacyMetadata = manifest("provenance-fixture", T, safe);
  const a = new ForwardController(legacyMetadata), b = new ForwardController(make());
  const h = { market: MARKET.contract, source: "SYNTHETIC_ONLY", fromTimestamp: T - 7200000,
    throughTimestamp: T, receivedTimestamp: T, error: null,
    trades: Array.from({ length: 120 }, (_, i) => ({ id: `${i}:0`, block: i + 1,
      timestamp: T - 7200000 + i * 60000 + 1000, price: 100, volume: 10 })) };
  const rowsA = a.observe(h, T, ["fixture"]), rowsB = b.observe(h, T, ["fixture"]);
  const strip = (rows: typeof rowsA) => rows.map(r => {
    if (r.stream !== "signal") return r;
    const { runtimeCodeCommit: _runtime, ruleSourceCommit: _rule, ...value } = r.value as any;
    return { ...r, value };
  });
  expect(strip(rowsA)).toEqual(strip(rowsB)); expect(a.checkpoint()).toEqual(b.checkpoint());
  expect(make().configHash).toBe(legacyMetadata.configHash);
  expect(make().configHash).toBe("eceb1b8d74ee5d1a8dc7f858c54be37071919dafe50effd5ac0d298fc52f8aa4");
});
