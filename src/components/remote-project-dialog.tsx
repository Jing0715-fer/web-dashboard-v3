'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  MonitorSmartphone, Loader2, CheckCircle2, XCircle, Terminal, FileText,
  Search, Play, CircleDot, Gauge, Server, Zap,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addToast } from '@/hooks/use-toast'

interface DeviceInfo { id: string; name: string; ip: string; port: number; status: string }

interface ProgressItem { ts: number; kind: string; text: string }

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

  React.useEffect(() => {
    if (!open) {
      setJobId(null); setJob(null); setError(null); setApplied(false); setElapsed(0); setPath(''); setName(''); setStarting(false)
    } else if (devices.length > 0 && !deviceId) {
      setDeviceId(devices[0].id)
    }
  }, [open, devices, deviceId])

  // Poll the remote analysis job.
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
          if (data.status !== 'running') return
        }
      } catch (e: any) {
        if (!stop) setError(e?.message || '网络错误')
      }
      if (!stop) { setElapsed(Math.floor((Date.now() - started) / 1000)); timer = window.setTimeout(tick, 2500) }
    }
    let timer = window.setTimeout(tick, 800)
    return () => { stop = true; window.clearTimeout(timer) }
  }, [jobId, deviceId])

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [job?.progress?.length])

  const start = React.useCallback(async () => {
    if (!deviceId || !path.trim()) {
      addToast({ title: '请填写完整', description: '选择设备并输入项目路径', variant: 'destructive' })
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
        addToast({ title: '远程分析已启动', description: '远程设备正在自动调试启动配置…', variant: 'success' })
      } else {
        const err = await res.json()
        setError(err.error || '启动失败')
        addToast({ title: '启动失败', description: err.error || 'Agent 不可达', variant: 'destructive' })
      }
    } catch (e: any) {
      setError(e?.message)
    } finally {
      setStarting(false)
    }
  }, [deviceId, path, name])

  // Apply result on the remote device: create envs via the agent's own API,
  // then trigger the dashboard sync so the project appears in the grid.
  const apply = React.useCallback(async (autoStart: boolean) => {
    if (!job?.result || !deviceId) return
    setStarting(true)
    try {
      const device = devices.find(d => d.id === deviceId)
      if (!device) throw new Error('设备不存在')
      // Create the project on the device (if missing) with analyzed envs.
      const res = await fetch('/api/mesh/apply-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, path: path.trim(), name: name.trim() || job.result.projectName, analysis: job.result, autoStart }),
      })
      if (res.ok) {
        setApplied(true)
        addToast({
          title: autoStart ? '远程项目已启动' : '远程项目已添加',
          description: `${job.result.environments?.length ?? 0} 个环境已在 ${device.name} 上配置${autoStart ? '并启动' : ''}。`,
          variant: 'success',
        })
        onCompleted()
        if (autoStart) onClose()
      } else {
        const err = await res.json()
        addToast({ title: '应用失败', description: err.error || '服务器错误', variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: '应用失败', description: e?.message || '网络错误', variant: 'destructive' })
    } finally {
      setStarting(false)
    }
  }, [job, deviceId, devices, path, name, onCompleted, onClose])

  if (!open) return null

  const running = jobId && job?.status === 'running'
  const done = job?.status === 'completed'
  const failed = job?.status === 'failed'
  const pct = done ? 100 : failed ? 100 : running ? Math.min(90, 10 + (job?.progress?.length ?? 0) * 8) : 0
  const progressItems: ProgressItem[] = job?.progress ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-500 text-white shrink-0">
              <MonitorSmartphone className="h-4 w-4" />
            </span>
            添加远程项目
            {running && <Loader2 className="h-4 w-4 animate-spin text-teal-500" />}
          </DialogTitle>
          <DialogDescription className="text-xs">
            输入远程设备上的项目路径，agent 将自动分析、安装依赖并调试启动直到成功
          </DialogDescription>
        </DialogHeader>

        {!jobId && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">目标设备</Label>
              <Select value={deviceId} onValueChange={setDeviceId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="选择设备" /></SelectTrigger>
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
            <div className="space-y-1.5">
              <Label className="text-xs">项目路径（远程设备上的绝对路径）</Label>
              <Input value={path} onChange={e => setPath(e.target.value)} placeholder="/home/user/projects/my-app" className="h-9 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">名称（可选，留空自动识别）</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="my-app" className="h-9 text-sm" />
            </div>
            {error && <div className="text-xs text-red-500">{error}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
              <Button size="sm" onClick={start} disabled={starting || !path.trim() || !deviceId}>
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}
                开始自动调试分析
              </Button>
            </div>
          </div>
        )}

        {jobId && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Badge variant={running ? 'secondary' : done ? 'default' : 'destructive'} className="text-[11px] h-5">
                {running ? '远程分析中' : done ? '已验证' : '失败'}
              </Badge>
              <span className="flex items-center gap-1"><Server className="h-3 w-3" />{devices.find(d => d.id === deviceId)?.name}</span>
              <span className="font-mono">{path}</span>
              <span className="ml-auto flex items-center gap-1"><Gauge className="h-3 w-3" />{elapsed}s</span>
            </div>
            <Progress value={pct} className="h-1.5" />
            <div ref={scrollRef} className="flex-1 min-h-0 max-h-64 overflow-y-auto rounded-lg border bg-muted/30 p-3 space-y-1.5">
              {progressItems.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在连接远程设备…
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
              <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-600 dark:text-red-400">
                {error || job?.error}
              </div>
            )}

            {done && job?.result && (
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
                <div className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{job.result.summary || '远程验证成功'}</span>
                </div>
                {(job.result.environments ?? []).map((e: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs font-mono bg-background/60 rounded-md px-2 py-1.5">
                    <Badge variant="outline" className="h-5 text-[10px] px-1.5">{e.name}</Badge>
                    <span className="truncate flex-1">{e.cmd}</span>
                    <span className="text-muted-foreground">:{e.port}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 justify-end">
              {running && <Button variant="outline" size="sm" onClick={onClose}>后台运行</Button>}
              {done && !applied && (
                <>
                  <Button variant="outline" size="sm" onClick={() => apply(false)} disabled={starting}>仅添加项目</Button>
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => apply(true)} disabled={starting}>
                    {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
                    一键启动（远程）
                  </Button>
                </>
              )}
              {applied && <Button size="sm" variant="outline" onClick={onClose}><CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />完成</Button>}
              {failed && <Button size="sm" variant="outline" onClick={() => { setJobId(null); setJob(null) }}>重试</Button>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
