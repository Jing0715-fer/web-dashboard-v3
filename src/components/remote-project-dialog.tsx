'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  MonitorSmartphone, Loader2, CheckCircle2, XCircle, Terminal, FileText,
  Search, Play, CircleDot, Gauge, Server, Zap, Save,
} from 'lucide-react'
import { AppDialog, AppDialogHeader, AppDialogTitle, AppDialogDescription, AppDialogBody, AppDialogFooter } from '@/components/app-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addToast } from '@/hooks/use-toast'
import { useT, type I18nContextValue } from '@/lib/i18n'

interface DeviceInfo { id: string; name: string; ip: string; port: number; status: string }

interface ProgressItem { ts: number; kind: string; text: string }

/** Server-side auto-apply outcome attached by the analyze-remote route. */
interface AppliedInfo {
  pending?: boolean
  ok?: boolean
  status?: string
  applied?: number
  projectId?: string | null
  error?: string
}

/** sessionStorage key for the in-flight remote analysis (wizard restore). */
const STORAGE_KEY = 'dashboard-remote-analysis'
/** Bounded wait for the server-side auto-apply before manual fallback. */
const AUTO_APPLY_WAIT_MS = 120_000

const kindIcon: Record<string, React.ReactNode> = {
  start: <CircleDot className="h-3.5 w-3.5 text-sky-500" />,
  command: <Terminal className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
  file: <FileText className="h-3.5 w-3.5 text-violet-500" />,
  result: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  note: <Search className="h-3.5 w-3.5 text-muted-foreground" />,
}

/**
 * RemoteProjectDialog — add a project that lives on a remote device:
 * enter the on-device path, the dashboard triggers the remote agent's
 * auto-debug analysis (LLM supplied by the dashboard's gateway) and shows
 * live progress until the service is verified to boot on the device.
 *
 * The verified result is applied on the device server-side automatically
 * (dashboard-side auto-apply watcher) — closing the dialog or reloading
 * can no longer lose it; this dialog adds progress + optional start.
 */
