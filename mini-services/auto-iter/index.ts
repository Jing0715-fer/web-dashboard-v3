/**
 * auto-iter — unattended continuous-iteration service for web-dashboard-v3.
 *
 * Every INTERVAL (default 30 min) it runs ONE guarded round:
 *   1. Preflight: worktree must be clean (CRLF-only noise is auto-reset).
 *   2. Inspect: read NEW dev.log content since the last round (byte offset),
 *      extract hard errors (⨯ / uncaught / 500).
 *   3. Decide:
 *        - errors found  → LLM analyzes + proposes a FIX, allowed ONLY as
 *          full-file replacement of EXISTING src/ files ≤ 400 lines.
 *        - no errors     → take the next unchecked item from backlog.md,
 *          LLM implements it, allowed ONLY as NEW files under docs/,
 *          scripts/, .github/.
 *   4. Verify: `bun run lint` must pass AND the dev server must still answer.
 *      On failure → restore original file contents (rollback), no commit.
 *   5. Commit (only the round's allow-listed files — never `git add -A`)
 *      and push with the PAT from .env. Push conflicts → rollback + log.
 *   6. Record: append to /home/z/my-project/worklog.md + update state.json.
 *
 * Safety rails:
 *   - ≤ 3 files touched per round
 *   - 3 consecutive failed rounds → status=paused (manual state.json flip
 *     or service restart with AUTO_ITER_FORCE=1 resumes)
 *   - PAT lives in mini-services/auto-iter/.env (gitignored, chmod 600)
 *   - status endpoint on port 3111 (GET / → state + tail of iter.log)
 *
 * Run:  bun run dev   (hot-reload loop)   |   bun run once (single round)
 */
import ZAI from 'z-ai-web-dev-sdk'
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'

// ============================== config ==============================
const ROOT = '/home/z/my-project'
const DIR = join(ROOT, 'mini-services/auto-iter')
const REPO_URL = 'https://github.com/Jing0715-fer/web-dashboard-v3.git'
const PORT = 3111
const INTERVAL_MS = Number(process.env.AUTO_ITER_INTERVAL_MS ?? 30 * 60_000)
const MAX_FILES_PER_ROUND = 3
const MAX_PATCHABLE_LINES = 400
const MAX_CONSECUTIVE_FAILURES = 3
const DEV_LOG = join(ROOT, 'dev.log')
const WORKLOG = join(ROOT, 'worklog.md')

// New-file prefixes allowed in backlog mode (never existing code):
const NEW_FILE_PREFIXES = ['docs/', 'scripts/', '.github/']
// Existing-file patch roots allowed in repair mode:
const PATCH_ROOTS = ['src/app/api/', 'src/lib/', 'mini-services/agent/']

interface IterState {
  round: number
  status: 'active' | 'paused'
  lastRunAt: string | null
  lastResult: string | null
  consecutiveFailures: number
  logOffset: number
}
interface FileOut { path: string; content: string }
interface LlmPlan { analysis: string; files: FileOut[]; summary: string }

// ============================== helpers ==============================
const now = () => new Date().toISOString()
const log = (msg: string) => {
  const line = `[${now()}] ${msg}`
  console.log(line)
  try { appendFileSync(join(DIR, 'iter.log'), line + '\n') } catch { /* best-effort */ }
}

function loadState(): IterState {
  try {
    return JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8')) as IterState
  } catch {
    return { round: 0, status: 'active', lastRunAt: null, lastResult: null, consecutiveFailures: 0, logOffset: 0 }
  }
}
function saveState(s: IterState) {
  writeFileSync(join(DIR, 'state.json'), JSON.stringify(s, null, 2))
}

function git(args: string): { ok: boolean; out: string } {
  try {
    const out = execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: (e?.stdout || '') + (e?.stderr || e?.message || '') }
  }
}

function gitPat(): string | null {
  try {
    const env = readFileSync(join(DIR, '.env'), 'utf8')
    return env.match(/GITHUB_PAT\s*=\s*(\S+)/)?.[1]?.trim() ?? null
  } catch { return null }
}

/** LLM chat via z-ai-web-dev-sdk (backend-only SDK — this is a backend service). */
async function askLLM(system: string, user: string): Promise<string> {
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'disabled' },
  })
  const content = completion.choices[0]?.message?.content ?? ''
  if (!content.trim()) throw new Error('LLM returned empty content')
  return content
}

/** Parse a JSON object out of an LLM reply (tolerates ```json fences + prose). */
function parseLlmJson<T>(raw: string): T {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM reply')
  return JSON.parse(text.slice(start, end + 1)) as T
}

