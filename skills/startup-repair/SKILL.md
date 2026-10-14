---
name: startup-repair
description: Field manual for repairing failed project/environment startups in the web dashboard — a complete taxonomy of startup failure classes (S1–S12), an ordered diagnosis procedure, the fix flow for every class, and the verification standard the dashboard's own auto-repair engines (legacy tool loop and delegated agent CLI) enforce. Use whenever an environment start/restart/rebuild fails, when an LLM or an operator must diagnose and fix a startup failure, or when tuning the auto-repair success rate. Model-agnostic: any LLM or engineer can execute it from this spec.
license: MIT
---

# Startup Repair — failure taxonomy, diagnosis procedure, fix flows

## 0. Mission

A user clicks ▶ Start (or Restart / Rebuild) in the dashboard. The command
spawns, fails or never listens, and the card flips to error. A terminal user
reads the log; a dashboard user is STUCK.

**The goal of this skill**: turn every startup failure into a classified,
fixable situation — either for the dashboard's built-in auto-repair (legacy
tool loop / delegated agent CLI) or for a human/LLM operator following this
manual. The single most important rule up front:

> **A fix is only a fix when the ORIGINAL start command runs and the ORIGINAL
> port answers.** Never change the command or port to dodge the failure; fix
> the project so the recorded command listens on the recorded port. The
> dashboard re-verifies independently and does not trust any self-reported
> "I fixed it".

### Where the facts live (read these first)

| Fact | Where |
|---|---|
| Immediate error envelope | start/rebuild route response: `error`, `detail` (exit code + log tail + log path), `stderr`, `stdout` |
| Full process log | `db/logs/<projectId>-<envName>.log` — surfaced as "View Logs"; last ~30 lines are also in `detail` |
| Port / PID ground truth | `checkPortStatus(port)` (raw TCP connect), `getPidOnPort(port)` |
| Project shape | `package.json` summary, top-level file listing (dotfiles included) |
| DB / schema errors | the log tail (`P1001`, `table does not exist`, `Client does not exist` …) |

## 1. Failure taxonomy (S1–S12)

