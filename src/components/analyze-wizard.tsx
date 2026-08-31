'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, Terminal, FileText, Search, CheckCircle2, XCircle, Loader2,
  Play, Zap, RefreshCw, ChevronDown, Sparkles, Gauge, CircleDot,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { addToast } from '@/hooks/use-toast'

export interface HarnessSessionState {
  sessionId: string
  projectId: string
  name: string
  path: string
}

interface ProgressItem {
  ts: number
  attempt: number
  kind: 'start' | 'command' | 'file' | 'message' | 'result' | 'error' | 'note'
  text: string
}

interface SessionView {
  id: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  attempt: number
  maxAttempts: number
  progress: ProgressItem[]
  result: any | null
  error: string | null
}

const kindIcon: Record<ProgressItem['kind'], React.ReactNode> = {
  start: <CircleDot className="h-3.5 w-3.5 text-sky-500" />,
  command: <Terminal className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
  file: <FileText className="h-3.5 w-3.5 text-violet-500" />,
  message: <Sparkles className="h-3.5 w-3.5 text-amber-500" />,
  result: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  note: <Search className="h-3.5 w-3.5 text-muted-foreground" />,
}

/**
 * AnalyzeWizard — live progress of the deepseek-harness agent analyzing a
 * project: installs dependencies, generates the startup command and
 * auto-debugs it until the service actually boots, then lets the user apply
 * the config and one-click start the project.
 */