/** Read dev.log bytes added since `offset`; returns [text, newOffset]. */
function readNewLog(offset: number): { text: string; offset: number } {
  try {
    const size = statSync(DEV_LOG).size
    if (size <= offset) return { text: '', offset }
    const fh = Bun.file(DEV_LOG)
    // slice by byte range via stream read
    const buf = Buffer.from(readFileSync(DEV_LOG).subarray(offset))
    return { text: buf.toString('utf8'), offset: size }
  } catch {
    return { text: '', offset }
  }
}

const ERROR_PATTERNS = [
  /⨯/u,
  /uncaught(?: exception)?/i,
  /Unhandled Promise Rejection/i,
  / GET \/[^\s]* 5\d\d /,
  / POST \/[^\s]* 5\d\d /,
  / PUT \/[^\s]* 5\d\d /,
  / DELETE \/[^\s]* 5\d\d /,
]

function extractErrorLines(logText: string): string[] {
  if (!logText) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of logText.split('\n')) {
    if (!line.trim()) continue
    if (line.includes('disk cleanup') || line.includes('prisma:query')) continue
    if (ERROR_PATTERNS.some((re) => re.test(line))) {
      // collapse identical lines (dev log repeats per request)
      const key = line.replace(/\d+ms/g, 'Nms').slice(0, 160)
      if (!seen.has(key) && out.length < 25) { seen.add(key); out.push(line.slice(0, 300)) }
    }
  }
  return out
}

/** Ensure the worktree is clean; CRLF-only noise is reset, real edits abort. */
function ensureCleanWorktree(): { ok: boolean; reason: string } {
  const st = git('status --porcelain')
  if (!st.ok) return { ok: false, reason: 'git status failed: ' + st.out.slice(0, 200) }
  if (!st.out.trim()) return { ok: true, reason: '' }
  const realDiff = git('diff -w --stat -- src/ mini-services/ prisma/ package.json')
  if (realDiff.ok && !realDiff.out.trim()) {
    // whitespace/line-ending only → safe reset
    git('checkout -- .')
    log('preflight: reset whitespace-only worktree noise')
    const st2 = git('status --porcelain')
    if (st2.ok && !st2.out.trim()) return { ok: true, reason: '' }
    return { ok: false, reason: 'untracked files present — skipping to avoid mixing: ' + st2.out.split('\n').slice(0, 5).join(' | ') }
  }
  return { ok: false, reason: 'real uncommitted changes present — skipping round: ' + st.out.split('\n').slice(0, 5).join(' | ') }
}

