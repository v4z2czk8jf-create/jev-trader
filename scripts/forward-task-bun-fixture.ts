/** Bounded local host fixture: no market imports, network, env-file reads or runner. */
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { readGitIdentity, assertGitIdentity } from "../src/forward-observation/provenance";
import { verifyFrozenRules, RULE_COMMIT } from "../src/forward-observation/config";
import { execFileSync } from "node:child_process";
const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
if (manifest.mode !== "Fixture" || manifest.fixtureRuntime !== "Bun" ||
    !/^fixture-forward-host-[a-f0-9]{32}$/.test(manifest.campaignId) ||
    manifest.fixtureSeconds < 1 || manifest.fixtureSeconds > 120 ||
    resolve(process.cwd()) !== resolve(manifest.repoRoot) ||
    Bun.version !== manifest.bunVersion || process.env.DRY_RUN !== "true" || process.env.MODEL !== "mock") {
  throw Error("BUN_FIXTURE_GUARD");
}
function save(name: string, value: unknown) {
  const fd = openSync(join(manifest.logDirectory, name), "wx");
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
const started = performance.now();
const git = readGitIdentity(manifest.repoRoot, manifest);
if (git.head !== manifest.runtimeCommit || RULE_COMMIT !== manifest.ruleCommit) throw Error("FIXTURE_PROVENANCE_MISMATCH");
const ruleType = execFileSync(manifest.gitExecutablePath,
  ["--no-optional-locks", "-C", manifest.repoRoot, "cat-file", "-t", manifest.ruleCommit],
  { cwd: manifest.repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
if (ruleType !== "commit") throw Error("FIXTURE_RULE_COMMIT_MISSING");
const frozenCount = Object.keys(verifyFrozenRules().fileHashes).length;
let dirtyGuard = "CLEAN";
try { assertGitIdentity(git, manifest.repoRoot, manifest.runtimeCommit); }
catch (error) {
  if (!git.status.trim() || (error as Error).message !== "RUNTIME_WORKTREE_DIRTY") throw error;
  dirtyGuard = "DIRTY_CORRECTLY_REJECTED_FOR_FORWARD"; // Fixture runs before its source commit.
}
const common = { provenance: "SYNTHETIC_FIXTURE_NOT_FORWARD", pid: process.pid, parentPid: process.ppid,
  bunExecutablePath: process.execPath, bunVersion: Bun.version, cwd: process.cwd(),
  gitExecutablePath: manifest.gitExecutablePath, gitVersion: manifest.gitVersion, gitSha256: manifest.gitSha256,
  gitHead: git.head, workingTreeClean: !git.status.trim(), dirtyGuard, frozenCount, ruleCommit: RULE_COMMIT, ruleType,
  dryRun: process.env.DRY_RUN, model: process.env.MODEL };
save("fixture-start.json", { ...common, startedAt: new Date().toISOString() });
console.log("FORWARD_BUN_HOST_FIXTURE_ONLY " + Bun.version);
await Bun.sleep(manifest.fixtureSeconds * 1000);
save("fixture-end.json", { ...common, endedAt: new Date().toISOString(), elapsedMs: performance.now() - started, exitCode: 0 });
