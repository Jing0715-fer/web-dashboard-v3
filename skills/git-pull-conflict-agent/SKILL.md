---
name: git-pull-conflict-agent
description: One-click git pull that never dead-ends on conflicts — a deterministic, backup-first agent that classifies every conflict class (local-changes blockers, untracked collisions, diverged history, stash-pop conflicts, missing origin, network flakes) and resolves the WHOLE loop to completion with live progress streaming. Use when a GUI/tool/agent must complete `git pull` on user machines where manual terminal work is not acceptable. Model-agnostic: any LLM or engineer can implement it from this spec.
license: MIT
---

# Git Pull Conflict Agent — universal implementation spec

## 0. Mission

A user clicks "Pull latest code" in a dashboard. `git pull` fails with hostile
stderr (`Your local changes … would be overwritten by merge`, `Not possible
to fast-forward`, `could not restore untracked files from stash` …). A
terminal user knows what to do; a dashboard user is STUCK.

**The goal of this skill**: replace every dead end with an AGENT that fully
resolves the situation — deterministically, without losing the user's local
work, reporting every step live, and finishing the pull.

Design rule zero: **the fixing agent is deterministic code, not an LLM.**
LLMs may *diagnose* and *recommend*, but they must never generate commands.
Every operation the agent performs comes from a fixed, auditable algorithm.

### Safety invariants (non-negotiable)

1. **NOTHING IS EVER LOST.** Before any destructive command runs, the
   affected state is backed up:
   - dirty working tree → `git stash push --include-untracked -m "<label>"`
   - diverged local commits → `git branch dashboard-backup/<branch>/<timestamp>`
   - conflicted local edits during restore → extracted to `<file>.local.bak`
     next to the file (the stash entry is also kept — git never drops a
     stash that conflicted on pop).
2. **NO SHELL STRINGS.** Every git call is direct argv (`execFile` /
   `spawn` without `shell: true`). Any file list that came from a client is
   sanitized: repo-relative paths only, no `..`, no absolute paths, no glob
   magic, no leading `-`, bounded length, bounded count.
3. **ALWAYS TERMINATES.** Every step either advances the state machine or
   fails the whole run with an actionable report. Iterative loops (clearing
   blocker waves) are bounded (max 3).
4. **HONEST REPORTING.** The final result lists every artifact the agent
   created (stash refs, backup branches, `.local.bak` files) so the user
   knows exactly where their local changes live.

## 1. Conflict-class taxonomy (know your enemy)

| ID | Class | git signature | Agent resolution |
|----|-------|---------------|------------------|
| C1 | Modified tracked files block merge | `error: Your local changes to the following files would be overwritten by merge:` + file list + `Please commit your changes or stash them before you merge` | Safety-stash (B2) → sync → restore (R) |
| C2 | Untracked files would be overwritten | `error: The following untracked working tree files would be overwritten by merge:` + file list | Safety-stash with `--include-untracked` (B2) captures them → sync → restore (R2/R3) |
| C3 | Checkout twin of C1/C2 (branch switch) | same text with `by checkout:` | Same as C1/C2 — the stash makes `git checkout` safe |
| C4 | Diverged history | `fatal: Not possible to fast-forward, aborting.` (with `--ff-only`) or ahead+behind counts > 0 | Backup branch of local commits (S3) → `git reset --hard origin/<branch>` |
| C5 | Stash-pop conflicts (restore phase) | `CONFLICT (content): Merge conflict in <file>` + `git diff --name-only --diff-filter=U` non-empty | Auto-resolve: take pulled version in tree, extract local version as `<file>.local.bak` from index stage `:3:<path>`, keep the stash entry |
| C6 | Stash untracked-restore collision | `could not restore untracked files from stash` (tracked changes DID apply, no unmerged paths) | Extract the stashed untracked copies from `stash@{0}^3:<path>` as `.local.bak`; the remote now tracks those paths |
| C7 | Missing origin / no upstream | `fatal: 'origin' does not appear to be a git repository` / `no tracking information` | Self-heal: `git remote add origin <configured-url>`; pull `origin/<branch>` explicitly when `@{u}` is unset |
| C8 | Network transient | `SSL_ERROR_SYSCALL`, `Connection reset`, `timed out`, `RPC failed`, HTTP 5xx, `curl (28\|35\|55\|56)` | Auto-retry ≤3 times with backoff (~1s/2.5s/5s ± jitter); mark `transient: true` if exhausted |
| C9 | Unrecoverable | auth/permission (`Authentication failed`, `could not read Username`), repo gone (`Repository not found`), not a repo, disk full | Fail with an actionable message + manual steps. NEVER auto-retry or auto-force these |

Parsing notes:
- git localizes output; match on the structural English patterns (git does
  not translate these particular error strings in practice) and fall back to
  ahead/behind counts from `git rev-list --left-right --count`.
- Unquote C-quoted paths (`"src/a b.ts"` → `src/a b.ts`).
- Locale-independent "already up to date" = identical HEAD SHA before/after.

