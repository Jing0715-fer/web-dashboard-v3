/**
 * Server-boot instrumentation.
 *
 * Next.js runs register() once per server process (dev + prod). We use it
 * to guarantee the co-located agent service (mini-services/agent*) is
 * running CURRENT code on dashboard machines:
 *
 *   - a fresh clone / first boot → the agent is spawned with a persisted
 *     identity (agent-config.json) — no manual start.sh step;
 *   - `git pull` + dashboard restart → a still-running OLD agent process
 *     (git pull cannot hot-reload a spawned child) is detected via its
 *     health markers and respawned with the new code.
 *
 * This keeps the mesh self-healing with zero user steps: heartbeats and
 * project pushes resume within seconds of a dashboard restart.
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
      ensureLocalAgent().catch((err) => {
        console.warn('[instrumentation] local agent ensure failed:', err?.message || err);
      });
    }, 2500);
  } catch (err: any) {
    console.warn('[instrumentation] agent module load failed:', err?.message || err);
  }
}
