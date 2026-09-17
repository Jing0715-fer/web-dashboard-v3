import { execFile } from 'child_process';
import { promisify } from 'util';
import { callLLM } from '@/lib/llm-providers';

// execFile with windowsHide ON by default: git.exe / git-remote-https.exe
// are console-subsystem programs — from a console-less dashboard server
// (supervisor/scheduled start) every git call allocates a WINDOW on the
// user's desktop. CREATE_NO_WINDOW on Windows, no-op elsewhere.
const execFileRawAsync = promisify(execFile);
const execFileAsync = (file: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> =>
  execFileRawAsync(file, args, { windowsHide: true, ...opts }) as unknown as Promise<{ stdout: string; stderr: string }>;

/**
 * AI-assisted pull diagnosis (dashboard v1.19).
 *
 * v1.17 already turns the blocked-by-local-changes class into a 409 with
 * file lists (stash / discard / cancel dialog). v1.18 auto-retries transient
 * network flakes. This module is the next layer: when a pull STILL fails
 * (retries exhausted, a conflict, auth, a broken repo…), the dashboard
 * asks the configured LLM provider to DIAGNOSE the failure and recommend
 * one of the already-implemented strategies.
 *
 * Safety model — the LLM never generates commands:
 *   - recommendedAction is validated against a fixed whitelist
 *     ('retry' | 'stash' | 'force' | 'manual'); anything else degrades
 *     to 'manual'.
 *   - 'stash' / 'force' execute through the SAME v1.17 pull route
 *     (git stash push --include-untracked → pull → pop, or discard ONLY
 *     the listed blocking files) — no new code path, no shell strings.
 *   - the frontend asks the user to CONFIRM the action before anything
 *     runs; 'force' additionally requires a second explicit confirmation
 *     (it discards the listed files irreversibly).
 */

export type PullDiagAction = 'retry' | 'stash' | 'force' | 'manual';
const VALID_ACTIONS: readonly PullDiagAction[] = ['retry', 'stash', 'force', 'manual'];

export interface PullDiagnosis {
  /** One short sentence naming the failure class. */
  rootCause: string;
  /** 1–3 sentences for a non-git-expert, in the user's language. */
  explanation: string;
  severity: 'low' | 'medium' | 'high';
  /** Whitelisted strategy id — see the module doc for semantics. */
  recommendedAction: PullDiagAction;
  /** Why this action fits this particular failure. */
  reason: string;
  /** 2–5 concrete manual steps (shown when the user picks manual / as background). */
  steps: string[];
}

export interface PullDiagnoseInput {
  /** Pull error title from the failing response (e.g. 'git pull failed'). */
  error: string;
  /** Raw stderr/detail from git. */
  detail?: string;
  /** v1.18 flag: transient network class, all auto-retries exhausted. */
  transient?: boolean;
  /** Branch the pull was switching to (optional). */
  branch?: string;
  /** UI language hint — the LLM answers in this language. */
  locale?: string;
  /** Blocking file lists when the failure was the 409 conflict class. */
  modified?: string[];
  untracked?: string[];
  /** Display name of the project (helps the model phrase things; not sensitive). */
  projectName?: string;
  /** Sanitized repo URL (tokens already stripped by the caller). */
  repoUrl?: string;
  /** Pre-collected git context for LOCAL projects (see collectGitContext). */
  gitContext?: string;
}

/** Strip credentials (PAT / basic-auth) from any URL before it reaches the
 * LLM prompt — remote URLs configured with embedded tokens must never leak. */
function sanitizeUrlToken(url: string): string {
  return String(url || '').replace(/(https?:\/\/)[^@/\s]+@/gi, '$1');
}

/** Read-only repo snapshot for the prompt: branch/status, recent commits,
 * remotes (token-stripped), stash entries. Every probe fails soft — a repo
 * in a weird state still gets diagnosed, just with less context. */
export async function collectGitContext(projectPath: string): Promise<string> {
  const parts: string[] = [];
  const run = async (args: string[], limit: number): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: projectPath, timeout: 10_000, maxBuffer: 256 * 1024,
      });
      return String(stdout || '').trim().split('\n').slice(0, limit).join('\n');
    } catch (e: any) {
      return `(unavailable: ${String(e?.stderr || e?.message || 'git error').trim().slice(0, 120)})`;
    }
  };
  // git remote -v can embed credentials in the URL — strip before it ever
  // leaves this process (the prompt may be proxied to a third-party LLM).
  const remote = sanitizeUrlToken(await run(['remote', '-v'], 4));
  parts.push(`$ git remote -v\n${remote}`);
  parts.push(`$ git status --porcelain -b (first 40 lines)\n${await run(['status', '--porcelain', '-b'], 40)}`);
  parts.push(`$ git log --oneline -5\n${await run(['log', '--oneline', '-5'], 5)}`);
  parts.push(`$ git stash list (first 5)\n${await run(['stash', 'list'], 5)}`);
  return parts.join('\n\n').slice(0, 4000);
}