## 2. The agent state machine

```
preflight → backup → fetch → analyze → [switch] → sync → restore → verify
```

Every step emits progress (key, status: pending|running|ok|warn|fail|skipped,
i18n note with params, raw git info) through a callback/SSE stream, and every
step is terminal-safe: on failure the run stops with a full report.

### P. preflight
- Verify `<path>/.git` exists (else C9 fail).
- Record: current branch (`git rev-parse --abbrev-ref HEAD`; empty string =
  detached, null = unborn), dirty files (`git status --porcelain`, split into
  modified vs untracked, `R old -> new` → take NEW), HEAD SHA.

### B. backup (the safety net — BEFORE anything touches the tree)
- Dirty tree? `git stash push --include-untracked -m "dashboard-agent <ts>"`.
  - "No local changes to save" → nothing to back up (ok).
  - Stash created → record label. This single step neutralizes C1/C2/C3 for
    everything that follows.
- Clean tree → skip (ok).

### F. fetch
- Self-heal missing origin from the configured repo URL (C7).
- `git fetch origin --prune` with the C8 retry wrapper; record retries.

### A. analyze
- Resolve the sync target: configured upstream (`<branch>@{u}`) else
  `origin/<branch>` (must exist, else C9 fail with "remote has no branch").
- Compute `git rev-list --left-right --count <branch>...<upstream>` →
  ahead/behind.
- If the user requested a different branch: verify `origin/<branch>` exists.

### S. switch (only when a target branch was requested)
- Tree is clean post-backup, so checkout is safe: `git checkout <branch>` if
  a local branch exists (keeps its commits), else
  `git checkout -b <branch> --track origin/<branch>`.

### Y. sync (the heart — get HEAD to the remote tip)
- behind == 0 && ahead == 0 → up to date, done.
- behind > 0 && ahead == 0 → fast-forward: `git pull --ff-only` (append the
  upstream ref when `@{u}` is unset). If a surprise blocker wave appears
  (C1/C2 again): everything is already backed up, so clear EXACTLY the
  listed paths (`git checkout HEAD -- <modified>` /
  `git clean -fd -- <untracked>`) and retry — max 3 iterations.
- ahead > 0 (diverged or local-only commits, C4) → FIRST create
  `git branch dashboard-backup/<branch>/<ts>` holding the local commits,
  THEN `git reset --hard <upstream>`. The commits stay fully recoverable.

### R. restore (bring the user's local changes back)
- No stash created → skip.
- `git stash pop`:
  - clean → restored (ok).
  - C6 (`could not restore untracked files from stash`, no unmerged paths) →
    tracked edits applied; extract each former-untracked file from
    `stash@{0}^3:<path>` as `<path>.local.bak`; note that the stash retains
    them too.
  - C5 (unmerged paths from `git diff --name-only --diff-filter=U`) →
    deterministic auto-resolution per file:
    1. local (stashed) version = `git show :3:<path>` → write
       `<path>.local.bak` (mkdir -p the parent).
    2. `git checkout --ours -- <path>` (pulled version stays in tree —
       clean and buildable).
    3. `git add -- <path>` then `git reset` (mark resolved, unstage).
    4. The stash entry is KEPT by git — it is the durable backup.
    5. Report each auto-resolved path.
  - other pop failure → warn; the stash entry keeps everything.

### V. verify
- Final branch + HEAD SHA, dirty-file counts, ahead/behind vs upstream.
- Assemble the summary + artifacts list:
  - stash backup label (if any)
  - backup branch name (if diverged was reset)
  - `.local.bak` files created (if conflicts were auto-resolved)

## 3. API contract (what the UI talks to)

`POST /api/projects/:id/pull-agent` with `{ "branch"?: string }` → SSE stream:

```
data: {"type":"steps","step":{"key":"backup","status":"ok","note":{"key":"dlg.pullAgent.note.backupStash","params":{"count":3}}}}
data: {"type":"done","result":{"ok":true,"upToDate":false,"before":"a1b2c3d","after":"e4f5a6b","restored":true,"autoResolved":[],"artifacts":{"stash":true,"stashLabel":"dashboard-agent 20250101-120000","branch":null,"backupFiles":[]},"steps":[...],"summary":"a1b2c3d → e4f5a6b · local changes restored","output":"..."}}
data: {"type":"failed","error":"...","detail":"...","result":{...}}
data: [DONE]
```

Rules:
- Auth-gated like every other route; every failure mode answers JSON or an
  SSE `failed` frame — NEVER an HTML 500 page.
- The step `note` is an i18n KEY + params so the client renders localized
  text; `info` carries raw git output for the detail log.
- Local-machine projects only: git must run where the code lives. Remote/
  device-proxied projects answer 400 with "update the agent on that machine".
- Activity log entry on completion (level warn when conflicts were
  auto-resolved, success otherwise).

## 4. UI requirements

1. **Live timeline dialog** (the agent "working" console): fixed 8-step
   vertical list, per-step status icon (pending dot / running spinner /
   ok check / warn triangle / fail cross / skipped dash), localized note
   under each step, collapsible raw transcript.
