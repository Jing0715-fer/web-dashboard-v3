# auto-iter — unattended continuous iteration service

Runs one guarded iteration round every 30 minutes against the main project
(`/home/z/my-project`) and pushes each successful round to GitHub.

## Quick facts

| | |
|---|---|
| Port (status only) | `3111` — `GET /` returns state + recent log tail |
| Round interval | 30 min (`AUTO_ITER_INTERVAL_MS` env to override) |
| Entry | `bun run dev` (hot reload) · `bun run once` (single round) |
| State | `state.json` (round #, status, failures, dev.log offset) |
| Log | `iter.log` + appends to `/home/z/my-project/worklog.md` |
| Credentials | `.env` → `GITHUB_PAT=...` (gitignored, chmod 600) |

## Round flow

1. **Preflight** — worktree must be clean. CRLF-only noise is auto-reset;
   real uncommitted changes abort the round (never mixed).
2. **Inspect** — new `dev.log` bytes since last round → hard-error lines
   (⨯ / uncaught / 5xx).
3. **Repair mode** (errors found) — LLM proposes fixes, applied ONLY as
   full-file replacement of existing files under `src/app/api/`, `src/lib/`,
   `mini-services/agent/` that are ≤ 400 lines.
4. **Backlog mode** (no errors) — next unchecked item in `backlog.md`,
   implemented ONLY as new files under `docs/`, `scripts/`, `.github/`.
5. **Verify** — `bun run lint` passes AND dev server still answers
   (`/api/auth/session` → 2xx/401/403). Failure → original contents restored,
   nothing committed.
6. **Commit + push** — only the round's allow-listed files (never `add -A`).
   Push conflict → local rollback, origin untouched.
7. **Record** — `worklog.md` entry + `state.json` update.

## Safety rails

- ≤ 3 files per round, complete-file writes only (no partial diffs)
- 3 consecutive failed rounds → `status: paused` in `state.json`
  (rounds keep logging but do nothing; set back to `active` to resume)
- Path allowlists enforced in both modes; `..`/absolute paths rejected
- Empty LLM plan (`files: []`) is a valid noop — never forces a change
- PAT never appears in git config/remotes — assembled per-push from `.env`

## Files

```
index.ts     service logic
backlog.md   iteration queue (new-file tasks, checked off as done)
state.json   runtime state (gitignored)
iter.log     per-round log (gitignored)
.env         GITHUB_PAT (gitignored, 600)
```
