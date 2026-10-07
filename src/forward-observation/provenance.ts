import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { hash, RULE_COMMIT, verifyFrozenRules, type Manifest } from "./config";

const repository = resolve(import.meta.dir, "../..");
export interface GitIdentity { root: string; head: string; status: string }
export interface GitPin { gitExecutablePath: string; gitVersion: string; gitSha256: string }
export function assertGitBinary(pin: GitPin) {
  if (!pin || !isAbsolute(pin.gitExecutablePath ?? "") || /["\r\n]/.test(pin.gitExecutablePath) ||
      !statSync(pin.gitExecutablePath).isFile()) throw Error("ABSOLUTE_EXISTING_GIT_REQUIRED");
  if (!/^git version [^\r\n]+$/.test(pin.gitVersion) || !/^[a-f0-9]{64}$/.test(pin.gitSha256) ||
      hash(readFileSync(pin.gitExecutablePath)) !== pin.gitSha256) throw Error("GIT_BINARY_PROVENANCE_MISMATCH");
}
export function readHostGitPin(): GitPin & { runtimeCommit: string } {
  const path = process.env.FORWARD_HOST_MANIFEST;
  if (path) {
    if (!isAbsolute(path)) throw Error("ABSOLUTE_HOST_MANIFEST_REQUIRED");
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (m.schema !== "forward-task-host-v1" || m.mode !== "Forward" ||
        realpathSync(m.repoRoot) !== realpathSync(repository) || m.ruleCommit !== RULE_COMMIT ||
        m.dryRun !== "true" || m.model !== "mock" || m.noEnvFile !== true ||
        !/^[a-f0-9]{40}$/.test(m.runtimeCommit)) throw Error("HOST_PROVENANCE_MISMATCH");
    assertGitBinary(m);
    return m;
  }
  // Legacy diagnostic launcher can supply an explicit pin; never fall back to PATH.
  const pin = { gitExecutablePath: process.env.FORWARD_GIT_EXECUTABLE ?? "",
    gitVersion: process.env.FORWARD_GIT_VERSION ?? "", gitSha256: process.env.FORWARD_GIT_SHA256 ?? "",
    runtimeCommit: process.env.FORWARD_RUNTIME_COMMIT ?? "" };
  if (!/^[a-f0-9]{40}$/.test(pin.runtimeCommit)) throw Error("PINNED_GIT_AND_RUNTIME_REQUIRED");
  assertGitBinary(pin);
  return pin;
}
/** Read only. No network, index writes, checkout, or authentication access. */
export function readGitIdentity(root = repository, pin: GitPin = readHostGitPin()): GitIdentity {
  assertGitBinary(pin);
  const git = (...args: string[]) => execFileSync(pin.gitExecutablePath, ["--no-optional-locks", "-C", root, ...args],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (git("--version").trim() !== pin.gitVersion) throw Error("GIT_VERSION_MISMATCH");
  return { root: git("rev-parse", "--show-toplevel").trim(), head: git("rev-parse", "HEAD").trim(),
    status: git("status", "--porcelain=v1", "--untracked-files=all") };
}
export function assertGitIdentity(git: GitIdentity, expectedRoot: string, expectedCommit?: string) {
  const canonical = (s: string) => { const p = realpathSync(s); return process.platform === "win32" ? p.toLowerCase() : p; };
  if (canonical(git.root) !== canonical(expectedRoot)) throw Error("RUNTIME_REPOSITORY_MISMATCH");
  if (!/^[0-9a-f]{40}$/.test(git.head)) throw Error("INVALID_GIT_HEAD");
  if (git.status.trim()) throw Error("RUNTIME_WORKTREE_DIRTY");
  if (expectedCommit !== undefined && git.head !== expectedCommit) throw Error("RUNTIME_COMMIT_MISMATCH");
  return git.head;
}
export function assertManifestProvenance(m: Manifest, actualHead: string) {
  const rules = verifyFrozenRules();
  if (m.codeCommit !== RULE_COMMIT || m.ruleSourceCommit !== RULE_COMMIT ||
      m.ruleFilesHash !== hash(JSON.stringify(rules.fileHashes)) ||
      JSON.stringify(m.ruleFiles) !== JSON.stringify(rules.fileHashes)) throw Error("RULE_PROVENANCE_MISMATCH");
  if (!m.runtimeCodeCommit || m.runtimeCodeCommit !== actualHead) throw Error("RUNTIME_COMMIT_MISMATCH");
}
export function forwardPreflight(m?: Manifest) {
  verifyFrozenRules();
  const pin = readHostGitPin();
  const head = assertGitIdentity(readGitIdentity(repository, pin), repository, pin.runtimeCommit);
  if (m) assertManifestProvenance(m, head);
  return head;
}