export function RemoteProjectDialog({
  open,
  onClose,
  devices,
  lanIp,
  onCompleted,
}: {
  open: boolean
  onClose: () => void
  devices: DeviceInfo[]
  lanIp: string
  onCompleted: () => void
}) {
  const t = useT()
  const [deviceId, setDeviceId] = React.useState('')
  const [path, setPath] = React.useState('')
  const [name, setName] = React.useState('')
  const [jobId, setJobId] = React.useState<string | null>(null)
  const [job, setJob] = React.useState<any>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [applied, setApplied] = React.useState(false)
  const [elapsed, setElapsed] = React.useState(0)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pendingSinceRef = React.useRef<number | null>(null)
  const autoNotifiedRef = React.useRef<string | null>(null)

  const clearRemoteSession = React.useCallback(() => {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }, [])

  // Reset on close; on open, restore an in-flight analysis (survives reload).
  React.useEffect(() => {
    if (!open) {
      setJobId(null); setJob(null); setError(null); setApplied(false); setElapsed(0); setPath(''); setName(''); setStarting(false)
      pendingSinceRef.current = null
      return
    }
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (raw) {
        const sess = JSON.parse(raw)
        if (sess?.jobId && sess?.deviceId && devices.some((d) => d.id === sess.deviceId)) {
          setJobId(sess.jobId)
          setDeviceId(sess.deviceId)
          if (sess.path) setPath(sess.path)
          if (sess.name) setName(sess.name)
          return
        }
        clearRemoteSession()
      }
    } catch { try { sessionStorage.removeItem(STORAGE_KEY) } catch {} }
    if (devices.length > 0 && !deviceId) {
      setDeviceId(devices[0].id)
    }
  }, [open, devices, deviceId, clearRemoteSession])

  // Poll the remote analysis job — and keep polling past the terminal state
  // while the server-side auto-apply is still in flight.
  React.useEffect(() => {
    if (!jobId || !deviceId) return
    let stop = false
    const started = Date.now()
    const tick = async () => {
      try {
        const res = await fetch(`/api/devices/${deviceId}/analyze-remote?jobId=${jobId}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (!stop) { setJob(data); setError(null) }
          if (data.status !== 'running') {
            if (data.applied?.pending) {
              if (pendingSinceRef.current === null) pendingSinceRef.current = Date.now()
              if (Date.now() - pendingSinceRef.current < AUTO_APPLY_WAIT_MS) {
                if (!stop) { setElapsed(Math.floor((Date.now() - started) / 1000)); timer = window.setTimeout(tick, 1500) }
                return
              }
            }
            return
          }
        } else {
          const err = await res.json().catch(() => null)
          // Terminal: the job no longer exists on the device (the agent
          // restarted — jobs are in-memory — or it aged out of the 1h GC).
          // Re-polling the same jobId can never succeed; fail the dialog
          // so the retry button appears instead of an endless spinner.
          if (err?.code === 'JOB_NOT_FOUND' && !stop) {
            const message = t('dlg.remoteProject.jobLost')
            setError(message)
            setJob((j: any) => ({ ...(j ?? {}), status: 'failed', error: message, progress: j?.progress ?? [] }))
            clearRemoteSession()
            return
          }
        }
      } catch (e: any) {
        if (!stop) setError(e?.message || t('dlg.common.networkError'))
      }
      if (!stop) { setElapsed(Math.floor((Date.now() - started) / 1000)); timer = window.setTimeout(tick, 2500) }
    }
    let timer = window.setTimeout(tick, 800)
    return () => { stop = true; window.clearTimeout(timer) }
  }, [jobId, deviceId, clearRemoteSession, t])

  // Auto-apply succeeded → toast + refresh the project list, once.
  const autoOutcome = job?.applied && !job.applied.pending ? (job.applied as AppliedInfo) : null
  const autoPending = !!job?.applied?.pending
  React.useEffect(() => {
    if (!autoOutcome?.ok || !jobId) return
    const key = `${jobId}:auto`
    if (autoNotifiedRef.current === key) return
    autoNotifiedRef.current = key
    setApplied(true)
    clearRemoteSession()
    addToast({
      title: t('dlg.remoteProject.addedToast'),
      description: t('dlg.remoteProject.addedDesc', { count: autoOutcome.applied ?? 0, device: devices.find((d) => d.id === deviceId)?.name ?? '' }),
      variant: 'success',
    })
    onCompleted()
  }, [autoOutcome, jobId, devices, deviceId, onCompleted, clearRemoteSession, t])

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [job?.progress?.length])

  const start = React.useCallback(async () => {
    if (!deviceId || !path.trim()) {
      addToast({ title: t('dlg.remoteProject.fillComplete'), description: t('dlg.remoteProject.fillDesc'), variant: 'destructive' })
      return
    }
    setStarting(true)
    try {
      const usedPorts: number[] = []
      const res = await fetch(`/api/devices/${deviceId}/analyze-remote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path.trim(), name: name.trim() || undefined, usedPorts }),
      })
      if (res.ok) {
        const data = await res.json()
        setJobId(data.jobId)
        autoNotifiedRef.current = null
        pendingSinceRef.current = null
        // Survive reload/close — the auto-apply watcher saves the result
        // server-side regardless; this only restores the progress view.
        try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: data.jobId, deviceId, path: path.trim(), name: name.trim() })) } catch {}
        addToast({ title: t('dlg.remoteProject.startedToast'), description: t('dlg.remoteProject.startedDesc'), variant: 'success' })
      } else {
        const err = await res.json().catch(() => ({} as any))
        // Actionable version: the agent answered but predates the
        // analyze-project endpoint (pre-1.14 TS agents / stale packages) —
        // a bare "Not found" told the user nothing about what to do.
        const message = err?.code === 'AGENT_ANALYZE_UNSUPPORTED'
          ? t('dlg.remoteProject.agentTooOld', { version: err.agentVersion || '?' })
          : err.error || t('dlg.toast.analysisStartFailed')
        setError(message)
        addToast({ title: t('dlg.toast.analysisStartFailed'), description: message, variant: 'destructive' })
      }
    } catch (e: any) {
      setError(e?.message)
    } finally {
      setStarting(false)
    }
  }, [deviceId, path, name, t])

  // Apply result on the remote device: create envs via the agent's own API,
  // then trigger the dashboard sync so the project appears in the grid.
  const apply = React.useCallback(async (autoStart: boolean) => {
    if (!job?.result || !deviceId) return
    setStarting(true)
    try {
      const device = devices.find(d => d.id === deviceId)
      if (!device) throw new Error(t('dlg.remoteProject.deviceMissing'))
      // Create the project on the device (if missing) with analyzed envs.
      const res = await fetch('/api/mesh/apply-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, path: path.trim(), name: name.trim() || job.result.projectName, analysis: job.result, autoStart }),
      })
      if (res.ok) {
        setApplied(true)
        clearRemoteSession()
        addToast({
          title: autoStart ? t('dlg.remoteProject.startedToast2') : t('dlg.remoteProject.addedToast'),
          description: t(autoStart ? 'dlg.remoteProject.startedDesc2' : 'dlg.remoteProject.addedDesc', { count: job.result.environments?.length ?? 0, device: device.name }),
          variant: 'success',
        })
        onCompleted()
        if (autoStart) onClose()
      } else {
        const err = await res.json()
        addToast({ title: t('dlg.remoteProject.applyFailed'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: t('dlg.remoteProject.applyFailed'), description: e?.message || t('dlg.common.networkError'), variant: 'destructive' })
    } finally {
      setStarting(false)
    }
  }, [job, deviceId, devices, path, name, onCompleted, onClose, clearRemoteSession, t])

  if (!open) return null

  const running = jobId && job?.status === 'running'
  const done = job?.status === 'completed'
  const failed = job?.status === 'failed'
  const autoSavedOk = !!(autoOutcome?.ok)
  const manualFallback = done && !autoSavedOk && !autoPending
  const pct = done ? 100 : failed ? 100 : running ? Math.min(90, 10 + (job?.progress?.length ?? 0) * 8) : 0
  const progressItems: ProgressItem[] = job?.progress ?? []

  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose() }} size="2xl">
      <AppDialogHeader icon={MonitorSmartphone}>
        <AppDialogTitle className="flex items-center gap-2">
          {t('dlg.remoteProject.title')}
          {running && <Loader2 className="h-4 w-4 animate-spin text-teal-500" />}
        </AppDialogTitle>
        <AppDialogDescription>
          {t('dlg.remoteProject.desc')}
        </AppDialogDescription>
      </AppDialogHeader>

      {!jobId && (
        <>
          <AppDialogBody>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs">{t('dlg.remoteProject.device')}</Label>
                <Select value={deviceId} onValueChange={setDeviceId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder={t('dlg.remoteProject.devicePlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {devices.map(d => (
                      <SelectItem key={d.id} value={d.id}>
                        <span className="flex items-center gap-2 text-sm">
                          <span className={`h-1.5 w-1.5 rounded-full ${d.status === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                          {d.name} · {d.ip}:{d.port}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t('dlg.remoteProject.path')}</Label>
                <Input value={path} onChange={e => setPath(e.target.value)} placeholder="/home/user/projects/my-app" className="h-9 font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t('dlg.remoteProject.name')}</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="my-app" className="h-9 text-sm" />
              </div>
              {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>{t('dlg.common.cancel')}</Button>
            <Button size="sm" onClick={start} disabled={starting || !path.trim() || !deviceId}>
              {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Zap className="mr-1.5 h-3.5 w-3.5" />}
              {t('dlg.remoteProject.startBtn')}
            </Button>
          </AppDialogFooter>
        </>
      )}

      {jobId && (
        <>
          <AppDialogBody className="space-y-4">
            {/* quiet step header — status dot + meta (v1.31 R7) */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-sky-500' : done ? 'bg-emerald-500' : 'bg-red-500'}`} />
                {running ? t('dlg.remoteProject.status.running') : done ? t('dlg.remoteProject.status.completed') : t('dlg.remoteProject.status.failed')}
              </span>
              <span className="flex items-center gap-1"><Server className="h-3 w-3" />{devices.find(d => d.id === deviceId)?.name}</span>
              <span className="font-mono">{path}</span>
              <span className="ml-auto flex items-center gap-1"><Gauge className="h-3 w-3" />{t('dlg.analyze.elapsed', { count: elapsed })}</span>
            </div>
            <Progress value={pct} className="h-1.5" />
            {/* live progress terminal — keeps its own bounded scroll so the
                scrollRef autoscroll keeps working inside the body */}
            <div ref={scrollRef} className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border bg-muted/30 p-3.5">
              {progressItems.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('dlg.remoteProject.connecting')}
                </div>
              )}
              {progressItems.map((p, i) => (
                <motion.div key={`${p.ts}-${i}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 text-xs leading-5">
                  <span className="mt-0.5 shrink-0">{kindIcon[p.kind] ?? kindIcon.note}</span>
                  <span className={p.kind === 'command' ? 'font-mono text-emerald-700 dark:text-emerald-300'
                    : p.kind === 'error' ? 'text-red-500'
                    : p.kind === 'result' ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                    : 'text-muted-foreground'}>{p.text}</span>
                </motion.div>
              ))}
            </div>

            {(error || job?.error) && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                {error || job?.error}
              </div>
            )}

            {done && job?.result && (
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex items-start gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{job.result.summary || t('dlg.remoteProject.verifiedFallback')}</span>
                </div>
                <div className="space-y-1.5">
                  {(job.result.environments ?? []).map((e: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 font-mono text-xs">
                      <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{e.name}</Badge>
                      <span className="flex-1 truncate">{e.cmd}</span>
                      <span className="text-muted-foreground">:{e.port}</span>
                    </div>
                  ))}
                </div>
                {/* server-side auto-save status */}
                {autoPending && (
                  <div className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('dlg.analyze.autoSaving')}
                  </div>
                )}
                {autoSavedOk && (
                  <div className="flex items-center gap-1.5 pt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                    <Save className="h-3.5 w-3.5 shrink-0" />
                    {t('dlg.remoteProject.autoSavedLine', { count: autoOutcome?.applied ?? 0 })}
                  </div>
                )}
                {autoOutcome && !autoOutcome.ok && (
                  <div className="flex items-center gap-1.5 pt-0.5 text-xs text-amber-600 dark:text-amber-400">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    {t('dlg.analyze.autoSaveFailed')}
                  </div>
                )}
              </div>
            )}
          </AppDialogBody>

          {/* actions — v1.31 footer strip; status text sits left of the buttons */}
          <AppDialogFooter className={done && autoPending && !manualFallback ? 'sm:justify-between' : undefined}>
            {running && <Button variant="outline" size="sm" onClick={onClose}>{t('dlg.remoteProject.background')}</Button>}
            {/* server already applied — offer start + done, no add button needed */}
            {done && autoSavedOk && (
              <>
                <Button size="sm" variant="outline" onClick={onClose}><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />{t('dlg.remoteProject.done')}</Button>
                <Button size="sm" onClick={() => apply(true)} disabled={starting}>
                  {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  {t('dlg.remoteProject.startRemote')}
                </Button>
              </>
            )}
            {/* auto-apply still working — nothing to click yet (bounded wait) */}
            {done && autoPending && !manualFallback && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('dlg.analyze.autoSaving')}
              </span>
            )}
            {/* manual fallback: auto-apply unavailable/failed/expired */}
            {manualFallback && !applied && (
              <>
                <Button variant="outline" size="sm" onClick={() => apply(false)} disabled={starting}>{t('dlg.remoteProject.addOnly')}</Button>
                <Button size="sm" onClick={() => apply(true)} disabled={starting}>
                  {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                  {t('dlg.remoteProject.startRemote')}
                </Button>
              </>
            )}
            {applied && !autoSavedOk && <Button size="sm" variant="outline" onClick={onClose}><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />{t('dlg.remoteProject.done')}</Button>}
            {failed && <Button size="sm" variant="outline" onClick={() => { setJobId(null); setJob(null); clearRemoteSession() }}>{t('dlg.remoteProject.retry')}</Button>}
          </AppDialogFooter>
        </>
      )}
    </AppDialog>
  )
}
