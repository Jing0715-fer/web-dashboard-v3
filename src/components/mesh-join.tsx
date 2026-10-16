'use client'

import * as React from 'react'
import {
  PlugZap, Loader2, CheckCircle2, AlertTriangle, RefreshCw, Play, Wifi,
} from 'lucide-react'
import { AppDialog, AppDialogHeader, AppDialogBody, AppDialogSection, AppDialogFooter } from '@/components/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { addToast } from '@/hooks/use-toast'
import { useT } from '@/lib/i18n'

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
  const t = useT()
  const [target, setTarget] = React.useState('')
  const [code, setCode] = React.useState('')
  const [agent, setAgent] = React.useState<LocalAgentInfo | null>(null)
  const [ip, setIp] = React.useState('')
  const [ips, setIps] = React.useState<string[]>([])
  const [agentLoading, setAgentLoading] = React.useState(false)
  const [manualMode, setManualMode] = React.useState(false)
  const [manualPort, setManualPort] = React.useState('')
  const [manualKey, setManualKey] = React.useState('')
  const [manualIp, setManualIp] = React.useState('')
  const [joining, setJoining] = React.useState(false)
  const [startingAgent, setStartingAgent] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [checkResult, setCheckResult] = React.useState<{ reachable?: boolean; dashboard?: boolean; reason?: string; host?: string } | null>(null)

  const loadAgent = React.useCallback(async () => {
    setAgentLoading(true)
    try {
      const res = await fetch('/api/mesh/local-agent')
      if (res.ok) {
        const data = await res.json()
        setAgent(data.agent)
        setIp(data.ip || '')
        setIps(Array.isArray(data.ips) ? data.ips : [])
        setManualIp(data.ip || '')
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

  // One-click fix for the most common mesh failure: the agent binary is
  // shipped with the project but nobody started it (user report:
  // "Local Agent: Not running"). POST /api/mesh/ensure-agent spawns it on
  // this machine and returns its port.
  const handleStartAgent = React.useCallback(async () => {
    if (startingAgent) return
    setStartingAgent(true)
    try {
      const res = await fetch('/api/mesh/ensure-agent', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.running) {
        addToast({
          // ensure-agent restarts an agent that is still executing pre-upgrade
          // code (git pull doesn't restart the spawned agent process) — a
          // different toast makes the auto-upgrade visible instead of silent.
          title: data.restarted
            ? t('dlg.meshJoin.agentUpgradedToast', { port: data.port ?? data.agent?.port ?? '' })
            : t('dlg.meshJoin.startAgentToast', { port: data.port ?? data.agent?.port ?? '' }),
          variant: 'success',
        })
        await loadAgent()
      } else {
        addToast({ title: t('dlg.meshJoin.startAgentFailed'), description: data.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: t('dlg.meshJoin.startAgentFailed'), description: e?.message || '', variant: 'destructive' })
    } finally {
      setStartingAgent(false)
    }
  }, [t, loadAgent, startingAgent])

  // Pre-flight "test connection": probes the target through OUR backend
  // (/api/mesh/check → target's /api/mesh/ping) and classifies failures —
  // firewall timeouts, refused ports, non-dashboard hosts — so the user
  // knows WHAT is wrong before typing a pairing code (user report: reverse
  // join from macOS failed with a bare timeout message; the cause was
  // almost certainly the Windows firewall blocking inbound connections).
  const checkTarget = React.useCallback(async () => {
    const t0 = target.trim()
    if (!t0 || !/^https?:\/\/.+/i.test(t0)) return
    setChecking(true)
    setCheckResult(null)
    try {
      const res = await fetch(`/api/mesh/check?target=${encodeURIComponent(t0)}`)
      const data = await res.json().catch(() => ({}))
      setCheckResult(res.ok ? data : { reachable: false, reason: 'error' })
    } catch {
      setCheckResult({ reachable: false, reason: 'error' })
    } finally {
      setChecking(false)
    }
  }, [target])

  // Map the server's classified network failure to a localized hint.
  const reasonText = React.useCallback((reason?: string) => {
    switch (reason) {
      case 'timeout': return t('dlg.meshJoin.checkTimeout')
      case 'refused': return t('dlg.meshJoin.checkRefused')
      case 'dns': return t('dlg.meshJoin.checkDns')
      case 'unreachable': return t('dlg.meshJoin.checkUnreachable')
      default: return t('dlg.meshJoin.checkError')
    }
  }, [t])

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
          ...(manualMode ? { agentPort: Number(manualPort) || undefined, agentApiKey: manualKey.trim() || undefined, ip: manualIp.trim() || undefined } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        // Already-paired shortcut: the reverse join the user attempted is
        // unnecessary (pairing is mutual from ONE join) — typically because
        // the target's firewall blocks inbound connections, but the pair
        // itself plus heartbeat pushes are already working. Say so instead
        // of a scary failure (user report: "win joins mac OK, mac joining
        // win times out — isn't pairing bidirectional?").
        if (data?.alreadyPaired) {
          addToast({
            title: t('dlg.meshJoin.alreadyPairedToast'),
            description: t('dlg.meshJoin.alreadyPairedDesc', {
              name: data.deviceName ?? '',
              target: data.target ?? '',
            }),
            variant: 'success',
          })
          onJoined?.()
          setCode('')
          setTarget('')
          setCheckResult(null)
          onClose()
          return
        }
        const baseDesc = data?.mutual
          ? t('dlg.meshJoin.joinedMutualDesc', {
              target: data.target,
              peer: data.peer?.name ?? '',
              peerIp: data.peer?.ip ?? '',
              peerPort: data.peer?.port ?? '',
            })
          : t('dlg.meshJoin.joinedDesc', { device: data.deviceName, ip: data.ip, port: data.port, target: data.target })
        // Pairing now auto-registers the peer's projects (they piggybacked on
        // the register response) — surface the count so the user knows the
        // remote projects are already visible, no follow-up step needed.
        const adopted = typeof data?.adoptedProjects === 'number' ? data.adoptedProjects : 0
        const adoptNote = adopted > 0
          ? ` · ${t('dlg.meshJoin.projectsAdopted', { count: adopted })}`
          : ''
        addToast({
          title: t('dlg.meshJoin.joinedToast'),
          description: `${baseDesc}${adoptNote}${data?.agentStarted ? ` · ${t('dlg.meshJoin.agentAutoStart')}` : ''}`,
          variant: 'success',
        })
        onJoined?.()
        setCode('')
        setTarget('')
        setCheckResult(null)
        onClose()
      } else {
        const networkReasons = ['timeout', 'refused', 'dns', 'unreachable', 'error']
        const desc = data?.reason && networkReasons.includes(data.reason) && !data?.error?.includes('重新生成')
          ? reasonText(data.reason)
          : (data.error || `HTTP ${res.status}`)
        addToast({ title: t('dlg.meshJoin.joinFailed'), description: desc, variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: t('dlg.meshJoin.joinFailed'), description: e?.message || t('dlg.common.networkError'), variant: 'destructive' })
    } finally {
      setJoining(false)
    }
  }, [t, target, code, manualMode, manualPort, manualKey, manualIp, joining, onClose, onJoined, reasonText])

  if (!open) return null

  const agentReady = !!agent && agent.running
  // The join API auto-starts / auto-upgrades the local agent server-side,
  // so a stopped agent no longer blocks joining — only manual mode needs
  // its explicit fields.
  const canJoin = !!target.trim() && !!code.trim() && !joining && (!manualMode || (!!manualPort && !!manualKey))

  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose() }} size="md">
      <AppDialogHeader icon={PlugZap} title={t('dlg.meshJoin.title')} description={t('dlg.meshJoin.desc')} />

      {/* v1.31 "Clear" — quiet AppDialogSection headers; the fields and the
          live agent state are the foreground. No colored buttons, no loud
          badges: status is a dot+text chip (R7), primary actions use bg-primary (R2). */}
      <AppDialogBody className="space-y-5">
        {/* Target dashboard URL — the "test connection" link rides the section action slot */}
        <AppDialogSection
          title={t('dlg.meshJoin.target')}
          action={
            <button
              type="button"
              onClick={checkTarget}
              disabled={checking || !/^https?:\/\/.+/i.test(target.trim())}
              className="inline-flex h-7 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {checking
                ? <><Loader2 className="h-3 w-3 animate-spin" />{t('dlg.meshJoin.checking')}</>
                : <><Wifi className="h-3 w-3" />{t('dlg.meshJoin.checkTarget')}</>}
            </button>
          }
        >
          <div className="space-y-2">
            <Input
              value={target}
              onChange={(e) => { setTarget(e.target.value); setCheckResult(null) }}
              onBlur={() => { if (/^https?:\/\/.+/i.test(target.trim())) checkTarget() }}
              placeholder="http://192.168.1.100:3000"
              className="h-9 text-sm font-mono"
              autoFocus
            />
            {(checking || checkResult) && (
              <div className="text-[11px] leading-4">
                {checking ? (
                  <span className="flex items-center text-muted-foreground"><Loader2 className="mr-1 h-3 w-3 animate-spin" />{t('dlg.meshJoin.checking')}</span>
                ) : checkResult?.reachable && checkResult?.dashboard ? (
                  <span className="flex items-center text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="mr-1 h-3 w-3 shrink-0" />{t('dlg.meshJoin.checkOk', { host: checkResult?.host ?? '' })}</span>
                ) : checkResult?.reachable ? (
                  <span className="flex items-center text-amber-600 dark:text-amber-400"><AlertTriangle className="mr-1 h-3 w-3 shrink-0" />{t('dlg.meshJoin.checkNotDashboard')}</span>
                ) : (
                  <span className="flex items-start text-red-600 dark:text-red-400"><AlertTriangle className="mr-1 mt-0.5 h-3 w-3 shrink-0" />{reasonText(checkResult?.reason)}</span>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{t('dlg.meshJoin.targetHint')}</p>
          </div>
        </AppDialogSection>

        {/* Pairing code */}
        <AppDialogSection title={t('dlg.meshJoin.code')}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="A30C00F1"
            maxLength={8}
            className="h-9 text-base font-mono font-bold tracking-[0.25em] uppercase"
          />
        </AppDialogSection>

        {/* Local agent status — the chip rides the section action slot */}
        <AppDialogSection
          title={t('dlg.meshJoin.localAgent')}
          action={
            agentLoading ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t('dlg.meshJoin.detecting')}</span>
            ) : agentReady ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{t('dlg.meshJoin.running', { port: agent?.port ?? '' })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />{agent ? t('dlg.meshJoin.notRunning') : t('dlg.meshJoin.notDetected')}
              </span>
            )
          }
        >
          <div className="space-y-3 rounded-xl bg-muted/30 p-4">
            {agent && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  {t('dlg.meshJoin.agentInfo', { name: agent.name, port: agent.port, ip: ip || t('dlg.meshJoin.unknown') })}
                </p>
                {ips.length > 1 && (
                  <p className="text-[11px] text-muted-foreground/80">
                    {t('dlg.meshJoin.otherIps', { ips: ips.slice(1).join(', ') })}
                  </p>
                )}
              </div>
            )}
            {!agentReady && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  {t('dlg.meshJoin.agentAutoStart')}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="default"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={handleStartAgent}
                    disabled={startingAgent || agentLoading}
                  >
                    {startingAgent
                      ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />{t('dlg.meshJoin.startingAgent')}</>
                      : <><Play className="mr-1 h-3 w-3" />{t('dlg.meshJoin.startAgent')}</>}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={loadAgent} disabled={agentLoading}>
                    <RefreshCw className={`mr-1 h-3 w-3 ${agentLoading ? 'animate-spin' : ''}`} />{t('dlg.meshJoin.retry')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => setManualMode((v) => !v)}>
                    {manualMode ? t('dlg.meshJoin.cancelManual') : t('dlg.meshJoin.manual')}
                  </Button>
                </div>
              </div>
            )}
            {manualMode && (
              <div className="space-y-3 border-t border-border/60 pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">{t('dlg.meshJoin.agentPort')}</Label>
                    <Input value={manualPort} onChange={(e) => setManualPort(e.target.value.replace(/\D/g, ''))} placeholder="3100" className="h-8 text-xs font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">{t('dlg.meshJoin.agentKey')}</Label>
                    <Input value={manualKey} onChange={(e) => setManualKey(e.target.value)} placeholder={t('dlg.meshJoin.keyPlaceholder')} className="h-8 text-xs font-mono" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px]">{t('dlg.meshJoin.advertisedIp')}</Label>
                  <Input
                    value={manualIp}
                    onChange={(e) => setManualIp(e.target.value.trim())}
                    placeholder={ip || '192.168.1.20'}
                    className="h-8 text-xs font-mono"
                    inputMode="numeric"
                  />
                  {ips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {ips.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setManualIp(c)}
                          className={`inline-flex h-7 items-center rounded-md border px-2 font-mono text-[11px] transition-colors cursor-pointer ${
                            manualIp === c
                              ? 'border-brand/40 bg-brand-soft text-brand-strong'
                              : 'border-border/60 bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                          }`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">{t('dlg.meshJoin.advertisedIpHint')}</p>
                </div>
              </div>
            )}
          </div>
        </AppDialogSection>
      </AppDialogBody>

      <AppDialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={joining}>{t('dlg.common.cancel')}</Button>
        <Button size="sm" onClick={handleJoin} disabled={!canJoin}>
          {joining ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{t('dlg.meshJoin.joining')}</> : <><PlugZap className="mr-1.5 h-3.5 w-3.5" />{t('dlg.meshJoin.join')}</>}
        </Button>
      </AppDialogFooter>
    </AppDialog>
  )
}
