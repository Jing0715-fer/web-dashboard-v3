/**
 * Server-boot instrumentation.
 *
 * Next.js runs register() once per server process (dev + prod). We use it
 * for two things:
 *
 *   1. Guarantee the co-located mesh agent service (mini-services/agent,
 *      port 3101) is running CURRENT code on dashboard machines:
 *      - a fresh clone / first boot → the agent is spawned with a persisted
 *        identity (agent-config.json) — no manual start.sh step;
 *      - `git pull` + dashboard restart → a still-running OLD agent process
 *        (git pull cannot hot-reload a spawned child) is detected via its
 *        health markers and respawned with the new code.
 *      This keeps the mesh self-healing with zero user steps: heartbeats and
 *      project pushes resume within seconds of a dashboard restart.
 *
 *   2. Warm up the in-process harness engine (project LLM analysis). The
 *      engine runs INSIDE this server on the dashboard port — no separate
 *      llm-gateway/harness-agent processes, no extra ports to occupy.
 *      Warming up restores finished sessions from disk, schedules artifact
 *      cleanup and registers the shutdown handler that kills dsh children.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { ensureLocalAgent } = await import('@/lib/agent-lifecycle');
    // Fire-and-forget: never block server boot on agent lifecycle. A short
    // delay lets the HTTP listener bind first (register can run before the
    // server accepts requests; the agent probe is local so order doesn't
    // matter, but a settled boot makes logs easier to read).
    setTimeout(() => {
      ensureLocalAgent().catch((err: any) => {
        console.warn('[instrumentation] local agent ensure failed:', err?.message || err);
      });
    }, 2500);
  } catch (err: any) {
    console.warn('[instrumentation] agent module load failed:', err?.message || err);
  }
  try {
    const { ensureEngine } = await import('@/lib/harness/engine');
    setTimeout(() => {
      try {
        ensureEngine();
      } catch (err: any) {
        console.warn('[instrumentation] harness engine init failed:', err?.message || err);
      }
    }, 1500);
  } catch (err: any) {
    console.warn('[instrumentation] harness engine module load failed:', err?.message || err);
  }
}