function lintPasses(): boolean {
  try {
    execSync('bun run lint', { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
    return true
  } catch { return false }
}

function devServerAlive(): boolean {
  try {
    const r = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://localhost:3000/api/auth/session`, { encoding: 'utf8', timeout: 30_000 })
    return r === '200' || r === '401' || r === '403'
  } catch { return false }
}

/** Commit ONLY the given paths and push. Rollback on push conflict. */
function commitAndPush(paths: string[], message: string): { ok: boolean; error?: string } {
  const before = git('rev-parse HEAD')
  if (!before.ok) return { ok: false, error: 'rev-parse failed' }
  for (const p of paths) {
    const add = git(`add -- "${p.replace(/"/g, '\\"')}"`)
    if (!add.ok) return { ok: false, error: 'git add failed for ' + p }
  }
  const commitMsg = message.replace(/"/g, '\\"').split('\n')[0].slice(0, 120)
  const commit = git(`commit -m "${commitMsg}"`)
  if (!commit.ok) return { ok: false, error: 'git commit failed: ' + commit.out.slice(0, 300) }
  const pat = gitPat()
  if (!pat) return { ok: false, error: 'GITHUB_PAT missing in mini-services/auto-iter/.env' }
  const push = git(`push https://${pat}@github.com/Jing0715-fer/web-dashboard-v3.git main`)
  if (!push.ok) {
    // conflict / non-ff — roll back this round's commit locally, keep origin intact
    git(`reset --hard ${before.out.trim()}`)
    return { ok: false, error: 'push failed (origin moved?): ' + push.out.slice(0, 300) }
  }
  git('fetch origin') // refresh origin/main ref
  return { ok: true }
}

function appendWorklog(taskId: string, lines: string[]) {
  const entry = [
    '---',
    `Task ID: ${taskId}`,
    `Agent: auto-iter (unattended)`,
    `Task: scheduled iteration round ${state.round}`,
    '',
    'Work Log:',
    ...lines.map((l) => `- ${l}`),
    '',
    'Stage Summary:',
    `- round ${state.round} ${state.lastResult ?? ''}`,
    '',
  ].join('\n')
  try { appendFileSync(WORKLOG, entry + '\n') } catch { /* best-effort */ }
}

// ============================== LLM round builders ==============================

/** Extract src file paths mentioned in error lines. */
function filesFromErrors(errors: string[]): string[] {
  const found = new Set<string>()
  for (const line of errors) {
    const m = line.match(/(src\/[A-Za-z0-9_\/.-]+\.(?:ts|tsx))/g)
    if (m) for (const p of m) found.add(p)
  }
  return [...found].slice(0, 5)
}

function readFileCapped(path: string, cap = MAX_PATCHABLE_LINES): { content: string; lines: number; truncated: boolean } | null {
  try {
    const raw = readFileSync(join(ROOT, path), 'utf8')
    const lines = raw.split('\n')
    if (lines.length > cap) {
      return { content: lines.slice(0, Math.floor(cap * 0.6)).join('\n') + '\n… [TRUNCATED] …\n' + lines.slice(-Math.floor(cap * 0.3)).join('\n'), lines: lines.length, truncated: true }
    }
    return { content: raw, lines: lines.length, truncated: false }
  } catch { return null }
}

const SYSTEM_PROMPT = [
  'You are the auto-iter agent for a Next.js 16 (App Router) + TypeScript + Prisma/SQLite project ("web-dashboard-v3") running in dev mode on Linux with bun.',
  'You output ONLY a JSON object with keys: "analysis" (string), "files" (array of {path, content}), "summary" (short imperative commit message, English, conventional-commit style).',
  'Every file you emit must be COMPLETE (full new file content, no placeholders, no "..."). Never emit diffs. Never emit partial files.',
  'Keep changes minimal, focused and low-risk. TypeScript strict, ES modules, no test code, no new heavy dependencies.',
  'If you cannot produce a safe complete change, return {"analysis":"...","files":[],"summary":"noop"} — an empty files array is a valid, safe answer.',
].join(' ')

async function repairRound(errors: string[]): Promise<{ plan: LlmPlan | null; note: string }> {
  const candidateFiles = filesFromErrors(errors)
  const fileBlocks: string[] = []
  for (const p of candidateFiles) {
    const info = readFileCapped(p)
    if (info) fileBlocks.push(`FILE ${p} (${info.lines} lines):\n\`\`\`\n${info.content}\n\`\`\``)
  }
  const user = [
    'The dev server log shows these NEW hard errors since the last check:',
    '```',
    errors.join('\n'),
    '```',
    fileBlocks.length ? 'Likely-related source files:\n\n' + fileBlocks.join('\n\n') : 'No source path found in the errors — infer the likely route/lib from the URL in the log lines, and say so in "analysis".',
    '',
    'TASK: Diagnose and produce a minimal fix. CONSTRAINTS:',
    '- You may ONLY replace EXISTING files under src/app/api/, src/lib/ or mini-services/agent/ whose current size is ≤ 400 lines.',
    '- Emit the FULL corrected file content for each file you change (max 3 files).',
    '- If the error looks transient/environmental (network hiccup, compile blip, port race that self-resolved), choose the noop answer instead of forcing a change.',
  ].join('\n')
  const raw = await askLLM(SYSTEM_PROMPT, user)
  return { plan: parseLlmJson<LlmPlan>(raw), note: 'repair' }
}

async function backlogRound(): Promise<{ plan: LlmPlan | null; note: string }> {
  const backlogRaw = readFileSync(join(DIR, 'backlog.md'), 'utf8')
  const nextItem = backlogRaw.split('\n').find((l) => l.trim().startsWith('- [ ]'))
  if (!nextItem) return { plan: null, note: 'backlog empty — patrol only' }
  const item = nextItem.replace(/^-\s*\[\s*\]\s*/, '').trim()

  // context: api route tree + route header comments + schema
  const routes = execSync(`find src/app/api -name route.ts | sort`, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim().split('\n').filter(Boolean)
  const routeBlocks: string[] = []
  for (const r of routes.slice(0, 60)) {
    try {
      const head = readFileSync(join(ROOT, r), 'utf8').split('\n').slice(0, 18).join('\n')
      routeBlocks.push(`${r}\n${head}`)
    } catch { /* skip */ }
  }
  let schema = ''
  try { schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8').split('\n').slice(0, 120).join('\n') } catch { /* no schema */ }

  const user = [
    'Project layout: Next.js 16 App Router dashboard managing local + remote (Windows/Mac agent) dev environments; auth (credentials+google), devices registry, LLM config + repair engine, harness analysis, mesh relay.',
    '',
    'API routes (path + header comment):',
    routeBlocks.join('\n\n---\n\n').slice(0, 60_000),
    '',
    'Prisma schema (first 120 lines):',
    '```prisma',
    schema,
    '```',
    '',
    `NEXT BACKLOG ITEM: ${item}`,
    '',
    'TASK: Implement this item. CONSTRAINTS:',
    '- You may ONLY create NEW files under docs/, scripts/ or .github/ (no existing-file edits).',
    '- Read the provided context carefully — documents must describe THIS project accurately, not a generic template.',
    '- Max 3 files, each ≤ 500 lines, complete content.',
  ].join('\n')
  const raw = await askLLM(SYSTEM_PROMPT, user)
  return { plan: parseLlmJson<LlmPlan>(raw), note: item.slice(0, 80) }
}

// ============================== round executor ==============================

let state = loadState()
let running = false

function pathAllowedNew(p: string): boolean {
  if (p.includes('..') || p.startsWith('/')) return false
  return NEW_FILE_PREFIXES.some((prefix) => p.startsWith(prefix)) && !existsSync(join(ROOT, p))
}
function pathAllowedPatch(p: string): boolean {
  if (p.includes('..') || p.startsWith('/')) return false
  if (!PATCH_ROOTS.some((root) => p.startsWith(root))) return false
  if (!existsSync(join(ROOT, p))) return false
  const info = readFileCapped(p)
  return !!info && !info.truncated
}

async function runIteration(): Promise<void> {
  if (running) return
  running = true
  const startedAt = Date.now()
  try {
    state = loadState() // re-read (manual un-pause / hot reload)
    state.round += 1

    if (state.status === 'paused') {
      state.lastRunAt = now()
      state.lastResult = 'paused (consecutive failures) — manual resume required'
      saveState(state)
      log(`round ${state.round}: SKIPPED (paused)`)
      return
    }

    // 1. worktree preflight
    const clean = ensureCleanWorktree()
    if (!clean.ok) {
      state.lastRunAt = now()
      state.lastResult = 'skipped: ' + clean.reason.slice(0, 160)
      saveState(state)
      log(`round ${state.round}: SKIP — ${clean.reason.slice(0, 200)}`)
      appendWorklog(`auto-${state.round}`, ['round skipped: ' + clean.reason.slice(0, 200)])
      return
    }

    // 2. inspect new log content
    const { text, offset } = readNewLog(state.logOffset)
    state.logOffset = offset
    const errors = extractErrorLines(text)

    let plan: LlmPlan | null = null
    let note = ''
    let mode = 'patrol'
    try {
      if (errors.length > 0) {
        mode = 'repair'
        log(`round ${state.round}: ${errors.length} new error line(s) → repair mode`)
        const r = await repairRound(errors)
        plan = r.plan
        note = r.note
      } else {
        log(`round ${state.round}: no new errors → backlog mode`)
        const b = await backlogRound()
        plan = b.plan
        note = b.note
      }
    } catch (e: any) {
      throw new Error('LLM round failed: ' + String(e?.message || e).slice(0, 300))
    }

    // 3. apply plan (guarded)
    const files = (plan?.files ?? []).slice(0, MAX_FILES_PER_ROUND)
    const originals = new Map<string, string | null>()
    const touched: string[] = []
    let applied = 0

    for (const f of files) {
      const p = f.path?.trim()
      if (!p || typeof f.content !== 'string' || !f.content.trim()) continue
      const allowed = mode === 'repair' ? pathAllowedPatch(p) : pathAllowedNew(p)
      if (!allowed) {
        log(`round ${state.round}: REJECT path ${p} (not in ${mode} allowlist)`)
        continue
      }
      originals.set(p, existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null)
      mkdirSync(dirname(join(ROOT, p)), { recursive: true })
      writeFileSync(join(ROOT, p), f.content)
      touched.push(p)
      applied++
    }

    if (applied === 0) {
      state.lastRunAt = now()
      state.lastResult = `${mode}: noop (${note})`
      state.consecutiveFailures = 0
      saveState(state)
      log(`round ${state.round}: noop — ${note}`)
      return
    }

    // 4. verify
    const lintOk = lintPasses()
    const alive = devServerAlive()
    if (!lintOk || !alive) {
      // rollback
      for (const [p, original] of originals) {
        if (original === null) { /* new file that failed verify — remove */ try { execSync(`rm -f "${join(ROOT, p)}"`) } catch { /* ignore */ } }
        else writeFileSync(join(ROOT, p), original)
      }
      git('checkout -- .') // safety net for any straggler
      state.consecutiveFailures += 1
      state.lastRunAt = now()
      state.lastResult = `verify FAILED (lint=${lintOk} alive=${alive}) → rolled back ${touched.join(', ').slice(0, 120)}`
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) state.status = 'paused'
      saveState(state)
      log(`round ${state.round}: VERIFY FAILED (lint=${lintOk}, server alive=${alive}) — rolled back; failures=${state.consecutiveFailures}`)
      appendWorklog(`auto-${state.round}`, [
        `mode: ${mode} (${note})`,
        `verify failed (lint=${lintOk}, devServer=${alive}); rolled back: ${touched.join(', ')}`,
        `consecutive failures: ${state.consecutiveFailures}${state.status === 'paused' ? ' → SERVICE PAUSED' : ''}`,
      ])
      return
    }

    // 5. commit + push
    const message = `auto-iter(${state.round}): ${plan?.summary || mode + ' — ' + note}`
    const push = commitAndPush(touched, message)
    if (!push.ok) {
      for (const [p, original] of originals) {
        if (original === null) { try { execSync(`rm -f "${join(ROOT, p)}"`) } catch { /* ignore */ } }
        else writeFileSync(join(ROOT, p), original)
      }
      git('checkout -- .')
      git('reset --hard origin/main 2>/dev/null || true')
      state.consecutiveFailures += 1
      state.lastRunAt = now()
      state.lastResult = `push failed → rolled back: ${push.error?.slice(0, 160)}`
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) state.status = 'paused'
      saveState(state)
      log(`round ${state.round}: PUSH FAILED — rolled back (${push.error?.slice(0, 200)})`)
      appendWorklog(`auto-${state.round}`, [
        `mode: ${mode} (${note})`,
        `push failed: ${(push.error || '').slice(0, 200)}; round rolled back`,
        `consecutive failures: ${state.consecutiveFailures}${state.status === 'paused' ? ' → SERVICE PAUSED' : ''}`,
      ])
      return
    }

    // 6. mark backlog item done + success state
    if (mode !== 'repair') {
      try {
        const bl = readFileSync(join(DIR, 'backlog.md'), 'utf8')
        const updated = bl.replace('- [ ]', '- [x]')
        writeFileSync(join(DIR, 'backlog.md'), updated)
      } catch { /* best-effort */ }
    }
    state.consecutiveFailures = 0
    state.lastRunAt = now()
    state.lastResult = `OK ${mode} → committed ${touched.join(', ').slice(0, 160)} (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`
    saveState(state)
    log(`round ${state.round}: OK — ${state.lastResult}`)
    appendWorklog(`auto-${state.round}`, [
      `mode: ${mode} (${note})`,
      `analysis: ${plan?.analysis?.slice(0, 300) ?? ''}`,
      `committed: ${touched.join(', ')}`,
      `pushed to origin/main`,
    ])
  } catch (e: any) {
    state.consecutiveFailures += 1
    state.lastRunAt = now()
    state.lastResult = 'error: ' + String(e?.message || e).slice(0, 200)
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) state.status = 'paused'
    saveState(state)
    log(`round ${state.round}: ERROR — ${state.lastResult}`)
    appendWorklog(`auto-${state.round}`, [`unhandled error: ${state.lastResult}`])
  } finally {
    running = false
  }
}

// ============================== status endpoint ==============================
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/state') {
      let tail = ''
      try { tail = readFileSync(join(DIR, 'iter.log'), 'utf8').split('\n').filter(Boolean).slice(-30).join('\n') } catch { /* no log yet */ }
      return Response.json({ service: 'auto-iter', port: PORT, intervalMs: INTERVAL_MS, ...state, recentLog: tail })
    }
    return new Response('not found', { status: 404 })
  },
})

// ============================== entry ==============================
if (process.argv.includes('--once')) {
  log('single-round mode (--once)')
  await runIteration()
  process.exit(0)
}

log(`auto-iter started — port ${PORT}, interval ${Math.round(INTERVAL_MS / 60000)} min`)
setTimeout(() => { void runIteration() }, 60_000)
setInterval(() => { void runIteration() }, INTERVAL_MS)
