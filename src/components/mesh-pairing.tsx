'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  PlugZap, Loader2, Copy, Check, RefreshCw, Terminal, QrCode, ChevronDown, MonitorSmartphone,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { addToast } from '@/hooks/use-toast'

interface PairInfo {
  code: string
  expiresAt: number
  dashboardUrl: string
  command: string
  curlCommand: string
}

/**
 * MeshPairingDialog — simplified device interconnection.
 *
 * Primary flow (no CLI): the OTHER device opens its own web UI →
 * 设备 → 加入网络, enters this dashboard's address + the code shown here.
 * The CLI one-liner stays available (collapsible) for agent-only devices.
 */
export function MeshPairingDialog({
  open,
  onClose,
  lanIp,
  onPaired,
}: {
  open: boolean
  onClose: () => void
  lanIp: string
  onPaired: () => void
}) {
  const [pair, setPair] = React.useState<PairInfo | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState<string | null>(null)
  const [countdown, setCountdown] = React.useState(0)
  const [showCli, setShowCli] = React.useState(false)

  const generate = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/mesh/pair', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setPair(data)
      } else {
        const err = await res.json()
        addToast({ title: '生成配对码失败', description: err.error, variant: 'destructive' })
      }
    } catch (e: any) {
      addToast({ title: '生成配对码失败', description: e?.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open && !pair) generate()
  }, [open, pair, generate])

  // Countdown until code expiry.
  React.useEffect(() => {
    if (!pair) return
    const t = setInterval(() => {
      const left = Math.max(0, Math.floor((pair.expiresAt - Date.now()) / 1000))
      setCountdown(left)
      if (left === 0) clearInterval(t)
    }, 1000)
    return () => clearInterval(t)
  }, [pair])

  const copy = React.useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
      addToast({ title: '已复制到剪贴板', variant: 'success' })
    })
  }, [])

  if (!open) return null

  const lanCommand = pair ? `node agent.js --pair http://${lanIp}:3000 --code ${pair.code}` : ''
  const lanDashboardUrl = `http://${lanIp}:3000`
  const expired = countdown <= 0

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white shrink-0">
              <PlugZap className="h-4 w-4" />
            </span>
            设备配对
            <Badge variant={expired ? 'destructive' : 'secondary'} className="text-[11px] h-5 ml-1">
              {expired ? '已过期' : `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs">
            在对方设备的 Web UI 中输入验证码即可完成配对 — 无需在对方设备执行任何命令
          </DialogDescription>
        </DialogHeader>

        {loading && !pair && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> 正在生成配对码…
          </div>
        )}

        {pair && (
          <div className="space-y-4">
            {/* pairing code */}
            <div className="flex items-center justify-center gap-3 py-3 rounded-xl border bg-muted/40">
              <QrCode className="h-8 w-8 text-muted-foreground/50" />
              <div className="text-center">
                <div className="text-2xl font-mono font-bold tracking-[0.3em]">{pair.code}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">5 分钟内有效 · 多设备可共用</div>
              </div>
            </div>

            {/* Primary: web UI steps on the other device */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MonitorSmartphone className="h-3.5 w-3.5" />在对方设备的 Web UI 中操作（推荐）
              </div>
              <ol className="space-y-2">
                {[
                  { step: 1, text: '对方设备安装本系统后，打开其 Web UI', },
                  { step: 2, text: '进入 设备管理 → 加入网络', },
                  { step: 3, text: '填入本机地址与本页验证码，点击「加入网络」', },
                ].map(({ step, text }) => (
                  <li key={step} className="flex items-start gap-2 text-xs text-foreground/90">
                    <span className="flex h-4.5 w-4.5 min-w-[18px] items-center justify-center rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 text-[10px] font-bold mt-0.5">{step}</span>
                    <span className="leading-5">{text}</span>
                  </li>
                ))}
              </ol>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground">本机地址（填入对方「仪表盘地址」栏）</div>
                  <code className="text-xs font-mono font-semibold">{lanDashboardUrl}</code>
                </div>
                <button
                  type="button"
                  onClick={() => copy(lanDashboardUrl, 'url')}
                  className="rounded-md p-1.5 hover:bg-muted transition-colors shrink-0"
                  aria-label="复制地址"
                >
                  {copied === 'url' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
              </div>
            </div>

            {/* Secondary: CLI one-liner for agent-only devices */}
            <div className="rounded-lg border border-dashed">
              <button
                type="button"
                onClick={() => setShowCli((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <Terminal className="h-3.5 w-3.5" />Agent-only 设备？使用命令行配对
                </span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showCli ? 'rotate-180' : ''}`} />
              </button>
              {showCli && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="px-3 pb-3 space-y-2">
                    <div className="relative rounded-lg border bg-muted/60 p-3 pr-10">
                      <code className="text-xs font-mono break-all leading-5">{lanCommand}</code>
                      <button
                        type="button"
                        onClick={() => copy(lanCommand, 'cmd')}
                        className="absolute top-2.5 right-2.5 rounded-md p-1.5 hover:bg-muted transition-colors"
                        aria-label="复制命令"
                      >
                        {copied === 'cmd' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-4">
                      在对方设备的 Agent 目录下执行。命令中的地址也可替换为仪表盘的公网地址（如通过内网穿透访问）。
                    </p>
                  </div>
                </motion.div>
              )}
            </div>

            <div className="flex items-center gap-2 justify-end pt-1">
              <Button variant="outline" size="sm" onClick={generate} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                重新生成
              </Button>
              <Button size="sm" onClick={onPaired}>
                <PlugZap className="h-3.5 w-3.5 mr-1.5" />
                我已完成配对
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