2. **Entry points** — every surface where a pull can fail must offer the
   agent:
   - the conflict dialog (stash/force list) — agent button FIRST
   - the AI diagnosis dialog — `agent` is a whitelisted action the LLM can
     recommend (still user-confirmed)
   - hide the agent for remote projects (git runs on another machine).
3. **Final report**: summary line (before → after SHA, restored yes/no,
   N conflicts auto-resolved) + artifacts list + where the backups live.
4. **Never a dead end**: failure shows the actionable error + retry button;
   closing the dialog mid-run does NOT cancel the server-side run
   (it is backup-first and safe by construction).
5. Mobile-friendly (max-w-md, scrollable timeline), dark-mode aware,
   i18n (zh/en at minimum).

## 5. Interop with the LLM diagnosis layer (if present)

The LLM picks ONE action from a fixed whitelist —
`retry | agent | stash | force | manual` — and NEVER generates commands:

- `retry` — transient network class only.
- `agent` — this skill; the default for local-change conflicts.
- `stash` / `force` — the older ask-the-user strategies (keep for users who
  want manual control; `force` requires a second explicit confirmation).
- `manual` — auth/repo-missing/unrecoverable classes; concrete steps shown.

Whitelist the LLM answer SERVER-side and CLIENT-side. Tell the LLM whether
the project is local or remote (`agent` is invalid for remote).

## 6. Reference implementation (this repo)

- `src/lib/pull-agent.ts` — the engine (state machine + parsing + backup +
  auto-resolution, ~600 lines, zero deps beyond git-retry/pull-conflict).
- `src/app/api/projects/[id]/pull-agent/route.ts` — the SSE route.
- `src/app/page.tsx` — `PullAgentDialog` (timeline UI), `runAgentPull`
  (SSE consumer), wiring into the v1.17 conflict dialog and v1.19 AI
  diagnosis dialog.
- `src/lib/pull-conflict.ts` — the C1/C2 stderr parser + path sanitizer +
  the legacy stash/force strategy executors (still used by the dialogs).
- `src/lib/git-retry.ts` — the C8 transient-network retry wrapper.
- `src/lib/i18n/dictionaries/{zh,en}/dialogs.ts` — `dlg.pullAgent.*` keys.
- Self-update reuse (v1.21): `src/app/api/self-update/route.ts` (GET — the
  dashboard checks ITS OWN repository exactly like a project: same
  `checkLocalRepoUpdate` pipeline, reserved cache key `__dashboard_self__`)
  and `src/app/api/self-update/pull/route.ts` (POST — the SAME engine,
  `runPullAgent({ projectPath: process.cwd() })`, SSE frames identical).
  Two extra guards when the target is the running app itself: a module-level
  in-flight lock (one self-update per process) and a call that pushes the
  background auto-pull's rate-limit floor forward so the two layers never
  interleave. Port both if the host app can update itself.

## 7. Acceptance matrix (verify ALL before shipping)

Build a local fixture: a bare "origin" repo + a clone. For each row, set up
the state, run the agent, assert the outcome:

| # | Setup | Expected outcome |
|---|-------|------------------|
| 1 | clean clone, remote advanced | ff pull, before→after, no artifacts |
| 2 | clean clone, no remote change | up-to-date, no artifacts |
| 3 | tracked file locally modified + remote changed same file | stash → pull → pop conflicts → `.local.bak` created, tree = pulled version, stash kept, autoResolved=[file] |
| 4 | untracked file that remote also added (package-lock.json case) | stash --include-untracked → pull → pop partial → `.local.bak` from `stash@{0}^3`, remote version in tree |
| 5 | local commits ahead + remote commits behind (diverged) | backup branch created, HEAD == origin/<branch>, artifacts.branch set |
| 6 | detached HEAD | warn, no crash |
| 7 | origin missing, project URL configured | origin wired, pull proceeds |
| 8 | remote branch deleted | fail: "remote has no branch", nothing destructive ran |
| 9 | auth failure / repo not found | fail with actionable message, no retry storm |
|10| branch switch request with dirty tree | stash → checkout target → sync → restore |
|11| network flake on fetch | auto-retried, fetchRetried note |
|12| remote project (deviceId set) | 400 "runs on the paired device" |

Also verify the UI: timeline updates live, artifacts render, closing
mid-run keeps the server run alive, i18n zh + en, mobile width.

## 8. Porting notes for other stacks

- Node/TS: direct port; keep `execFile` with `windowsHide: true` (console
  flashes on Windows services otherwise) and argv-only calls.
- Python: `subprocess.run(['git', ...], capture_output=True)` equivalent;
  same state machine; note `git show :3:<path>` needs a non-shell argv list
  to survive the colon in the path spec.
- Go: `os/exec` with `exec.Command("git", args...)` — same rules.
- The SSE frames are language-neutral; any streaming response works.
  Polling a job store is an acceptable substitute (repair-jobs pattern).