| ID | Class | Signature in logs / error | Fix flow |
|----|-------|--------------------------|----------|
| S1 | Command not found / immediate exit | `Spawn Error`, exit code 127, `command not found`, `not recognized as an internal or external command`, `Cannot find module` for the LAUNCHER itself | F1 |
| S2 | Port already in use | `Port X is already in use`, `EADDRINUSE`, start route pre-check reports the port occupied | F2 |
| S3 | Dependencies missing / stale | `Cannot find module 'X'` (a project dep, not the launcher), `Module not found`, works after fresh install | F3 |
| S4 | Build/compile error (start compiles, or rebuild) | TypeScript errors, `Failed to compile`, webpack/vite resolution errors, syntax errors | F4 |
| S5 | Env / config not loaded | `DATABASE_URL` undefined, missing `.env`, `environment variable is not defined`, Prisma `Client does not exist` (generate step skipped) | F5 |
| S6 | Database schema out of sync | Prisma `P1001` (can't reach DB), `Table 'main.X' does not exist`, `prisma db push` never ran after schema change | F6 |
| S7 | Process lives but never listens | `Port X did not become active within 45s — the process is running but not listening on it`, or a startup banner advertises a DIFFERENT port | F7 |
| S8 | Guarded by design (dashboard self-path / reserved port) | `Refusing to start an environment inside the dashboard's own directory`, `Port 3000/3100–3105 is reserved and protected` | F8 (do NOT "fix" — relocate) |
| S9 | Build-dir lock / orphan from a previous run | builds hang silently, `.next/dev/lock` held, "another instance is running", a zombie from a previous dashboard session holds the port right after S2 cleanup | F9 |
| S10 | Interactive prompt starves the start | process waits on stdin (`more`, a CLI asking a question, `yes/no` prompt), log goes quiet, timeout kills it | F10 |
| S11 | The auto-repair loop itself failed | 11 broken-JSON turns, blind patches, sandbox allowlist walls, repair job stuck "LLM 处理中" forever | F11 |
| S12 | Container / sandbox environment | Chromium sandbox crashes (screenshots), network-restricted installs fail, HOME differs, PATH lacks the CLI | F12 |

Classification rules:
- Always classify by the EARLIEST hard error in the log tail, not the last
  line (frameworks print follow-up noise after the real cause).
- One failure can be two classes (S3 reveals itself as S4 after install);
  re-classify after each fix step and re-verify.

## 2. Diagnosis procedure (ordered — never skip ahead)

> **v1.24 pipeline order (deterministic-first).** Before any LLM is consulted,
> the repair job itself runs two zero-cost fast paths, in this order:
>
> 1. **Pattern fix** — the failure text is matched against the deterministic
>    taxonomy (module-missing → install per lockfile `installCmdFor`; cache
>    corruption → clean `.next`/`.vite`/… if present; env-missing → copy
>    `.env.example` → `.env` when absent). Applied + verified with the same
>    runRetry health check the engines trust. Success ⇒ job settles with
>    `resolvedBy: 'pattern'`, no model call.
> 2. **Lesson replay** — the environment's stored `RepairLesson` row
>    (cmd/port/envVars that worked + fix commands + cleans from the LAST
>    successful repair) is replayed and health-verified. Success ⇒
>    `resolvedBy: 'lesson'`, no model call.
> 3. Only then do the engines run — with the failed fast-path attempts
>    injected into their context ("already tried, don't repeat") so they
>    never rediscover a known fix.
>
> On ANY success (fast path or engine) the lesson row is (re)written — so the
> NEXT identical failure resolves at step 1/2 in seconds. An operator
> following this manual should mimic the same order: cheapest deterministic
> fix first, model call last.

1. **Read the envelope.** exit code + the last ~30 log lines. Classify per §1.
2. **Probe the port.** Is anything listening? Who (`getPidOnPort`)? A listener
   that is NOT our process means S2/S9; no listener at all means the process
   died (S1/S3/S4/S5/S6) or is stuck (S7/S10).
3. **Read the project shape.** package.json scripts (does the recorded cmd
   exist as a script?), deps present in `node_modules`?, dotfiles (`.env`
   present?), config files (next.config, prisma/).
4. **Apply the class fix flow (§3).** One surgical change per step.
5. **Re-verify like the dashboard does:** run the EXACT recorded command,
   wait for the EXACT recorded port to answer any HTTP status, then stop
   nothing else. Only then report success.

## 3. Fix flows (one surgical step, then re-verify)

### F1 — launcher not found
- Use the project's own binaries: the dashboard already prepends
  `<project>/node_modules/.bin` and global bin dirs to the child PATH.
- Prefer rewriting the env command to `npm run <script>` / `bun run <script>`
  (script table is auditable) over absolute one-off paths.
- Windows: npm-global CLIs need `.cmd` shims (`claude.cmd`, not `claude`) for
  `execFile`; shells resolve either.

### F2 — port occupied
- Identify the owner first (`getPidOnPort`). The dashboard's start route
  already sweeps strays of the SAME project before starting (siblings' ports
  are preserved). If the owner is a DIFFERENT project or a foreign process,
  that's a port-hygiene problem — use the Ports panel, not a start retry.
- Never "fix" by moving the project to another port to dodge the conflict;
  reserved ports (3000, 3100–3105) are the dashboard's own and never valid.

### F3 — dependencies
- `npm install` / `bun install` in the project dir (the repair allowlist
  permits npm/yarn/pnpm/bun prefixes without approval).
- After install, re-run start; re-classify if a deeper error appears (S4).

### F4 — build errors
- Fix the REAL error. **Never** set `ignoreBuildErrors`, drop type-checks,
  or delete the failing code path to make it pass — the dashboard's
  guardrail detects the `ignoreBuildErrors` flip and fails the round; a
  silenced build is a corrupted project, not a repair.
- Keep patches minimal and surgical: one precise edit beats a rewrite.
  Never reformat or touch unrelated files (surfaces in git review).

### F5 — env / config
- Ensure the project's own `.env` exists and is loaded BY THE PROJECT (the
  dashboard strips its own `DATABASE_URL`/`DATABASE_*` from children so
  parents never leak into children — if a child needs a var, put it in the
  env's envVars field or the child's `.env`).
- Prisma projects: `prisma generate` after schema edits (missing client is
  S5 even when the error text mentions modules).

### F6 — schema sync
- `prisma db push` (dev) / migrate (prod) for the CHILD project's own DB —
  never point a child at the dashboard's SQLite.

### F7 — alive but not listening
- Check what the banner says: `Local: http://localhost:N` with N ≠ recorded
  port → the server ignored the port request. Make the PROJECT honor it
  (its own config/env file), or record the env with the port the server
  actually uses — but the recorded pair (cmd, port) is the contract; the
  dashboard re-runs exactly that pair.
- Slow first compile (cold cache) legitimately takes minutes: the start
  verify budget is `START_VERIFY_TIMEOUT_MS` (45 s default) — raise it for
  heavy monorepos instead of looping retries.

### F8 — guards (by design, never "fix")
- Self-path: the project directory IS the dashboard directory (also via
  symlinks/junctions/casing) → register a COPY of the project elsewhere.
- Reserved port: move the project's env to a free non-reserved port.

### F9 — locks and orphans
- Kill the orphan (tree-kill: `killTree`, the dashboard kills process GROUPS
  — a bare SIGTERM leaves `next dev` workers holding ports on Windows).
- Remove the held build dir (`.next/dev/lock`) only after the holder is dead.

### F10 — interactive starvation
- Refuse interactive commands in headless contexts (the repair exec tool
  hard-refuses pagers/editors; CLIs must run with their non-interactive flag:
  `claude -p`, `codex exec`, `gemini` with piped stdin).