const DIAGNOSE_SYSTEM_PROMPT = `You are a senior git expert embedded in a web dashboard. A "git pull" just failed on the user's machine. Diagnose the failure and recommend exactly ONE action.

Respond with ONLY a valid JSON object — no markdown fences, no prose outside the JSON — with exactly these keys:
{"rootCause": string, "explanation": string, "severity": "low"|"medium"|"high", "recommendedAction": "retry"|"stash"|"force"|"manual", "reason": string, "steps": string[]}

Action semantics (these strategies are ALREADY implemented by the dashboard — you only pick which one fits):
- "retry": the failure was transient (network flake, SSL/connection error, timeout) and another pull attempt is likely to succeed. NEVER choose this for conflicts, auth failures, or missing repos.
- "stash": local changes block the pull (blocking file lists are provided) — the dashboard will stash them, pull, then re-apply them automatically. Nothing is lost. Choose this when the listed local changes might matter.
- "force": local changes block the pull AND look disposable (build artifacts like package-lock.json, lock files, generated output) — the dashboard discards ONLY the listed files and takes the remote version. Destructive and irreversible for those files. When unsure between stash and force, prefer "stash".
- "manual": cannot be resolved safely by the dashboard (authentication/token failure, repository deleted or renamed, not a git repository, diverged history needing a human merge/rebase decision, disk or environment problems). Explain the concrete fix in "steps".

Rules:
- Write rootCause, explanation, reason and steps in the user's language (a "locale" hint is provided; default to concise English).
- rootCause: one short sentence naming the failure class.
- explanation: 1-3 sentences understandable by someone who is NOT a git expert.
- reason: why the recommended action fits THIS failure.
- steps: 2-5 short, concrete, executable manual instructions (shell commands the user can copy are welcome here).
- Use only the provided error text and git context; never invent file names.
- If the detail mentions the pull was already auto-retried, treat the network problem as persistent and say so.`;

/** Clamp + sanitize one LLM-generated text field. */
function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Parse + whitelist the LLM's JSON. Throws on unusable output (the route
 * then reports an unavailable diagnosis and the frontend falls back to the
 * v1.17 conflict dialog / plain error toast). */
export function parseDiagnosis(text: string): PullDiagnosis {
  let raw = String(text || '').trim();
  // Tolerate markdown fences some models add despite the instructions.
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  // Tolerate leading prose before the JSON object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('diagnosis is not a JSON object');
  let obj: any;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('diagnosis JSON is unparseable');
  }

  const actionRaw = String(obj?.recommendedAction || '').toLowerCase();
  const recommendedAction: PullDiagAction =
    (VALID_ACTIONS as readonly string[]).includes(actionRaw) ? (actionRaw as PullDiagAction) : 'manual';

  const sevRaw = String(obj?.severity || '').toLowerCase();
  const severity: PullDiagnosis['severity'] =
    sevRaw === 'low' || sevRaw === 'high' ? sevRaw : 'medium';

  const steps: string[] = Array.isArray(obj?.steps)
    ? obj.steps
        .map((s: unknown) => cleanText(s, 400))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const rootCause = cleanText(obj?.rootCause, 200);
  const explanation = cleanText(obj?.explanation, 700);
  const reason = cleanText(obj?.reason, 400);
  if (!rootCause && !explanation) throw new Error('diagnosis is empty');

  return {
    rootCause: rootCause || '(no root cause given)',
    explanation,
    severity,
    recommendedAction,
    reason,
    steps,
  };
}

