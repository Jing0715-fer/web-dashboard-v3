'use client'

import * as React from 'react'
import {
  PlugZap, Loader2, Globe, KeyRound, Server, CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addToast } from '@/hooks/use-toast'

interface LocalAgentInfo {
  port: number
  apiKey: string
  name: string
  running: boolean
  dir: string
}

/**
 * JoinMeshDialog — join ANOTHER dashboard's mesh purely from the web UI.
 *
 * The other dashboard opens 设备 → 配对 to show a 6-char code; on THIS
 * device you just enter that dashboard's address + the code. No CLI, no
 * manual IP/port/key entry — the local agent is auto-discovered.
 */
export function JoinMeshDialog({
  open,
  onClose,
  onJoined,
}: {
  open: boolean
  onClose: () => void
  onJoined?: () => void
}) {
  const [target, setTarget] = React.useState('')
  const [code, setCode] = React.useState('')
  const [agent, setAgent] = React.useState<LocalAgentInfo | null>(null)
  const [ip, setIp] = React.useState('')
  const [agentLoading, setAgentLoading] = React.useState(false)
  const [manualMode, setManualMode] = React.useState(false)
  const [manualPort, setManualPort] = React.useState('')
  const [manualKey, setManualKey] = React.useState('')
  const [joining, setJoining] = React.useState(false)

  const loadAgent = React.useCallback(async () => {
    setAgentLoading(true)
    try {
      const res = await fetch('/api/mesh/local-agent')
      if (res.ok) {
        const data = await res.json()
        setAgent(data.agent)
        setIp(data.ip || '')
      }
    } catch { /* ignore */ } finally {
      setAgentLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) {
      loadAgent()
    }
  }, [open, loadAgent])

  const handleJoin = React.useCallback(async () => {
    if (joining) return
    setJoining(true)
    try {
      const res = await fetch('/api/mesh/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: target.trim(),
          code: code.trim(),
          ...(manualMode ? { agentPort: Number(manualPort) || undefined, agentApiKey: manualKey.trim() || undefined } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        addToast({
          title: '已加入网络',
          description: `本机（${data.deviceName} · ${data.ip}:${data.port}）已注册到 ${data.target}`,
          variant: 'success',
        })
        onJoined?.()
        setCode('')
        setTarget('')
        onClose()
      } else {
        addToast({ title: '加入失败', description: data.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: '加入失败', description: e?.message || '网络错误', variant: 'destructive' })
    } finally {
      setJoining(false)
    }
  }, [target, code, manualMode, manualPort, manualKey, joining, onClose, onJoined])

  if (!open) return null

  const agentReady = !!agent && agent.running
  const canJoin = !!target.trim() && !!code.trim() && !joining && (agentReady || (manualMode && !!manualPort && !!manualKey))

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-cyan-500 text-white shrink-0">
              <PlugZap className="h-4 w-4" />
            </span>
            加入其他仪表盘
          </DialogTitle>
          <DialogDescription className="text-xs">
            在对方设备的 Web UI 中打开 设备 → 配对 获取验证码，在下方输入即可将本机加入对方网络 — 无需命令行
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Target dashboard URL */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />对方仪表盘地址
            </Label>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="http://192.168.1.100:3000"
              className="h-9 text-sm font-mono"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">对方设备访问其 Web UI 使用的地址（局域网 IP 或公网地址均可）</p>
          </div>

          {/* Pairing code */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />配对验证码
            </Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="A30C00F1"
              maxLength={8}
              className="h-9 text-base font-mono font-bold tracking-[0.25em] uppercase"
            />
          </div>

          {/* Local agent status */}
          <div className="rounded-xl border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />本机 Agent
              </span>
              {agentLoading ? (
                <Badge variant="secondary" className="text-[10px] h-5"><Loader2 className="h-3 w-3 animate-spin mr-1" />检测中</Badge>
              ) : agentReady ? (
                <Badge className="text-[10px] h-5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3 mr-1" />运行中 · {agent?.port}
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px] h-5">
                  <AlertTriangle className="h-3 w-3 mr-1" />{agent ? '未运行' : '未检测到'}
                </Badge>
              )}
            </div>
            {agent && (
              <p className="text-[11px] text-muted-foreground">
                {agent.name} · 端口 {agent.port} · 上报地址 {ip || '未知'}:{agent.port}
              </p>
            )}
            {!agentReady && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Agent 未运行时对方将无法控制本机项目
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2" onClick={loadAgent} disabled={agentLoading}>
                    <RefreshCw className={`h-3 w-3 mr-1 ${agentLoading ? 'animate-spin' : ''}`} />重试
                  </Button>
                  <Button variant="outline" size="sm" className="h-6 text-[11px] px-2" onClick={() => setManualMode((v) => !v)}>
                    {manualMode ? '取消手动' : '手动填写'}
                  </Button>
                </div>
              </div>
            )}
            {manualMode && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="space-y-1">
                  <Label className="text-[11px]">Agent 端口</Label>
                  <Input value={manualPort} onChange={(e) => setManualPort(e.target.value.replace(/\D/g, ''))} placeholder="3100" className="h-8 text-xs font-mono" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Agent API Key</Label>
                  <Input value={manualKey} onChange={(e) => setManualKey(e.target.value)} placeholder="key…" className="h-8 text-xs font-mono" />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose} disabled={joining}>取消</Button>
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700 text-white" onClick={handleJoin} disabled={!canJoin}>
              {joining ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />正在加入…</> : <><PlugZap className="h-3.5 w-3.5 mr-1.5" />加入网络</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
