# JEV recovery record

## Recovery baseline

- Recovery date: 2026-10-08.
- Recovery branch: `recovery/2026-10-08`.
- Restore baseline HEAD: `b587759e459ea049590102e54a0b07800864cdc3`.
- First recovery checkpoint / R00.1 canonical blob source: `afae02134cda68ec459aac14f459c6be1f13da52`.
- Source snapshot revision: `59bf98d33cf01168bdb7af18bff2c645fd9dca2f`.
- RULE_COMMIT: `91e0b07a7638f0c575ceabd8fb770c7e89eda88c`.
- The Git objects for `59bf98d` and `91e0b07` are absent from this recovered clone. No network fetch was performed.
- The snapshot is a working-tree capture at acquisition, not a guaranteed pure commit checkout. Its recorded revision does not establish that every included file belonged to that commit.
- Push has not been performed.

The snapshot revision, RULE_COMMIT, and runtime commit are different provenance fields. Do not replace one with another or rewrite historical manifests to make their checks pass.

## Snapshot byte provenance

Immediately after restoration on 2026-10-08, before the first recovery commit, the working tree's 127 snapshot files matched the manifest in raw bytes/SHA256, totaling 769,647 bytes. This was a check of that restored working tree; it does not mean the blobs in `afae021` preserved all 127 original files byte-for-byte.

The Claude review findings were independently reproduced by a read-only snapshot-to-`afae021` blob comparison during R00.1:

| Snapshot files | Raw-byte relationship to afae021 blobs |
| --- | --- |
| 68 | Exact manifest/raw-byte matches |
| 57 | Snapshot CRLF normalized to Git blob LF |
| 2 | Snapshot mixed EOL normalized to Git blob LF |

The two mixed-EOL files were `src/index.ts` and `src/market-data/rpc-source.ts`. Normalized content matched; these are EOL differences, not code-content changes. The Git commit alone cannot reproduce all original snapshot raw bytes.

The byte-exact source of truth is the external Recovery Snapshot and its manifest. These existing paths were verified on disk, without modifying them:

- Source: `C:\Users\kkkos\ChatGPT\JARVIS\backups\jev-recovery-20261005\snapshot\source`.
- Manifest: `C:\Users\kkkos\ChatGPT\JARVIS\backups\jev-recovery-20261005\snapshot\review\manifest.json`.
- Archive: `C:\Users\kkkos\ChatGPT\JARVIS\backups\jev-recovery-20261005\jev-trader-review-20261005.zip`.

The external source and the archive's 127 source entries matched the manifest, and the archive's manifest matched the external manifest. Current repo-wide raw-byte equality with the original snapshot is not an R00.1 PASS condition.

## Byte reproducibility: R00.1

The frozen-rule 11 files retain their recorded bytes/SHA256. Their exact paths have `-text` attributes; their Git blobs, working-tree bytes, and prior local-clone check matched the frozen rules. R00.1 keeps those protections and requires the same 11-file checks in both post-commit checkout configurations.

Implementation fingerprint targets are derived from `src/forward-observation/runner.ts:37-41`: sorted direct entries matching its TS/JSON regex, followed by the two named market-data files. There are 22 targets. R00.1 fixes these paths to the raw Git blob bytes already stored in `afae021` and adds exact-path `-text` attributes. Only differing EOL bytes are restored from those blobs; normalized content and the runner implementation remain unchanged.

The 11 frozen-rule paths and 22 fingerprint paths form a 33-path union, with no wildcard rules or duplicate entries. The goal is to make the raw-byte implementation fingerprint reproducible across checkouts, `core.autocrlf` settings, and a new PC. Post-commit local clones with `core.autocrlf=true` and `false` must reproduce the same 22 file hashes as the repo.

R00.1 intentionally changes the working-tree EOL of `src/forward-observation/frozen-rules.json` and `src/market-data/rpc-source.ts` to canonical LF. It does not change frozen-rule values, normalize the whole snapshot, or claim repo-wide byte equality with the external snapshot. No automatic renormalization was performed.

## Known missing / not restored

The following material was not included in the review snapshot itself. Its absence is not a snapshot restoration failure.

- `scripts/forward-task-install.ps1`.
- `src/market-data/market-data.test.ts`.
- `src/market-data/derivatives/derivatives.test.ts`.
- Documentation excluded from the snapshot:
  - `docs/4stage-market-signal-engine.md`.
  - `docs/forward-host-diagnostics.md`.
  - `docs/forward-task-host.md`.
  - `docs/important-sr-integration.md`.
  - `docs/kuru-forward-capacity.md`.
  - `docs/kuru-forward-hardening.md`.
  - `docs/kuru-forward-observation-v1.md`.
  - `docs/kuru-forward-provenance.md`.
  - `docs/kuru-forward-readiness.md`.
  - `docs/market-data-adapter-v1.md`.
  - `docs/phase-b-observation.md`.
  - `docs/phase-c-long-observation.md`.
  - `docs/phase-c-observation.md`.
- Past observation data.
- Historical journals.
- Historical checkpoints.
- Historical host/diagnostics logs.
- The original Git history beyond the history available in the recovered clone.

The two missing market-data test files are safety-gate tests. They must be reconstructed and verified before any new Forward observation or campaign starts. Their assignment within R01-R06 awaits follow-up instructions; R00.1 does not reconstruct or run them.

Past observation data and parts of the original Git history are lost from the available recovery material. Their availability in other backups has not been checked. The included code cannot establish past campaign state, reconstruct missing signal/execution books, or determine historical stop causes.

## Safety boundary and campaign provenance

- The upstream README contains historical demo instructions. Current safety boundaries in `CLAUDE.md`, `SPEC.md`, and this record take priority.
- `DRY_RUN=false`, real orders, private-key/API-key use, token approval, write RPC, fund transfers, external communication, and push are prohibited.
- Do not execute the historical live trading, wallet, approval, or `dry-encode.ts` instructions in the README.
- Do not run `scripts/dry-encode.ts`, `scripts/trace-rpc.ts`, or `scripts/probe-book2.ts`.
- Old campaigns are not resume targets. Do not reuse their manifests, checkpoints, identifiers, or start permits.
- A new campaign requires completion of R01-R06 reconstruction and the safety gates, new runtime/provenance records using the actual new runtime HEAD, and a separate authorized start phase.
- R01-R06 diagnostic reconstruction has not been performed in R00.1.
- Dependency installation, typecheck, tests, build, JEV startup, project scripts, market API/RPC requests, and Task Scheduler operations have not been performed in this phase.
- This phase permits one local checkpoint commit only after the static checks pass. Commit and local-clone verification do not grant permission to execute JEV or start observations.
- Secret-environment checks report presence only; no secret values are recorded here.