### F11 — when the repair engine itself is the problem
- Symptoms: job log shows repeated unreadable-JSON turns, blind patch/verify
  ping-pong, or (fixed in v1.23) a job stuck `running` forever.
- Switch engines: Settings → LLM 配置 → repair engine.
  - **legacy tool loop**: built-in inspect/probe/patch/run_retry harness —
    depends on the model following the tool protocol; weak models burn the
    15-step budget.
  - **delegated agent CLI** (recommended when installed): Claude Code, Claude
    Desktop (via the claude CLI), Codex, Gemini, OpenCode, Hermes — the CLI
    brings its own hardened harness; the dashboard still verifies
    independently (3 rounds × 10 min, whole process group killed on expiry;
    raised from 2 rounds in v1.24 — the deterministic fast paths handle the
    easy classes first, so the cases that reach the CLI are the hard ones).
  - No CLI installed → automatic fallback to legacy (logged, never a dead end).
- Every job is watchdogged: 12 min with zero progress ⇒ force-failed with an
  actionable message; session loss mid-poll (401/403) stops the poller with a
  visible notice instead of spinning "LLM 处理中" forever.
- CLIs not on the service PATH are probed at known install roots
  (`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, npm-global shims,
  Homebrew) before falling back.

### F12 — container/sandbox quirks
- Headless Chromium (live-preview thumbnails): always launch with
  `--no-sandbox --disable-dev-shm-usage --disable-gpu` — a probe WITHOUT
  `--no-sandbox` fails for sandbox reasons, not browser-availability reasons,
  and wrongly reports "no browser" (the v1.22 bug). The browser cache is
  scanned for ANY `chromium-*`/`chromium_headless_shell-*` revision —
  including the newer `chrome-linux64/` and `chrome-headless-shell-*`
  layouts — so playwright/browsers version drift no longer disables previews.
- Restricted network: prefer offline-safe fixes (vendored deps, local
  assets, system font stacks) over assuming install access.

## 4. Escalation matrix

| Situation | Action |
|---|---|
| Single-class failure, flow known | Apply §3 flow, verify, done |
| Two rounds of the same fix failed | STOP repeating it — re-classify from the ORIGINAL error; append what you tried to the task context (the CLI engine feeds previous rounds' verifier output forward the same way) |
| Fix would require changing cmd/port | Not allowed — fix the project to honor the recorded pair |
| Fix would touch git history / run git commit | Not allowed — leave every change in the working tree for human review (read-only git is fine) |
| Guarded by design (S8) | Relocate the project; never bypass the guard |
| Engine pathology (S11) | Switch repair engine; check LLM provider health in Settings |

## 5. Implementation notes for agents

- The dashboard's `startProcess` verifies with a raw TCP connect (universal,
  no external tools) — treat ANY HTTP status on the port as "up" for
  verification, exactly like `waitForHttpReady` does for thumbnails.
- Spawned children get a sanitized env: no `__NEXT_PRIVATE_*`, no
  `TURBOPACK`, no `DATABASE_*` leak; the child's own `.env` supplies its own.
- `runShellProcess` runs commands as process-group leaders and kills the
  WHOLE group on timeout — an agent must never use `exec()` whose timeout
  orphans grandchildren holding locks (that exact bug created class S9).
- All repair activity lands in the Activity feed (`type: 'repair'`), so an
  operator can audit every automated decision afterwards.
- **Lesson memory (v1.24)**: every successful repair upserts a `RepairLesson`
  row per environment (`src/lib/repair-lesson.ts`) — error signature,
  working cmd/port/envVars, replayable fix commands (installs) and cleans.
  Replays are bounded: one lesson per env, applied BEFORE engines, verified
  with the standard health check, and discarded (escalated) when they stop
  working. The engines also receive the lesson as context so they never
  re-derive a known fix.
- **Pull→start chain (v1.24)**: a pull that touched `package.json`/lockfiles
  triggers a background dependency sync (`src/lib/pull-deps-sync.ts`) right
  after the pull lands — the S3-after-pull class should now never reach a
  start failure at all.
- **Stale-branch pulls (v1.25)**: "pull says up-to-date but the code is old"
  is usually NOT a network problem — the checkout sits on a side branch
  (e.g. `v3-base`) while the default branch moved on. Pulls now return
  `newerOnDefault`/`remoteDiffers` with the branch + behind count; the fix is
  `git checkout <default>` (the UI offers the switch), not another pull.
- **Remote thumbnails (v1.24)**: devices expose
  `GET /api/agent/proxy/<apiKey>/<port>/<path>` (key-in-path so relative
  sub-resources inherit auth; registered env ports only; GET/HEAD only;
  `Referrer-Policy: no-referrer`). Agent error responses carry
  `X-Agent-Proxy-Error: 1` so the dashboard's readiness probe can tell an
  agent error from an app response and never screenshots a JSON error page.