export function AnalyzeWizard({
  session,
  onClose,
  onApplied,
  onStartEnv,
}: {
  session: HarnessSessionState | null
  onClose: () => void
  onApplied: () => void
  onStartEnv: (projectId: string, envId: string) => void
}) {
  const [view, setView] = React.useState<SessionView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [applying, setApplying] = React.useState(false)
  const [applied, setApplied] = React.useState(false)
  const [elapsed, setElapsed] = React.useState(0)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const sessionId = session?.sessionId

  // Poll the harness session for live progress.
  React.useEffect(() => {
    if (!sessionId) { setView(null); setError(null); setApplied(false); setElapsed(0); return }
    let stop = false
    const started = Date.now()
    const tick = async () => {
      try {
        const res = await fetch(`/api/harness/sessions/${sessionId}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (!stop) { setView(data); setError(null) }
          if (data.status !== 'running') return
        } else if (!stop) {
          setError('无法连接 harness-agent 服务')
        }
      } catch (e: any) {
        if (!stop) setError(e?.message || '网络错误')
      }
      if (!stop) { setElapsed(Math.floor((Date.now() - started) / 1000)); timer = window.setTimeout(tick, 2500) }
    }
    let timer = window.setTimeout(tick, 600)
    return () => { stop = true; window.clearTimeout(timer) }
  }, [sessionId])

  // Auto-scroll the progress feed.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [view?.progress?.length])

  const apply = React.useCallback(async (autoStart: boolean) => {
    if (!session || !view?.result) return
    setApplying(true)
    try {
      const res = await fetch(`/api/projects/${session.projectId}/apply-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis: view.result, autoStart }),
      })
      if (res.ok) {
        const data = await res.json()
        setApplied(true)
        addToast({
          title: '配置已应用',
          description: `${data.applied} 个环境已${autoStart ? '创建并启动' : '创建'}。`,
          variant: 'success',
        })
        onApplied()
        if (autoStart && data.project?.environments?.[0]) {
          onStartEnv(session.projectId, data.project.environments[0].id)
        }
        if (autoStart) onClose()
      } else {
        const err = await res.json()
        addToast({ title: '应用失败', description: err.error || '服务器错误', variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: '应用失败', description: e?.message || '网络错误', variant: 'destructive' })
    } finally {
      setApplying(false)
    }
  }, [session, view, onApplied, onStartEnv, onClose])

  const cancel = React.useCallback(async () => {
    if (!sessionId) return
    try { await fetch(`/api/harness/sessions/${sessionId}/cancel`, { method: 'POST' }) } catch { /* ignore */ }
    onClose()
  }, [sessionId, onClose])

  if (!session) return null

  const status = view?.status ?? 'running'
  const progressItems = view?.progress ?? []
  const attempt = view?.attempt ?? 1
  const maxAttempts = view?.maxAttempts ?? 3
  const done = status === 'completed'
  const failed = status === 'failed' || status === 'cancelled'
  const pct = done ? 100 : failed ? 100 : Math.min(92, 8 + progressItems.length * 2.4)
  const envs = view?.result?.environments ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o && status === 'running') { /* require explicit cancel */ } }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-500 text-white shrink-0">
              <Bot className="h-4 w-4" />
            </span>
            Agent 分析 · {session.name}
            {status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-sky-500" />}
            {done && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            {failed && <XCircle className="h-4 w-4 text-red-500" />}
          </DialogTitle>
          <DialogDescription className="text-xs font-mono truncate">
            {session.path}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={status === 'running' ? 'secondary' : done ? 'default' : 'destructive'} className="text-[11px] h-5">
            {status === 'running' ? '分析中' : done ? '已完成' : status === 'cancelled' ? '已取消' : '失败'}
          </Badge>
          <span>尝试 {attempt}/{maxAttempts}</span>
          <span className="flex items-center gap-1"><Gauge className="h-3 w-3" />{elapsed}s</span>
          <span className="ml-auto flex items-center gap-1"><Zap className="h-3 w-3 text-amber-500" />deepseek-harness</span>
        </div>

        <Progress value={pct} className="h-1.5" />

        {/* live progress feed */}
        <div ref={scrollRef} className="flex-1 min-h-0 max-h-72 overflow-y-auto rounded-lg border bg-muted/30 p-3 space-y-1.5">
          {progressItems.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在启动 agent（加载 deepseek-harness 运行时）…
            </div>
          )}
          <AnimatePresence initial={false}>
            {progressItems.map((p, i) => (
              <motion.div
                key={`${p.ts}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2 text-xs leading-5"
              >
                <span className="mt-0.5 shrink-0">{kindIcon[p.kind]}</span>
                <span className={
                  p.kind === 'command' ? 'font-mono text-emerald-700 dark:text-emerald-300'
                  : p.kind === 'error' ? 'text-red-500'
                  : p.kind === 'result' ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                  : 'text-muted-foreground'
                }>
                  {p.text}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* error */}
        {(error || view?.error) && (
          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-600 dark:text-red-400 max-h-24 overflow-y-auto">
            {error || view?.error}
          </div>
        )}

        {/* result summary */}
        {done && view?.result && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
            <div className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{view.result.summary || '分析完成'}</span>
            </div>
            <div className="space-y-1">
              {envs.map((e: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono bg-background/60 rounded-md px-2 py-1.5">
                  <Badge variant="outline" className="h-5 text-[10px] px-1.5">{e.name}</Badge>
                  <span className="truncate flex-1">{e.cmd}</span>
                  <span className="text-muted-foreground">:{e.port}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 justify-end pt-1">
          {status === 'running' && (
            <>
              <span className="text-[11px] text-muted-foreground mr-auto">agent 会自动安装依赖、启动并验证服务，失败时自动调试重试</span>
              <Button variant="outline" size="sm" onClick={cancel}>取消分析</Button>
            </>
          )}
          {done && !applied && (
            <>
              <Button variant="outline" size="sm" onClick={() => apply(false)} disabled={applying}>
                {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                仅保存配置
              </Button>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => apply(true)} disabled={applying}>
                {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
                一键启动
              </Button>
            </>
          )}
          {applied && (
            <Button size="sm" variant="outline" onClick={onClose}><CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />完成</Button>
          )}
          {failed && (
            <Button size="sm" variant="outline" onClick={onClose}>关闭</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
