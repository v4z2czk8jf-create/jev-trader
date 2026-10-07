# JEV recovery record

## Recovery baseline

- Recovery date: 2026-10-08.
- Recovery branch: `recovery/2026-10-08`.
- Baseline HEAD: `b587759e459ea049590102e54a0b07800864cdc3`.
- Source snapshot revision: `59bf98d33cf01168bdb7af18bff2c645fd9dca2f`.
- RULE_COMMIT: `91e0b07a7638f0c575ceabd8fb770c7e89eda88c`.
- The Git objects for `59bf98d` and `91e0b07` are absent from this recovered clone. No network fetch was performed.
- The 2026-10-05 snapshot records the working tree at acquisition. It is not guaranteed to be a pure commit checkout, and its recorded revision does not establish that every included file belonged to that commit.
- All 127 snapshot files were restored and checked against the snapshot manifest: bytes and SHA256 matched for every file, totaling 769,647 bytes.
- All 11 files listed by `src/forward-observation/frozen-rules.json` matched their recorded SHA256 values. Root `.gitattributes` sets `-text` for exactly these paths to prevent Git line-ending conversion.
- The snapshot source files and frozen-rule hashes are preserved. No automatic renormalization was performed.
- Push has not been performed.

The snapshot revision, RULE_COMMIT, and runtime commit are different provenance fields. Do not replace one with another or rewrite historical manifests to make their checks pass. A future campaign must record the actual new runtime HEAD and verified runtime provenance.

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

Past observation data and parts of the original Git history are lost from the available recovery material. Their availability in other backups has not been checked. The included code cannot establish past campaign state, reconstruct missing signal/execution books, or determine historical stop causes.

## Safety boundary and campaign provenance

- The upstream README contains historical demo instructions. Current safety boundaries in `CLAUDE.md`, `SPEC.md`, and this record take priority.
- `DRY_RUN=false`, real orders, private-key/API-key use, token approval, write RPC, fund transfers, external communication, and push are prohibited.
- Do not execute the historical live trading, wallet, approval, or `dry-encode.ts` instructions in the README.
- Do not run `scripts/dry-encode.ts`, `scripts/trace-rpc.ts`, or `scripts/probe-book2.ts`.
- Old campaigns are not resume targets. Do not reuse their manifests, checkpoints, identifiers, or start permits.
- Any future campaign must be a new campaign with new runtime/provenance records. Creating or starting a campaign requires a separate authorized phase.
- R01-R06 diagnostic reconstruction has not been performed in this recovery phase.
- Dependency installation, typecheck, tests, JEV startup, market API/RPC requests, and Task Scheduler operations have not been performed in this phase.
- This phase permits one local recovery commit only after the static checks pass. Commit and local-clone verification do not grant permission to execute JEV or start observations.
- Secret-environment checks report presence only; no secret values or personal information are recorded here.