/** The user-facing prompt body: failure, conflict lists, live git context. */
export function buildDiagnosisPrompt(input: PullDiagnoseInput): string {
  const lines: string[] = [];
  lines.push(`Failed git pull${input.projectName ? ` on project "${input.projectName}"` : ''}${input.branch ? ` (switching to branch "${input.branch}")` : ''}.`);
  if (input.repoUrl) lines.push(`Repository: ${sanitizeUrlToken(input.repoUrl)}`);
  if (input.transient) {
    lines.push('NOTE: this was a transient network failure class and the dashboard ALREADY auto-retried it 3 times with backoff — the problem persisted through all retries.');
  }
  lines.push('');
  lines.push('Error returned to the user:');
  lines.push(cleanText(input.error, 400) || '(none)');
  if (input.detail) {
    lines.push('');
    lines.push('Raw git output / detail:');
    lines.push(String(input.detail).slice(0, 1200));
  }
  const modified = (input.modified || []).filter(Boolean);
  const untracked = (input.untracked || []).filter(Boolean);
  if (modified.length > 0 || untracked.length > 0) {
    lines.push('');
    lines.push('The pull was blocked by local changes (the dashboard already extracted these exact lists from the error):');
    if (modified.length > 0) lines.push(`- Modified tracked files: ${modified.slice(0, 30).join(', ')}`);
    if (untracked.length > 0) lines.push(`- Untracked files that would be overwritten: ${untracked.slice(0, 30).join(', ')}`);
  }
  lines.push('');
  lines.push('Current repository state (read-only probes):');
  lines.push(input.gitContext || '(not available — the pull ran on a remote device agent, or the local repo could not be probed)');
  lines.push('');
  lines.push(`locale: ${input.locale === 'zh' ? 'zh (中文)' : 'en'}`);
  return lines.join('\n').slice(0, 8000);
}

const DIAGNOSE_TIMEOUT_MS = 90_000;

/** Full diagnosis: prompt → configured LLM → whitelisted result.
 * One retry on rate-limit answers (the z-ai backend intermittently 429s a
 * burst; a single spaced retry recovers most of them) — anything else fails
 * through to the v1.17 fallback UX. */
export async function diagnosePullFailure(input: PullDiagnoseInput): Promise<{ diagnosis: PullDiagnosis; provider: string; model: string }> {
  const prompt = buildDiagnosisPrompt(input);
  // Promise.race watchdog — callLLM has no built-in timeout and a hung
  // provider must not hang the diagnose route (the frontend waits on it).
  const attempt = async (): Promise<{ text: string; provider: string; model: string }> => {
    let timer: any = null;
    try {
      return await Promise.race([
        callLLM({ system: DIAGNOSE_SYSTEM_PROMPT, prompt, temperature: 0.2 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LLM diagnosis timed out after ${DIAGNOSE_TIMEOUT_MS / 1000}s`)),
            DIAGNOSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    const llm = await attempt();
    const diagnosis = parseDiagnosis(llm.text);
    return { diagnosis, provider: llm.provider, model: llm.model };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/429|too many|rate limit/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 15_000));
      const retried = await attempt();
      const diagnosis = parseDiagnosis(retried.text);
      return { diagnosis, provider: retried.provider, model: retried.model };
    }
    throw e;
  }
}
