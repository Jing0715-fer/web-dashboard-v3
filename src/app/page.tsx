'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Search, LayoutGrid, List, Bell, Settings,
  Play, Square, RotateCw, Hammer, Trash2, Edit3,
  Folder, ChevronRight, X, AlertTriangle, Info, AlertCircle,
  Clock, Cpu, HardDrive, Server, Globe, Shield, Zap, Activity,
  Copy, GripVertical, Terminal, RefreshCw, ChevronDown,
  ChevronUp, MoreVertical, Eye, Filter, Tag, Layers,
  Monitor, Database, Smartphone, Cpu as CpuIcon, GitBranch,
  CheckCircle2, XCircle, Loader2,
  Bot, ArrowUpDown, ArrowRightLeft, ArrowUpNarrowWide, ArrowDownWideNarrow,
  CircleDot, Download, Star, ExternalLink, Link2, Plug, PlugZap, MonitorSmartphone,
  Keyboard,
  Wifi, Gauge, MemoryStick, BarChart3, Upload, LayoutTemplate,
  Network, Ban, Lock as LockIcon,
  TrendingUp, TrendingDown, Pin, PinOff, ArrowUp, GitFork, Tags, Clipboard,
  SearchX,
  Cloud, Container, Wrench, Building, House, Box,
  EyeOff, KeyRound, Sparkles,
  ShieldAlert, ShieldCheck, ShieldX, Minimize2,
  UserPlus,
} from 'lucide-react'

import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent, DragOverlay
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy, rectSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { Button } from '@/components/ui/button'
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from '@/components/ui/context-menu'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { proxyToAgent } from '@/lib/remote-agent'
import { ThemeToggle } from '@/components/theme-toggle'
import { ThemeCustomizer } from '@/components/theme-customizer'
import { LanguageToggle } from '@/components/language-toggle'
import { useI18n, useT, type I18nContextValue } from '@/lib/i18n'
import { type HarnessSessionState } from '@/components/analyze-wizard'
import { useToast, addToast } from '@/hooks/use-toast'
import { AuthProvider, useAuth, AuthLoadingSplash } from '@/components/auth/auth-provider'
import { AccountStatusScreen } from '@/components/auth/account-status-screen'
import { UserMenu } from '@/components/auth/user-menu'
import type { DashboardSession } from '@/components/auth/auth-types'
import { setToastClickHandler } from '@/components/ui/toaster'

// ---- Code-split heavy, rarely-shown surfaces --------------------------
// These dialogs together are ~2400 lines (login screen alone 600, user
// management 715) and only appear on specific flows (logged out, admin
// panel, wizard, remote/mesh setup). Loading them on demand cuts the
// first-load chunk of this 9000-line page substantially.
const AnalyzeWizard = dynamic(() => import('@/components/analyze-wizard').then((m) => m.AnalyzeWizard))
const RemoteProjectDialog = dynamic(() => import('@/components/remote-project-dialog').then((m) => m.RemoteProjectDialog))
const MeshPairingDialog = dynamic(() => import('@/components/mesh-pairing').then((m) => m.MeshPairingDialog))
const JoinMeshDialog = dynamic(() => import('@/components/mesh-join').then((m) => m.JoinMeshDialog))
const LoginScreen = dynamic(() => import('@/components/auth/login-screen').then((m) => m.LoginScreen), {
  loading: () => <AuthLoadingSplash />,
})
const ChangePasswordDialog = dynamic(() => import('@/components/auth/change-password-dialog').then((m) => m.ChangePasswordDialog))
const UserManagementDialog = dynamic(() => import('@/components/auth/user-management-dialog').then((m) => m.UserManagementDialog))

// ======================== CUSTOM DnD SENSOR ========================
// A PointerSensor that only activates when the pointerdown target is a
// [data-dnd-drag-handle] element.  This prevents the sensor from
// intercepting clicks on the rest of the card.
//
// We create a proper subclass of PointerSensor that overrides the activators
// to check for the drag handle element before starting a drag.
function createDragHandleSensor(): typeof PointerSensor {
  return class DragHandleSensor extends PointerSensor {
    static activators = [
      {
        eventName: 'onPointerDown' as const,
        handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
          if (!nativeEvent.isPrimary || nativeEvent.button !== 0) {
            return false
          }
          const target = nativeEvent.target as HTMLElement | null
          if (!target || !target.closest('[data-dnd-drag-handle]')) {
            return false
          }
          return true
        },
      },
    ]
  }
}

const DragHandleSensor = createDragHandleSensor()

// ======================== TYPES ========================

interface Environment {
  id: string
  projectId: string
  name: string
  cmd: string
  port: number
  envVars: string
  status: string
  pid: number | null
  createdAt: string
  updatedAt: string
}

interface Device {
  id: string
  name: string
  ip: string
  port: number
  apiKey: string
  status: string
  lastSeen: string
  createdAt: string
  updatedAt: string
  projectCount?: number
  icon?: string
}

interface Project {
  id: string
  name: string
  path: string
  description: string
  icon: string
  tags: string
  createdAt: string
  updatedAt: string
  environments: Environment[]
  deviceId?: string | null
  deviceName?: string | null
  deviceStatus?: string | null
}

interface Notification {
  id: string
  type: 'success' | 'warning' | 'error' | 'info'
  title: string
  message: string
  timestamp: string
  read: boolean
  projectId?: string
  projectName?: string
}

interface ActivityEvent {
  id: string
  type: 'deploy' | 'start' | 'stop' | 'restart' | 'rebuild' | 'config_change' | 'error' | 'create' | 'analyze' | 'repair' | 'pair' | 'delete' | string
  message: string
  timestamp: string
  projectId?: string
  projectName?: string
  level?: string
  metadata?: Record<string, unknown>
}

interface LogEntry {
  id: string
  timestamp: string | null
  level: string
  source: string
  message: string
  projectId: string
  envName?: string
}

interface GatewayStatus {
  caddyRunning: boolean
  caddyVersion: string
  gatewayPort: number
  gatewayListening: boolean
  configValid: boolean
  uptime: string
  uptimeSeconds: number
  systemUptime: string
  systemUptimeSeconds: number
  memoryUsage: { total: number; used: number; free: number; percentage: number }
  cpuUsage: { percentage: number; cores: number; loadAverage: number[] }
  processMemory?: { rss: number; heapUsed: number; heapTotal: number }
  diskUsage?: { total: number; used: number; free: number; percentage: number }
  services: Array<{ name: string; status: string; port: number; pid: number; uptime: string; memory: number }>
  agentGateways: Array<{ name: string; url: string; connected: boolean; lastPing: string }>
  lastChecked: string
}

interface LlmConfig {
  id: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  updatedAt: string
}

interface HealthCheckResult {
  overallStatus: string
  checkedAt: string
  results: Array<{ port: number; status: string; responseTime: number; lastChecked: string; details: string }>
}

type AlertSeverity = 'critical' | 'warning' | 'notice' | 'ok'

type ViewMode = 'grid' | 'list'
type SortOption = 'newest' | 'name' | 'status' | 'port' | 'custom'
type SortDir = 'asc' | 'desc'
type FilterStatus = 'all' | 'running' | 'stopped'
type GroupBy = 'device' | 'tags' | 'none'

// Neutral tag chips — color belongs to status data, not labels.
const TAG_CHIP = 'bg-brand-soft text-brand-strong border border-transparent'

const TAG_OPTIONS = [
  { name: 'Frontend', color: TAG_CHIP },
  { name: 'Backend', color: TAG_CHIP },
  { name: 'Fullstack', color: TAG_CHIP },
  { name: 'DevOps', color: TAG_CHIP },
  { name: 'Mobile', color: TAG_CHIP },
  { name: 'API', color: TAG_CHIP },
  { name: 'Database', color: TAG_CHIP },
  { name: 'ML/AI', color: TAG_CHIP },
  { name: 'Automation', color: TAG_CHIP },
]

const ICON_MAP: Record<string, React.ElementType> = {
  folder: Folder,
  globe: Globe,
  server: Server,
  database: Database,
  smartphone: Smartphone,
  cpu: CpuIcon,
  'git-branch': GitBranch,
  terminal: Terminal,
  shield: Shield,
  zap: Zap,
  monitor: Monitor,
  'plug-zap': PlugZap,
}

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  deploy: RocketIcon,
  start: Play,
  stop: Square,
  restart: RotateCw,
  rebuild: Hammer,
  config_change: Settings,
  error: AlertCircle,
  create: Plus,
  analyze: Sparkles,
  repair: Wrench,
  pair: Link2,
  delete: Trash2,
  user: UserPlus,
}

const ACTIVITY_COLORS: Record<string, string> = {
  deploy: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30',
  start: 'text-green-500 bg-green-100 dark:bg-green-900/30',
  stop: 'text-red-500 bg-red-100 dark:bg-red-900/30',
  restart: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30',
  rebuild: 'text-teal-500 bg-teal-100 dark:bg-teal-900/30',
  config_change: 'text-violet-500 bg-violet-100 dark:bg-violet-900/30',
  error: 'text-red-600 bg-red-100 dark:bg-red-900/30',
  create: 'text-cyan-500 bg-cyan-100 dark:bg-cyan-900/30',
  analyze: 'text-sky-500 bg-sky-100 dark:bg-sky-900/30',
  repair: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30',
  pair: 'text-teal-500 bg-teal-100 dark:bg-teal-900/30',
  delete: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-900/30',
  user: 'text-fuchsia-500 bg-fuchsia-100 dark:bg-fuchsia-900/30',
}

// RocketIcon for deploy
function RocketIcon(props: React.SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}

// ======================== UTILITY FUNCTIONS ========================

// localStorage key for the stale-while-revalidate project list cache.
// Written by fetchProjects, read synchronously in the projects useState
// initializer so the very FIRST render already shows data (no skeleton flash)
// — the network revalidation then runs in the background.
const PROJECTS_CACHE_KEY = 'dashboard-projects-cache-v1'
const PROJECTS_CACHE_MAX_AGE_MS = 10 * 60 * 1000

/** Read the cached project list (module-level memo: called from two useState
 *  initializers on the first render, never again). */
let projectsCacheInit: { hit: boolean; data: Project[] } | null = null
function readProjectsCacheOnce(): { hit: boolean; data: Project[] } {
  if (projectsCacheInit) return projectsCacheInit
  try {
    const raw = localStorage.getItem(PROJECTS_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.data) && Date.now() - (parsed.ts ?? 0) < PROJECTS_CACHE_MAX_AGE_MS) {
        projectsCacheInit = { hit: true, data: parsed.data }
        return projectsCacheInit
      }
    }
  } catch { /* corrupt cache — ignore */ }
  projectsCacheInit = { hit: false, data: [] }
  return projectsCacheInit
}

function parseTags(tagsStr: string | string[]): string[] {
  if (Array.isArray(tagsStr)) return tagsStr
  try {
    return JSON.parse(tagsStr || '[]')
  } catch {
    return []
  }
}

function parseEnvVars(varsStr: string): Record<string, string> {
  try {
    return JSON.parse(varsStr || '{}')
  } catch {
    return {}
  }
}

function getTagColor(tagName: string): string {
  const found = TAG_OPTIONS.find((t) => t.name === tagName)
  return found?.color || TAG_CHIP
}

function getProjectStatus(project: Project): 'running' | 'stopped' | 'mixed' {
  const envs = project.environments || []
  if (envs.length === 0) return 'stopped'
  const running = envs.filter((e) => e.status === 'running').length
  if (running === envs.length) return 'running'
  if (running === 0) return 'stopped'
  return 'mixed'
}

/** Port used when sorting a project by port — mirrors the card's open-URL
 *  fallback: the running env's port, else the first env's port. Projects
 *  without any environment sink to the end (Infinity) instead of position 0. */
function getProjectSortPort(project: Project): number {
  const envs = project.environments || []
  return (envs.find((e) => e.status === 'running') ?? envs[0])?.port ?? Number.POSITIVE_INFINITY
}

function calculateHealthScore(project: Project): number {
  const envs = project.environments || []
  if (envs.length === 0) return 50
  const running = envs.filter((e) => e.status === 'running').length
  const ratio = running / envs.length
  return Math.round(ratio * 100)
}

function healthColor(score: number): string {
  if (score >= 80) return 'text-emerald-500'
  if (score >= 50) return 'text-amber-500'
  return 'text-red-500'
}

// Health trend: compare current health with previous value stored in localStorage
type HealthTrend = 'up' | 'down' | 'stable'

function getHealthTrend(projectId: string, currentScore: number): HealthTrend {
  try {
    const key = `health-prev-${projectId}`
    const prev = localStorage.getItem(key)
    if (prev === null) {
      // First time — store current and return stable
      localStorage.setItem(key, String(currentScore))
      return 'stable'
    }
    const prevScore = parseInt(prev, 10)
    localStorage.setItem(key, String(currentScore))
    if (currentScore > prevScore) return 'up'
    if (currentScore < prevScore) return 'down'
    return 'stable'
  } catch {
    return 'stable'
  }
}

function HealthTrendIcon({ trend }: { trend: HealthTrend }) {
  const t = useT()
  if (trend === 'up') return <span className="health-trend-icon inline-flex items-center text-emerald-500 text-[9px] leading-none ml-0.5" title={t('surf.trendUp')}>▲</span>
  if (trend === 'down') return <span className="health-trend-icon inline-flex items-center text-red-400 text-[9px] leading-none ml-0.5" title={t('surf.trendDown')}>▼</span>
  return <span className="health-trend-icon inline-flex items-center text-zinc-300 dark:text-zinc-600 text-[9px] leading-none ml-0.5" title={t('surf.trendStable')}>◆</span>
}

function healthStroke(score: number): string {
  if (score >= 80) return '#10b981'
  if (score >= 50) return '#f59e0b'
  return '#ef4444'
}

function getAlertSeverity(score: number): AlertSeverity {
  if (score <= 25) return 'critical'
  if (score <= 50) return 'warning'
  if (score <= 75) return 'notice'
  return 'ok'
}

function severityConfig(severity: AlertSeverity): { label: string; color: string; bg: string; dot: string; ring: string } {
  switch (severity) {
    case 'critical': return { label: 'Critical', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', dot: 'bg-red-500', ring: 'ring-red-200 dark:ring-red-800/40' }
    case 'warning': return { label: 'Warning', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', dot: 'bg-amber-500', ring: 'ring-amber-200 dark:ring-amber-800/40' }
    case 'notice': return { label: 'Notice', color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-900/20', dot: 'bg-yellow-500', ring: 'ring-yellow-200 dark:ring-yellow-800/40' }
    case 'ok': return { label: 'OK', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', dot: 'bg-emerald-500', ring: 'ring-emerald-200 dark:ring-emerald-800/40' }
  }
}

function MiniSparkline({ data, color = '#f43f5e', height = 28, width = 64 }: { data: number[]; color?: string; height?: number; width?: number }) {
  if (data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline points={points} className="sparkline-path" stroke={color} />
    </svg>
  )
}

// Collapsible severity group for Health Alerts dialog (Session 14)
function SeverityGroup({ label, color, dot, count, children }: { label: string; color: string; dot: string; count: number; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false)
  return (
    <div>
      <button type="button" className="flex items-center gap-1.5 w-full text-left cursor-pointer hover:bg-muted/30 rounded-md px-1 py-0.5 transition-colors" onClick={() => setCollapsed(!collapsed)}>
        <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>{label}</span>
        <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5">{count}</Badge>
        <div className="flex-1" />
        {collapsed ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="space-y-1 mt-1 pl-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function formatTimeAgo(dateStr: string, t?: I18nContextValue['t']): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (t) {
    // localized units (task 18): renders via the active dictionary
    if (mins < 1) return t('time.now')
    if (mins < 60) return t('time.minutesAgo', { count: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('time.hoursAgo', { count: hours })
    const days = Math.floor(hours / 24)
    return t('time.daysAgo', { count: days })
  }
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-amber-100 text-foreground dark:bg-amber-400/25 rounded px-0.5">{part}</mark>
    ) : (
      part
    )
  )
}

// ======================== ANIMATED COUNTER ========================

function AnimatedCounter({ target, duration = 1200 }: { target: number; duration?: number }) {
  const [count, setCount] = React.useState(0)
  const prevTarget = React.useRef(0)

  React.useEffect(() => {
    const start = prevTarget.current
    const diff = target - start
    if (diff === 0) return
    const startTime = performance.now()

    function animate(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCount(Math.round(start + diff * eased))
      if (progress < 1) requestAnimationFrame(animate)
    }

    requestAnimationFrame(animate)
    prevTarget.current = target
  }, [target, duration])

  return <span>{count}</span>
}

// ======================== HEALTH SCORE CIRCLE ========================

function HealthScoreCircle({ score, size = 40 }: { score: number; size?: number }) {
  const t = useT()
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const safeScore = typeof score === 'number' && !isNaN(score) ? score : 0
  const offset = circumference - (safeScore / 100) * circumference
  // Number is rendered as an HTML overlay (not rotated SVG text): flex centering
  // is pixel-exact regardless of font metrics — the old dominantBaseline="central"
  // + double-rotation approach landed 1-2.6px off-center depending on digit count.
  const numClass = size <= 28 ? 'text-[10px]' : size >= 40 ? 'text-[13px]' : 'text-[11px]'

  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-label={t('surf.healthScore', { score: safeScore })}>
      <svg width={size} height={size} className="block -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted-foreground/20 dark:text-muted-foreground/20" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={healthStroke(safeScore)}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={circumference}
          strokeLinecap="round"
          animate={{ strokeDashoffset: offset, stroke: healthStroke(safeScore) }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center ${numClass} font-semibold tabular-nums leading-none ${healthColor(safeScore)}`}>
        {safeScore}
      </span>
    </span>
  )
}

// ======================== DEPLOYMENT PIPELINE (unused - removed from cards) ========================
// DeploymentPipeline component removed from cards to simplify UI

// ======================== HEALTH SCORE HOVER CARD ========================

function HealthScoreHoverCard({
  score, size, runningEnvs, totalEnvs, updatedAt
}: {
  score: number
  size?: number
  runningEnvs: number
  totalEnvs: number
  updatedAt: string
}) {
  const t = useT()
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className="cursor-pointer"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <HealthScoreCircle score={score} size={size} />
        </div>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        className="w-56 p-3 text-xs"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="space-y-2.5">
          <div className="font-semibold text-sm">{t('card.preview.stats')}</div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('card.preview.healthScore')}</span>
            <span className={`font-medium ${healthColor(score)}`}>{score}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('card.preview.uptime')}</span>
            <span className="font-medium">{totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('card.preview.runningEnvs')}</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{runningEnvs}/{totalEnvs}</span>
          </div>
          {/* Status breakdown bar */}
          <div className="space-y-1">
            <span className="text-muted-foreground text-[10px]">{t('card.preview.statusBreakdown')}</span>
            <div className="h-2 rounded-full bg-muted overflow-hidden flex">
              {totalEnvs > 0 && runningEnvs > 0 && (
                <div className="bg-emerald-500 h-full rounded-l-full transition-all" style={{ width: `${(runningEnvs / totalEnvs) * 100}%` }} />
              )}
              {totalEnvs > 0 && totalEnvs - runningEnvs > 0 && (
                <div className="bg-red-400 h-full rounded-r-full transition-all" style={{ width: `${((totalEnvs - runningEnvs) / totalEnvs) * 100}%` }} />
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {t('card.preview.runningCount', { count: runningEnvs })}</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-400" /> {t('card.preview.stoppedCount', { count: totalEnvs - runningEnvs })}</span>
            </div>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('card.preview.lastUpdated')}</span>
            <span className="font-medium">{formatTimeAgo(updatedAt, t)}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ======================== PROJECT QUICK PREVIEW HOVER CARD ========================

function ProjectQuickPreview({
  project, children
}: {
  project: Project
  children: React.ReactNode
}) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const health = calculateHealthScore(project)
  const runningEnvs = (project.environments || []).filter((e) => e.status === 'running').length
  const totalEnvs = (project.environments || []).length
  const status = getProjectStatus(project)
  const IconComp = ICON_MAP[project.icon] || Folder

  const handleMouseEnter = React.useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setOpen(true), 800)
  }, [])

  const handleMouseLeave = React.useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    setOpen(false)
  }, [])

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={800} closeDelay={150}>
      <HoverCardTrigger asChild
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-72 p-0 overflow-hidden"
        onMouseEnter={() => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); setOpen(true) }}
        onMouseLeave={handleMouseLeave}
      >
        <div className="p-3 border-b bg-brand-soft/50 dark:bg-brand-soft">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-brand-soft-strong">
              <IconComp className="h-4 w-4 text-brand-strong" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{project.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{project.path}</p>
            </div>
          </div>
        </div>
        <div className="p-3 space-y-2.5">
          {project.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">{project.description}</p>
          )}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <HealthScoreCircle score={health} size={28} />
              <span className={`text-xs font-semibold ${healthColor(health)}`}>{health}%</span>
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'mixed' ? 'bg-amber-500' : 'bg-red-400'}`} />
              <span className="text-xs text-muted-foreground">{t('card.preview.runningFraction', { running: runningEnvs, total: totalEnvs })}</span>
            </div>
          </div>
          {/* Health bar */}
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${health >= 80 ? 'bg-emerald-500' : health >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
              style={{ width: `${health}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('card.preview.updatedAgo', { time: formatTimeAgo(project.updatedAt, t) })}</span>
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
              <Play className="h-3 w-3" />{t('card.chipStart')}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-[11px] font-medium ring-1 ring-red-200/50 dark:ring-red-800/30">
              <Square className="h-3 w-3" />{t('card.chipStop')}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/50 text-muted-foreground text-[11px] font-medium ring-1 ring-border/30">
              <ExternalLink className="h-3 w-3" />{t('card.chipOpen')}
            </span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

// ======================== DASHBOARD CLOCK WIDGET ========================

function DashboardClockWidget() {
  const [time, setTime] = React.useState<string | null>(null)

  React.useEffect(() => {
    const update = () => {
      const now = new Date()
      setTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  // Render empty placeholder on SSR to avoid hydration mismatch
  return (
    <span className="text-[10px] text-muted-foreground dark:text-zinc-400 font-mono tabular-nums">
      {time ?? '--:--:--'}
    </span>
  )
}

// ======================== HERMES BRIDGE TOGGLE ========================
// Small switch embedded in the Hermes Web project card. Controls the
// "Hermes Bridge" project's bridge environment (port 3210). Status is
// driven by the dashboard's existing 5s project refresh — the toggle is
// ======================== HERMES BRIDGE TOGGLE ========================
// Minimal badge for the Hermes Web card's dev env row.
// Green = bridge running, gray = stopped. No switch, no pulse animation.
// Placed inline with the dev tag to avoid adding height.

const HERMES_BRIDGE_NAME = 'Hermes Bridge'

function HermesBridgeToggle() {
  const { bridgeRunning } = useBridgeStatus()

  return (
    <span
      className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-md font-semibold tracking-wide ${bridgeRunning ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-200/60 dark:ring-emerald-700/50' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400 ring-1 ring-zinc-200/50 dark:ring-zinc-700/40'}`}
      title={`Hermes Bridge :3210 — ${bridgeRunning ? 'running' : 'stopped'}`}
    >
      Bridge
    </span>
  )
}

// Hook: read the Hermes Bridge project + its first environment from the
// parent's projects list. Returns null entries if the project isn't configured.
function useBridgeStatus() {
  const [bridgeProject, setBridgeProject] = React.useState<Project | null>(null)
  const [bridgeEnv, setBridgeEnv] = React.useState<Environment | null>(null)
  const [bridgeRunning, setBridgeRunning] = React.useState(false)

  // Use a global event bus via window so the toggle can react to project list
  // updates without re-rendering the whole dashboard. The dashboard dispatches
  // 'projects-updated' on every fetchProjects() call (we add that separately).
  const refresh = React.useCallback(() => {
    try {
      const projects = (window.__dashboardProjects ?? []) as Project[]
      const proj = projects.find((p) => p.name === HERMES_BRIDGE_NAME) || null
      setBridgeProject(proj)
      const env = proj?.environments?.[0] || null
      setBridgeEnv(env)
      setBridgeRunning(env?.status === 'running')
    } catch {
      // ignore
    }
  }, [])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    window.addEventListener('projects-updated', refresh)
    return () => {
      clearInterval(id)
      window.removeEventListener('projects-updated', refresh)
    }
  }, [refresh])

  return { bridgeProject, bridgeEnv, bridgeRunning }
}

// ======================== ANIMATED STATUS DOT ========================

function AnimatedStatusDot({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' }) {
  const dotSize = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2'
  // Quiet data-dots: emerald for running, red only for unreachable devices,
  // muted zinc for a normal stopped state.
  if (status === 'running') {
    return <span className={`inline-block rounded-full bg-emerald-500 ${dotSize}`} />
  }
  if (status === 'offline') {
    return <span className={`inline-block rounded-full bg-red-500 ${dotSize}`} />
  }
  return <span className={`inline-block rounded-full bg-zinc-300 dark:bg-zinc-600 ${dotSize}`} />
}

// ======================== SORTABLE PROJECT CARD ========================

// Labels for in-flight env operations (progress indicator on env rows).
const OP_PROGRESS_LABELS: Record<string, string> = {
  start: 'Starting',
  stop: 'Stopping',
  restart: 'Restarting',
  rebuild: 'Rebuilding',
}

function EnvOpPending({ action, t }: { action: string; t?: I18nContextValue['t'] }) {
  const op = t && ['start', 'stop', 'restart', 'rebuild'].includes(action)
    ? t(`dlg.op.${action}` as Parameters<typeof t>[0])
    : OP_PROGRESS_LABELS[action] ?? action
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap"
      title={t ? t('dlg.op.inProgressTitle', { op }) : `${OP_PROGRESS_LABELS[action] ?? action} in progress — please wait`}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {op}…
    </span>
  )
}

function SortableProjectCardImpl({
  project, viewMode, searchQuery, onSelect, onEdit, onDelete,
  onEnvAction, onRebuildConfirm, selected, onToggleSelect, rebuilding,
  starred, onToggleStar, lanIp, currentHost, index = 0,
  batchMode = false, onDuplicate, onMoveToDevice, devices, onHover,
  focused = false, cardDensity = 'comfortable', onCompare, pinOrder, onReanalyze,
  pendingOps = {},
}: {
  project: Project
  viewMode: ViewMode
  searchQuery: string
  onSelect: (p: Project) => void
  onEdit: (p: Project) => void
  onDelete: (p: Project) => void
  onEnvAction: (projectId: string, envId: string, action: string) => void
  onRebuildConfirm: (p: Project) => void
  selected: boolean
  onToggleSelect: (id: string) => void
  rebuilding: boolean
  starred: boolean
  onToggleStar: (id: string) => void
  lanIp: string
  currentHost: string
  index?: number
  batchMode?: boolean
  onDuplicate?: (id: string) => void
  onMoveToDevice?: (project: Project) => void
  devices?: Device[]
  onHover?: (id: string | null) => void
  focused?: boolean
  cardDensity?: 'compact' | 'comfortable' | 'spacious'
  onCompare?: (project: Project) => void
  pinOrder?: number
  onReanalyze?: (p: Project) => void
  pendingOps?: Record<string, string>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const t = useT()
  const [expanded, setExpanded] = React.useState(false)
  const needsExpand = (project.environments || []).length > 3
  const style = {
    transform: isDragging
      ? `${CSS.Transform.toString(transform)} scale(1.02)`
      : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.9 : 1,
    // Hint the compositor before the drag transform is applied — avoids the
    // first-frame paint hitch when picking the card up.
    willChange: isDragging ? 'transform' : undefined,
  }

  const status = getProjectStatus(project)
  const prevStatusRef = React.useRef(status)
  const [statusChanged, setStatusChanged] = React.useState(false)
  React.useEffect(() => {
    if (prevStatusRef.current !== status) {
      setStatusChanged(true)
      const timer = setTimeout(() => setStatusChanged(false), 1500)
      prevStatusRef.current = status
      return () => clearTimeout(timer)
    }
  }, [status])
  const health = calculateHealthScore(project)
  const healthTrend = getHealthTrend(project.id, health)
  const tags = parseTags(project.tags)
  const runningEnvs = (project.environments || []).filter((e) => e.status === 'running').length
  const totalEnvs = (project.environments || []).length
  const IconComp = ICON_MAP[project.icon] || Folder
  const isRemote = !!(project.deviceId && project.deviceName)
  const deviceOnline = project.deviceStatus === 'online'

  const envLabel = (name: string) => name === 'development' ? 'dev' : name === 'production' ? 'prod' : name

  // Any operation in flight on this project (rebuild-all or a per-env action)?
  // Used to block duplicate bulk actions while something is still running.
  const projectBusy = rebuilding || (project.environments || []).some((e) => !!pendingOps[e.id])

  // Smart URL: use proxy path for external access (ngrok), direct URL for local/LAN.
  // For remote projects, point to the device's own IP+port (the process runs there, not on the dashboard).
  const getOpenUrl = (port: number) => {
    if (isRemote) {
      // Remote project: process runs on the device — use device.ip + port
      // Fall back to localhost if device.ip is missing for any reason
      const deviceIp = (project as any).deviceIp || (project as any).ip || 'localhost'
      return `http://${deviceIp}:${port}`
    }
    if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) {
      // External access (ngrok or similar) — use proxy path
      return `/api/proxy/${port}/`
    }
    // Local/LAN access — use direct URL
    const host = currentHost || 'localhost'
    return `http://${host}:${port}`
  }

  const densityClass = cardDensity === 'compact' ? 'p-2' : cardDensity === 'spacious' ? 'p-5' : 'p-2.5'
  const densityListClass = cardDensity === 'compact' ? 'p-2 gap-2' : cardDensity === 'spacious' ? 'p-5 gap-4' : 'p-3 gap-3'
  // Compact cards: tighter header/content paddings without dropping any element.
  const headerPad = cardDensity === 'compact' ? 'pb-2 pt-4 px-3' : cardDensity === 'spacious' ? 'pb-3 pt-5 px-5 sm:px-6' : 'pb-2.5 pt-4 px-4'
  const contentPad = cardDensity === 'compact' ? 'px-3 pb-3' : cardDensity === 'spacious' ? 'px-5 sm:px-6 pb-4' : 'px-4 pb-3.5'
  const envRowPad = cardDensity === 'compact' ? 'px-2 py-1.5' : cardDensity === 'spacious' ? 'px-2 sm:px-2.5 py-2.5' : 'px-2 py-2'
  const envRowGap = cardDensity === 'compact' ? 'space-y-1' : 'space-y-1.5'

  if (viewMode === 'list') {
    return (
      <div ref={setNodeRef} style={style} data-project-index={index} className={isDragging ? 'z-50' : ''} onMouseEnter={() => onHover?.(project.id)} onMouseLeave={() => onHover?.(null)}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          tabIndex={0}
          className={`surface-card group flex items-center ${densityListClass} rounded-lg border border-zinc-200 dark:border-zinc-800 bg-card hover:border-brand/35 dark:hover:border-brand/30 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer overflow-hidden ${isDragging ? 'shadow-lg ring-1 ring-zinc-300 dark:ring-zinc-600' : ''} ${focused ? 'ring-1 ring-zinc-400 dark:ring-zinc-500' : ''} ${statusChanged ? 'ring-1 ring-amber-500/50' : ''}`}
          onClick={() => onSelect(project)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(project) } }}
        >
          <div {...attributes} {...listeners} data-dnd-drag-handle className="cursor-grab active:cursor-grabbing p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" onClick={(e) => e.stopPropagation()} title={t('card.dragToReorder')}>
            <GripVertical className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
          </div>
          {batchMode && (
            <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(project.id)} onClick={(e) => e.stopPropagation()} className="shrink-0" />
          )}
          {project.name === 'Hermes Web' && (
            <span onClick={(e) => e.stopPropagation()}>
              <HermesBridgeToggle />
            </span>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`shrink-0 cursor-pointer transition-colors ${starred ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-300 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-300'}`}>
            {starred ? <Pin className="h-4 w-4 fill-current" /> : <Star className="h-4 w-4" />}
          </button>
          {starred && pinOrder != null && <span className="text-[8px] min-w-[14px] text-center px-0.5 py-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-semibold shrink-0">#{pinOrder}</span>}
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-brand/25 bg-brand-soft shadow-xs shrink-0">
            <IconComp className="h-3.5 w-3.5 text-brand-strong" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{highlightText(project.name, searchQuery)}</span>
              {isRemote && (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-700/70 text-zinc-500 dark:text-zinc-400 font-medium">
                  <span className={`h-1.5 w-1.5 rounded-full ${deviceOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  {project.deviceName}
                </span>
              )}
              <Badge variant="outline" className="text-[11px] font-medium shrink-0 gap-1.5 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 tabular-nums">
                <span className={`h-1.5 w-1.5 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'mixed' ? 'bg-amber-500' : 'bg-zinc-400 dark:bg-zinc-500'}`} />
                {runningEnvs}/{totalEnvs} running
              </Badge>
              {project.name === 'Hermes Web' && <HermesBridgeToggle />}
            </div>
            <button type="button" className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 truncate text-left cursor-pointer hover:text-foreground dark:hover:text-zinc-200 transition-colors" title={t('card.pathTooltip', { path: project.path })} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(project.path); addToast({ title: t('dlg.toast.pathCopied'), description: project.path, variant: 'success' }) }}>{highlightText(project.path, searchQuery)}</button>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 justify-end max-w-[200px] overflow-hidden">
            {tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className={`text-[10px] px-1.5 cursor-default shrink-0 whitespace-nowrap ${getTagColor(tag)}`}>{tag}</Badge>
            ))}
          </div>
          {/* List view: per-environment controls */}
          <div className="hidden md:flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            {(project.environments || []).slice(0, 3).map((env) => (
              <div key={env.id} className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors`}
                title={env.pid ? t('card.envRowTitlePid', { env: envLabel(env.name), port: env.port, status: env.status, pid: env.pid }) : t('card.envRowTitle', { env: envLabel(env.name), port: env.port, status: env.status })}
              >
                <AnimatedStatusDot status={env.status} />
                {env.name === 'development' ? <span className="text-[10px] leading-4 px-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-medium shrink-0">dev</span> : env.name === 'production' ? <span className="text-[10px] leading-4 px-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium shrink-0">prod</span> : <span className="text-[10px] text-muted-foreground dark:text-zinc-300 max-w-[40px] truncate">{envLabel(env.name)}</span>}
                {env.name === 'development' && env.status === 'running' && <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium shrink-0" title={t('card.hmrTitle')}>HMR</span>}
                {env.name === 'production' && <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium shrink-0" title={t('card.buildTitle')}>Build</span>}
                {pendingOps[env.id] ? <EnvOpPending action={pendingOps[env.id]} t={t} /> : (<>
                {env.status === 'running' && (
                  <a
                    href={getOpenUrl(env.port)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-md h-4 w-4 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    title={t('card.openEnv', { env: envLabel(env.name), port: env.port })}
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
                {env.status === 'running' && (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={t('card.restartEnv', { env: envLabel(env.name) })}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.restartEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {env.name !== 'development' && (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={t('card.rebuildEnv', { env: envLabel(env.name) })}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.rebuildEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {/* Start/Stop at rightmost position */}
                {env.status === 'running' ? (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer shrink-0 ml-0.5" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={t('card.stopEnv', { env: envLabel(env.name) })}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.stopEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                ) : (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer shrink-0 ml-0.5" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={t('card.startEnv', { env: envLabel(env.name) })}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.startEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                )}
                </>)}
              </div>
            ))}
            {(project.environments || []).length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{(project.environments || []).length - 3}</span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <div onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }} className="cursor-pointer rounded-full transition-opacity hover:opacity-75">
              <HealthScoreHoverCard score={health} size={32} runningEnvs={runningEnvs} totalEnvs={totalEnvs} updatedAt={project.updatedAt} />
            </div>
            <HealthTrendIcon trend={healthTrend} />
          </div>
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {(project.environments || []).some((e) => e.status === 'running') && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><a
                href={getOpenUrl((project.environments || []).find((e) => e.status === 'running')?.port || (project.environments || [])[0]?.port || 3000)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md h-7 px-2 gap-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">{t('surf.open')}</span>
              </a></TooltipTrigger><TooltipContent>{t('surf.openInBrowser')}</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Re-fetch Environments — surfaced prominently when the project
                has no environments and is stranded in an unstartable state.
                Skipped for remote projects (analyze runs on the host machine). */}
            {totalEnvs === 0 && onReanalyze && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 px-2.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer gap-1.5 text-[11px] font-medium transition-colors" onClick={() => onReanalyze(project)}>
                <RefreshCw className="h-3 w-3" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.refetchEnv')}</span>
              </button></TooltipTrigger><TooltipContent>{t('surf.refetchEnvHint')}</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button. Hidden when
                there are zero environments (the Re-fetch button above takes that slot). */}
            {(project.environments || []).some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" disabled={projectBusy} className="inline-flex items-center justify-center rounded-md h-7 px-2.5 border border-zinc-200 dark:border-zinc-700 bg-card hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50/60 dark:hover:bg-red-950/30 cursor-pointer gap-1.5 text-zinc-600 dark:text-zinc-300 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.stopAll')}</span>
              </button></TooltipTrigger><TooltipContent>{projectBusy ? t('card.busyTooltip') : t('card.stopAllRunning')}</TooltipContent></Tooltip></TooltipProvider>
            ) : totalEnvs > 0 ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" disabled={projectBusy} className="inline-flex items-center justify-center rounded-md h-7 px-2.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer gap-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.startAll')}</span>
              </button></TooltipTrigger><TooltipContent>{projectBusy ? t('card.busyTooltip') : t('card.startAllStopped')}</TooltipContent></Tooltip></TooltipProvider>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"><MoreVertical className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.editProject')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.viewDetails')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate?.(project.id)} className="px-2.5 py-2 text-sm rounded-md"><Copy className="h-3.5 w-3.5 mr-2.5" />{t('surf.duplicate')}</DropdownMenuItem>
                {!project.deviceId && onMoveToDevice && (
                  <DropdownMenuItem onClick={() => onMoveToDevice(project)} className="px-2.5 py-2 text-sm rounded-md"><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />{t('surf.moveToDevice')}</DropdownMenuItem>
                )}
                {onReanalyze && (
                  <DropdownMenuItem onClick={() => onReanalyze(project)} className="px-2.5 py-2 text-sm rounded-md"><RefreshCw className="h-3.5 w-3.5 mr-2.5" />{t('surf.refetchEnvs')}</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {(project.environments || []).some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />{t('surf.copyProxy')}</DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={projectBusy} onClick={() => { if (projectBusy) return; (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />{t('surf.restartAll')}</DropdownMenuItem>
                <DropdownMenuItem disabled={projectBusy} onClick={() => { if (projectBusy) return; onRebuildConfirm(project) }} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />{t('surf.rebuildAll')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />{t('dlg.common.delete')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[180px] p-1.5 text-sm">
            {(project.environments || []).some((e) => e.status === 'running') && (
              <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) window.open(getOpenUrl(port), '_blank') }}><ExternalLink className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.openBrowser')}</ContextMenuItem>
            )}
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onSelect(project)}><Eye className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.viewDetails')}</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onEdit(project)}><Edit3 className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.editProject')}</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onDuplicate?.(project.id)}><Copy className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.duplicate')}</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onToggleStar(project.id)}>{starred ? <><PinOff className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.unpin')}</> : <><Pin className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.pinToTop')}</>}</ContextMenuItem>
            {(project.environments || []).every((e) => e.status !== 'running') && (
              <ContextMenuItem disabled={projectBusy} className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { if (projectBusy) return; (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'start')) }}><Play className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.startAll')}</ContextMenuItem>
            )}
            {(project.environments || []).some((e) => e.status === 'running') && (
              <ContextMenuItem disabled={projectBusy} className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}><Square className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.stopAll')}</ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onCompare?.(project)}><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.compare')}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" className="px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />{t('dlg.common.delete')}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  return (
    <ProjectQuickPreview project={project}>
    <div ref={setNodeRef} style={style} data-project-index={index} onClick={() => onSelect(project)} className={`card-lift h-full ${isDragging ? 'z-50' : ''}`} onMouseEnter={() => onHover?.(project.id)} onMouseLeave={() => onHover?.(null)}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(project) } }}
        className={`surface-card group relative flex flex-col ${densityClass} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-card hover:border-brand/35 dark:hover:border-brand/30 cursor-pointer overflow-hidden h-full ${isDragging ? 'shadow-lg ring-1 ring-zinc-300 dark:ring-zinc-600' : ''} ${focused ? 'ring-1 ring-zinc-400 dark:ring-zinc-500' : ''} ${statusChanged ? 'ring-1 ring-amber-500/50' : ''}`}
      >

        {/* Drag handle lives inline in the header flow (before the icon) — no overlap. */}
        {/* Hermes Bridge toggle is rendered in the bottom action row, not the card top */}

        {rebuilding && (
          <div className="absolute top-0 left-0 right-0 h-[3px] overflow-hidden rounded-t-xl z-20 bg-zinc-100 dark:bg-zinc-800" role="progressbar" aria-label={t('surf.rebuildInProgress')}>
            <div className="h-full w-1/3 bg-zinc-900 dark:bg-zinc-100 rounded-full progress-indeterminate" />
          </div>
        )}

        {/* Decorations (subtle, data-driven) — brand hairline */}
        <span aria-hidden className="pointer-events-none absolute top-0 left-0 right-0 h-[2px] z-10 bg-gradient-to-r from-brand/50 via-brand/15 to-transparent" />

        <CardHeader className={`${headerPad} shrink-0 relative z-[1]`}>
          <div className="flex items-start gap-2 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <div {...attributes} {...listeners} data-dnd-drag-handle onClick={(e) => e.stopPropagation()} className="cursor-grab active:cursor-grabbing -my-0.5 p-1 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/60 transition-colors shrink-0" title={t('card.dragToReorder')}>
                <GripVertical className="h-3.5 w-3.5" />
              </div>
              {batchMode && (
                <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(project.id)} onClick={(e) => e.stopPropagation()} className="shrink-0" />
              )}
              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-brand/25 bg-brand-soft shadow-xs shrink-0 relative z-[1]">
                <IconComp className="h-3.5 w-3.5 text-brand-strong" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <CardTitle className="text-[13px] font-semibold truncate tracking-tight text-foreground dark:text-zinc-100 leading-tight min-w-0 shrink">{highlightText(project.name, searchQuery)}</CardTitle>
                  {/* Tags inline with the title — single row, clipped when narrow */}
                  <div className="flex items-center gap-1 min-w-0 overflow-hidden max-w-[55%]">
                    {tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className={`text-[10px] px-1.5 py-0 rounded cursor-default shrink-0 whitespace-nowrap font-medium ${getTagColor(tag)}`}>{tag}</Badge>
                    ))}
                  </div>
                  {isRemote && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-700/70 text-zinc-500 dark:text-zinc-400 font-medium">
                      <span className={`h-1.5 w-1.5 rounded-full ${deviceOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {project.deviceName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                  <button type="button" className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 truncate min-w-0 text-left cursor-pointer hover:text-foreground dark:hover:text-zinc-200 transition-colors" title={t('card.pathTooltip', { path: project.path })} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(project.path); addToast({ title: t('dlg.toast.pathCopied'), description: project.path, variant: 'success' }) }}>
                    {highlightText(project.path, searchQuery)}
                  </button>
                  {totalEnvs > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] px-1 py-0 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 tabular-nums">
                      <Layers className="h-2.5 w-2.5" />{totalEnvs}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center shrink-0">
              <div className="flex items-center gap-0.5">
                <div onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }} className="cursor-pointer rounded-full transition-opacity hover:opacity-75">
                  <HealthScoreHoverCard score={health} size={28} runningEnvs={runningEnvs} totalEnvs={totalEnvs} updatedAt={project.updatedAt} />
                </div>
                <HealthTrendIcon trend={healthTrend} />
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`cursor-pointer transition-colors ml-0.5 ${starred ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-300 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-300'}`}>
                {starred ? <Pin className="h-3 w-3 fill-current" /> : <Star className="h-3 w-3" />}
              </button>
              {starred && pinOrder != null && <span className="text-[8px] min-w-[14px] text-center px-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-semibold shrink-0">#{pinOrder}</span>}
            </div>
          </div>
        </CardHeader>

        <CardContent className={`${contentPad} flex-1 min-w-0 relative z-[1]`}>
          {project.description && (
            <p className="text-xs text-muted-foreground/80 dark:text-zinc-400 mb-2 truncate" title={project.description}>{highlightText(project.description, searchQuery)}</p>
          )}
          <div className={envRowGap}>
            {(project.environments || []).slice(0, 3).map((env, envIdx) => (
              <div key={env.id} className={`flex items-center justify-between text-xs group/env min-w-0 gap-1.5 rounded-lg ${envRowPad} hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors ${envIdx < Math.min((project.environments || []).length, 3) - 1 ? 'border-b border-zinc-100 dark:border-zinc-800/60 pb-1.5' : ''}`}
                title={env.pid ? t('card.envRowTitlePid', { env: envLabel(env.name), port: env.port, status: env.status, pid: env.pid }) : t('card.envRowTitle', { env: envLabel(env.name), port: env.port, status: env.status })}
              >
                <div className="flex items-center gap-1.5 min-w-0 shrink">
                  <AnimatedStatusDot status={env.status} />
                  {env.name === 'development' ? <span className="shrink-0 text-[10px] leading-4 px-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-medium">dev</span> : env.name === 'production' ? <span className="shrink-0 text-[10px] leading-4 px-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium">prod</span> : <span className="text-muted-foreground dark:text-zinc-300 truncate max-w-[60px] text-[10px]">{envLabel(env.name)}</span>}
                  {/* Hermes Bridge badge (only on Hermes Web dev env, inline with dev tag) */}
                  {project.name === 'Hermes Web' && env.name === 'development' && (
                    <HermesBridgeToggle />
                  )}
                  {env.name === 'development' && env.status === 'running' && <span className="shrink-0 font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium" title={t('card.hmrTitle')}>HMR</span>}
                  {env.name === 'production' && <span className="shrink-0 font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium" title={t('card.buildTitle')}>Build</span>}
                </div>
                <div className="flex items-center gap-1 sm:gap-1 shrink-0">
                  {pendingOps[env.id] ? <EnvOpPending action={pendingOps[env.id]} t={t} /> : (<>
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors tabular-nums px-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(env.port)); addToast({ title: t('dlg.toast.portCopied'), description: t('dlg.toast.portCopiedDesc', { port: env.port }), variant: 'success' }) }} title={t('card.clickToCopyPort')}>:{env.port}</button></TooltipTrigger><TooltipContent>{t('card.clickToCopyPort')}</TooltipContent></Tooltip></TooltipProvider>
                  {env.status === 'running' && (
                    <a
                      href={getOpenUrl(env.port)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                      title={t('card.openEnv', { env: envLabel(env.name), port: env.port })}
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                  {env.status === 'running' && (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={t('card.restartEnv', { env: envLabel(env.name) })}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.restartEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                  )}
                  {env.name !== 'development' && (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={t('card.rebuildEnv', { env: envLabel(env.name) })}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.rebuildEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                  )}

                  {/* Start/Stop at rightmost position */}
                  {env.status === 'running' ? (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={t('card.stopEnv', { env: envLabel(env.name) })}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.stopEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                  ) : (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-zinc-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={t('card.startEnv', { env: envLabel(env.name) })}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.startEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                  )}
                  </>)}
                </div>
              </div>
            ))}
            <AnimatePresence>
              {expanded && (project.environments || []).length > 3 && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: 'easeInOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="space-y-2">
                    {(project.environments || []).slice(3).map((env, envIdx) => (
                      <div key={env.id} className={`flex items-center justify-between text-xs group/env min-w-0 gap-1.5 rounded-lg px-2 sm:px-2.5 py-2 sm:py-2.5 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors ${envIdx < (project.environments || []).length - 3 - 1 ? 'border-b border-zinc-100 dark:border-zinc-800/60 pb-2 sm:pb-3' : ''}`}
                        title={env.pid ? t('card.envRowTitlePid', { env: envLabel(env.name), port: env.port, status: env.status, pid: env.pid }) : t('card.envRowTitle', { env: envLabel(env.name), port: env.port, status: env.status })}
                      >
                        <div className="flex items-center gap-1.5 min-w-0 shrink">
                          <AnimatedStatusDot status={env.status} />
                          {env.name === 'development' ? <span className="shrink-0 text-[10px] leading-4 px-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-medium">dev</span> : env.name === 'production' ? <span className="shrink-0 text-[10px] leading-4 px-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium">prod</span> : <span className="text-muted-foreground dark:text-zinc-300 truncate max-w-[60px] text-[10px]">{envLabel(env.name)}</span>}
                          {env.name === 'development' && env.status === 'running' && <span className="shrink-0 font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium" title={t('card.hmrTitle')}>HMR</span>}
                          {env.name === 'production' && <span className="shrink-0 font-mono text-[9px] text-zinc-500 dark:text-zinc-400 font-medium" title={t('card.buildTitle')}>Build</span>}
                        </div>
                        <div className="flex items-center gap-1 sm:gap-1 shrink-0">
                          {pendingOps[env.id] ? <EnvOpPending action={pendingOps[env.id]} t={t} /> : (<>
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors tabular-nums px-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(env.port)); addToast({ title: t('dlg.toast.portCopied'), description: t('dlg.toast.portCopiedDesc', { port: env.port }), variant: 'success' }) }} title={t('card.clickToCopyPort')}>:{env.port}</button></TooltipTrigger><TooltipContent>{t('card.clickToCopyPort')}</TooltipContent></Tooltip></TooltipProvider>
                          {env.status === 'running' && (
                            <a href={getOpenUrl(env.port)} target="_blank" rel="noopener noreferrer" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" onClick={(e) => e.stopPropagation()} title={t('card.openEnv', { env: envLabel(env.name), port: env.port })}>
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                          {env.status === 'running' && (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={t('card.restartEnv', { env: envLabel(env.name) })}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.restartEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                          {env.name !== 'development' && (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={t('card.rebuildEnv', { env: envLabel(env.name) })}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>{t('card.rebuildEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                          {env.status === 'running' ? (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={t('card.stopEnv', { env: envLabel(env.name) })}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.stopEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                          ) : (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-zinc-500 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={t('card.startEnv', { env: envLabel(env.name) })}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>{t('card.startEnv', { env: envLabel(env.name) })}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                          </>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {!expanded && (project.environments || []).length > 3 && (
              <p className="text-[10px] text-muted-foreground">{t('surf.moreEnvs', { count: (project.environments || []).length - 3 })}</p>
            )}
          </div>

          {/* Expand/Collapse toggle */}
          {needsExpand && (
            <button
              type="button"
              className="mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            >
              {expanded ? <><ChevronUp className="h-3 w-3" />{t('surf.showLess')}</> : <><ChevronDown className="h-3 w-3" />{t('surf.showMore')}</>}
            </button>
          )}
        </CardContent>

        {/* Action bar — tinted footer zone separates actions from content */}
        <div className="relative z-[1] mt-auto border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/40 rounded-b-xl">
          <div className="px-4 sm:px-5 pb-3 pt-2 flex items-center justify-between min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px] font-medium px-2 py-0.5 gap-1.5 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 tabular-nums">
              <span className={`h-1.5 w-1.5 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'mixed' ? 'bg-amber-500' : 'bg-zinc-400 dark:bg-zinc-500'}`} />
              {t('card.preview.runningFraction', { running: runningEnvs, total: totalEnvs })}
            </Badge>
            {project.name === 'Hermes Web' && <HermesBridgeToggle />}
            <span className="text-[10px] text-muted-foreground dark:text-zinc-400 hidden sm:inline" title={new Date(project.createdAt).toLocaleString()}>{formatTimeAgo(project.createdAt, t)}</span>
          </div>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {(project.environments || []).some((e) => e.status === 'running') && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><a
                href={getOpenUrl((project.environments || []).find((e) => e.status === 'running')?.port || (project.environments || [])[0]?.port || 3000)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md h-7 px-2 gap-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">{t('surf.open')}</span>
              </a></TooltipTrigger><TooltipContent>{t('surf.openInBrowser')}</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Re-fetch Environments — surfaced prominently when the project
                has no environments and is stranded in an unstartable state.
                Skipped for remote projects (analyze runs on the host machine). */}
            {totalEnvs === 0 && onReanalyze && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 px-2.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer gap-1.5 text-[11px] font-medium transition-colors" onClick={() => onReanalyze(project)}>
                <RefreshCw className="h-3 w-3" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.refetchEnv')}</span>
              </button></TooltipTrigger><TooltipContent>{t('surf.refetchEnvHint')}</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button. Hidden when
                there are zero environments (the Re-fetch button above takes that slot). */}
            {(project.environments || []).some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" disabled={projectBusy} className="inline-flex items-center justify-center rounded-md h-7 px-2.5 border border-zinc-200 dark:border-zinc-700 bg-card hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50/60 dark:hover:bg-red-950/30 cursor-pointer gap-1.5 text-zinc-600 dark:text-zinc-300 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.stopAll')}</span>
              </button></TooltipTrigger><TooltipContent>{projectBusy ? t('card.busyTooltip') : t('card.stopAllRunning')}</TooltipContent></Tooltip></TooltipProvider>
            ) : totalEnvs > 0 ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" disabled={projectBusy} className="inline-flex items-center justify-center rounded-md h-7 px-2.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer gap-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">{t('surf.startAll')}</span>
              </button></TooltipTrigger><TooltipContent>{projectBusy ? t('card.busyTooltip') : t('card.startAllStopped')}</TooltipContent></Tooltip></TooltipProvider>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"><MoreVertical className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.editProject')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.viewDetails')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate?.(project.id)} className="px-2.5 py-2 text-sm rounded-md"><Copy className="h-3.5 w-3.5 mr-2.5" />{t('surf.duplicate')}</DropdownMenuItem>
                {!project.deviceId && onMoveToDevice && (
                  <DropdownMenuItem onClick={() => onMoveToDevice(project)} className="px-2.5 py-2 text-sm rounded-md"><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />{t('surf.moveToDevice')}</DropdownMenuItem>
                )}
                {onReanalyze && (
                  <DropdownMenuItem onClick={() => onReanalyze(project)} className="px-2.5 py-2 text-sm rounded-md"><RefreshCw className="h-3.5 w-3.5 mr-2.5" />{t('surf.refetchEnvs')}</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {(project.environments || []).some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />{t('surf.copyProxy')}</DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={projectBusy} onClick={() => { if (projectBusy) return; (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />{t('surf.restartAll')}</DropdownMenuItem>
                <DropdownMenuItem disabled={projectBusy} onClick={() => { if (projectBusy) return; onRebuildConfirm(project) }} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />{t('surf.rebuildAll')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />{t('dlg.common.delete')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>
        </div>

      </motion.div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[220px] p-1.5 text-sm">
          {/* Actions section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">{t('card.ctx.actions')}</div>
          {(project.environments || []).some((e) => e.status === 'running') && (
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) window.open(getOpenUrl(port), '_blank') }}><ExternalLink className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.openBrowser')} <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">Enter</kbd></ContextMenuItem>
          )}
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onSelect(project)}><Eye className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.viewDetails')} <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">Enter</kbd></ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onEdit(project)}><Edit3 className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.editProject')} <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">e</kbd></ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onToggleStar(project.id)}>{starred ? <><PinOff className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.unpin')}</> : <><Pin className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.pinToTop')}</>}</ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onDuplicate?.(project.id)}><Copy className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.duplicate')}</ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { navigator.clipboard.writeText(project.path); addToast({ title: t('dlg.toast.pathCopied'), variant: 'success' }) }}><Clipboard className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.copyPath')}</ContextMenuItem>
          <ContextMenuSeparator />
          {/* Environment section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">{t('card.ctx.environment')}</div>
          {(project.environments || []).every((e) => e.status !== 'running') && (
            <ContextMenuItem disabled={projectBusy} className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { if (projectBusy) return; (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'start')) }}><Play className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.startAll')} <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">s</kbd></ContextMenuItem>
          )}
          {(project.environments || []).some((e) => e.status === 'running') && (
            <ContextMenuItem disabled={projectBusy} className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { if (projectBusy) return; (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}><Square className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.stopAll')} <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">x</kbd></ContextMenuItem>
          )}
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onCompare?.(project)}><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.compare')}</ContextMenuItem>
          <ContextMenuSeparator />
          {/* Dangerous section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-red-500/60 uppercase tracking-wider">{t('card.ctx.dangerous')}</div>
          <ContextMenuItem variant="destructive" className="px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />{t('card.ctx.delete')} <kbd className="ml-auto text-[9px] text-red-400/60 bg-red-50 dark:bg-red-900/20 px-1 rounded">Del</kbd></ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
    </ProjectQuickPreview>
  )
}

// Memoized so that unrelated parent re-renders (hover tracking, timers,
// toast churn, …) don't re-render every card — this also keeps drag-start
// smooth. Props are stable callbacks / primitives; `project` objects keep
// their identity between polls unless data actually changes.
const SortableProjectCard = React.memo(SortableProjectCardImpl)

// ======================== COMMAND PALETTE ========================

function CommandPalette({
  open, onClose, projects, onSelectProject, onAddProject, onRefresh, onToggleView,
  devices, onOpenDeviceManagement, onFilterByDevice
}: {
  open: boolean
  onClose: () => void
  projects: Project[]
  onSelectProject: (p: Project) => void
  onAddProject: () => void
  onRefresh: () => void
  onToggleView: () => void
  devices: Device[]
  onOpenDeviceManagement: () => void
  onFilterByDevice: (deviceId: string | null) => void
}) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Focus input when dialog opens (key on parent resets this component)
  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  const commands = [
    { id: 'add', label: t('dlg.cmd.addProject'), icon: Plus, category: t('dlg.cmd.catActions'), action: onAddProject, shortcut: '⌘N' },
    { id: 'refresh', label: t('dlg.cmd.refresh'), icon: RefreshCw, category: t('dlg.cmd.catActions'), action: onRefresh, shortcut: '⌘⇧R' },
    { id: 'toggle-view', label: t('dlg.cmd.toggleView'), icon: LayoutGrid, category: t('dlg.cmd.catActions'), action: onToggleView, shortcut: 'G G/L' },
    { id: 'gateway', label: t('dlg.cmd.gateway'), icon: Server, category: t('dlg.cmd.catActions'), action: () => {}, shortcut: '' },
    { id: 'llm', label: t('dlg.cmd.llm'), icon: Bot, category: t('dlg.cmd.catActions'), action: () => {}, shortcut: '' },
    { id: 'device-mgmt', label: t('dlg.cmd.deviceMgmt'), icon: Monitor, category: t('dlg.cmd.catActions'), action: onOpenDeviceManagement, shortcut: '⌘D' },
  ]

  const projectItems = projects.map((p) => ({
    id: `project-${p.id}`,
    label: p.name,
    icon: Folder,
    category: t('dlg.cmd.catProjects'),
    action: () => onSelectProject(p),
  }))

  const deviceItems = [
    ...devices.map((d) => [
      {
        id: `device-health-${d.id}`,
        label: t('dlg.cmd.checkHealth', { name: d.name }),
        icon: Activity,
        category: t('dlg.cmd.catDevices'),
        action: () => {
          fetch(`http://${d.ip}:${d.port}/api/agent/health`, {
            headers: { 'Authorization': `Bearer ${d.apiKey}` },
          })
            .then((r) => addToast({ title: r.ok ? t('dlg.cmd.deviceOnline', { name: d.name }) : t('dlg.cmd.deviceOffline', { name: d.name }), variant: r.ok ? 'success' : 'destructive' }))
            .catch(() => addToast({ title: t('dlg.cmd.deviceUnreachable', { name: d.name }), variant: 'destructive' }))
        },
      },
      {
        id: `device-filter-${d.id}`,
        label: t('dlg.cmd.filterBy', { name: d.name }),
        icon: Filter,
        category: t('dlg.cmd.catDevices'),
        action: () => onFilterByDevice(d.id),
      },
    ]).flat(),
  ]

  const allItems = [...commands, ...projectItems, ...deviceItems]
  const filtered = query.trim()
    ? allItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    : allItems

  const categories = Array.from(new Set(filtered.map((i) => i.category)))

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <div className="flex items-center border-b px-3">
          <Search className="h-4 w-4 mr-2 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('dlg.cmd.placeholder')}
            className="flex-1 py-3 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">ESC</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('dlg.cmd.noResults')}</div>
          )}
          {categories.map((cat) => (
            <div key={cat}>
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{cat}</div>
              {filtered.filter((i) => i.category === cat).map((item) => (
                <button
                  key={item.id}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent transition-colors text-left"
                  onClick={() => { item.action(); onClose(); }}
                >
                  <item.icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {'shortcut' in item && (item as { shortcut?: string }).shortcut && (
                    <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono shrink-0">{(item as { shortcut: string }).shortcut}</kbd>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ======================== KEYBOARD SHORTCUTS DIALOG ========================

function KeyboardShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const shortcuts = [
    { keys: '⌘/Ctrl + K', description: t('dlg.shortcuts.focusSearch') },
    { keys: '⌘/Ctrl + N', description: t('dlg.shortcuts.addProject') },
    { keys: '⌘/Ctrl + Shift + A', description: t('dlg.shortcuts.addProjectGlobal') },
    { keys: '⌘/Ctrl + Shift + R', description: t('dlg.shortcuts.refreshData') },
    { keys: '⌘/Ctrl + P', description: t('dlg.shortcuts.commandPalette') },
    { keys: '⌘/Ctrl + D', description: t('dlg.shortcuts.deviceMgmt') },
    { keys: 'G then G', description: t('dlg.shortcuts.gridView') },
    { keys: 'G then L', description: t('dlg.shortcuts.listView') },
    { keys: '↑ / ↓', description: t('dlg.shortcuts.navigateCards') },
    { keys: 'Home / End', description: t('dlg.shortcuts.firstLast') },
    { keys: 'Enter', description: t('dlg.shortcuts.openDetails') },
    { keys: 'e', description: t('dlg.shortcuts.editProject') },
    { keys: 's', description: t('dlg.shortcuts.startEnvs') },
    { keys: 'x', description: t('dlg.shortcuts.stopEnvs') },
    { keys: 'Delete', description: t('dlg.shortcuts.deleteProject') },
    { keys: 'Escape', description: t('dlg.shortcuts.closeDialog') },
    { keys: '?', description: t('dlg.shortcuts.showShortcuts') },
  ]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dlg.shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('dlg.shortcuts.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div key={s.keys} className="flex items-center justify-between py-1">
              <span className="text-sm">{s.description}</span>
              <kbd className="inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ======================== NOTIFICATION DETAIL DIALOG ========================

function NotificationDetailDialog({
  notification, open, onClose
}: {
  notification: Notification | null
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  if (!notification) return null
  const iconMap = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info }
  const colorMap = {
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    error: 'text-red-500',
    info: 'text-cyan-500',
  }
  const Icon = iconMap[notification.type]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={`h-5 w-5 ${colorMap[notification.type]}`} />
            {notification.title}
          </DialogTitle>
          <DialogDescription>{notification.message}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.notifDetail.type')}</span><Badge variant="outline" className="capitalize">{t(`dlg.notifDetail.type.${notification.type}` as Parameters<typeof t>[0])}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.notifDetail.time')}</span><span>{new Date(notification.timestamp).toLocaleString()}</span></div>
          {notification.projectName && (
            <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.notifDetail.project')}</span><span>{notification.projectName}</span></div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.notifDetail.status')}</span><Badge variant={notification.read ? 'secondary' : 'default'}>{notification.read ? t('dlg.notifDetail.read') : t('dlg.notifDetail.unread')}</Badge></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ======================== TOAST CONTAINER ========================

function ToastContainer() {
  const { toasts, dismiss } = useToast()
  const variantColor = (v?: string) => {
    if (v === 'success') return 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/50'
    if (v === 'destructive') return 'border-red-500 bg-red-50 dark:bg-red-950/50'
    return 'border-border bg-card'
  }
  return (
    <div className="fixed bottom-16 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 50, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.95 }}
            className={`rounded-lg border p-3 shadow-lg ${variantColor(toast.variant)}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{toast.title}</p>
                {toast.description && <p className="text-xs text-muted-foreground mt-0.5">{toast.description}</p>}
              </div>
              <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => dismiss(toast.id)}><X className="h-3 w-3" /></Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// ======================== PROJECT FORM DIALOG ========================

function ProjectFormDialog({
  open, onClose, onSubmit, project, mode, devices
}: {
  open: boolean
  onClose: () => void
  onSubmit: (data: { name: string; path: string; description: string; icon: string; tags: string[]; deviceId: string | null }) => void
  project?: Project | null
  mode: 'add' | 'edit'
  devices: Device[]
}) {
  const t = useT()
  // Initialize from props - key on parent component resets this when dialog opens
  const [name, setName] = React.useState(() => mode === 'edit' && project ? project.name : '')
  const [path, setPath] = React.useState(() => mode === 'edit' && project ? project.path : '')
  const [description, setDescription] = React.useState(() => mode === 'edit' && project ? project.description : '')
  const [icon, setIcon] = React.useState(() => mode === 'edit' && project ? project.icon : 'folder')
  const [selectedTags, setSelectedTags] = React.useState<string[]>(() => mode === 'edit' && project ? parseTags(project.tags) : [])
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(() => mode === 'edit' && project ? (project.deviceId || null) : null)

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !path.trim()) return
    onSubmit({ name: name.trim(), path: path.trim(), description: description.trim(), icon, tags: selectedTags, deviceId: selectedDeviceId })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md flex flex-col p-0 max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>{mode === 'add' ? t('dlg.projectForm.addTitle') : t('dlg.projectForm.editTitle')}</DialogTitle>
          <DialogDescription>{mode === 'add' ? t('dlg.projectForm.addDesc') : t('dlg.projectForm.editDesc')}</DialogDescription>
        </DialogHeader>
        <form id="project-form" onSubmit={handleSubmit} className="space-y-3 px-6 pb-6 overflow-y-auto flex-1 min-h-0">
          {/* Templates - only shown when adding a new project */}
          {mode === 'add' && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5"><LayoutTemplate className="h-3.5 w-3.5" />{t('dlg.projectForm.templates')}</Label>
              <div className="grid grid-cols-5 gap-1.5">
                {([
                  { label: t('dlg.projectForm.tpl.web'), icon: Globe, tpl: { name: 'Web App', icon: 'globe', tags: ['Frontend', 'Fullstack'], description: t('dlg.projectForm.tpl.webDesc') } },
                  { label: t('dlg.projectForm.tpl.api'), icon: Server, tpl: { name: 'API Server', icon: 'server', tags: ['Backend', 'API'], description: t('dlg.projectForm.tpl.apiDesc') } },
                  { label: t('dlg.projectForm.tpl.ml'), icon: CpuIcon, tpl: { name: 'ML Project', icon: 'cpu', tags: ['ML/AI', 'Backend'], description: t('dlg.projectForm.tpl.mlDesc') } },
                  { label: t('dlg.projectForm.tpl.mobile'), icon: Smartphone, tpl: { name: 'Mobile App', icon: 'smartphone', tags: ['Mobile', 'Fullstack'], description: t('dlg.projectForm.tpl.mobileDesc') } },
                  { label: t('dlg.projectForm.tpl.devops'), icon: Terminal, tpl: { name: 'DevOps', icon: 'terminal', tags: ['DevOps', 'Automation'], description: t('dlg.projectForm.tpl.devopsDesc') } },
                ] as const).map(({ label, icon: TplIcon, tpl }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => { setName(tpl.name); setIcon(tpl.icon); setSelectedTags([...tpl.tags]); setDescription(tpl.description) }}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all duration-150 hover:bg-accent/50 cursor-pointer border-border hover:border-muted-foreground/30"
                  >
                    <TplIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[10px] leading-tight text-muted-foreground">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="proj-name">{t('dlg.projectForm.name')}</Label>
            <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('dlg.projectForm.namePlaceholder')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proj-path">{t('dlg.projectForm.path')}</Label>
            <Input id="proj-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/user/projects/my-project" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proj-desc">{t('dlg.projectForm.description')}</Label>
            <Textarea id="proj-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('dlg.projectForm.descPlaceholder')} rows={2} />
          </div>
          <div className="space-y-1">
            <Label>{t('dlg.projectForm.icon')}</Label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(ICON_MAP).map(([key, Ic]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all duration-150 hover:bg-accent/50 cursor-pointer ${
                    icon === key
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 ring-2 ring-emerald-500/30 shadow-sm shadow-emerald-500/20'
                      : 'border-border hover:border-muted-foreground/30'
                  }`}
                >
                  <Ic className={`h-5 w-5 ${icon === key ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                  <span className={`text-[10px] leading-tight ${icon === key ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground'}`}>
                    {key.replace('-', ' ')}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('dlg.projectForm.tags')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {TAG_OPTIONS.map((tag) => (
                <button
                  key={tag.name}
                  type="button"
                  onClick={() => toggleTag(tag.name)}
                  className={`px-2 py-0.5 rounded-full text-xs transition-colors border ${selectedTags.includes(tag.name) ? tag.color + ' border-current/20' : 'border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('dlg.projectForm.device')}</Label>
            <Select value={selectedDeviceId ?? 'local'} onValueChange={(v) => setSelectedDeviceId(v === 'local' ? null : v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('dlg.common.thisMachine')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t('dlg.common.thisMachine')}</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    <span className="inline-flex items-center gap-2">
                      <CircleDot className={`h-3 w-3 ${device.status === 'online' ? 'text-emerald-500 fill-emerald-500' : 'text-red-400 fill-red-400'}`} />
                      {device.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </form>
        <DialogFooter className="px-6 pt-4 pb-6 border-t shrink-0 bg-background">
          <Button type="button" variant="outline" onClick={onClose}>{t('dlg.common.cancel')}</Button>
          <Button type="submit" form="project-form" disabled={!name.trim() || !path.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleSubmit}>
            {mode === 'add' ? t('dlg.common.create') : t('dlg.common.update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ======================== ENVIRONMENT FORM DIALOG ========================

function EnvFormDialog({
  open, onClose, onSubmit, env, mode
}: {
  open: boolean
  onClose: () => void
  onSubmit: (data: { name: string; cmd: string; port: number; envVars: Record<string, string> }) => void
  env?: Environment | null
  mode: 'add' | 'edit'
}) {
  const t = useT()
  // Initialize from props - key on parent component resets this when dialog opens
  const [name, setName] = React.useState(() => mode === 'edit' && env ? env.name : '')
  const [cmd, setCmd] = React.useState(() => mode === 'edit' && env ? env.cmd : '')
  const [port, setPort] = React.useState(() => mode === 'edit' && env ? String(env.port) : '3000')
  const [envVars, setEnvVars] = React.useState<Record<string, string>>(() => mode === 'edit' && env ? parseEnvVars(env.envVars) : {})
  const [newKey, setNewKey] = React.useState('')
  const [newVal, setNewVal] = React.useState('')

  const addEnvVar = () => {
    if (newKey.trim()) {
      setEnvVars((prev) => ({ ...prev, [newKey.trim()]: newVal.trim() }))
      setNewKey('')
      setNewVal('')
    }
  }

  const removeEnvVar = (key: string) => {
    setEnvVars((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !cmd.trim() || !port) return
    onSubmit({ name: name.trim(), cmd: cmd.trim(), port: parseInt(port), envVars })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? t('dlg.envForm.addTitle') : t('dlg.envForm.editTitle')}</DialogTitle>
          <DialogDescription>{mode === 'add' ? t('dlg.envForm.addDesc') : t('dlg.envForm.editDesc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="env-name">{t('dlg.envForm.name')}</Label>
            <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="development" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-cmd">{t('dlg.envForm.cmd')}</Label>
            <Input id="env-cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm run dev" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-port">{t('dlg.envForm.port')}</Label>
            <Input id="env-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" />
          </div>
          <div className="space-y-2">
            <Label>{t('dlg.envForm.envVars')}</Label>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {Object.entries(envVars).map(([key, val]) => (
                <div key={key} className="flex items-center gap-1">
                  <Input value={key} readOnly className="h-7 text-xs flex-1 font-mono" />
                  <Input value={val} readOnly className="h-7 text-xs flex-1 font-mono" />
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removeEnvVar(key)}><X className="h-3 w-3" /></Button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="KEY" className="h-7 text-xs font-mono flex-1" />
              <Input value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="value" className="h-7 text-xs font-mono flex-1" />
              <Button type="button" variant="outline" size="icon" className="h-7 w-7 shrink-0" onClick={addEnvVar}><Plus className="h-3 w-3" /></Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('dlg.common.cancel')}</Button>
            <Button type="submit" disabled={!name.trim() || !cmd.trim() || !port} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {mode === 'add' ? t('dlg.common.create') : t('dlg.common.update')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ======================== SYSTEM MONITOR DIALOG ========================

function CircularGauge({ value, size = 100, label, color = '#10b981' }: { value: number; size?: number; label: string; color?: string }) {
  const strokeWidth = 6
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const safeValue = typeof value === 'number' && !isNaN(value) ? Math.min(Math.max(value, 0), 100) : 0
  const offset = circumference - (safeValue / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-1">
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted-foreground/15" />
          <motion.circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={circumference}
            strokeLinecap="round"
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: size,
            height: size,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <span className="text-xl font-bold tabular-nums leading-none" style={{ color }}>{safeValue}</span>
          <span className="text-[9px] text-muted-foreground font-medium leading-none mt-0.5">%</span>
        </div>
      </div>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  )
}

function SystemMonitorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [status, setStatus] = React.useState<GatewayStatus | null>(null)
  const [networkInfo, setNetworkInfo] = React.useState<{ hostname: string; platform: string; arch: string; cpus: number } | null>(null)
  const [runningServices, setRunningServices] = React.useState<Array<{ name: string; port: number; pid: number | null; device: string }>>([])
  const [loading, setLoading] = React.useState(false)

  const fetchStatus = React.useCallback(async () => {
    setLoading(true)
    try {
      // /api/projects is NOT re-fetched here (it can trigger a remote-device
      // sync server-side — heavy). The dashboard already publishes the fresh
      // project list on every change via window.__dashboardProjects; the
      // 10s interval in this dialog re-reads that snapshot instead.
      const [statusRes, netRes] = await Promise.all([
        fetch('/api/gateway/status'),
        fetch('/api/network-info'),
      ])
      if (statusRes.ok) setStatus(await statusRes.json())
      if (netRes.ok) setNetworkInfo(await netRes.json())
      const projs = ((window as unknown as { __dashboardProjects?: Project[] }).__dashboardProjects ?? []) as Project[]
      const svc: Array<{ name: string; port: number; pid: number | null; device: string }> = []
      for (const p of projs) {
        for (const e of p.environments || []) {
          if (e.status === 'running') {
            svc.push({ name: `${p.name} · ${e.name === 'development' ? 'dev' : e.name}`, port: e.port, pid: e.pid ?? null, device: p.deviceName || 'local' })
          }
        }
      }
      setRunningServices(svc)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => { fetchStatus() })
    const interval = setInterval(fetchStatus, 10000)
    return () => { cancelAnimationFrame(id); clearInterval(interval) }
  }, [open, fetchStatus])

  const cpuColor = (v: number) => v >= 80 ? '#ef4444' : v >= 50 ? '#f59e0b' : '#10b981'
  const memColor = (v: number) => v >= 80 ? '#ef4444' : v >= 50 ? '#f59e0b' : '#10b981'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-emerald-600" />
            {t('dlg.systemMonitor.title')}
          </DialogTitle>
          <DialogDescription>{t('dlg.systemMonitor.desc')}</DialogDescription>
        </DialogHeader>
        {loading && !status ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : status ? (
          <div className="space-y-5">
            {/* CPU & Memory gauges */}
            <div className="grid grid-cols-2 gap-6">
              <div className="p-4 rounded-xl border bg-gradient-to-br from-amber-50/50 to-orange-50/30 dark:from-amber-950/20 dark:to-orange-950/10">
                <div className="flex items-center gap-2 mb-3">
                  <Gauge className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-semibold">{t('dlg.systemMonitor.cpuUsage')}</span>
                </div>
                <div className="flex items-center justify-center">
                  <CircularGauge value={status.cpuUsage.percentage} size={88} label={t('dlg.systemMonitor.cpu')} color={cpuColor(status.cpuUsage.percentage)} />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between"><span>{t('dlg.systemMonitor.cores')}</span><span className="font-medium text-foreground">{status.cpuUsage.cores}</span></div>
                  <div className="flex justify-between"><span>{t('dlg.systemMonitor.loadAvg')}</span><span className="font-medium text-foreground font-mono">{status.cpuUsage.loadAverage.map((l) => l.toFixed(2)).join(', ')}</span></div>
                </div>
              </div>
              <div className="p-4 rounded-xl border bg-gradient-to-br from-teal-50/50 to-cyan-50/30 dark:from-teal-950/20 dark:to-cyan-950/10">
                <div className="flex items-center gap-2 mb-3">
                  <MemoryStick className="h-4 w-4 text-teal-500" />
                  <span className="text-sm font-semibold">{t('dlg.systemMonitor.memUsage')}</span>
                </div>
                <div className="flex items-center justify-center">
                  <CircularGauge value={status.memoryUsage.percentage} size={88} label={t('dlg.systemMonitor.memory')} color={memColor(status.memoryUsage.percentage)} />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between"><span>{t('dlg.systemMonitor.usedTotal')}</span><span className="font-medium text-foreground">{status.memoryUsage.used}MB / {status.memoryUsage.total}MB</span></div>
                  <div className="flex justify-between"><span>{t('dlg.systemMonitor.processRss')}</span><span className="font-medium text-foreground">{status.processMemory?.rss ?? '—'} MB</span></div>
                </div>
              </div>
            </div>

            {/* Network info */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-cyan-50/50 to-sky-50/30 dark:from-cyan-950/20 dark:to-sky-950/10">
              <div className="flex items-center gap-2 mb-3">
                <Wifi className="h-4 w-4 text-cyan-500" />
                <span className="text-sm font-semibold">{t('dlg.systemMonitor.network')}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.hostname')}</span><span className="font-medium">{networkInfo?.hostname ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.platform')}</span><span className="font-medium">{networkInfo?.platform ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.architecture')}</span><span className="font-medium">{networkInfo?.arch ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.gateway')}</span><span className="font-medium">:{status.gatewayPort}</span></div>
              </div>
            </div>

            {/* Uptime */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-emerald-50/50 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold">{t('dlg.systemMonitor.uptime')}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.gateway')}</span><span className="font-medium">{status.uptime}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('dlg.systemMonitor.system')}</span><span className="font-medium">{status.systemUptime}</span></div>
              </div>
            </div>

            {/* Services — real running environments across local + remote devices */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-emerald-50/50 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10">
              <div className="flex items-center gap-2 mb-2">
                <Server className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold">{t('dlg.systemMonitor.services')}</span>
                <Badge variant="secondary" className="text-[10px] ml-auto">{t('dlg.systemMonitor.servicesCount', { count: runningServices.length })}</Badge>
              </div>
              <div className="space-y-1.5">
                {runningServices.length === 0 && (
                  <div className="text-xs text-muted-foreground py-2">{t('dlg.systemMonitor.noServices')}</div>
                )}
                {runningServices.map((svc) => (
                  <div key={`${svc.device}-${svc.name}`} className="flex items-center justify-between p-2 rounded border text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="font-medium truncate">{svc.name}</span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{svc.device}</span>
                    </div>
                    <div className="flex items-center gap-3 text-muted-foreground shrink-0">
                      {svc.port > 0 && <span>:{svc.port}</span>}
                      {svc.pid != null && <span>PID {svc.pid}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Disk Usage (real data from df) */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-violet-50/50 to-purple-50/30 dark:from-violet-950/20 dark:to-purple-950/10">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="h-4 w-4 text-violet-500" />
                <span className="text-sm font-semibold">{t('dlg.systemMonitor.diskUsage')}</span>
              </div>
              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{t('dlg.systemMonitor.usage')}</span>
                    <span className="font-medium">{status.diskUsage?.percentage ?? 0}%</span>
                  </div>
                  <Progress value={status.diskUsage?.percentage ?? 0} className="h-2" />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{t('dlg.systemMonitor.used', { used: status.diskUsage?.used ?? 0, total: status.diskUsage?.total ?? 0 })}</span>
                  <span>{t('dlg.systemMonitor.free', { count: status.diskUsage?.free ?? 0 })}</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={fetchStatus}><RefreshCw className="h-3.5 w-3.5 mr-1" />{t('dlg.common.refresh')}</Button>
              <span className="text-[10px] text-muted-foreground">{t('dlg.systemMonitor.lastChecked', { time: formatTimeAgo(status.lastChecked, t) })}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">{t('dlg.systemMonitor.loadFailed')}</div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ======================== PORTS PANEL (live port occupancy + kill) ========================

interface PortRow {
  port: number
  pid: number | null
  processName: string
  command: string
  self: boolean
  reserved: boolean
  owner: { projectId: string; projectName: string; envId: string; envName: string; remote: boolean } | null
}

function PortsPanel({ open, onClose, onKilled }: { open: boolean; onClose: () => void; onKilled?: () => void }) {
  const t = useT()
  const [rows, setRows] = React.useState<PortRow[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [killingPid, setKillingPid] = React.useState<number | null>(null)
  const [confirmPid, setConfirmPid] = React.useState<PortRow | null>(null)
  const [lastRefresh, setLastRefresh] = React.useState<number | null>(null)

  const fetchPorts = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ports', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setRows(Array.isArray(data.ports) ? data.ports : [])
        setLastRefresh(Date.now())
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  // Live refresh: immediately on open, then every 3s while the panel is open.
  // The interval also catches processes the user starts/kills OUTSIDE the
  // dashboard (terminal, another tool) — that is the point of the panel.
  React.useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => { fetchPorts() })
    const interval = setInterval(fetchPorts, 3000)
    return () => { cancelAnimationFrame(raf); clearInterval(interval) }
  }, [open, fetchPorts])

  const doKill = React.useCallback(async (row: PortRow) => {
    if (row.pid == null) return
    setKillingPid(row.pid)
    try {
      const res = await fetch('/api/ports/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: row.pid }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        addToast({ title: t('ports.killOk'), description: t('ports.killOkDesc', { port: row.port, pid: row.pid }), variant: 'success' })
        onKilled?.()
        fetchPorts()
      } else {
        addToast({ title: t('ports.killFailed'), description: data.error || '', variant: 'destructive' })
      }
    } catch {
      addToast({ title: t('ports.killFailed'), variant: 'destructive' })
    }
    setKillingPid(null)
    setConfirmPid(null)
  }, [t, fetchPorts, onKilled])

  const filtered = React.useMemo(() => {
    if (!rows) return []
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      String(r.port).includes(q) ||
      String(r.pid ?? '').includes(q) ||
      r.processName.toLowerCase().includes(q) ||
      r.command.toLowerCase().includes(q) ||
      (r.owner ? `${r.owner.projectName} ${r.owner.envName}`.toLowerCase().includes(q) : false)
    )
  }, [rows, filter])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-5 w-5 text-teal-600" />
            {t('ports.title')}
            {rows && <Badge variant="secondary" className="text-[10px] ml-1">{t('ports.count', { count: rows.length })}</Badge>}
          </DialogTitle>
          <DialogDescription>{t('ports.desc')}</DialogDescription>
        </DialogHeader>

        {/* Toolbar: search + manual refresh + live indicator */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('ports.search')}
              className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Button variant="outline" size="sm" className="h-8" onClick={fetchPorts} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-60 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
            </span>
            {lastRefresh ? t('ports.liveUpdated', { seconds: Math.max(0, Math.round((Date.now() - lastRefresh) / 1000)) }) : t('ports.live')}
          </span>
        </div>

        {/* Port table */}
        <div className="min-h-[200px] flex-1 overflow-y-auto rounded-lg border">
          {rows == null ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-600" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground">{filter ? t('ports.noMatch') : t('ports.empty')}</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-muted/80 dark:bg-zinc-900/90 backdrop-blur">
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium w-[74px]">{t('ports.colPort')}</th>
                  <th className="px-3 py-2 font-medium w-[84px]">{t('ports.colPid')}</th>
                  <th className="px-3 py-2 font-medium">{t('ports.colProcess')}</th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">{t('ports.colOwner')}</th>
                  <th className="px-3 py-2 font-medium w-[80px] text-right">{t('ports.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const selfRow = r.self || r.reserved
                  const killable = !selfRow && r.pid != null
                  return (
                    <tr key={`${r.port}-${r.pid ?? 'x'}`} className="border-t border-border/60 hover:bg-accent/40 transition-colors">
                      <td className="px-3 py-2">
                        <span className={`font-mono font-semibold ${selfRow ? 'text-amber-600 dark:text-amber-400' : 'text-teal-600 dark:text-teal-400'}`}>:{r.port}</span>
                        {r.reserved && <LockIcon className="inline ml-1 h-3 w-3 text-amber-500" />}
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{r.pid ?? '—'}</td>
                      <td className="px-3 py-2 max-w-[260px]">
                        <div className="truncate font-medium" title={r.command || r.processName}>{r.processName || t('ports.unknownProc')}</div>
                        {r.command && <div className="truncate text-[10px] text-muted-foreground" title={r.command}>{r.command}</div>}
                      </td>
                      <td className="px-3 py-2 hidden md:table-cell">
                        {r.owner ? (
                          <span className={`inline-flex items-center gap-1 ${r.owner.remote ? 'text-violet-600 dark:text-violet-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {r.owner.projectName} · {r.owner.envName}{r.owner.remote ? ' (remote)' : ''}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t('ports.unowned')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {selfRow ? (
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><span className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/50"><Ban className="h-3.5 w-3.5" /></span></TooltipTrigger><TooltipContent>{t('ports.protected')}</TooltipContent></Tooltip></TooltipProvider>
                        ) : killable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                            disabled={killingPid != null}
                            onClick={() => setConfirmPid(r)}
                          >
                            {killingPid === r.pid ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" />}
                            <span className="ml-1 hidden sm:inline">{t('ports.kill')}</span>
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{t('ports.noPid')}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter className="text-[10px] text-muted-foreground sm:justify-between">
          <span>{t('ports.footerNote')}</span>
          <Button variant="outline" size="sm" onClick={onClose}>{t('dlg.common.close')}</Button>
        </DialogFooter>
      </DialogContent>

      {/* Kill confirmation */}
      <AlertDialog open={confirmPid != null} onOpenChange={(v) => !v && setConfirmPid(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />{t('ports.killConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmPid && t('ports.killConfirmDesc', { port: confirmPid.port, pid: confirmPid.pid ?? '?', name: confirmPid.processName || confirmPid.command.slice(0, 40) || '?' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmPid(null)}>{t('dlg.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => { e.preventDefault(); if (confirmPid) doKill(confirmPid) }}
            >
              {t('ports.kill')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

// ======================== LLM CONFIG DIALOG ========================

interface ProviderModelInfo { id: string; name: string }
interface ProviderCatalogInfo {
  id: string
  displayName: string
  label: string
  baseURL: string
  apiKeyEnv: string
  defaultModel: string
  models: ProviderModelInfo[]
  requiresKey: boolean
  docsUrl: string
}

function LlmConfigDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [provider, setProvider] = React.useState('zai')
  const [apiKey, setApiKey] = React.useState('')
  const [keyMask, setKeyMask] = React.useState('')
  const [hasApiKey, setHasApiKey] = React.useState(false)
  const [savedProvider, setSavedProvider] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [catalog, setCatalog] = React.useState<ProviderCatalogInfo[]>([])
  const [models, setModels] = React.useState<ProviderModelInfo[]>([])
  const [modelsLive, setModelsLive] = React.useState(false)
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [modelNote, setModelNote] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const { toast } = useToast()

  const activeProfile = React.useMemo(() => catalog.find((p) => p.id === provider), [catalog, provider])

  // The GET response only ever carries a masked key (••••xxxx). While the
  // input still shows that mask, the real key stays server-side; live model
  // fetches use useSavedKey=1 instead of round-tripping the secret.
  const keyUnchanged = !!keyMask && apiKey === keyMask
  const savedKeyUsable = hasApiKey && keyUnchanged && provider === savedProvider

  const fetchModels = React.useCallback(async (prov: string, key: string, base: string, useSavedKey = false) => {
    if (!prov) return
    setFetchingModels(true)
    try {
      const params = new URLSearchParams({ provider: prov })
      if (key) params.set('apiKey', key)
      if (useSavedKey) params.set('useSavedKey', '1')
      if (base) params.set('baseUrl', base)
      const r = await fetch(`/api/llm-config/models?${params.toString()}`)
      const data = await r.json()
      if (Array.isArray(data.models) && data.models.length > 0) {
        setModels(data.models)
        setModelsLive(!!data.live)
        setModelNote(data.live
          ? t('dlg.llm.modelsLive', { count: data.models.length })
          : (data.warning || data.error || data.note || t('dlg.llm.modelsCatalog')))
      } else {
        setModels([])
        setModelsLive(false)
        setModelNote(data.error || data.warning || t('dlg.llm.noModels'))
      }
    } catch {
      setModelNote(t('dlg.llm.fetchFailed'))
    } finally {
      setFetchingModels(false)
    }
  }, [t])

  React.useEffect(() => {
    if (open) {
      // Use requestAnimationFrame to avoid synchronous setState in effect
      const id = requestAnimationFrame(() => {
        setLoading(true)
        fetch('/api/llm-config')
          .then((r) => r.json())
          .then((data) => {
            setProvider(data.provider || 'zai')
            setSavedProvider(data.provider || 'zai')
            setApiKey(data.apiKey || '')
            setKeyMask(data.apiKey || '')
            setHasApiKey(!!data.hasApiKey)
            setBaseUrl(data.baseUrl || '')
            setModel(data.model || '')
            if (Array.isArray(data.catalog)) {
              setCatalog(data.catalog)
              const profile = (data.catalog as ProviderCatalogInfo[]).find((p) => p.id === (data.provider || 'zai'))
              setModels(profile?.models ?? [])
            }
            // Live-fetch with the server-side key when one is saved (the
            // secret never reaches the browser), else fall back to catalog.
            if (data.hasApiKey && data.provider && data.provider !== 'zai') {
              void fetchModels(data.provider, '', data.baseUrl || '', true)
            } else {
              void fetchModels(data.provider || 'zai', '', data.baseUrl || '')
            }
          })
          .catch(() => {})
          .finally(() => setLoading(false))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [open, fetchModels])

  const handleProviderChange = (id: string) => {
    setProvider(id)
    const profile = catalog.find((p) => p.id === id)
    setBaseUrl(profile?.baseURL || '')
    setModel('')
    setModels(profile?.models ?? [])
    setModelsLive(false)
    setModelNote('')
    // live-fetch immediately when a real (typed) key is filled or no key is needed
    const needsKey = profile?.requiresKey ?? true
    if (apiKey && !keyUnchanged) {
      void fetchModels(id, apiKey, profile?.baseURL || '')
    } else if (savedKeyUsable && id === savedProvider) {
      void fetchModels(id, '', profile?.baseURL || '', true)
    } else if (!needsKey) {
      void fetchModels(id, '', profile?.baseURL || '')
    } else if (needsKey && !apiKey) {
      setModelNote(t('dlg.llm.keyHint'))
    } else if (needsKey && keyUnchanged && id !== savedProvider) {
      setModelNote(t('dlg.llm.keyOtherProvider'))
    }
  }

  // Debounced live model fetch once a NEW API key is typed (pdb-tracker pattern).
  // An untouched masked key resolves server-side via useSavedKey instead.
  React.useEffect(() => {
    if (!open || provider === 'zai' || !catalog.length) return
    if (apiKey && !keyUnchanged) {
      const t = setTimeout(() => { void fetchModels(provider, apiKey, baseUrl) }, 900)
      return () => clearTimeout(t)
    }
  }, [apiKey, open])

  const handleSave = async () => {
    setSaving(true)
    try {
      // Only send the key when it actually changed — an untouched masked
      // value round-trips as "undefined" so the server keeps the secret.
      const body: Record<string, unknown> = { provider, baseUrl, model }
      if (!keyUnchanged) body.apiKey = apiKey
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: t('dlg.llm.savedToast'), description: t('dlg.llm.savedToastDesc'), variant: 'success' })
        onClose()
      }
    } catch {
      toast({ title: t('dlg.llm.saveFailed'), variant: 'destructive' })
    }
    setSaving(false)
  }

  const isZai = provider === 'zai'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-emerald-600" />
            {t('dlg.llm.title')}
          </DialogTitle>
          <DialogDescription>{t('dlg.llm.desc')}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : (
          <div className="space-y-3.5">
            <div className="space-y-1">
              <Label>{t('dlg.llm.provider')}</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger><SelectValue placeholder={t('dlg.llm.providerPlaceholder')} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {catalog.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mr-2">{p.label}</span>
                      {p.displayName}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">
                    <span className="font-mono text-[10px] font-bold text-muted-foreground mr-2">CU</span>
                    {t('dlg.llm.custom')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isZai && (
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-950/20 p-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
                <Sparkles className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  {t('dlg.llm.zaiHintBefore')} <span className="font-semibold">{t('dlg.llm.zaiHintNoKey')}</span>{t('dlg.llm.zaiHintAfter')}
                </div>
              </div>
            )}

            {!isZai && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label>{t('dlg.llm.apiKey')}</Label>
                  {activeProfile?.docsUrl && (
                    <a href={activeProfile.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline">
                      <KeyRound className="h-3 w-3" />{t('dlg.llm.getKey')}<ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasApiKey && keyUnchanged ? t('dlg.llm.savedKeyPlaceholder', { mask: keyMask }) : (activeProfile?.apiKeyEnv ? t('dlg.llm.keyEnvPlaceholder', { env: activeProfile.apiKeyEnv }) : 'sk-...')}
                />
              </div>
            )}

            {!isZai && (
              <div className="space-y-1">
                <Label>{t('dlg.llm.baseUrl')}</Label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={provider === 'custom' ? 'https://your-provider.com/v1' : activeProfile?.baseURL || 'https://api.openai.com/v1'}
                />
                {provider === 'custom' && <p className="text-[11px] text-muted-foreground">{t('dlg.llm.baseUrlHint')}</p>}
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>{t('dlg.llm.model')}</Label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-50"
                  onClick={() => fetchModels(provider, keyUnchanged ? '' : apiKey, baseUrl, savedKeyUsable)}
                  disabled={fetchingModels}
                >
                  {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {fetchingModels ? t('dlg.llm.fetching') : t('dlg.llm.fetchLive')}
                </button>
              </div>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={activeProfile?.defaultModel || t('dlg.llm.modelPlaceholder')}
                list="llm-model-options"
              />
              <datalist id="llm-model-options">
                {models.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
              </datalist>
              {models.length > 0 && (
                <div className="max-h-28 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
                  {models.slice(0, 60).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(m.id)}
                      className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors cursor-pointer ${model === m.id
                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-medium'
                        : 'border-border text-muted-foreground hover:border-emerald-300 hover:text-foreground'}`}
                      title={m.name}
                    >
                      {m.id}
                    </button>
                  ))}
                </div>
              )}
              {modelNote && (
                <p className={`text-[11px] ${modelsLive ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {modelsLive ? '✓ ' : ''}{modelNote}
                </p>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('dlg.common.cancel')}</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{t('dlg.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ======================== LLM AUTO-REPAIR DIALOG ========================

interface RepairStepInfo { ts: number; level: string; msg: string; round?: number }
interface RepairPendingApprovalInfo { cmd: string; ts: number; expiresAt: number }
interface RepairJobInfo {
  id: string
  projectId: string
  projectName: string
  envId: string
  envName: string
  kind: 'start' | 'rebuild'
  status: 'running' | 'success' | 'failed'
  steps: RepairStepInfo[]
  diagnosis?: string
  error?: string
  startedAt: number
  finishedAt?: number
  round: number
  maxRounds: number
  pendingApproval?: RepairPendingApprovalInfo | null
}

const REPAIR_LOG_STYLES: Record<string, string> = {
  info: 'text-zinc-500 dark:text-zinc-400',
  command: 'text-teal-600 dark:text-teal-300',
  output: 'text-zinc-400 dark:text-zinc-500 text-[11px] whitespace-pre-wrap',
  llm: 'text-violet-600 dark:text-violet-300',
  tool: 'text-cyan-700 dark:text-cyan-300',
  success: 'text-emerald-600 dark:text-emerald-400 font-medium',
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  approval: 'text-amber-600 dark:text-amber-300 font-medium',
  approved: 'text-emerald-600 dark:text-emerald-300',
  denied: 'text-zinc-400 dark:text-zinc-500',
}

function formatRepairClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function formatRepairDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function formatRepairCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function RepairDialog({ jobId, open, onOpenChange, onFinished, onApprovalNeeded, onJobUpdate }: {
  jobId: string | null
  /** Dialog visibility. The job keeps polling even while hidden (background
   *  mode) so approvals can wake the user and completion fires its toast. */
  open: boolean
  onOpenChange: (open: boolean) => void
  onFinished: (job: RepairJobInfo) => void
  /** Fired when the job pauses for a manual approval while the dialog is hidden. */
  onApprovalNeeded: () => void
  /** Latest job snapshot on every poll (lets the parent decide close semantics). */
  onJobUpdate?: (job: RepairJobInfo | null) => void
}) {
  const t = useT()
  const { toast } = useToast()
  const [job, setJob] = React.useState<RepairJobInfo | null>(null)
  const [notFound, setNotFound] = React.useState(false)
  const [responding, setResponding] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const finishedRef = React.useRef(false)
  const approvalNotifiedRef = React.useRef(false)
  const openRef = React.useRef(open)
  openRef.current = open

  React.useEffect(() => {
    if (!jobId) {
      setJob(null); setNotFound(false)
      finishedRef.current = false
      approvalNotifiedRef.current = false
      return
    }
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      if (stop) return
      try {
        const r = await fetch(`/api/repair-jobs/${jobId}`)
        if (r.ok) {
          const data: RepairJobInfo = await r.json()
          if (stop) return
          setJob(data)
          onJobUpdate?.(data)
          if (!data.pendingApproval) {
            approvalNotifiedRef.current = false
          } else if (!openRef.current && !approvalNotifiedRef.current) {
            // The job is paused on a dangerous command but nobody is watching —
            // ask the parent to re-open the dialog (fires once per request).
            approvalNotifiedRef.current = true
            onApprovalNeeded()
          }
          if (data.status === 'success' || data.status === 'failed') {
            if (!finishedRef.current) { finishedRef.current = true; onFinished(data) }
            return
          }
        } else if (r.status === 404) {
          setNotFound(true)
          onJobUpdate?.(null)
          return
        }
      } catch { /* keep polling */ }
      if (!stop) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [jobId, onFinished, onApprovalNeeded, onJobUpdate])

  // 1s heartbeat while the job runs — drives the elapsed timer and the
  // approval countdown. Stops as soon as the job settles.
  React.useEffect(() => {
    if (!jobId || job?.status !== 'running') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [jobId, job?.status])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job?.steps.length, job?.pendingApproval?.ts])

  const respondApproval = async (approved: boolean) => {
    if (!jobId || responding) return
    setResponding(true)
    try {
      const r = await fetch(`/api/repair-jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      })
      if (!r.ok) {
        toast({ title: t('dlg.repair.approvalGone'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.repair.approvalGone'), variant: 'destructive' })
    } finally {
      setResponding(false)
      // Pull the fresh job state immediately so the log reflects the decision
      // (approved / skipped) without waiting for the next scheduled poll.
      try {
        const r = await fetch(`/api/repair-jobs/${jobId}`)
        if (r.ok) {
          const data: RepairJobInfo = await r.json()
          setJob(data)
          onJobUpdate?.(data)
        }
      } catch { /* the next poll will catch up */ }
    }
  }

  const envLabel = (name: string) => name === 'development' ? 'dev' : name === 'production' ? 'prod' : name
  const isRunning = job?.status === 'running'
  const pending = job?.pendingApproval ?? null
  const remaining = pending ? Math.max(0, pending.expiresAt - now) : 0
  const elapsed = job ? (job.status === 'running' ? now : (job.finishedAt ?? now)) - job.startedAt : 0
  const progressPct = !job ? 30
    : job.status !== 'running' ? 100
    : Math.min(88, ((job.round - 1) / job.maxRounds) * 100 + 30)
  const barColor = !job || isRunning ? 'bg-amber-400 animate-pulse' : job.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'

  // Steps grouped by repair round — a divider row marks each new round.
  const renderedSteps: React.ReactNode[] = []
  let prevRound: number | undefined
  if (job) {
    for (let i = 0; i < job.steps.length; i++) {
      const s = job.steps[i]
      // Round 0 = pre-round setup steps (initial failure notice) — no divider.
      if (s.round != null && s.round > 0 && s.round !== prevRound) {
        renderedSteps.push(
          <div key={`rd-${s.round}-${i}`} className="flex items-center gap-2.5 py-2">
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t('dlg.repair.round', { round: s.round, max: job.maxRounds })}
            </span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
        )
        prevRound = s.round
      }
      renderedSteps.push(
        <div key={`st-${i}`} className="flex gap-2.5">
          <span className="shrink-0 select-none tabular-nums text-zinc-400/60 dark:text-zinc-600">{formatRepairClock(s.ts)}</span>
          <span className={`min-w-0 break-all whitespace-pre-wrap leading-relaxed ${REPAIR_LOG_STYLES[s.level] || REPAIR_LOG_STYLES.info}`}>
            {s.level === 'command' && <span className="select-none text-teal-600/70 dark:text-teal-500/70">$ </span>}
            {s.level === 'tool' && <span className="select-none text-cyan-700/70 dark:text-cyan-400/70">❯ </span>}
            {s.level === 'approval' && <ShieldAlert className="mr-1 inline h-3 w-3 -mt-0.5 text-amber-500" />}
            {s.level === 'approved' && <ShieldCheck className="mr-1 inline h-3 w-3 -mt-0.5 text-emerald-500" />}
            {s.level === 'denied' && <ShieldX className="mr-1 inline h-3 w-3 -mt-0.5 text-zinc-400" />}
            {s.msg}
          </span>
        </div>
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* flex column capped to the viewport (base DialogContent provides the
       * max-h safety net): header / progress / footer stay pinned, the body
       * below flexes and scrolls, the terminal log shrinks first (own scroll)
       * before the body ever scrolls — nothing overflows small screens. */}
      <DialogContent className="flex flex-col gap-3 sm:max-w-2xl sm:gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2.5">
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Wrench className="h-5 w-5" />
              {isRunning && (
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
                </span>
              )}
            </span>
            <span className="flex flex-col items-start leading-tight">
              <span className="flex items-center gap-2">
                {t('dlg.repair.title')}
                {job && (
                  <Badge variant={job.status === 'running' ? 'secondary' : job.status === 'success' ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
                    {job.status === 'running' ? t('dlg.repair.statusRunning', { round: job.round, max: job.maxRounds }) : job.status === 'success' ? t('dlg.repair.statusSuccess') : t('dlg.repair.statusFailed')}
                  </Badge>
                )}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {job ? `${job.projectName} · ${envLabel(job.envName)} · ${job.kind === 'rebuild' ? 'rebuild' : 'start'}` : t('dlg.repair.creating')}
              </span>
            </span>
          </DialogTitle>
          <DialogDescription>
            {job
              ? t(job.kind === 'rebuild' ? 'dlg.repair.descRebuild' : 'dlg.repair.descStart', { project: job.projectName, env: envLabel(job.envName) })
              : t('dlg.repair.creating')}
          </DialogDescription>
        </DialogHeader>

        {/* round progress bar */}
        <div className="h-1 shrink-0 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${progressPct}%` }} />
        </div>

        {notFound ? (
          <div className="text-center py-8 text-muted-foreground text-sm">{t('dlg.repair.notFound')}</div>
        ) : !job ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {job.diagnosis && (
              <div className="flex shrink-0 gap-3 rounded-xl border border-violet-200/80 bg-violet-50/60 p-3.5 dark:border-violet-900/50 dark:bg-violet-950/20">
                <div className="h-fit shrink-0 rounded-lg bg-violet-500/15 p-1.5">
                  <Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">{t('dlg.repair.diagnosis')}</p>
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-violet-900 dark:text-violet-200">{job.diagnosis}</p>
                </div>
              </div>
            )}

            {pending && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="shrink-0 rounded-xl border border-amber-300/80 bg-amber-50/80 p-4 dark:border-amber-700/60 dark:bg-amber-950/30"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 rounded-lg bg-amber-400/20 dark:bg-amber-500/15 p-2">
                    <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{t('dlg.repair.approvalTitle')}</p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10px] text-amber-700 tabular-nums dark:bg-amber-900/50 dark:text-amber-300">
                        <Clock className="h-2.5 w-2.5" />{t('dlg.repair.autoDenyIn', { time: formatRepairCountdown(remaining) })}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-amber-700/90 dark:text-amber-300/80">{t('dlg.repair.approvalDesc')}</p>
                  </div>
                </div>
                <div className="mt-3 whitespace-pre-wrap break-all rounded-lg border border-amber-400/25 bg-zinc-950 px-3 py-2.5 font-mono text-xs text-amber-200 dark:text-amber-300">
                  <span className="select-none text-amber-500/70">$ </span>{pending.cmd}
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button size="sm" disabled={responding} onClick={() => void respondApproval(true)} className="flex-1 bg-emerald-600 text-white hover:bg-emerald-500">
                    {responding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    {t('dlg.repair.approve')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={responding} onClick={() => void respondApproval(false)} className="flex-1 border-amber-300 text-amber-700 hover:bg-amber-100/60 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/30">
                    <ShieldX className="h-3.5 w-3.5" />
                    {t('dlg.repair.deny')}
                  </Button>
                </div>
              </motion.div>
            )}

            <div className="flex min-h-[8.5rem] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center gap-1.5 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                <span className="ml-2 inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  <Terminal className="h-3 w-3" />{t('dlg.repair.logTitle')}
                </span>
                {isRunning && (
                  <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('dlg.repair.statusRunning', { round: job.round, max: job.maxRounds })}
                  </span>
                )}
              </div>
              <div ref={scrollRef} className="max-h-48 min-h-0 space-y-1 overflow-y-auto p-3 font-mono text-xs sm:max-h-80">
                {job.steps.length === 0 && (
                  <div className="space-y-2 py-2">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" style={{ width: `${76 - i * 22}%` }} />
                    ))}
                  </div>
                )}
                {renderedSteps}
                {isRunning && (
                  <div className="flex items-center gap-2.5 pt-1 text-zinc-400 dark:text-zinc-500">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: '150ms' }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: '300ms' }} />
                    </span>
                    <span className="text-[11px]">{pending ? t('dlg.repair.waitingApproval') : t('dlg.repair.waiting')}</span>
                  </div>
                )}
              </div>
            </div>

            {job.status === 'success' && (
              <div className="flex shrink-0 items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {t('dlg.repair.successNote')}
              </div>
            )}
            {job.status === 'failed' && job.error && (
              <div className="shrink-0 rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <XCircle className="h-3.5 w-3.5 shrink-0" />{t('dlg.repair.failedTitle')}
                </p>
                <p className="break-all whitespace-pre-wrap">{job.error}</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter className="shrink-0 items-center gap-2 sm:justify-between">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {job ? `${t('dlg.repair.elapsed')} ${formatRepairDuration(elapsed)}` : ''}
          </span>
          <div className="flex gap-2">
            {(!job || isRunning) ? (
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                <Minimize2 className="h-3.5 w-3.5" />
                {t('dlg.repair.background')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('dlg.common.close')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ======================== ENHANCED ACTIVITY TIMELINE ========================

function ActivityTimeline({ activity }: { activity: ActivityEvent[] }) {
  const t = useT()
  const [filter, setFilter] = React.useState<'all' | 'deploys' | 'startstop' | 'errors'>('all')

  const filteredActivity = React.useMemo(() => {
    if (filter === 'all') return activity
    if (filter === 'deploys') return activity.filter((e) => e.type === 'deploy' || e.type === 'create')
    if (filter === 'startstop') return activity.filter((e) => e.type === 'start' || e.type === 'stop' || e.type === 'restart')
    if (filter === 'errors') return activity.filter((e) => e.type === 'error')
    return activity
  }, [activity, filter])

  const groupedActivity = React.useMemo(() => {
    const now = Date.now()
    const today = new Date().setHours(0, 0, 0, 0)
    const yesterday = today - 86400000
    const groups: { label: string; events: ActivityEvent[] }[] = [
      { label: t('dlg.activity.justNow'), events: [] },
      { label: t('dlg.activity.today'), events: [] },
      { label: t('dlg.activity.yesterday'), events: [] },
      { label: t('dlg.activity.earlier'), events: [] },
    ]
    for (const event of filteredActivity) {
      const ts = new Date(event.timestamp).getTime()
      const diff = now - ts
      if (diff < 3600000) groups[0].events.push(event)
      else if (ts >= today) groups[1].events.push(event)
      else if (ts >= yesterday) groups[2].events.push(event)
      else groups[3].events.push(event)
    }
    return groups.filter((g) => g.events.length > 0)
  }, [filteredActivity, t])

  const getEventMeta = (event: ActivityEvent): string | null => {
    const meta = event.metadata
    if (!meta) return null
    if (event.type === 'start' || event.type === 'stop' || event.type === 'restart') {
      return (meta.environmentName as string) || null
    }
    if (event.type === 'error') {
      return (meta.errorCode as string) || null
    }
    if (event.type === 'deploy') {
      return (meta.version as string) || null
    }
    return null
  }

  const filterButtons: { key: typeof filter; label: string }[] = [
    { key: 'all', label: t('dlg.activity.filterAll') },
    { key: 'deploys', label: t('dlg.activity.filterDeploys') },
    { key: 'startstop', label: t('dlg.activity.filterStartStop') },
    { key: 'errors', label: t('dlg.activity.filterErrors') },
  ]

  if (activity.length === 0) {
    return <div className="text-center py-8 text-muted-foreground text-sm">{t('dlg.activity.noActivity')}</div>
  }

  return (
    <div>
      {/* Filter buttons */}
      <div className="flex items-center gap-1.5 mb-4">
        {filterButtons.map((btn) => (
          <button
            key={btn.key}
            type="button"
            onClick={() => setFilter(btn.key)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              filter === btn.key
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-200/60 dark:ring-emerald-700/40'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted dark:bg-white/5 dark:hover:bg-white/10'
            }`}
          >
            {btn.label}
          </button>
        ))}
        <span className="text-[10px] text-muted-foreground ml-auto">{t('dlg.activity.eventsCount', { count: filteredActivity.length })}</span>
      </div>

      {/* Grouped timeline */}
      <div className="relative">
        <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-emerald-500/50 to-teal-500/50" />
        <div className="space-y-4">
          {groupedActivity.map((group) => (
            <div key={group.label}>
              <div className="relative pl-10 mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground dark:text-zinc-400">{group.label}</span>
              </div>
              <div className="space-y-2">
                {group.events.map((event, idx) => {
                  const ActivityIcon = ACTIVITY_ICONS[event.type] || Activity
                  const colorClass = ACTIVITY_COLORS[event.type] || 'text-muted-foreground bg-muted'
                  const meta = getEventMeta(event)
                  return (
                    <motion.div
                      key={event.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 30 }}
                      className="relative pl-10 hover:bg-accent/30 transition-colors rounded p-1.5"
                    >
                      <div className={`absolute left-2 top-1 p-1.5 rounded-full ${colorClass}`}>
                        <ActivityIcon className="h-3 w-3" />
                      </div>
                      <div className="absolute left-[15px] top-[6px] h-1 w-1 rounded-full bg-background ring-2 ring-emerald-500/30" />
                      <div>
                        <p className="text-sm">{event.message}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-[10px] text-muted-foreground">{formatTimeAgo(event.timestamp, t)}</p>
                          {meta && (
                            <span className="text-[9px] px-1.5 py-0 rounded-full bg-muted/60 dark:bg-white/5 text-muted-foreground dark:text-zinc-400 font-medium">{meta}</span>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ======================== DETAIL SHEET ========================

function DetailSheet({
  project, open, onClose, onEnvAction, lanIp, currentHost, onRefresh, devices, onOpenDeviceManagement, onReanalyze
}: {
  project: Project | null
  open: boolean
  onClose: () => void
  onEnvAction: (projectId: string, envId: string, action: string) => void
  lanIp: string
  currentHost: string
  onRefresh?: () => void
  devices?: Device[]
  onOpenDeviceManagement?: () => void
  onReanalyze?: (p: Project) => void
}) {
  const t = useT()
  const [activeTab, setActiveTab] = React.useState('overview')
  const [activity, setActivity] = React.useState<ActivityEvent[]>([])
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [loadingActivity, setLoadingActivity] = React.useState(false)
  const [loadingLogs, setLoadingLogs] = React.useState(false)
  const [expandedEnv, setExpandedEnv] = React.useState<string | null>(null)
  const [editingPort, setEditingPort] = React.useState<string | null>(null)
  const [portValue, setPortValue] = React.useState('')
  const [healthResult, setHealthResult] = React.useState<HealthCheckResult | null>(null)
  const [editingEnvVars, setEditingEnvVars] = React.useState<string | null>(null) // env.id being edited
  const [envVarDraft, setEnvVarDraft] = React.useState<Record<string, string>>({}) // draft key-value pairs
  const [newEnvKey, setNewEnvKey] = React.useState('')
  const [newEnvValue, setNewEnvValue] = React.useState('')
  const [savingEnvVars, setSavingEnvVars] = React.useState(false)
  const [editingTags, setEditingTags] = React.useState(false)
  const [tagDraft, setTagDraft] = React.useState<string[]>([])
  const [savingTags, setSavingTags] = React.useState(false)
  const [tagSearchOpen, setTagSearchOpen] = React.useState(false)
  const [tagSearchQuery, setTagSearchQuery] = React.useState('')
  const [editingDescription, setEditingDescription] = React.useState(false)
  const [descDraft, setDescDraft] = React.useState('')
  const [savingDesc, setSavingDesc] = React.useState(false)
  const [localNetworkInfo, setLocalNetworkInfo] = React.useState<{ hostname: string; platform: string; arch: string; cpus: number } | null>(null)
  // Log viewer state
  const [logLevelFilter, setLogLevelFilter] = React.useState<string>('all')
  const [logEnvFilter, setLogEnvFilter] = React.useState<string>('all')
  const [logSearchQuery, setLogSearchQuery] = React.useState('')
  const [logAutoScroll, setLogAutoScroll] = React.useState(true)
  const logContainerRef = React.useRef<HTMLDivElement>(null)
  // Collapsible sections state
  const [descCollapsed, setDescCollapsed] = React.useState(() => !project?.description)
  const [deviceCollapsed, setDeviceCollapsed] = React.useState(false)
  const [tagsCollapsed, setTagsCollapsed] = React.useState(() => parseTags(project?.tags || '').length === 0)
  const [envSummaryCollapsed, setEnvSummaryCollapsed] = React.useState(false)
  // Project Notes state (Session 13)
  const [projectNotes, setProjectNotes] = React.useState<string>(() => {
    try { return project ? (localStorage.getItem(`project-notes-${project.id}`) || '') : '' } catch { return '' }
  })
  const [editingNotes, setEditingNotes] = React.useState(false)
  const [notesDraft, setNotesDraft] = React.useState(projectNotes)
  const [savingNotes, setSavingNotes] = React.useState(false)
  const { toast } = useToast()

  // Fetch network info for local device display
  React.useEffect(() => {
    if (open && !project?.deviceId) {
      fetch('/api/network-info')
        .then((r) => r.json())
        .then((data) => setLocalNetworkInfo({ hostname: data.hostname, platform: data.platform, arch: data.arch, cpus: data.cpus }))
        .catch(() => {})
    }
  }, [open, project?.deviceId])

  const startEditingTags = () => {
    setTagDraft([...tags])
    setEditingTags(true)
    setTagSearchQuery('')
    setTagSearchOpen(false)
  }

  const saveTags = async () => {
    if (!project) return
    setSavingTags(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: JSON.stringify(tagDraft) }),
      })
      if (res.ok) {
        toast({ title: t('dlg.detail.tagsUpdated'), variant: 'success' })
        setEditingTags(false)
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: t('dlg.detail.tagsUpdateFailed'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.detail.tagsUpdateFailed'), variant: 'destructive' })
    } finally {
      setSavingTags(false)
    }
  }

  const removeTag = (tagName: string) => {
    setTagDraft((prev) => prev.filter((t) => t !== tagName))
  }

  const addTag = (tagName: string) => {
    if (!tagDraft.includes(tagName)) {
      setTagDraft((prev) => [...prev, tagName])
    }
    setTagSearchQuery('')
    setTagSearchOpen(false)
  }

  const startEditingDescription = () => {
    setDescDraft(project?.description || '')
    setEditingDescription(true)
  }

  const saveDescription = async () => {
    if (!project) return
    setSavingDesc(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: descDraft }),
      })
      if (res.ok) {
        toast({ title: t('dlg.detail.descUpdated'), variant: 'success' })
        setEditingDescription(false)
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: t('dlg.detail.descUpdateFailed'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.detail.descUpdateFailed'), variant: 'destructive' })
    } finally {
      setSavingDesc(false)
    }
  }

  const handleSaveNotes = React.useCallback(async () => {
    if (!project) return
    setSavingNotes(true)
    try {
      localStorage.setItem(`project-notes-${project.id}`, notesDraft)
      setProjectNotes(notesDraft)
      setEditingNotes(false)
      addToast({ title: t('dlg.detail.notesSaved'), variant: 'success' })
    } catch {
      addToast({ title: t('dlg.detail.notesSaveFailed'), variant: 'destructive' })
    }
    setSavingNotes(false)
  }, [notesDraft, project, t])

  React.useEffect(() => {
    if (project && (activeTab === 'activity' || activeTab === 'deployments') && open) {
      const id = requestAnimationFrame(() => {
        setLoadingActivity(true)
        fetch(`/api/projects/${project.id}/activity`)
          .then((r) => r.json())
          .then(setActivity)
          .catch(() => {})
          .finally(() => setLoadingActivity(false))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [project, activeTab, open])

  React.useEffect(() => {
    if (project && activeTab === 'logs' && open) {
      const id = requestAnimationFrame(() => {
        setLoadingLogs(true)
        setLogEnvFilter('all')
        fetch(`/api/projects/${project.id}/logs`)
          .then((r) => r.json())
          .then((data: LogEntry[]) => { setLogs(Array.isArray(data) ? data : []) })
          .catch(() => {})
          .finally(() => setLoadingLogs(false))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [project, activeTab, open])

  // Auto-scroll log viewer when new logs arrive
  React.useEffect(() => {
    if (logAutoScroll && logContainerRef.current && activeTab === 'logs') {
      const el = logContainerRef.current
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [logs, logAutoScroll, activeTab])

  const runHealthCheck = React.useCallback(async () => {
    if (!project) return
    const ports = (project.environments || []).map((e) => e.port).join(',')
    if (!ports) return
    try {
      const res = await fetch(`/api/health-check?ports=${ports}`)
      if (res.ok) {
        const data = await res.json()
        setHealthResult(data)
        toast({ title: t('dlg.detail.healthCheckDone'), description: t('dlg.detail.overall', { status: data.overallStatus }), variant: data.overallStatus === 'healthy' ? 'success' : 'destructive' })
      }
    } catch { /* ignore */ }
  }, [project, toast, t])

  const savePort = async (envId: string, newPort: number) => {
    if (!project) return
    try {
      const res = await fetch(`/api/projects/${project.id}/environments/${envId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: newPort }),
      })
      if (res.ok) {
        toast({ title: t('dlg.detail.portUpdated'), variant: 'success' })
        onRefresh?.()
      } else {
        const err = await res.json().catch(() => ({} as { error?: string }))
        toast({
          title: t('dlg.detail.portSaveFailed'),
          description: err.error || t('dlg.common.serverError'),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('dlg.detail.portSaveFailed'), variant: 'destructive' })
    }
    setEditingPort(null)
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: t('dlg.detail.copied', { label }), variant: 'success' })
  }

  const startEditingEnvVars = (envId: string, currentVars: string) => {
    setEditingEnvVars(envId)
    setEnvVarDraft(parseEnvVars(currentVars))
    setNewEnvKey('')
    setNewEnvValue('')
  }

  const saveEnvVars = async (envId: string) => {
    if (!project) return
    setSavingEnvVars(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/environments/${envId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVars: envVarDraft }),
      })
      if (res.ok) {
        toast({ title: t('dlg.detail.envVarsSaved'), variant: 'success' })
        setEditingEnvVars(null)
        // Refresh the project data so the detail sheet shows updated env vars
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: t('dlg.detail.envVarsSaveFailed'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.detail.envVarsSaveFailed'), variant: 'destructive' })
    } finally {
      setSavingEnvVars(false)
    }
  }

  const addEnvVarPair = () => {
    const key = newEnvKey.trim()
    if (!key) return
    setEnvVarDraft((prev) => ({ ...prev, [key]: newEnvValue }))
    setNewEnvKey('')
    setNewEnvValue('')
  }

  const removeEnvVarPair = (key: string) => {
    setEnvVarDraft((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const updateEnvVarKey = (oldKey: string, newKey: string) => {
    setEnvVarDraft((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (k === oldKey) next[newKey] = v
        else next[k] = v
      }
      return next
    })
  }

  const updateEnvVarValue = (key: string, value: string) => {
    setEnvVarDraft((prev) => ({ ...prev, [key]: value }))
  }

  if (!project) return null

  // Real build/repair/deploy history for the Deployments tab, derived from
  // the persistent activity feed (no simulated deployments anymore).
  const opsEvents = activity.filter((e) => e.type === 'rebuild' || e.type === 'repair' || e.type === 'deploy')

  // Log lines available for the current env filter (source files carry real
  // process output; lines without timestamps render '—').
  const logEnvNames = Array.from(new Set(logs.map((l) => l.envName).filter((n): n is string => !!n)))

  // Defensive default: if environments is missing for any reason, render an
  // empty list rather than crashing. (Bug guard for any caller that forgets
  // to unwrap the { project } envelope from /api/projects/:id.)
  const envs = project.environments ?? []
  const status = getProjectStatus({ ...project, environments: envs })
  const tags = parseTags(project.tags)
  const IconComp = ICON_MAP[project.icon] || Folder

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden p-0 flex flex-col dark:bg-zinc-900/98 dark:border-l dark:border-zinc-800/60">
        <SheetHeader className="px-4 pt-4 pb-2 border-b shrink-0 bg-brand-soft/50 dark:bg-brand-soft">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-brand-soft-strong">
              <IconComp className="h-5 w-5 text-brand-strong" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="truncate">{project.name}</SheetTitle>
              <SheetDescription className="truncate text-xs">{project.path}</SheetDescription>
            </div>
            <Badge variant={status === 'running' ? 'default' : 'secondary'} className={`shrink-0 ${status === 'running' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`}>
              {status === 'running' ? t('dlg.detail.statusRunning') : status === 'mixed' ? t('dlg.depGraph.mixed') : t('dlg.detail.statusStopped')}
            </Badge>
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="border-b px-4 shrink-0">
            <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-2">
              <TabsTrigger value="overview" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabOverview')}</TabsTrigger>
              <TabsTrigger value="environments" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabEnvironments')}</TabsTrigger>
              <TabsTrigger value="activity" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabActivity')}</TabsTrigger>
              <TabsTrigger value="logs" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabLogs')}</TabsTrigger>
              <TabsTrigger value="deployments" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabDeployments')}</TabsTrigger>
              <TabsTrigger value="timeline" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-brand-soft data-[state=active]:text-brand-strong dark:data-[state=active]:bg-brand-soft dark:data-[state=active]:text-brand-strong dark:data-[state=active]:border-transparent rounded-full transition-colors">{t('dlg.detail.tabTimeline')}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="p-4 space-y-3 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="space-y-3"
            >
            {/* Description - collapsible */}
            <div>
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 w-full text-left group/section cursor-pointer rounded-md hover:bg-muted/30 transition-colors px-1 -mx-1"
                onClick={() => setDescCollapsed(!descCollapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDescCollapsed(!descCollapsed) } }}
              >
                <div className="h-1 w-3 rounded-full bg-emerald-500" />
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1">{t('dlg.detail.description')}</h4>
                <div className="flex-1" />
                {!editingDescription && !descCollapsed && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEditingDescription() }}>
                    <Edit3 className="h-2.5 w-2.5 mr-0.5" />{t('dlg.common.edit')}
                  </Button>
                )}
                <span className="text-muted-foreground">
                  {descCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {!descCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    {editingDescription ? (
                      <div className="space-y-2">
                        <Textarea
                          value={descDraft}
                          onChange={(e) => setDescDraft(e.target.value)}
                          placeholder={t('dlg.detail.descPlaceholder')}
                          className="text-sm min-h-[80px] resize-none"
                          autoFocus
                        />
                        <div className="flex items-center gap-1.5 justify-end">
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingDescription(false)} disabled={savingDesc}>{t('dlg.common.cancel')}</Button>
                          <Button size="sm" className="h-6 text-xs bg-primary hover:bg-primary/90 text-primary-foreground" onClick={saveDescription} disabled={savingDesc}>
                            {savingDesc && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            {t('dlg.common.save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      project.description ? (
                        <p className="text-sm">{project.description}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">{t('dlg.detail.noDescription')}</p>
                      )
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Device - collapsible */}
            <div>
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 w-full text-left cursor-pointer rounded-md hover:bg-muted/30 transition-colors px-1 -mx-1"
                onClick={() => setDeviceCollapsed(!deviceCollapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDeviceCollapsed(!deviceCollapsed) } }}
              >
                <div className="h-1 w-3 rounded-full bg-emerald-500" />
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">{t('dlg.detail.device')}</h4>
                <div className="flex-1" />
                <span className="text-muted-foreground">
                  {deviceCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {!deviceCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="p-2.5 rounded-lg border bg-muted/30">
                      {project.deviceId && project.deviceName ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="relative flex h-2.5 w-2.5">
                              {project.deviceStatus === 'online' && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                              )}
                              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${project.deviceStatus === 'online' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                            </span>
                            <span className="text-sm font-medium">{project.deviceName}</span>
                            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${project.deviceStatus === 'online' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400'}`}>
                              {project.deviceStatus === 'online' ? t('dlg.common.online') : t('dlg.common.offline')}
                            </Badge>
                          </div>
                          {(() => {
                            const device = devices?.find((d) => d.id === project.deviceId)
                            if (!device) return null
                            return (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground pl-5">
                                <span>{t('dlg.detail.ipPort')}</span>
                                <span className="font-mono text-foreground dark:text-zinc-200">{device.ip}:{device.port}</span>
                                <span>{t('dlg.detail.lastSeen')}</span>
                                <span className="font-mono text-foreground dark:text-zinc-200">{device.lastSeen ? formatTimeAgo(device.lastSeen, t) : t('dlg.common.never')}</span>
                              </div>
                            )
                          })()}
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => { onOpenDeviceManagement?.(); onClose() }}>
                              <ExternalLink className="h-2.5 w-2.5 mr-0.5" />{t('dlg.detail.goToDevice')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <span className="text-sm font-medium">{t('dlg.detail.thisMachine')}</span>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300">{t('dlg.detail.localBadge')}</Badge>
                          </div>
                          {localNetworkInfo && (
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground pl-6">
                              <span>{t('dlg.detail.hostname')}</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.hostname}</span>
                              <span>{t('dlg.detail.platform')}</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.platform} {localNetworkInfo.arch}</span>
                              <span>{t('dlg.detail.cpuCores')}</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.cpus}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border">
                <div className="text-xs text-muted-foreground">{t('dlg.detail.path')}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="text-sm font-mono truncate">{project.path}</span>
                  <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => copyToClipboard(project.path, t('dlg.detail.path'))}><Copy className="h-3 w-3" /></Button>
                </div>
              </div>
              <div className="p-3 rounded-lg border">
                <div className="text-xs text-muted-foreground">{t('dlg.detail.created')}</div>
                <div className="text-sm mt-0.5">{new Date(project.createdAt).toLocaleDateString()}</div>
              </div>
            </div>
            <div>
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 w-full text-left cursor-pointer rounded-md hover:bg-muted/30 transition-colors px-1 -mx-1"
                onClick={() => setTagsCollapsed(!tagsCollapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTagsCollapsed(!tagsCollapsed) } }}
              >
                <div className="h-1 w-3 rounded-full bg-emerald-500" />
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">
                  {t('dlg.detail.tags')}{tagsCollapsed && tags.length > 0 ? ` (${tags.length})` : ''}
                </h4>
                <div className="flex-1" />
                {!editingTags && !tagsCollapsed && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEditingTags() }}>
                    <Edit3 className="h-2.5 w-2.5 mr-0.5" />{t('dlg.common.edit')}
                  </Button>
                )}
                <span className="text-muted-foreground">
                  {tagsCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {!tagsCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    {editingTags ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                          {tagDraft.map((tag) => (
                            <Badge key={tag} variant="secondary" className={`cursor-default pr-0.5 ${getTagColor(tag)}`}>
                              {tag}
                              <button type="button" className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/20 transition-colors" onClick={() => removeTag(tag)}>
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </Badge>
                          ))}
                          {tagDraft.length === 0 && <span className="text-xs text-muted-foreground italic">{t('dlg.detail.noTagsSelected')}</span>}
                        </div>
                        <Popover open={tagSearchOpen} onOpenChange={setTagSearchOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" size="sm" className="h-6 text-[10px] w-full justify-start">
                              <Tag className="h-2.5 w-2.5 mr-1" />{t('dlg.detail.addTag')}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="start">
                            <Input
                              placeholder={t('dlg.detail.searchTags')}
                              value={tagSearchQuery}
                              onChange={(e) => setTagSearchQuery(e.target.value)}
                              className="h-7 text-xs mb-1.5"
                              autoFocus
                            />
                            <div className="max-h-40 overflow-y-auto space-y-0.5">
                              {TAG_OPTIONS
                                .filter((t) => t.name.toLowerCase().includes(tagSearchQuery.toLowerCase()) && !tagDraft.includes(t.name))
                                .map((tag) => (
                                  <button
                                    key={tag.name}
                                    type="button"
                                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent transition-colors text-left"
                                    onClick={() => addTag(tag.name)}
                                  >
                                    <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 cursor-default ${tag.color}`}>{tag.name}</Badge>
                                  </button>
                                ))
                              }
                              {TAG_OPTIONS.filter((t) => t.name.toLowerCase().includes(tagSearchQuery.toLowerCase()) && !tagDraft.includes(t.name)).length === 0 && (
                                <p className="text-[10px] text-muted-foreground text-center py-2">{t('dlg.detail.noMoreTags')}</p>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                        <div className="flex items-center gap-1.5 justify-end">
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingTags(false)} disabled={savingTags}>{t('dlg.common.cancel')}</Button>
                          <Button size="sm" className="h-6 text-xs bg-primary hover:bg-primary/90 text-primary-foreground" onClick={saveTags} disabled={savingTags}>
                            {savingTags && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            {t('dlg.common.save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {tags.length > 0 ? tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className={`cursor-default ${getTagColor(tag)}`}>{tag}</Badge>
                        )) : <span className="text-xs text-muted-foreground">{t('dlg.detail.noTags')}</span>}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Project Notes (Session 13) */}
            <div className="rounded-lg border bg-muted/20 overflow-hidden">
              <div
                role="button"
                tabIndex={0}
                className="flex items-center justify-between w-full p-3 hover:bg-accent/50 transition-colors"
                onClick={() => setEditingNotes(!editingNotes)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingNotes(!editingNotes) } }}
              >
                <div className="flex items-center gap-2">
                  <Edit3 className="h-3.5 w-3.5 text-amber-500" />
                  <h4 className="text-sm font-semibold">{t('dlg.detail.notes')}</h4>
                </div>
                <div className="flex items-center gap-2">
                  {projectNotes && (
                    <Badge variant="secondary" className="text-[9px] bg-amber-100/60 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                      {t('dlg.detail.chars', { count: projectNotes.length })}
                    </Badge>
                  )}
                  {editingNotes ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </div>
              </div>
              <AnimatePresence>
                {editingNotes && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 pt-0 space-y-2">
                      <Textarea
                        value={notesDraft}
                        onChange={(e) => setNotesDraft(e.target.value)}
                        placeholder={t('dlg.detail.notesPlaceholder')}
                        className="min-h-[80px] text-xs resize-y"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">{t('dlg.detail.characters', { count: notesDraft.length })}</span>
                        <div className="flex gap-1.5">
                          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setNotesDraft(projectNotes); setEditingNotes(false) }}>{t('dlg.common.cancel')}</Button>
                          <Button size="sm" className="h-6 text-[10px] bg-amber-600 hover:bg-amber-700 text-white" onClick={handleSaveNotes} disabled={savingNotes}>
                            {savingNotes && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
                            {t('dlg.detail.saveNotes')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {!editingNotes && projectNotes && (
                <div className="px-3 pb-3 pt-0">
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">{projectNotes}</p>
                </div>
              )}
              {!editingNotes && !projectNotes && (
                <div className="px-3 pb-3 pt-0">
                  <p className="text-[10px] text-muted-foreground/60 italic">{t('dlg.detail.noNotes')}</p>
                </div>
              )}
            </div>
            <div>
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 w-full text-left cursor-pointer rounded-md hover:bg-muted/30 transition-colors px-1 -mx-1"
                onClick={() => setEnvSummaryCollapsed(!envSummaryCollapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEnvSummaryCollapsed(!envSummaryCollapsed) } }}
              >
                <div className="h-1 w-3 rounded-full bg-emerald-500" />
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">
                  {t('dlg.detail.envSummary')}{envSummaryCollapsed && envs.length > 0 ? ` (${envs.length})` : ''}
                </h4>
                <div className="flex-1" />
                {!envSummaryCollapsed && (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { const ports = envs.map((e) => String(e.port)).join(', '); navigator.clipboard.writeText(ports); toast({ title: t('dlg.detail.portsCopied'), description: ports, variant: 'success' }) }}
                      title={t('dlg.detail.copyAllPortsTitle')}
                    ><Copy className="h-2.5 w-2.5" />{t('dlg.detail.copyAllPorts')}</button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { envs.filter((e) => e.status === 'running').forEach((env) => { let url: string; if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) { url = `/api/proxy/${env.port}/` } else { const host = currentHost || 'localhost'; url = `http://${host}:${env.port}` } window.open(url, '_blank') }) }}
                      title={t('dlg.detail.openAllRunningTitle')}
                    ><ExternalLink className="h-2.5 w-2.5" />{t('dlg.detail.openAllRunning')}</button>
                  </div>
                )}
                <span className="text-muted-foreground">
                  {envSummaryCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {!envSummaryCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1">
                      {envs.map((env) => (
                        <div key={env.id} className="flex items-center justify-between p-2 rounded border text-sm">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${env.status === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                            <span>{env.name}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <button className="font-mono hover:text-foreground transition-colors" onClick={() => copyToClipboard(String(env.port), `:${env.port}`)}>:{env.port}</button>
                            {env.pid && <span>PID {env.pid}</span>}
                            {env.status === 'running' && (
                              <a
                                href={(() => {
                                  if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) {
                                    return `/api/proxy/${env.port}/`
                                  }
                                  const host = currentHost || 'localhost'
                                  return `http://${host}:${env.port}`
                                })()}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-0.5"
                              >
                                Open <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                      {envs.length === 0 && <span className="text-xs text-muted-foreground">{t('dlg.detail.noEnvironments')}</span>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Access URLs Section */}
            {envs.some((e) => e.status === 'running') && (
              <div>
                <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">{t('dlg.detail.accessUrls')}</h4></div>
                <div className="space-y-1.5">
                  {envs.filter((e) => e.status === 'running').map((env) => {
                    const envName = env.name === 'development' ? 'dev' : env.name === 'production' ? 'prod' : env.name
                    return (
                      <div key={env.id} className="p-2.5 rounded-lg border bg-muted/30 space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="text-xs font-medium">{envName}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">:{env.port}</span>
                        </div>
                        <div className="space-y-1 pl-3.5">
                          {/* Localhost */}
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-[9px] text-muted-foreground w-10 shrink-0">{t('dlg.detail.local')}</span>
                            <a href={`http://localhost:${env.port}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline font-mono truncate">http://localhost:{env.port}</a>
                            <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(`http://localhost:${env.port}`, t('dlg.detail.urlCopied'))}><Copy className="h-2.5 w-2.5" /></button>
                          </div>
                          {/* LAN */}
                          {lanIp && (
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className="text-[9px] text-muted-foreground w-10 shrink-0">{t('dlg.detail.lan')}</span>
                              <a href={`http://${lanIp}:${env.port}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline font-mono truncate">http://{lanIp}:{env.port}</a>
                              <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(`http://${lanIp}:${env.port}`, t('dlg.detail.urlCopied'))}><Copy className="h-2.5 w-2.5" /></button>
                            </div>
                          )}
                          {/* Proxy (ngrok) */}
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-[9px] text-muted-foreground w-10 shrink-0">{t('dlg.detail.proxy')}</span>
                            <a href={`/api/proxy/${env.port}/`} target="_blank" rel="noopener noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline font-mono truncate">/api/proxy/{env.port}/</a>
                            <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => { const url = `${window.location.origin}/api/proxy/${env.port}/`; copyToClipboard(url, t('dlg.detail.proxyUrlCopied')) }}><Copy className="h-2.5 w-2.5" /></button>
                            <span className="text-[9px] text-muted-foreground italic">{t('dlg.detail.viaNgrok')}</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  <Link2 className="h-3 w-3 inline mr-0.5" />
                  {t('dlg.detail.proxyNote')}
                </p>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={runHealthCheck} className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0">
              <Activity className="h-3.5 w-3.5 mr-1" /> {t('dlg.detail.runHealthCheck')}
            </Button>
            {healthResult && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={healthResult.overallStatus === 'healthy' ? 'default' : 'destructive'} className={healthResult.overallStatus === 'healthy' ? 'bg-emerald-100 text-emerald-800' : ''}>
                    {healthResult.overallStatus === 'healthy' ? t('dlg.detail.statusHealthy') : t('dlg.detail.statusUnhealthy')}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{new Date(healthResult.checkedAt).toLocaleTimeString()}</span>
                </div>
                {healthResult.results.map((r) => (
                  <div key={r.port} className="flex items-center justify-between p-2 rounded border text-xs">
                    <div className="flex items-center gap-2">
                      <span className={r.status === 'healthy' ? 'text-emerald-500' : 'text-red-500'}>:{r.port}</span>
                      <span className="capitalize">{r.status === 'healthy' ? t('dlg.detail.statusHealthy') : t('dlg.detail.statusUnhealthy')}</span>
                    </div>
                    <span className="text-muted-foreground">{r.responseTime}ms</span>
                  </div>
                ))}
              </div>
            )}
            </motion.div>
          </TabsContent>

          <TabsContent value="environments" className="p-4 space-y-3 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="space-y-3"
            >
            {/* ======================== ENVIRONMENT QUICK ACTIONS BAR (Session 11) ======================== */}
            {envs.length > 0 && (
              <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-3 px-4 pt-3 pb-2 bg-background/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-border/30 dark:border-zinc-700/30">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {envs.filter((e) => e.status !== 'running').length > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { envs.filter((e) => e.status !== 'running').forEach((e) => onEnvAction(project.id, e.id, 'start')) }}>
                      <Play className="h-3 w-3 mr-1 text-emerald-500" />{t('dlg.detail.startAllStopped', { count: envs.filter((e) => e.status !== 'running').length })}
                    </Button>
                  )}
                  {envs.filter((e) => e.status === 'running').length > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { envs.filter((e) => e.status === 'running').forEach((e) => onEnvAction(project.id, e.id, 'stop')) }}>
                      <Square className="h-3 w-3 mr-1 text-red-500" />{t('dlg.detail.stopAllRunning', { count: envs.filter((e) => e.status === 'running').length })}
                    </Button>
                  )}
                  {envs.some((e) => e.status === 'running') && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { envs.forEach((e) => { if (e.status === 'running') onEnvAction(project.id, e.id, 'restart') }) }}>
                      <RotateCw className="h-3 w-3 mr-1 text-amber-500" />{t('dlg.detail.restartAll', { count: envs.filter((e) => e.status === 'running').length })}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { const ports = envs.map((e) => `:${e.port}`).join(', '); navigator.clipboard.writeText(ports); toast({ title: t('dlg.detail.portsCopied'), description: ports, variant: 'success' }) }}>
                    <Copy className="h-3 w-3 mr-1 text-teal-500" />{t('dlg.detail.copyPorts')}
                  </Button>
                </div>
              </div>
            )}
            {envs.map((env) => {
              const envVars = parseEnvVars(env.envVars)
              const isExpanded = expandedEnv === env.id
              return (
                <div key={env.id} className={`rounded-lg border shadow-sm hover:shadow-md transition-shadow ${env.status === 'running' ? 'border-emerald-200 dark:border-emerald-800/40' : 'border-muted'}`}>
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${env.status === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      <span className="font-medium text-sm">{env.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {editingPort === env.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            value={portValue}
                            onChange={(e) => setPortValue(e.target.value)}
                            className="h-6 w-16 text-xs font-mono"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') savePort(env.id, parseInt(portValue))
                              if (e.key === 'Escape') setEditingPort(null)
                            }}
                            onBlur={() => setEditingPort(null)}
                          />
                        </div>
                      ) : (
                        <button
                          className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors px-1 rounded"
                          onClick={() => { setEditingPort(env.id); setPortValue(String(env.port)) }}
                          title={t('dlg.detail.editPortTitle')}
                        >
                          :{env.port}
                        </button>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(`:${env.port}`, `:${env.port}`)}><Copy className="h-3 w-3" /></Button>
                      {env.status === 'running' ? (
                        <>
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><a
                            href={(() => {
                              if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) {
                                return `/api/proxy/${env.port}/`
                              }
                              const host = currentHost || 'localhost'
                              return `http://${host}:${env.port}`
                            })()}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer text-emerald-500 dark:text-emerald-400"
                          ><ExternalLink className="h-3 w-3" /></a></TooltipTrigger><TooltipContent>{t('dlg.detail.openBrowser')}</TooltipContent></Tooltip></TooltipProvider>
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-red-500" onClick={() => onEnvAction(project.id, env.id, 'stop')}><Square className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>{t('dlg.detail.stop')}</TooltipContent></Tooltip></TooltipProvider>
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-amber-500" onClick={() => onEnvAction(project.id, env.id, 'restart')}><RotateCw className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>{t('dlg.detail.restart')}</TooltipContent></Tooltip></TooltipProvider>
                        </>
                      ) : (
                        <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-emerald-500" onClick={() => onEnvAction(project.id, env.id, 'start')}><Play className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>{t('dlg.detail.run')}</TooltipContent></Tooltip></TooltipProvider>
                      )}
                      {env.name !== 'development' && (
                        <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-teal-500" onClick={() => onEnvAction(project.id, env.id, 'rebuild')}><Hammer className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>{t('dlg.detail.rebuild')}</TooltipContent></Tooltip></TooltipProvider>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setExpandedEnv(isExpanded ? null : env.id)}>
                        <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                      </Button>
                    </div>
                  </div>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="border-t px-3 pb-3 pt-2 space-y-2"
                    >
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><span className="text-muted-foreground">{t('dlg.detail.command')}</span> <span className="font-mono">{env.cmd}</span></div>
                        <div><span className="text-muted-foreground">{t('dlg.detail.pid')}</span> {env.pid || 'N/A'}</div>
                        <div><span className="text-muted-foreground">{t('dlg.detail.status')}</span> <span className={env.status === 'running' ? 'text-emerald-600' : 'text-red-500'}>{env.status === 'running' ? t('dlg.detail.statusRunning') : t('dlg.detail.statusStopped')}</span></div>
                        <div><span className="text-muted-foreground">{t('dlg.detail.createdAt')}</span> {new Date(env.createdAt).toLocaleDateString()}</div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-xs text-muted-foreground">{t('dlg.detail.envVars')}</div>
                          {editingEnvVars !== env.id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 text-[10px] px-1.5 gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                              onClick={() => startEditingEnvVars(env.id, env.envVars)}
                            >
                              <Edit3 className="h-2.5 w-2.5" />
                              {t('dlg.common.edit')}
                            </Button>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 text-[10px] px-1.5 text-muted-foreground"
                                onClick={() => setEditingEnvVars(null)}
                                disabled={savingEnvVars}
                              >
                                {t('dlg.common.cancel')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 text-[10px] px-1.5 gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                                onClick={() => saveEnvVars(env.id)}
                                disabled={savingEnvVars}
                              >
                                {savingEnvVars ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
                                {t('dlg.common.save')}
                              </Button>
                            </div>
                          )}
                        </div>
                        {editingEnvVars === env.id ? (
                          <div className="rounded bg-muted/50 p-2 space-y-1.5 max-h-48 overflow-y-auto">
                            {Object.entries(envVarDraft).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-1.5 text-xs">
                                <Input
                                  value={k}
                                  onChange={(e) => updateEnvVarKey(k, e.target.value)}
                                  className="h-6 text-xs font-mono flex-1 min-w-0 bg-background"
                                  placeholder="KEY"
                                />
                                <span className="text-muted-foreground shrink-0">=</span>
                                <Input
                                  value={v}
                                  onChange={(e) => updateEnvVarValue(k, e.target.value)}
                                  className="h-6 text-xs font-mono flex-1 min-w-0 bg-background"
                                  placeholder="value"
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5 shrink-0 text-red-400 hover:text-red-600"
                                  onClick={() => removeEnvVarPair(k)}
                                  disabled={savingEnvVars}
                                >
                                  <Trash2 className="h-2.5 w-2.5" />
                                </Button>
                              </div>
                            ))}
                            {Object.entries(envVarDraft).length === 0 && (
                              <div className="text-xs text-muted-foreground text-center py-1">{t('dlg.detail.noVars')}</div>
                            )}
                            {/* Add new pair */}
                            <div className="flex items-center gap-1.5 text-xs pt-1 border-t border-border/30">
                              <Input
                                value={newEnvKey}
                                onChange={(e) => setNewEnvKey(e.target.value)}
                                className="h-6 text-xs font-mono flex-1 min-w-0 bg-background"
                                placeholder="NEW_KEY"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && newEnvKey.trim()) addEnvVarPair()
                                }}
                                disabled={savingEnvVars}
                              />
                              <span className="text-muted-foreground shrink-0">=</span>
                              <Input
                                value={newEnvValue}
                                onChange={(e) => setNewEnvValue(e.target.value)}
                                className="h-6 text-xs font-mono flex-1 min-w-0 bg-background"
                                placeholder="value"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && newEnvKey.trim()) addEnvVarPair()
                                }}
                                disabled={savingEnvVars}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 shrink-0 text-emerald-500 hover:text-emerald-700"
                                onClick={addEnvVarPair}
                                disabled={savingEnvVars || !newEnvKey.trim()}
                              >
                                <Plus className="h-2.5 w-2.5" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded bg-muted/50 p-2 space-y-1 max-h-32 overflow-y-auto">
                            {Object.entries(envVars).length > 0 ? Object.entries(envVars).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-2 text-xs font-mono">
                                <span className="text-emerald-600 dark:text-emerald-400">{k}</span>
                                <span className="text-muted-foreground">=</span>
                                <span className="text-foreground">{v}</span>
                                <Button variant="ghost" size="icon" className="h-4 w-4 ml-auto" onClick={() => copyToClipboard(`${k}=${v}`, k)}><Copy className="h-2.5 w-2.5" /></Button>
                              </div>
                            )) : <span className="text-xs text-muted-foreground">{t('dlg.detail.noVarsSet')}</span>}
                          </div>
                        )}
                      </div>
                      {/* Resource Usage Bars */}
                      <div className="px-1 pb-1 space-y-1.5">
                        {(() => {
                          const cpuPercent = env.status === 'running' ? ((parseInt(env.id.replace(/\D/g, '') || '1') * 7) % 40 + 10) : 0
                          const memPercent = env.status === 'running' ? ((parseInt(env.id.replace(/\D/g, '') || '1') * 13) % 30 + 20) : 0
                          return (
                            <>
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-muted-foreground">CPU</span>
                                <span className="font-medium">{cpuPercent}%</span>
                              </div>
                              <div className="h-1 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${env.status === 'running' ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} style={{ width: `${cpuPercent}%` }} />
                              </div>
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-muted-foreground">{t('dlg.detail.memory')}</span>
                                <span className="font-medium">{memPercent}%</span>
                              </div>
                              <div className="h-1 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${env.status === 'running' ? 'bg-teal-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} style={{ width: `${memPercent}%` }} />
                              </div>
                            </>
                          )
                        })()}
                      </div>
                    </motion.div>
                  )}
                </div>
              )
            })}
            {envs.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm mb-3">{t('dlg.detail.noEnvsYet')}</p>
                {project && onReanalyze && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => onReanalyze(project)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('dlg.detail.detectEnvs')}
                  </Button>
                )}
              </div>
            )}
            </motion.div>
          </TabsContent>

          <TabsContent value="activity" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
            {loadingActivity ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
            ) : (
              <ActivityTimeline activity={activity} />
            )}
            </motion.div>
          </TabsContent>

          <TabsContent value="logs" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
            {loadingLogs ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
            ) : (
              <div className="space-y-2">
                {/* Log filter toolbar */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    {(['all', 'error', 'warn', 'info', 'debug'] as const).map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => setLogLevelFilter(level)}
                        className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                          logLevelFilter === level
                            ? (level === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 ring-1 ring-red-300 dark:ring-red-700/50'
                              : level === 'warn' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ring-1 ring-amber-300 dark:ring-amber-700/50'
                              : level === 'info' ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300 ring-1 ring-cyan-300 dark:ring-cyan-700/50'
                              : level === 'debug' ? 'bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300 ring-1 ring-slate-300 dark:ring-slate-600/50'
                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-300 dark:ring-emerald-700/50')
                            : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {t(`dlg.detail.logLevel.${level}` as Parameters<typeof t>[0])}
                      </button>
                    ))}
                  </div>
                  {logEnvNames.length > 0 && (
                    <div className="flex items-center gap-1">
                      {['all', ...logEnvNames].map((env) => (
                        <button
                          key={env}
                          type="button"
                          onClick={() => setLogEnvFilter(env)}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                            logEnvFilter === env
                              ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 ring-1 ring-teal-300 dark:ring-teal-700/50'
                              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                          }`}
                        >
                          {env === 'all' ? t('dlg.detail.allEnvs') : env}
                        </button>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (logEnvFilter === 'all' || log.envName === logEnvFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                    return (
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">{t('dlg.detail.logsCount', { count: filtered.length })}</Badge>
                    )
                  })()}
                  <div className="flex-1" />
                  <div className="relative">
                    <Search className="h-3 w-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={logSearchQuery}
                      onChange={(e) => setLogSearchQuery(e.target.value)}
                      placeholder={t('dlg.detail.searchLogs')}
                      className="h-6 text-[10px] pl-6 w-32"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground">{t('dlg.detail.autoScroll')}</span>
                    <Switch checked={logAutoScroll} onCheckedChange={setLogAutoScroll} className="scale-75" />
                  </div>
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
                    const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (logEnvFilter === 'all' || log.envName === logEnvFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                    const text = filtered.map((log) => `[${log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '—'}] [${log.level.toUpperCase()}] ${log.source}: ${log.message}`).join('\n')
                    navigator.clipboard.writeText(text)
                    toast({ title: t('dlg.detail.logsCopied'), variant: 'success' })
                  }}><Copy className="h-3 w-3" /></Button></TooltipTrigger><TooltipContent>{t('dlg.detail.copyLogs')}</TooltipContent></Tooltip></TooltipProvider>
                </div>
                {/* Log entries — real process output streamed from each environment's log file */}
                <div className="rounded-lg bg-zinc-950 dark:bg-zinc-950 border border-zinc-800 overflow-hidden shadow-inner">
                  <div ref={logContainerRef} className="max-h-80 overflow-y-auto font-mono text-[11px] leading-5 custom-scrollbar">
                    {(() => {
                      const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (logEnvFilter === 'all' || log.envName === logEnvFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                      if (filtered.length === 0) {
                        if (logs.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
                              <Terminal className="h-6 w-6 mb-2 opacity-40" />
                              <p className="text-xs">{t('dlg.detail.noProcessLogs')}</p>
                              <p className="text-[10px] mt-1 text-zinc-600">{t('dlg.detail.noProcessLogsHint')}</p>
                            </div>
                          )
                        }
                        return (
                          <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
                            <Filter className="h-6 w-6 mb-2 opacity-40" />
                            <p className="text-xs">{t('dlg.detail.noLogsFound')}</p>
                            {(logLevelFilter !== 'all' || logEnvFilter !== 'all' || logSearchQuery) && <p className="text-[10px] mt-1">{t('dlg.detail.adjustFilters')}</p>}
                          </div>
                        )
                      }
                      return filtered.map((log, idx) => (
                        <div key={log.id} className={`flex gap-0 border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors ${log.level === 'error' ? 'bg-red-950/20' : log.level === 'warn' ? 'bg-amber-950/10' : ''}`}>
                          <span className="px-2 py-0.5 text-zinc-600 select-none shrink-0 text-right w-8 border-r border-zinc-800/50">{idx + 1}</span>
                          <span className="px-1.5 py-0.5 text-zinc-500 shrink-0">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '—'}</span>
                          <span className={`px-1.5 py-0.5 uppercase font-bold shrink-0 w-12 ${log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-amber-400' : log.level === 'info' ? 'text-cyan-400' : 'text-zinc-500'}`}>{log.level}</span>
                          <span className="px-1.5 py-0.5 text-emerald-400/80 shrink-0 w-20 truncate">{log.source}</span>
                          <span className={`px-1.5 py-0.5 break-all ${log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-200' : 'text-zinc-300'}`}>{log.message}</span>
                        </div>
                      ))
                    })()}
                  </div>
                </div>
              </div>
            )}
            </motion.div>
          </TabsContent>

          {/* ======================== DEPLOYMENTS TAB — real rebuild/repair history ======================== */}
          <TabsContent value="deployments" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <div className="space-y-4">
                {loadingActivity ? (
                  <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-4 w-4 text-rose-500" />
                      <span className="text-sm font-semibold">{t('dlg.detail.buildRepairHistory')}</span>
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{opsEvents.length}</Badge>
                      <span className="ml-auto text-[10px] text-muted-foreground">{t('dlg.detail.opsHint')}</span>
                    </div>

                    {opsEvents.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <GitBranch className="h-10 w-10 text-muted-foreground/20 mb-3" />
                        <p className="text-sm text-muted-foreground">{t('dlg.detail.noBuildEvents')}</p>
                        <p className="text-xs text-muted-foreground/70 mt-1">{t('dlg.detail.noBuildEventsHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-0">
                        {opsEvents.map((ev, idx) => {
                          const failed = ev.level === 'error'
                          const durMs = typeof ev.metadata?.durationMs === 'number' ? (ev.metadata.durationMs as number) : null
                          const envName = (ev.metadata?.environmentName as string) || null
                          const detail = (ev.metadata?.detail as string) || null
                          const kindLabel = ev.type === 'rebuild' ? t('dlg.detail.kindRebuild') : ev.type === 'repair' ? t('dlg.detail.kindRepair') : t('dlg.detail.kindApply')
                          return (
                            <div key={ev.id} className="relative pl-8 pb-4">
                              {idx < opsEvents.length - 1 && <div className="deployment-timeline-line" />}
                              <div className={`absolute left-1.5 top-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ${
                                failed ? 'bg-red-100 dark:bg-red-900/30 ring-red-300 dark:ring-red-700/50'
                                : 'bg-emerald-100 dark:bg-emerald-900/30 ring-emerald-300 dark:ring-emerald-700/50'
                              }`}>
                                {failed ? <XCircle className="h-3 w-3 text-red-600 dark:text-red-400" /> : <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
                              </div>
                              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-mono text-xs font-bold shrink-0">{kindLabel}</span>
                                    {envName && <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">{envName}</Badge>}
                                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${
                                      failed ? 'border-red-300 text-red-700 dark:border-red-600 dark:text-red-300'
                                      : 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300'
                                    }`}>{failed ? t('dlg.detail.failed') : t('dlg.detail.success')}</Badge>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground shrink-0">{formatTimeAgo(ev.timestamp, t)}</span>
                                </div>
                                <p className="text-[11px] text-muted-foreground mt-1">{ev.message}</p>
                                {(durMs != null || detail) && (
                                  <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground min-w-0">
                                    {durMs != null && (
                                      <span className="flex items-center gap-0.5 shrink-0"><Clock className="h-2.5 w-2.5" />{(durMs / 1000).toFixed(1)}s</span>
                                    )}
                                    {detail && (
                                      <span className="truncate" title={detail}>{detail}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </TabsContent>
          <TabsContent value="timeline" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            <ProjectStatusTimeline project={project} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

// ======================== PROJECT STATUS TIMELINE ========================

interface TimelineEvent {
  id: string
  timestamp: string
  oldStatus: string
  newStatus: string
  envName: string
  envPort: number
}

function generateSampleTimeline(project: Project): TimelineEvent[] {
  const envs = project.environments || []
  if (envs.length === 0) return []

  const events: TimelineEvent[] = []
  const now = Date.now()
  const statusCycle: Array<{ from: string; to: string }> = [
    { from: 'stopped', to: 'running' },
    { from: 'running', to: 'stopped' },
    { from: 'stopped', to: 'running' },
    { from: 'running', to: 'running' }, // restart
    { from: 'running', to: 'stopped' },
    { from: 'stopped', to: 'running' },
  ]

  // Generate 8-14 events per project
  const count = 8 + Math.floor(Math.abs(Math.sin(project.id.charCodeAt(0) * 17)) * 7)
  for (let i = 0; i < count; i++) {
    const envIdx = i % envs.length
    const env = envs[envIdx]
    const cycle = statusCycle[i % statusCycle.length]
    events.push({
      id: `tl_${project.id}_${i}`,
      timestamp: new Date(now - i * 2400000 - Math.floor(Math.abs(Math.cos(i * 3.7)) * 1800000)).toISOString(),
      oldStatus: cycle.from,
      newStatus: cycle.to,
      envName: env.name,
      envPort: env.port,
    })
  }

  return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

function getTimelineDotColor(status: string): string {
  if (status === 'running') return 'bg-emerald-500 ring-emerald-300 dark:ring-emerald-700/50'
  if (status === 'stopped') return 'bg-red-500 ring-red-300 dark:ring-red-700/50'
  return 'bg-amber-500 ring-amber-300 dark:ring-amber-700/50'
}

function getTimelineStatusLabel(oldStatus: string, newStatus: string, t?: I18nContextValue['t']): { text: string; className: string } {
  if (oldStatus === 'stopped' && newStatus === 'running') return { text: t ? t('dlg.timeline.started') : 'Started', className: 'text-emerald-600 dark:text-emerald-400' }
  if (oldStatus === 'running' && newStatus === 'stopped') return { text: t ? t('dlg.timeline.stopped') : 'Stopped', className: 'text-red-600 dark:text-red-400' }
  if (oldStatus === 'running' && newStatus === 'running') return { text: t ? t('dlg.timeline.restarted') : 'Restarted', className: 'text-amber-600 dark:text-amber-400' }
  return { text: `${oldStatus} → ${newStatus}`, className: 'text-muted-foreground' }
}

function ProjectStatusTimeline({ project }: { project: Project }) {
  const t = useT()
  const [timelineEvents, setTimelineEvents] = React.useState<TimelineEvent[]>([])

  React.useEffect(() => {
    const storedKey = `project-timeline-${project.id}`
    try {
      const stored = localStorage.getItem(storedKey)
      if (stored) {
        setTimelineEvents(JSON.parse(stored))
      } else {
        const sample = generateSampleTimeline(project)
        setTimelineEvents(sample)
        localStorage.setItem(storedKey, JSON.stringify(sample))
      }
    } catch {
      const sample = generateSampleTimeline(project)
      setTimelineEvents(sample)
    }
  }, [project.id])

  const addTimelineEvent = React.useCallback((event: Omit<TimelineEvent, 'id'>) => {
    const newEvent: TimelineEvent = { ...event, id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }
    setTimelineEvents((prev) => {
      const next = [newEvent, ...prev].slice(0, 50)
      try { localStorage.setItem(`project-timeline-${project.id}`, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [project.id])
  // Record env action events to timeline
  React.useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { projectId, envId, action } = e.detail || {}
      if (projectId !== project.id) return
      const env = (project.environments || []).find((e) => e.id === envId)
      if (!env) return
      const statusMap: Record<string, { old: string; new: string }> = {
        start: { old: 'stopped', new: 'running' },
        stop: { old: 'running', new: 'stopped' },
        restart: { old: 'running', new: 'running' },
      }
      const change = statusMap[action]
      if (change) {
        addTimelineEvent({ timestamp: new Date().toISOString(), oldStatus: change.old, newStatus: change.new, envName: env.name, envPort: env.port })
      }
    }
    window.addEventListener('env-action' as string, handler as EventListener)
    return () => window.removeEventListener('env-action' as string, handler as EventListener)
  }, [project, addTimelineEvent])

  const envLabel = (name: string) => name === 'development' ? 'dev' : name === 'production' ? 'prod' : name

  return (
    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-cyan-500" />
          <span className="text-sm font-semibold">{t('dlg.timeline.title')}</span>
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{timelineEvents.length}</Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] text-muted-foreground"
          onClick={() => {
            const sample = generateSampleTimeline(project)
            setTimelineEvents(sample)
            try { localStorage.setItem(`project-timeline-${project.id}`, JSON.stringify(sample)) } catch { /* ignore */ }
            addToast({ title: t('dlg.timeline.refreshed'), variant: 'success' })
          }}
        >
          <RefreshCw className="h-3 w-3 mr-1" />{t('dlg.timeline.regenerate')}
        </Button>
      </div>

      {timelineEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Clock className="h-10 w-10 text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground">{t('dlg.timeline.noEvents')}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{t('dlg.timeline.noEventsHint')}</p>
        </div>
      ) : (
        <div className="relative pl-7 space-y-0">
          {/* Vertical line */}
          <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border/40 dark:bg-zinc-700/40" />
          {timelineEvents.map((event, idx) => {
            const label = getTimelineStatusLabel(event.oldStatus, event.newStatus, t)
            return (
              <div key={event.id} className="relative pb-4 group/tl">
                {/* Dot */}
                <div className={`absolute -left-7 top-1 h-3.5 w-3.5 rounded-full ring-2 ring-background dark:ring-zinc-900 ${getTimelineDotColor(event.newStatus)} transition-transform group-hover/tl:scale-125`} />
                {/* Content */}
                <div className="rounded-lg border bg-muted/20 px-3 py-2 group-hover/tl:bg-muted/40 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-semibold ${label.className}`}>{label.text}</span>
                      <span className="text-[10px] text-muted-foreground">·</span>
                      <span className="text-[10px] text-muted-foreground">
                        {envLabel(event.envName)}
                        <span className="font-mono ml-0.5">:{event.envPort}</span>
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">{formatTimeAgo(event.timestamp, t)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground/70">
                    <span className="flex items-center gap-0.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${event.oldStatus === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      {event.oldStatus === 'running' ? t('dlg.detail.statusRunning') : t('dlg.detail.statusStopped')}
                    </span>
                    <span>→</span>
                    <span className="flex items-center gap-0.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${event.newStatus === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      {event.newStatus === 'running' ? t('dlg.detail.statusRunning') : t('dlg.detail.statusStopped')}
                    </span>
                    <span className="text-muted-foreground/50 ml-1">{new Date(event.timestamp).toLocaleString()}</span>
                  </div>
                </div>
                {idx < timelineEvents.length - 1 && (
                  <div className="absolute -left-[4.5px] top-5 bottom-0 w-px bg-border/20 dark:bg-zinc-700/20" />
                )}
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

// ======================== GLOBAL STATUS PANEL ========================

function GlobalStatusPanel({ projects }: { projects: Project[] }) {
  const t = useT()
  const [collapsed, setCollapsed] = React.useState(true)
  const totalEnvs = projects.reduce((a, p) => a + (p.environments?.length || 0), 0)
  const runningEnvs = projects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0)
  const healthScore = totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0

  if (collapsed) {
    return (
      <motion.button
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        className="fixed bottom-20 sm:bottom-16 left-4 z-40 h-8 w-8 sm:h-10 sm:w-10 rounded-full bg-card surface-card border flex items-center justify-center hover:bg-accent transition-colors"
        onClick={() => setCollapsed(false)}
      >
        <Activity className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${healthColor(healthScore)}`} />
      </motion.button>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-20 sm:bottom-16 left-4 z-40 rounded-lg border shadow-xl backdrop-blur-sm bg-card/95 p-3 sm:max-w-xs max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5"><Zap className="h-3 w-3 text-emerald-500" /><span className="text-xs font-semibold dark:text-zinc-200 text-emerald-700 dark:text-emerald-400">{t('surf.systemHealth')}</span></div>
        <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md hover:bg-accent" onClick={() => setCollapsed(true)}><ChevronDown className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-zinc-400">{t('surf.projectsLabel')}</span>
          <span className="font-medium dark:text-zinc-200">{projects.length}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-zinc-400">{t('surf.environmentsLabel')}</span>
          <span className="font-medium dark:text-zinc-200">{t('card.preview.runningFraction', { running: runningEnvs, total: totalEnvs })}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-zinc-400">{t('surf.healthLabel')}</span>
          <span className={`font-semibold ${healthColor(healthScore)}`}>{healthScore}%</span>
        </div>
        <Progress value={healthScore} className="h-1.5" />
      </div>
    </motion.div>
  )
}

// ======================== ENHANCED FOOTER ========================

function EnhancedFooter({ projects, filteredCount, onOpenDevices, devices, onOpenSystemMonitor, onOpenPorts, onRefresh, onAddProject }: { projects: Project[]; filteredCount: number; onOpenDevices: () => void; devices: Device[]; onOpenSystemMonitor: () => void; onOpenPorts: () => void; onRefresh?: () => void; onAddProject?: () => void }) {
  const t = useT()
  const totalEnvs = projects.reduce((a, p) => a + (p.environments?.length || 0), 0)
  const runningEnvs = projects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0)
  const onlineDevices = devices.filter((d) => d.status === 'online').length
  const totalDevices = devices.length
  const healthRatio = totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0

  // Last refreshed timer
  const [lastRefreshAgo, setLastRefreshAgo] = React.useState(0)
  React.useEffect(() => {
    const interval = setInterval(() => setLastRefreshAgo((prev) => prev + 1), 5000)
    return () => clearInterval(interval)
  }, [])
  // Reset timer when projects change (i.e., when data refreshes)
  React.useEffect(() => { setLastRefreshAgo(0) }, [projects])

  // Current time display — updates every 60 seconds (null on SSR to avoid hydration mismatch)
  const [currentTime, setCurrentTime] = React.useState<string | null>(null)
  React.useEffect(() => {
    const update = () => setCurrentTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [])

  // Network status — assume connected, detect offline
  const [isOnline, setIsOnline] = React.useState(true)
  React.useEffect(() => {
    setIsOnline(navigator.onLine)
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return (
    <motion.footer
      initial={{ y: 20 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="mt-auto relative border-t border-border/60 bg-card/80 backdrop-blur-xl shadow-[0_-4px_16px_rgba(9,9,11,0.04)] dark:bg-card/50 dark:border-zinc-800/70 dark:shadow-[0_-4px_16px_rgba(0,0,0,0.35)]"
    >
      <div className="footer-hairline" aria-hidden="true" />
      <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3 text-xs text-foreground/80 dark:text-zinc-300">
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-5">
          <span className="flex items-center gap-1.5">
            {/* Animated pulse dot when envs running */}
            <span className="relative flex h-2 w-2">
              {runningEnvs > 0 && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${runningEnvs > 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
            </span>
            <span className="font-bold dark:text-zinc-200">{runningEnvs}/{totalEnvs}</span>
            <span className="text-muted-foreground dark:text-zinc-400">{t('surf.running')}</span>
          </span>
          {/* Mini health bar */}
          <div className="hidden sm:flex items-center gap-1.5">
            <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${healthRatio >= 80 ? 'bg-emerald-500' : healthRatio >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${healthRatio}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground">{healthRatio}%</span>
          </div>
          <span className="text-muted-foreground dark:text-zinc-400 hidden sm:inline">·</span>
          <span className="dark:text-zinc-300 font-medium">{t('surf.projectsCount', { count: projects.length })}</span>
          {filteredCount !== projects.length && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">{t('surf.showing', { shown: filteredCount, total: projects.length })}</span>
          )}
          <span className="text-muted-foreground dark:text-zinc-400 hidden sm:inline">·</span>
          <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground dark:text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${totalDevices === 0 ? 'bg-zinc-400' : onlineDevices > 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
            {t('surf.devicesOnline', { online: onlineDevices, total: totalDevices + 1 })}
          </span>
          <span className="text-muted-foreground dark:text-zinc-400 hidden sm:inline">·</span>
          <span className="hidden sm:inline text-[11px] text-muted-foreground dark:text-zinc-400">{t('surf.lastUpdatedAgo', { seconds: lastRefreshAgo })}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Network status indicator */}
          <span className={`hidden md:inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${isOnline ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400'}`}>
            <Wifi className="h-2.5 w-2.5" />
            {isOnline ? t('surf.connected') : t('dlg.common.offline')}
          </span>
          {/* Current time */}
          <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground dark:text-zinc-400 tabular-nums">
            <Clock className="h-2.5 w-2.5" />
            {currentTime ?? '--:--'}
          </span>
          {/* Keyboard shortcut hints */}
          <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-muted-foreground dark:text-zinc-400">
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">⌘K</kbd>
            <span>{t('surf.kbdSearch')}</span>
            <span className="mx-0.5">·</span>
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">?</kbd>
            <span>{t('surf.kbdShortcuts')}</span>
            <span className="mx-0.5">·</span>
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">↑↓</kbd>
            <span>{t('surf.kbdNavigate')}</span>
          </div>
          {/* Quick action buttons */}
          {onRefresh && (
            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all active:scale-90" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent>{t('dlg.common.refresh')}</TooltipContent></Tooltip></TooltipProvider>
          )}
          {onAddProject && (
            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all active:scale-90" onClick={onAddProject}><Plus className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent>{t('topbar.addProject')}</TooltipContent></Tooltip></TooltipProvider>
          )}
          <button className="flex items-center gap-1.5 hover:text-foreground transition-colors px-2.5 sm:px-3 py-1.5 rounded-md bg-brand-soft text-brand-strong hover:bg-brand-soft-strong ring-1 ring-brand/25 dark:ring-brand/20 active:scale-95 font-medium" onClick={onOpenDevices}>
            <Plug className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">{t('surf.devices')}</span>
            {totalDevices > 0 && (
              <span className="text-[9px] px-1 py-0 rounded-full bg-brand-soft-strong text-brand-strong font-semibold">{onlineDevices}/{totalDevices}</span>
            )}
          </button>
          <button className="flex items-center gap-1.5 hover:text-foreground transition-colors px-2.5 sm:px-3 py-1.5 rounded-md bg-brand-soft text-brand-strong hover:bg-brand-soft-strong ring-1 ring-brand/25 dark:ring-brand/20 active:scale-95 font-medium" onClick={onOpenSystemMonitor}>
            <Monitor className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">{t('surf.system')}</span>
          </button>
          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all active:scale-90" onClick={onOpenPorts}><Network className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent>{t('ports.title')}</TooltipContent></Tooltip></TooltipProvider>
        </div>
      </div>
    </motion.footer>
  )
}

// ======================== DEVICE MANAGEMENT PANEL ========================

function DeviceManagementPanel({
  open, onClose, devices, onAdd, onEdit, onDelete, onHealthCheck, onOpenDeployGuide, onOpenPairing, onOpenRemoteProject, onOpenJoin
}: {
  open: boolean
  onClose: () => void
  devices: Device[]
  onAdd: () => void
  onEdit: (device: Device) => void
  onDelete: (id: string) => void
  onHealthCheck: (id: string) => Promise<{ status: string } | null>
  onOpenDeployGuide: () => void
  onOpenPairing: () => void
  onOpenRemoteProject: () => void
  onOpenJoin: () => void
}) {
  const t = useT()
  const [healthCheckingIds, setHealthCheckingIds] = React.useState<Set<string>>(new Set())
  const [testingIds, setTestingIds] = React.useState<Set<string>>(new Set())
  const [testResults, setTestResults] = React.useState<Record<string, { latency: number; success: boolean } | null>>({})

  const onlineCount = devices.filter((d) => d.status === 'online').length
  const offlineCount = devices.filter((d) => d.status !== 'online').length

  const handleHealthCheck = async (id: string) => {
    setHealthCheckingIds((prev) => new Set(prev).add(id))
    await onHealthCheck(id)
    setHealthCheckingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleTestConnection = async (device: Device) => {
    setTestingIds((prev) => new Set(prev).add(device.id))
    const start = performance.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`http://${device.ip}:${device.port}/api/health`, { signal: controller.signal })
      clearTimeout(timeout)
      const latency = Math.round(performance.now() - start)
      setTestResults((prev) => ({ ...prev, [device.id]: { latency, success: res.ok } }))
    } catch {
      const latency = Math.round(performance.now() - start)
      setTestResults((prev) => ({ ...prev, [device.id]: { latency, success: false } }))
    }
    setTestingIds((prev) => {
      const next = new Set(prev)
      next.delete(device.id)
      return next
    })
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-hidden p-0 flex flex-col dark:bg-zinc-900/98 dark:border-l dark:border-zinc-800/60">
        <SheetHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/50 dark:ring-teal-800/30">
              <Plug className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle>{t('dlg.devicePanel.title')}</SheetTitle>
              <SheetDescription className="text-xs">{t('dlg.devicePanel.desc')}</SheetDescription>
            </div>
            <Button size="sm" variant="outline" onClick={onOpenJoin} className="h-7 text-xs border-cyan-300 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-700 dark:text-cyan-400 dark:hover:bg-cyan-900/20">
              <MonitorSmartphone className="h-3 w-3 mr-1" />{t('dlg.devicePanel.join')}
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenPairing} className="h-7 text-xs border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-900/20">
              <PlugZap className="h-3 w-3 mr-1" />{t('dlg.devicePanel.pair')}
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenDeployGuide} className="h-7 text-xs border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20">
              <Download className="h-3 w-3 mr-1" />{t('dlg.devicePanel.deploy')}
            </Button>
            <Button size="sm" onClick={onAdd} className="bg-teal-600 hover:bg-teal-700 text-white h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" />{t('dlg.devicePanel.addDevice')}
            </Button>
          </div>
        </SheetHeader>

        {/* Device Stats Bar */}
        {devices.length > 0 && (
          <div className="px-4 py-3 border-b bg-muted/20 dark:bg-zinc-800/20">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-lg font-bold dark:text-zinc-100">{devices.length}</div>
                <div className="text-[10px] text-muted-foreground dark:text-zinc-400 font-medium">{t('dlg.devicePanel.total')}</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{onlineCount}</div>
                <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/60 font-medium">{t('dlg.common.online')}</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-red-500 dark:text-red-400">{offlineCount}</div>
                <div className="text-[10px] text-red-500/70 dark:text-red-400/60 font-medium">{t('dlg.common.offline')}</div>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={onOpenRemoteProject}
              className="w-full mt-2.5 h-8 text-xs border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20"
            >
              <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" />
              {t('dlg.devicePanel.addRemote')}
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-6 rounded-2xl bg-gradient-to-br from-teal-50/80 to-cyan-50/60 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/30 dark:ring-teal-800/20 shadow-inner mb-4">
                <Plug className="h-12 w-12 text-teal-600/70 dark:text-teal-400/60" />
              </div>
              <h3 className="text-sm font-semibold mb-1">{t('dlg.devicePanel.noDevices')}</h3>
              <p className="text-xs text-muted-foreground dark:text-zinc-400 mb-4 max-w-xs">{t('dlg.devicePanel.noDevicesDesc')}</p>
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <Button onClick={onOpenPairing} size="sm" className="bg-orange-500 hover:bg-orange-600 text-white">
                  <PlugZap className="h-3 w-3 mr-1" />{t('dlg.devicePanel.oneClickPair')}
                </Button>
                <Button onClick={onOpenJoin} size="sm" className="bg-cyan-600 hover:bg-cyan-700 text-white">
                  <MonitorSmartphone className="h-3 w-3 mr-1" />{t('dlg.devicePanel.join')}
                </Button>
                <Button onClick={onAdd} size="sm" className="bg-teal-600 hover:bg-teal-700 text-white">
                  <Plus className="h-3 w-3 mr-1" />{t('dlg.devicePanel.addDevice')}
                </Button>
                <Button onClick={onOpenDeployGuide} size="sm" variant="outline" className="border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20">
                  <Download className="h-3 w-3 mr-1" />{t('dlg.devicePanel.deploy')}
                </Button>
              </div>
            </div>
          ) : (
            devices.map((device) => (
              <motion.div
                key={device.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`rounded-lg border p-3.5 space-y-2.5 hover:shadow-md transition-shadow ${
                  device.status === 'online'
                    ? 'border-emerald-200/50 dark:border-emerald-800/30 bg-emerald-50/20 dark:bg-emerald-900/5'
                    : device.status === 'error'
                    ? 'border-amber-200/50 dark:border-amber-800/30 bg-amber-50/20 dark:bg-amber-900/5'
                    : 'border-red-200/50 dark:border-red-800/30 bg-red-50/20 dark:bg-red-900/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  <AnimatedStatusDot status={device.status === 'online' ? 'running' : 'offline'} size="md" />
                  <span className="font-medium text-sm truncate">{device.name}</span>
                  <Badge variant="outline" className={`text-[9px] ml-auto shrink-0 ${device.status === 'online' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20' : device.status === 'error' ? 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'}`}>
                    {device.status === 'online' ? t('dlg.common.online') : device.status === 'error' ? t('dlg.devicePanel.statusError') : t('dlg.common.offline')}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-muted-foreground dark:text-zinc-400">{device.ip}:{device.port}</span>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-muted dark:hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
                      onClick={() => { navigator.clipboard.writeText(`${device.ip}:${device.port}`); addToast({ title: t('dlg.toast.copiedShort'), description: `${device.ip}:${device.port}`, variant: 'success' }) }}
                      title={t('dlg.devicePanel.copyIpPort')}
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Folder className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground dark:text-zinc-400">{t('dlg.devicePanel.projects', { count: device.projectCount ?? 0 })}</span>
                    {device.projectCount !== undefined && device.projectCount > 0 && (
                      <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5 bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{device.projectCount}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 col-span-2">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground dark:text-zinc-400">{t('dlg.devicePanel.lastSeen', { time: device.lastSeen ? formatTimeAgo(device.lastSeen, t) : t('dlg.common.never') })}</span>
                  </div>
                </div>
                {/* Connection test result */}
                {testResults[device.id] && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className={`text-[10px] px-2 py-1 rounded-md ${
                      testResults[device.id]!.success
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                        : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                    }`}
                  >
                    {testResults[device.id]!.success
                      ? t('dlg.devicePanel.connectedIn', { latency: testResults[device.id]!.latency })
                      : t('dlg.devicePanel.unreachable', { latency: testResults[device.id]!.latency })
                    }
                  </motion.div>
                )}
                <div className="flex items-center gap-1.5 pt-1">
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => onEdit(device)}>
                    <Edit3 className="h-3 w-3 mr-1" />{t('dlg.common.edit')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => handleTestConnection(device)} disabled={testingIds.has(device.id)}>
                    {testingIds.has(device.id) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}
                    {t('dlg.devicePanel.test')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => handleHealthCheck(device.id)} disabled={healthCheckingIds.has(device.id)}>
                    {healthCheckingIds.has(device.id) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Activity className="h-3 w-3 mr-1" />}
                    {t('dlg.devicePanel.health')}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:bg-red-50 dark:hover:bg-red-900/20 px-2">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('dlg.devicePanel.deleteTitle', { name: device.name })}</AlertDialogTitle>
                        <AlertDialogDescription>{t('dlg.devicePanel.deleteDesc')}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('dlg.common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(device.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t('dlg.common.delete')}</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ======================== DEVICE FORM DIALOG ========================

function DeviceFormDialog({
  open, onClose, onSubmit, device, mode
}: {
  open: boolean
  onClose: () => void
  onSubmit: (data: { name: string; ip: string; port: number; apiKey: string; icon?: string }) => void
  device?: Device | null
  mode: 'add' | 'edit'
}) {
  const t = useT()
  const [name, setName] = React.useState(() => mode === 'edit' && device ? device.name : '')
  const [ip, setIp] = React.useState(() => mode === 'edit' && device ? device.ip : '')
  const [port, setPort] = React.useState(() => mode === 'edit' && device ? String(device.port) : '3100')
  const [apiKey, setApiKey] = React.useState(() => mode === 'edit' && device ? device.apiKey : '')
  const [showApiKey, setShowApiKey] = React.useState(false)
  // P-fix-device-emojis: replaced emoji picker with a lucide-react icon picker.
  // No emojis anywhere in the device UI. Each entry is { key, Icon } so React's
  // `key` prop is always unique (previous version had duplicate 🔧 and crashed
  // with "Encountered two children with the same key, 🔧").
  const DEVICE_ICONS: { key: string; Icon: React.ElementType; label: string }[] = [
    { key: 'monitor',     Icon: Monitor,     label: t('dlg.deviceForm.icon.monitor') },
    { key: 'server',      Icon: Server,      label: t('dlg.deviceForm.icon.server') },
    { key: 'smartphone',  Icon: Smartphone,  label: t('dlg.deviceForm.icon.smartphone') },
    { key: 'cloud',       Icon: Cloud,       label: t('dlg.deviceForm.icon.cloud') },
    { key: 'container',   Icon: Container,   label: t('dlg.deviceForm.icon.container') },
    { key: 'wrench',      Icon: Wrench,      label: t('dlg.deviceForm.icon.wrench') },
    { key: 'zap',         Icon: Zap,         label: t('dlg.deviceForm.icon.zap') },
    { key: 'building',    Icon: Building,    label: t('dlg.deviceForm.icon.building') },
    { key: 'home',        Icon: House,       label: t('dlg.deviceForm.icon.home') },
    { key: 'globe',       Icon: Globe,       label: t('dlg.deviceForm.icon.globe') },
    { key: 'database',    Icon: Database,    label: t('dlg.deviceForm.icon.database') },
    { key: 'cpu',         Icon: CpuIcon,     label: t('dlg.deviceForm.icon.cpu') },
    { key: 'plug-zap',    Icon: PlugZap,     label: t('dlg.deviceForm.icon.plug-zap') },
    { key: 'shield',      Icon: Shield,      label: t('dlg.deviceForm.icon.shield') },
    { key: 'box',         Icon: Box,         label: t('dlg.deviceForm.icon.box') },
  ]
  const [icon, setIcon] = React.useState(() => {
    if (mode === 'edit' && device) {
      return device.icon || 'monitor'
    }
    return 'monitor'
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !ip.trim()) return
    onSubmit({ name: name.trim(), ip: ip.trim(), port: parseInt(port) || 3100, apiKey: apiKey.trim(), icon })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? t('dlg.deviceForm.addTitle') : t('dlg.deviceForm.editTitle')}</DialogTitle>
          <DialogDescription>{mode === 'add' ? t('dlg.deviceForm.addDesc') : t('dlg.deviceForm.editDesc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label>{t('dlg.deviceForm.icon')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {DEVICE_ICONS.map(({ key: iconKey, Icon, label }) => {
                const active = icon === iconKey
                return (
                  <button
                    key={iconKey}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => setIcon(iconKey)}
                    className={`p-1.5 rounded-md border transition-colors ${
                      active
                        ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20 ring-1 ring-teal-500/30'
                        : 'border-border hover:bg-accent'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? 'text-teal-600 dark:text-teal-400' : 'text-muted-foreground'}`} />
                  </button>
                )
              })}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-name">{t('dlg.deviceForm.name')}</Label>
            <div className="flex items-center gap-2">
              {(() => {
                const selected = DEVICE_ICONS.find((d) => d.key === icon)
                const SelectedIcon = selected?.Icon ?? Monitor
                return <SelectedIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              })()}
              <Input id="device-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook Pro" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-ip">{t('dlg.deviceForm.ip')}</Label>
            <Input id="device-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-port">{t('dlg.deviceForm.port')}</Label>
            <Input id="device-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-apikey">{t('dlg.deviceForm.apiKey')}</Label>
            <div className="relative">
              <Input
                id="device-apikey"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('dlg.deviceForm.autoKey')}
                className="pr-10 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                title={showApiKey ? t('dlg.deviceForm.hideKey') : t('dlg.deviceForm.showKey')}
                aria-label={showApiKey ? t('dlg.deviceForm.hideKey') : t('dlg.deviceForm.showKey')}
                aria-pressed={showApiKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('dlg.common.cancel')}</Button>
            <Button type="submit" disabled={!name.trim() || !ip.trim()} className="bg-teal-600 hover:bg-teal-700 text-white">
              {mode === 'add' ? t('dlg.deviceForm.addBtn') : t('dlg.deviceForm.updateBtn')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ======================== SKELETON LOADING ========================

function ProjectCardSkeleton() {
  return (
    <div className="surface-card rounded-xl border border-zinc-200 dark:border-zinc-800 bg-card overflow-hidden relative skeleton-card">
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brand/50 via-brand/15 to-transparent" />
      <div className="absolute inset-0 animate-shimmer pointer-events-none rounded-xl" />
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-muted/70 skeleton-shimmer-block" />
          <div className="flex-1 space-y-1.5">
            <div className="h-4 w-28 rounded bg-muted/70 skeleton-shimmer-block" />
            <div className="h-3 w-40 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '100ms' }} />
          </div>
          <div className="h-7 w-7 rounded-full bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '100ms' }} />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-full rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '150ms' }} />
          <div className="h-3 w-2/3 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '200ms' }} />
        </div>
        <div className="flex gap-1.5">
          <div className="h-5 w-14 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '150ms' }} />
          <div className="h-5 w-14 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '200ms' }} />
          <div className="h-5 w-10 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '250ms' }} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2 py-2 rounded-lg">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-muted/70 skeleton-shimmer-block" />
              <div className="h-4 w-8 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '200ms' }} />
              <div className="h-3 w-6 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '250ms' }} />
            </div>
            <div className="flex items-center gap-1">
              <div className="h-4 w-8 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '250ms' }} />
              <div className="h-5 w-5 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
          <div className="flex items-center justify-between px-2 py-2 rounded-lg">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '200ms' }} />
              <div className="h-4 w-8 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '250ms' }} />
              <div className="h-3 w-6 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '300ms' }} />
            </div>
            <div className="flex items-center gap-1">
              <div className="h-4 w-8 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '300ms' }} />
              <div className="h-5 w-5 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '350ms' }} />
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/40 rounded-b-xl">
        <div className="px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-5 w-20 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '300ms' }} />
            <div className="h-3 w-10 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '350ms' }} />
          </div>
          <div className="flex gap-1">
            <div className="h-7 w-14 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '350ms' }} />
            <div className="h-7 w-7 rounded-md bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: '400ms' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

function LoadingSkeleton({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="surface-card flex items-center gap-3 p-3.5 rounded-lg border bg-card dark:bg-zinc-900/80 relative overflow-hidden">
            <div className="absolute inset-0 animate-shimmer pointer-events-none" />
            <div className="h-4 w-4 rounded bg-muted/70 skeleton-shimmer-block" />
            <div className="h-5 w-5 rounded bg-muted/70 skeleton-shimmer-block" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-32 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: `${i * 100}ms` }} />
              <div className="h-3 w-48 rounded bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: `${i * 100 + 50}ms` }} />
            </div>
            <div className="h-8 w-8 rounded-full bg-muted/70 skeleton-shimmer-block" style={{ animationDelay: `${i * 100 + 100}ms` }} />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <ProjectCardSkeleton key={i} />
      ))}
    </div>
  )
}

// ======================== EMPTY STATE ========================

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const t = useT()
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <motion.div
        className="p-8 rounded-2xl bg-gradient-to-br from-emerald-50/80 via-teal-50/40 to-cyan-50/60 dark:from-emerald-900/20 dark:via-teal-900/10 dark:to-cyan-900/15 ring-1 ring-emerald-200/30 dark:ring-emerald-800/20 shadow-inner mb-6"
        animate={{ y: [0, -12, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Folder className="h-16 w-16 text-emerald-600/70 dark:text-emerald-400/60" />
      </motion.div>
      <h3 className="text-lg font-semibold mb-1 text-foreground">{t('surf.emptyTitle')}</h3>
      <p className="text-sm text-muted-foreground dark:text-zinc-400 mb-5 max-w-xs">{t('surf.emptyDesc')}</p>
      <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
        <Button onClick={onAdd} className="bg-primary hover:bg-primary/90 text-primary-foreground h-10 px-6 text-sm font-semibold shadow-sm transition-colors">
          <Plus className="h-4 w-4 mr-2" />{t('surf.createProject')}
        </Button>
      </motion.div>
    </div>
  )
}

// ======================== MAIN PAGE COMPONENT ========================
// Gated by auth (see DashboardPage/AuthGate at the bottom of this file):
// renders only for authenticated + approved users.

function DashboardInner({ session }: { session: DashboardSession }) {
  // i18n (task 17): top-bar chrome strings
  const { t } = useI18n()
  // State
  const [userMgmtOpen, setUserMgmtOpen] = React.useState(false)
  const [changePwOpen, setChangePwOpen] = React.useState(false)
  const [adminPendingCount, setAdminPendingCount] = React.useState(0)
  const [projects, setProjects] = React.useState<Project[]>(() => readProjectsCacheOnce().data)
  const [notifications, setNotifications] = React.useState<Notification[]>([])
  // Skeleton only when there is no cached paint — a cache hit renders data on
  // the very first frame, killing the skeleton flash + one wasted render.
  const [loading, setLoading] = React.useState(() => !readProjectsCacheOnce().hit)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [viewMode, setViewMode] = React.useState<ViewMode>(() => {
    try { const v = localStorage.getItem('dashboard-viewMode'); return v === 'grid' || v === 'list' ? v : 'grid' } catch { return 'grid' }
  })
  const [sortBy, setSortBy] = React.useState<SortOption>(() => {
    try {
      const v = localStorage.getItem('dashboard-sortBy')
      // One-time migration: 'custom' used to be the default; the default is
      // now port ascending. Explicitly chosen sorts are still honored, and
      // after this runs once, drag-to-reorder ('custom') persists normally.
      if (v === 'custom' && localStorage.getItem('dashboard-sortBy-migrated') !== '1') {
        localStorage.setItem('dashboard-sortBy-migrated', '1')
        return 'port'
      }
      return v === 'newest' || v === 'name' || v === 'status' || v === 'custom' || v === 'port' ? v : 'port'
    } catch { return 'port' }
  })
  // Sort direction for the non-custom sorts ('asc' = natural forward order:
  // port small→large, A→Z, newest first, running first). Toggle button flips it.
  const [sortDir, setSortDir] = React.useState<SortDir>(() => {
    try { return localStorage.getItem('dashboard-sortDir') === 'desc' ? 'desc' : 'asc' } catch { return 'asc' }
  })
  const [filterStatus, setFilterStatus] = React.useState<FilterStatus>('all')
  const [filterTags, setFilterTags] = React.useState<string[]>([])
  const [groupBy, setGroupBy] = React.useState<GroupBy>(() => {
    try { const v = localStorage.getItem('dashboard-groupBy'); return v === 'device' || v === 'tags' || v === 'none' ? v : 'device' } catch { return 'device' }
  })
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [projectFormOpen, setProjectFormOpen] = React.useState(false)
  const [projectFormMode, setProjectFormMode] = React.useState<'add' | 'edit'>('add')
  const [editingProject, setEditingProject] = React.useState<Project | null>(null)
  const [deleteProject, setDeleteProject] = React.useState<Project | null>(null)
  const [envFormOpen, setEnvFormOpen] = React.useState(false)
  const [envFormMode, setEnvFormMode] = React.useState<'add' | 'edit'>('add')
  const [editingEnv, setEditingEnv] = React.useState<Environment | null>(null)
  const [addEnvProjectId, setAddEnvProjectId] = React.useState<string>('')
  const [systemMonitorOpen, setSystemMonitorOpen] = React.useState(false)
  const [portsPanelOpen, setPortsPanelOpen] = React.useState(false)
  const [llmOpen, setLlmOpen] = React.useState(false)
  const [repairJobId, setRepairJobId] = React.useState<string | null>(null)
  const [repairDialogOpen, setRepairDialogOpen] = React.useState(false)
  const [harnessSession, setHarnessSession] = React.useState<HarnessSessionState | null>(null)

  // Restore an in-flight analysis wizard after an HMR remount / reload —
  // otherwise a completed-but-unapplied analysis is lost and the user has
  // no way to reach its result.
  React.useEffect(() => {
    try {
      const raw = sessionStorage.getItem('dashboard-harness-wizard')
      if (raw) {
        const sess = JSON.parse(raw)
        if (sess && sess.sessionId && sess.projectId) setHarnessSession(sess)
      }
    } catch { try { sessionStorage.removeItem('dashboard-harness-wizard') } catch {} }
  }, [])

  const closeHarnessWizard = React.useCallback(() => {
    setHarnessSession(null)
    try { sessionStorage.removeItem('dashboard-harness-wizard') } catch {}
  }, [])
  const [remoteProjectOpen, setRemoteProjectOpen] = React.useState(false)
  const [meshPairingOpen, setMeshPairingOpen] = React.useState(false)
  const [meshJoinOpen, setMeshJoinOpen] = React.useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [notifDetail, setNotifDetail] = React.useState<Notification | null>(null)
  const [notifDetailOpen, setNotifDetailOpen] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = React.useState(false)
  const [gSequence, setGSequence] = React.useState('')
  const [searchDropdownOpen, setSearchDropdownOpen] = React.useState(false)
  const [rebuildConfirmProject, setRebuildConfirmProject] = React.useState<Project | null>(null)
  const [rebuildingProjectIds, setRebuildingProjectIds] = React.useState<Set<string>>(new Set())
  // Per-env in-flight operations (envId → action). Drives the progress
  // spinners on env rows and blocks duplicate clicks while an operation runs.
  const [pendingEnvOps, setPendingEnvOps] = React.useState<Record<string, string>>({})
  const pendingEnvOpsRef = React.useRef<Record<string, string>>({})
  const setEnvOpPending = React.useCallback((envId: string, action: string | null) => {
    setPendingEnvOps((prev) => {
      const next = { ...prev }
      if (action) next[envId] = action
      else delete next[envId]
      pendingEnvOpsRef.current = next
      return next
    })
  }, [])
  const [lastRefreshed, setLastRefreshed] = React.useState<string>(new Date().toISOString())
  const [starredIds, setStarredIds] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('starred-projects') || '[]')) } catch { return new Set() }
  })
  const [lanIp, setLanIp] = React.useState<string>('')
  const [currentHost, setCurrentHost] = React.useState<string>('')
  const [devices, setDevices] = React.useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(() => {
    try { const v = localStorage.getItem('dashboard-selectedDeviceId'); return v === null || v === 'null' ? null : v } catch { return null }
  }) // null = all, 'local' = this machine
  const [deviceManagementOpen, setDeviceManagementOpen] = React.useState(false)
  const [addDeviceFormOpen, setAddDeviceFormOpen] = React.useState(false)
  const [editingDevice, setEditingDevice] = React.useState<Device | null>(null)
  const [agentDeployGuideOpen, setAgentDeployGuideOpen] = React.useState(false)
  const [moveProjectDialog, setMoveProjectDialog] = React.useState<Project | null>(null)
  const [errorDialog, setErrorDialog] = React.useState<{ title: string; detail: string } | null>(null)
  // Session 11 states
  const [depGraphOpen, setDepGraphOpen] = React.useState(false)
  const [batchTagEditorOpen, setBatchTagEditorOpen] = React.useState(false)
  const [batchTagMode, setBatchTagMode] = React.useState<'add' | 'replace'>('add')
  const [batchTagDraft, setBatchTagDraft] = React.useState<string[]>([])
  const [batchTagApplying, setBatchTagApplying] = React.useState(false)
  const [scrollTopVisible, setScrollTopVisible] = React.useState(false)
  // Session 12 states
  const [healthAlertThreshold, setHealthAlertThreshold] = React.useState<number>(() => {
    try { const v = localStorage.getItem('dashboard-health-alert-threshold'); return v ? parseInt(v, 10) : 50 } catch { return 50 }
  })
  const [healthAlertEnabled, setHealthAlertEnabled] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-health-alert-enabled') !== 'false' } catch { return true }
  })
  const [healthAlertsOpen, setHealthAlertsOpen] = React.useState(false)
  const [cardDensity, setCardDensity] = React.useState<'compact' | 'comfortable' | 'spacious'>(() => {
    try { const v = localStorage.getItem('dashboard-card-density'); return v === 'compact' || v === 'spacious' ? v : 'compact' } catch { return 'compact' }
  })
  const [visibleStats, setVisibleStats] = React.useState<Set<string>>(() => {
    try { const v = localStorage.getItem('dashboard-visible-stats'); return v ? new Set(JSON.parse(v)) : new Set(['totalProjects', 'environments', 'devices', 'healthScore']) } catch { return new Set(['totalProjects', 'environments', 'devices', 'healthScore']) }
  })
  const [dashboardCustomizeOpen, setDashboardCustomizeOpen] = React.useState(false)
  const [compareOpen, setCompareOpen] = React.useState(false)
  const [compareProjectA, setCompareProjectA] = React.useState<Project | null>(null)
  const [compareProjectB, setCompareProjectB] = React.useState<Project | null>(null)
  const [focusedProjectIndex, setFocusedProjectIndex] = React.useState(-1)
  // Session 13 states
  const [quickLaunchBarVisible, setQuickLaunchBarVisible] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-quicklaunch-visible') !== 'false' } catch { return true }
  })
  const [globalActivity, setGlobalActivity] = React.useState<ActivityEvent[]>([])
  const [activityFeedVisible, setActivityFeedVisible] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-activity-feed-visible') !== 'false' } catch { return true }
  })
  // Session 14 states
  const [alertsAcknowledged, setAlertsAcknowledged] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-alerts-acknowledged') === 'true' } catch { return false }
  })

  const toggleStar = React.useCallback((id: string) => {
    setStarredIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('starred-projects', JSON.stringify([...next]))
      return next
    })
  }, [])

  // Persist dashboard preferences to localStorage
  React.useEffect(() => { localStorage.setItem('dashboard-viewMode', viewMode) }, [viewMode])
  React.useEffect(() => { localStorage.setItem('dashboard-sortBy', sortBy) }, [sortBy])
  React.useEffect(() => { localStorage.setItem('dashboard-sortDir', sortDir) }, [sortDir])
  React.useEffect(() => { localStorage.setItem('dashboard-selectedDeviceId', selectedDeviceId ?? 'null') }, [selectedDeviceId])
  React.useEffect(() => { localStorage.setItem('dashboard-groupBy', groupBy) }, [groupBy])
  React.useEffect(() => { localStorage.setItem('dashboard-health-alert-threshold', String(healthAlertThreshold)) }, [healthAlertThreshold])
  React.useEffect(() => { localStorage.setItem('dashboard-health-alert-enabled', String(healthAlertEnabled)) }, [healthAlertEnabled])
  React.useEffect(() => { localStorage.setItem('dashboard-card-density', cardDensity) }, [cardDensity])
  React.useEffect(() => { localStorage.setItem('dashboard-visible-stats', JSON.stringify([...visibleStats])) }, [visibleStats])
  React.useEffect(() => { localStorage.setItem('dashboard-quicklaunch-visible', String(quickLaunchBarVisible)) }, [quickLaunchBarVisible])
  React.useEffect(() => { localStorage.setItem('dashboard-activity-feed-visible', String(activityFeedVisible)) }, [activityFeedVisible])

  const { toast } = useToast()

  // Ref to track whether a reorder POST is in flight — used to pause
  // auto-refresh from overwriting local drag order with stale DB data.
  const reorderInFlightRef = React.useRef(false)
  const lastProjectsSerializedRef = React.useRef('')
  // True once the project list has been painted from the localStorage cache —
  // the initial network load then skips flashing the skeleton over it.
  const hydratedFromCacheRef = React.useRef(false)

  // Data fetching
  const fetchProjects = React.useCallback(async (opts?: { fresh?: boolean }) => {
    // If a reorder POST is in-flight, skip this auto-refresh cycle so we
    // don't overwrite the locally-reordered state with stale DB data.
    if (reorderInFlightRef.current) return
    try {
      // `fresh` (manual refresh button) bypasses the server-side sync cache
      // so a user-initiated refresh always talks to the agents for real.
      const res = await fetch(opts?.fresh ? '/api/projects?fresh=1' : '/api/projects')
      if (res.ok) {
        const data = await res.json()
        const parsed = (data.projects ?? []).map((p: Record<string, unknown>) => ({
          ...p,
          tags: parseTags(p.tags as string),
        }))
        // Skip setProjects if nothing actually changed. Prevents unnecessary
        // re-renders every 8s when the backend data is stable (the most
        // common case when nothing is being started/stopped on the device).
        const serialized = JSON.stringify(parsed)
        if (serialized !== lastProjectsSerializedRef.current) {
          lastProjectsSerializedRef.current = serialized
          setProjects(parsed)
          // "Last updated" only moves when DATA actually moved — this setState
          // re-renders the whole tree, so it must not fire on every 8s poll
          // with identical data (was: unconditional → constant idle churn).
          setLastRefreshed(new Date().toISOString())
          // Persist for instant next-refresh paint (stale-while-revalidate).
          // Best-effort: quota or serialization failures must never break
          // the refresh itself.
          try {
            localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: parsed }))
          } catch { /* ignore */ }
          // Publish projects for cross-component consumers (e.g. HermesBridgeToggle)
          try {
            window.__dashboardProjects = parsed
            window.dispatchEvent(new CustomEvent('projects-updated'))
          } catch {
            // ignore
          }
        } else if (opts?.fresh) {
          // A manual refresh with unchanged data still deserves a timestamp
          // update so the footer reflects that the check DID happen.
          setLastRefreshed(new Date().toISOString())
        }
      } else if (res.status === 401) {
        // Logged out — drop the cache so a later user doesn't see a stale
        // list from this session while their own data loads.
        lastProjectsSerializedRef.current = ''
        try { localStorage.removeItem(PROJECTS_CACHE_KEY) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }, [])

  const fetchNotifications = React.useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (res.ok) setNotifications(await res.json())
    } catch { /* ignore */ }
  }, [])

  // Ref to hold latest projects for use in fetchGlobalActivity without dependency
  const projectsRef = React.useRef<Project[]>([])
  projectsRef.current = projects

  const fetchGlobalActivity = React.useCallback(async (_projectList?: Project[]) => {
    try {
      const res = await fetch('/api/activity')
      if (res.ok) {
        const events: ActivityEvent[] = await res.json()
        setGlobalActivity(events.slice(0, 8))
      }
    } catch { /* ignore */ }
  }, [])

  const fetchDevices = React.useCallback(async () => {
    try {
      const res = await fetch('/api/devices')
      if (res.ok) setDevices(await res.json())
    } catch { /* ignore */ }
  }, [])

  const handleAddDevice = React.useCallback(async (data: { name: string; ip: string; port: number; apiKey: string }) => {
    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        toast({ title: t('dlg.toast.deviceAdded'), variant: 'success' })
        fetchDevices()
      } else {
        const err = await res.json()
        toast({ title: t('dlg.toast.failedAddDevice'), description: err.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedAddDevice'), variant: 'destructive' })
    }
  }, [toast, fetchDevices])

  const handleUpdateDevice = React.useCallback(async (id: string, data: { name?: string; ip?: string; port?: number; apiKey?: string }) => {
    try {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        toast({ title: t('dlg.toast.deviceUpdated'), variant: 'success' })
        fetchDevices()
      } else {
        toast({ title: t('dlg.toast.failedUpdateDevice'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedUpdateDevice'), variant: 'destructive' })
    }
  }, [toast, fetchDevices])

  const handleDeleteDevice = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('dlg.toast.deviceDeleted'), variant: 'success' })
        fetchDevices()
        if (selectedDeviceId === id) setSelectedDeviceId(null)
      } else {
        toast({ title: t('dlg.toast.failedDeleteDevice'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedDeleteDevice'), variant: 'destructive' })
    }
  }, [toast, fetchDevices, selectedDeviceId])

  const handleCheckDeviceHealth = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/devices/${id}/health`)
      if (res.ok) {
        const data = await res.json()
        toast({ title: t(data.status === 'online' ? 'dlg.toast.deviceOnline' : 'dlg.toast.deviceOffline', { name: data.name ?? data.hostname ?? 'device' }), variant: data.status === 'online' ? 'success' : 'destructive' })
        fetchDevices()
        return data
      } else {
        toast({ title: t('dlg.toast.healthCheckFailed'), variant: 'destructive' })
        return null
      }
    } catch {
      toast({ title: t('dlg.toast.healthCheckFailed'), variant: 'destructive' })
      return null
    }
  }, [toast, fetchDevices])

  const loadData = React.useCallback(async () => {
    // Cache-hydrated paint already shows projects — don't flash the skeleton
    // over it while the network refresh runs in the background.
    if (!hydratedFromCacheRef.current) setLoading(true)
    await Promise.all([fetchProjects(), fetchNotifications(), fetchDevices()])
    // fetchGlobalActivity will be triggered by the projects-changed effect below
    setLoading(false)
  }, [fetchProjects, fetchNotifications, fetchDevices])

  // Initial load — the project list was already hydrated from the localStorage
  // cache inside the useState initializers (first render shows data). Here we
  // only mark the refs (serialized-diff guard + skeleton suppression) and kick
  // off the network revalidation. The cached snapshot may briefly show stale
  // statuses; the first network response (≤ one poll cycle) reconciles it.
  React.useEffect(() => {
    const init = readProjectsCacheOnce()
    if (init.hit) {
      lastProjectsSerializedRef.current = JSON.stringify(init.data)
      hydratedFromCacheRef.current = true
    }
    const id = requestAnimationFrame(() => { loadData() })
    return () => cancelAnimationFrame(id)
  }, []) // Initial load only

  // Fetch global activity when projects change. With the cache initializer,
  // a cache hit fires this on the FIRST render — in parallel with the network
  // load instead of chained behind it (was: session → projects → activity).
  React.useEffect(() => {
    if (projects.length > 0) {
      fetchGlobalActivity()
    }
  }, [projects, fetchGlobalActivity])

  // Auto-refresh: only the 8s interval below is needed. A second 5s poll
  // existed previously and created a feeling of constant churn even when
  // data was unchanged. Removed to halve background network traffic and
  // reduce render pressure. The remaining interval is still paused when
  // the tab is hidden, so this is plenty for keeping status fresh.
  // (Kept intentionally as a comment to prevent re-introduction.)

  // Client-side notification queue for auto-generated notifications
  const autoNotifIdRef = React.useRef(0)
  const addAutoNotification = React.useCallback((type: 'success' | 'warning' | 'error' | 'info', title: string, message: string, projectName?: string) => {
    const id = `auto_${++autoNotifIdRef.current}_${Date.now()}`
    const notif: Notification = {
      id,
      type,
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
      projectName,
    }
    setNotifications((prev) => [notif, ...prev])
  }, [])

  // Device health polling every 30 seconds
  const prevDeviceStatusRef = React.useRef<Record<string, string>>({})
  // Fresh device list for the poller without re-subscribing the effect on
  // every identity change (the poll reads the ref, deps stay on length).
  const devicesRef = React.useRef<Device[]>([])
  devicesRef.current = devices
  React.useEffect(() => {
    // Capture current device statuses for change detection
    const currentStatuses: Record<string, string> = {}
    for (const d of devices) {
      currentStatuses[d.id] = d.status
    }
    prevDeviceStatusRef.current = currentStatuses
  }, [devices])
  React.useEffect(() => {
    if (devices.length === 0) return
    // Update ONE device row in the top-level devices array without churning
    // object identities: returns the SAME array reference when nothing
    // changed (status same + lastSeen not due for its 5-min refresh), so a
    // stable poll does NOT re-render the whole dashboard every 30s.
    const patchDevice = (deviceId: string, status: string, seen: boolean) => {
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === deviceId)
        if (idx === -1) return prev
        const d = prev[idx]
        let nextStatus = status
        let nextLastSeen = d.lastSeen
        if (seen) {
          const lastSeenMs = Date.parse(d.lastSeen || '') || 0
          // Throttle lastSeen updates to every 5 min while online — updating
          // it every poll re-creates the device object → full re-render.
          if (Date.now() - lastSeenMs > 5 * 60_000) nextLastSeen = new Date().toISOString()
        }
        if (d.status === nextStatus && d.lastSeen === nextLastSeen) return prev
        const next = [...prev]
        next[idx] = { ...d, status: nextStatus, lastSeen: nextLastSeen }
        return next
      })
    }
    const pollDeviceHealth = async () => {
      // Skip while the tab is hidden — the 8s project poll already pauses;
      // an invisible dashboard probing devices just burns battery/traffic.
      if (typeof document !== 'undefined' && document.hidden) return
      // All devices probed in PARALLEL (was a sequential for..of — 5s timeout
      // each, so 4 unreachable devices blocked the loop for 20s+).
      await Promise.all(devicesRef.current.map(async (device) => {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          const res = await fetch(`http://${device.ip}:${device.port}/api/agent/health`, {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${device.apiKey}` },
          })
          clearTimeout(timeout)
          const isOnline = res.ok
          const prevStatus = prevDeviceStatusRef.current[device.id]
          patchDevice(device.id, isOnline ? 'online' : 'offline', isOnline)
          // Generate notification for status changes
          if (prevStatus && prevStatus !== (isOnline ? 'online' : 'offline')) {
            addAutoNotification(
              isOnline ? 'success' : 'error',
              isOnline ? t('dlg.notif.deviceOnlineTitle') : t('dlg.notif.deviceOfflineTitle'),
              isOnline
                ? t('dlg.notif.deviceOnlineDesc', { device: device.name, addr: `${device.ip}:${device.port}` })
                : t('dlg.notif.deviceOfflineDesc', { device: device.name, addr: `${device.ip}:${device.port}` })
            )
          }
        } catch {
          const prevStatus = prevDeviceStatusRef.current[device.id]
          patchDevice(device.id, 'offline', false)
          if (prevStatus && prevStatus === 'online') {
            addAutoNotification(
              'error',
              t('dlg.notif.deviceOfflineTitle'),
              t('dlg.notif.deviceOfflineDesc', { device: device.name, addr: `${device.ip}:${device.port}` })
            )
          }
        }
      }))
    }
    pollDeviceHealth()
    const interval = setInterval(pollDeviceHealth, 30000)
    return () => clearInterval(interval)
  }, [devices.length, addAutoNotification, t])

  // Fetch LAN IP for access links
  React.useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (typeof window !== 'undefined') {
        setCurrentHost(window.location.hostname)
      }
    })
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((data) => {
        const externalIp = data.ips?.find((ip: { internal: boolean }) => !ip.internal)
        if (externalIp) setLanIp(externalIp.address)
        else if (data.ips?.length > 0) setLanIp(data.ips[0].address)
      })
      .catch(() => {})
    return () => cancelAnimationFrame(id)
  }, [])

  // Auto-refresh every 8 seconds, pauses on tab blur
  React.useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const startInterval = () => {
      interval = setInterval(fetchProjects, 8000)
    }
    const stopInterval = () => {
      if (interval) { clearInterval(interval); interval = null }
    }
    const handleVisibility = () => {
      if (document.hidden) stopInterval()
      else startInterval()
    }
    startInterval()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stopInterval()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [fetchProjects])

  // Handlers
  const handleAddProject = React.useCallback(() => {
    setProjectFormMode('add')
    setEditingProject(null)
    setProjectFormOpen(true)
  }, [])

  // Keyboard shortcuts - defined after handleAddProject to avoid before-declaration error
  const [hoveredProjectId, setHoveredProjectId] = React.useState<string | null>(null)
  const projectActionsRef = React.useRef<{ selectProject: (p: Project) => void; editProject: (p: Project) => void; envAction: (projectId: string, envId: string, action: string) => void }>({ selectProject: () => {}, editProject: () => {}, envAction: () => {} })
  const filteredProjectsRef = React.useRef<Project[]>([])
  const focusedProjectIndexRef = React.useRef(-1)

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        if (e.key === 'Escape') target.blur()
        return
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'k') { e.preventDefault(); document.getElementById('search-input')?.focus() }
        if (e.key === 'n') { e.preventDefault(); handleAddProject() }
        if (e.shiftKey && (e.key === 'A' || e.key === 'a')) { e.preventDefault(); handleAddProject() }
        if (e.shiftKey && (e.key === 'R' || e.key === 'r')) { e.preventDefault(); loadData() }
        if (e.key === 'p') { e.preventDefault(); setCommandPaletteOpen(true) }
        if (e.key === 'd') { e.preventDefault(); setDeviceManagementOpen(true) }
        return
      }

      if (e.key === '?' && !e.ctrlKey && !e.metaKey) { setShortcutsOpen(true) }

      // Arrow key navigation between projects
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const total = filteredProjectsRef.current.length
        if (total === 0) return
        setFocusedProjectIndex((prev) => {
          let next = prev
          if (e.key === 'ArrowDown') next = prev < total - 1 ? prev + 1 : 0
          if (e.key === 'ArrowUp') next = prev > 0 ? prev - 1 : total - 1
          focusedProjectIndexRef.current = next
          // Focus the project card element
          const card = document.querySelector(`[data-project-index="${next}"]`)
          if (card) (card as HTMLElement).focus()
          return next
        })
      }
      if (e.key === 'Enter' && focusedProjectIndexRef.current >= 0 && focusedProjectIndexRef.current < filteredProjectsRef.current.length) {
        e.preventDefault()
        const project = filteredProjectsRef.current[focusedProjectIndexRef.current]
        if (project) projectActionsRef.current.selectProject(project)
      }
      if (e.key === 'Home') { e.preventDefault(); setFocusedProjectIndex(0); focusedProjectIndexRef.current = 0; const card = document.querySelector('[data-project-index="0"]'); if (card) (card as HTMLElement).focus() }
      if (e.key === 'End') { e.preventDefault(); const last = filteredProjectsRef.current.length - 1; setFocusedProjectIndex(last); focusedProjectIndexRef.current = last; const card = document.querySelector(`[data-project-index="${last}"]`); if (card) (card as HTMLElement).focus() }

      // Project-specific shortcuts when a project is hovered
      if (hoveredProjectId) {
        const hoveredProject = projects.find((p) => p.id === hoveredProjectId)
        if (hoveredProject) {
          if (e.key === 'Enter') { e.preventDefault(); projectActionsRef.current.selectProject(hoveredProject) }
          if (e.key === 'e') { e.preventDefault(); projectActionsRef.current.editProject(hoveredProject) }
          if (e.key === 's') { e.preventDefault(); (hoveredProject.environments || []).filter((env) => env.status !== 'running').forEach((env) => projectActionsRef.current.envAction(hoveredProject.id, env.id, 'start')) }
          if (e.key === 'x') { e.preventDefault(); (hoveredProject.environments || []).filter((env) => env.status === 'running').forEach((env) => projectActionsRef.current.envAction(hoveredProject.id, env.id, 'stop')) }
          if (e.key === 'Delete') { e.preventDefault(); setDeleteProject(hoveredProject) }
        }
      }

      // G sequence
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        setGSequence((prev) => {
          if (prev === 'g') {
            setViewMode('grid')
            return ''
          }
          return 'g'
        })
        return
      }
      if (e.key === 'l' && !e.ctrlKey && !e.metaKey && gSequence === 'g') {
        setViewMode('list')
        setGSequence('')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [gSequence, handleAddProject, loadData, hoveredProjectId, projects])

  // G sequence timeout
  React.useEffect(() => {
    if (gSequence) {
      const t = setTimeout(() => setGSequence(''), 1000)
      return () => clearTimeout(t)
    }
  }, [gSequence])

  // Computed values
  const filteredProjects = React.useMemo(() => {
    let result = [...projects].filter((p) => p.name !== HERMES_BRIDGE_NAME)

    // Filter by device
    if (selectedDeviceId === 'local') {
      result = result.filter((p) => !p.deviceId)
    } else if (selectedDeviceId) {
      result = result.filter((p) => p.deviceId === selectedDeviceId)
    }
    // null = all devices, no filter

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          (p.environments || []).some((e) => e.name.toLowerCase().includes(q)) ||
          parseTags(p.tags).some((t) => t.toLowerCase().includes(q)) ||
          (p.deviceName && p.deviceName.toLowerCase().includes(q))
      )
    }

    // Filter by status
    if (filterStatus !== 'all') {
      result = result.filter((p) => getProjectStatus(p) === filterStatus)
    }

    // Filter by tags
    if (filterTags.length > 0) {
      result = result.filter((p) => {
        const tags = parseTags(p.tags)
        return filterTags.some((ft) => tags.includes(ft))
      })
    }

    // Sort — each key sorts in its natural forward order; 'desc' flips it.
    // Starred projects are partitioned AFTER sorting so they always lead.
    const fwd = sortDir === 'desc' ? -1 : 1
    if (sortBy === 'port') {
      result.sort((a, b) => (getProjectSortPort(a) - getProjectSortPort(b)) * fwd)
    } else if (sortBy === 'newest') {
      result.sort((a, b) => (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) * fwd)
    } else if (sortBy === 'name') {
      result.sort((a, b) => a.name.localeCompare(b.name) * fwd)
    } else if (sortBy === 'status') {
      result.sort((a, b) => {
        const sa = getProjectStatus(a)
        const sb = getProjectStatus(b)
        const order = { running: 0, mixed: 1, stopped: 2 }
        return ((order[sa] ?? 3) - (order[sb] ?? 3)) * fwd
      })
    }

    // Starred projects always appear first (stable sort)
    const starred = result.filter((p) => starredIds.has(p.id))
    const unstarred = result.filter((p) => !starredIds.has(p.id))
    result = [...starred, ...unstarred]

    return result
  }, [projects, searchQuery, filterStatus, filterTags, sortBy, sortDir, starredIds, selectedDeviceId])

  // Keep refs in sync for keyboard handler (avoids temporal dead zone)
  React.useEffect(() => { filteredProjectsRef.current = filteredProjects }, [filteredProjects])
  React.useEffect(() => { focusedProjectIndexRef.current = focusedProjectIndex }, [focusedProjectIndex])

  // Device-grouped projects for when "All" devices are selected
  const deviceGroupedProjects = React.useMemo(() => {
    if (selectedDeviceId !== null) return null // Only group when "All" is selected
    const localProjects = filteredProjects.filter((p) => !p.deviceId)
    const remoteMap = new Map<string, { device: Device; projects: Project[] }>()
    for (const p of filteredProjects) {
      if (p.deviceId && p.deviceName) {
        const existing = remoteMap.get(p.deviceId)
        if (existing) {
          existing.projects.push(p)
        } else {
          const device = devices.find((d) => d.id === p.deviceId)
          remoteMap.set(p.deviceId, { device: device!, projects: [p] })
        }
      }
    }
    // Sort remote groups by device name
    const remoteGroups = Array.from(remoteMap.values()).sort((a, b) => (a.device?.name ?? '').localeCompare(b.device?.name ?? ''))
    return { localProjects, remoteGroups }
  }, [filteredProjects, selectedDeviceId, devices])

  // Tag-grouped projects
  const tagGroupedProjects = React.useMemo(() => {
    const groups: Array<{ tagName: string; tagColor: string; projects: Project[] }> = []
    const assigned = new Set<string>()
    // Add groups in TAG_OPTIONS order
    for (const tagOption of TAG_OPTIONS) {
      const matching = filteredProjects.filter((p) => {
        const tags = parseTags(p.tags)
        return tags.includes(tagOption.name)
      })
      if (matching.length > 0) {
        groups.push({ tagName: tagOption.name, tagColor: tagOption.color, projects: matching })
        matching.forEach((p) => assigned.add(p.id))
      }
    }
    // Untagged projects
    const untagged = filteredProjects.filter((p) => !assigned.has(p.id))
    if (untagged.length > 0) {
      groups.push({ tagName: 'Untagged', tagColor: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-400', projects: untagged })
    }
    return groups
  }, [filteredProjects])

  const stats = React.useMemo(() => ({
    total: projects.length,
    running: projects.filter((p) => getProjectStatus(p) === 'running').length,
    stopped: projects.filter((p) => getProjectStatus(p) === 'stopped').length,
    mixed: projects.filter((p) => getProjectStatus(p) === 'mixed').length,
    environments: projects.reduce((a, p) => a + (p.environments?.length || 0), 0),
  }), [projects])

  const filteredEnvStats = React.useMemo(() => ({
    total: filteredProjects.reduce((a, p) => a + (p.environments?.length || 0), 0),
    running: filteredProjects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0),
    stopped: filteredProjects.reduce((a, p) => a + (p.environments?.filter((e) => e.status !== 'running').length || 0), 0),
  }), [filteredProjects])

  const dashboardStats = React.useMemo(() => {
    const totalEnvs = filteredProjects.reduce((a, p) => a + (p.environments?.length || 0), 0)
    const runningEnvs = filteredProjects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0)
    const onlineDevices = devices.filter((d) => d.status === 'online').length
    const totalDevices = devices.length + 1 // +1 for local
    const healthScore = totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0
    return { totalProjects: filteredProjects.length, runningEnvs, totalEnvs, onlineDevices, totalDevices, healthScore }
  }, [filteredProjects, devices])

  const runningEnvsForQuickLaunch = React.useMemo(() => {
    const envs: Array<{ projectName: string; envName: string; port: number; projectId: string; envId: string }> = []
    filteredProjects.forEach((p) => {
      (p.environments || []).filter((e) => e.status === 'running').forEach((e) => {
        envs.push({ projectName: p.name, envName: e.name, port: e.port, projectId: p.id, envId: e.id })
      })
    })
    return envs
  }, [filteredProjects])

  // Health score history for sparkline
  const [healthScoreHistory, setHealthScoreHistory] = React.useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem('health-score-history') || '[]') } catch { return [] }
  })
  React.useEffect(() => {
    const pushScore = () => {
      setHealthScoreHistory((prev) => {
        // Only append when the score actually MOVED — a flat line every 30s
        // re-created the array and re-rendered the whole dashboard for
        // nothing (the history is a sparkline of CHANGES).
        if (prev.length > 0 && prev[prev.length - 1] === dashboardStats.healthScore) return prev
        const next = [...prev, dashboardStats.healthScore].slice(-20)
        localStorage.setItem('health-score-history', JSON.stringify(next))
        return next
      })
    }
    pushScore()
    const id = setInterval(pushScore, 30000)
    return () => clearInterval(id)
  }, [dashboardStats.healthScore])

  // Project count / running-envs history removed together with the Analytics widget.

  // Health alert: toast when health drops below threshold (Session 14: replaced per-project spam with banner)
  const prevHealthScoreRef = React.useRef(dashboardStats.healthScore)
  React.useEffect(() => {
    if (!healthAlertEnabled) return
    if (prevHealthScoreRef.current > healthAlertThreshold && dashboardStats.healthScore <= healthAlertThreshold && prevHealthScoreRef.current !== dashboardStats.healthScore) {
      toast({
        title: t('dlg.toast.healthAlertTitle'),
        description: t('dlg.toast.healthAlertDesc', { score: dashboardStats.healthScore, threshold: healthAlertThreshold }),
        variant: 'destructive',
      })
      setAlertsAcknowledged(false)
      localStorage.setItem('dashboard-alerts-acknowledged', 'false')
    }
    prevHealthScoreRef.current = dashboardStats.healthScore
  }, [dashboardStats.healthScore, healthAlertThreshold, healthAlertEnabled, toast])

  // Per-project health alerts: NO LONGER toast per project (Session 14 fix - replaced with banner)
  // This effect is intentionally empty - health alerts now shown in the summary banner instead

  const unreadNotifs = React.useMemo(() => notifications.filter((n) => !n.read).length, [notifications])

  const handleEditProject = React.useCallback((p: Project) => {
    setProjectFormMode('edit')
    setEditingProject(p)
    setProjectFormOpen(true)
  }, [])

  // Launch a harness-agent (deepseek-harness) analysis session for a local
  // project and open the live-progress wizard. The agent installs deps,
  // generates the startup command and auto-debugs it until the service boots.
  const startHarnessAnalysis = React.useCallback(async (projectId: string, name: string, path: string) => {
    try {
      const usedPorts = Array.from(new Set(projects.flatMap(p => p.environments?.map(e => e.port) ?? [])))
      const res = await fetch('/api/harness/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name, usedPorts: [...usedPorts, 3000, 3100, 3021, 3022] }),
      })
      if (res.ok) {
        const data = await res.json()
        const sess = { sessionId: data.sessionId, projectId, name, path }
        setHarnessSession(sess)
        // Survive HMR remounts / accidental reloads — see the restore effect above.
        try { sessionStorage.setItem('dashboard-harness-wizard', JSON.stringify(sess)) } catch {}
        addToast({ title: t('dlg.toast.agentStarted'), description: t('dlg.toast.agentStartedDesc'), variant: 'success' })
      } else {
        const err = await res.json()
        toast({ title: t('dlg.toast.analysisStartFailed'), description: err.error || t('dlg.toast.harnessUnreachable'), variant: 'destructive' })
      }
    } catch (e: any) {
      toast({ title: t('dlg.toast.analysisStartFailed'), description: e?.message || t('dlg.common.networkError'), variant: 'destructive' })
    }
  }, [projects, toast])

  const handleProjectSubmit = React.useCallback(async (data: { name: string; path: string; description: string; icon: string; tags: string[]; deviceId: string | null }) => {
    try {
      if (projectFormMode === 'add') {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          const result = await res.json()
          const newProjectId = result.project?.id
          toast({ title: t('dlg.toast.projectCreated'), variant: 'success' })
          addAutoNotification('success', t('dlg.notif.projectCreatedTitle'), t('dlg.notif.projectCreatedDesc', { name: data.name }), data.name)

          // Local projects → harness-agent (deepseek-harness) analyzes, installs deps,
          // generates and VERIFIES the startup command (auto-debug until success).
          if (newProjectId && !data.deviceId) {
            startHarnessAnalysis(newProjectId, data.name, data.path)
          }

          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: t('dlg.toast.failedCreateProject'), description: err.error, variant: 'destructive' })
        }
      } else if (editingProject) {
        const res = await fetch(`/api/projects/${editingProject.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: t('dlg.toast.projectUpdated'), variant: 'success' })
          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: t('dlg.toast.failedUpdateProject'), description: err.error, variant: 'destructive' })
        }
      }
    } catch {
      toast({ title: t('dlg.toast.opFailed'), variant: 'destructive' })
    }
  }, [projectFormMode, editingProject, toast, fetchProjects, startHarnessAnalysis])

  const handleDeleteProject = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('dlg.toast.projectDeleted'), variant: 'success' })
        addAutoNotification('warning', t('dlg.notif.projectDeletedTitle'), t('dlg.notif.projectDeletedDesc'), undefined)
        fetchProjects()
        setDeleteProject(null)
        if (selectedProject?.id === id) { setSelectedProject(null); setDetailOpen(false) }
      } else {
        toast({ title: t('dlg.toast.failedDeleteProject'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedDelete'), variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject])

  const handleDuplicateProject = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, { method: 'POST' })
      if (res.ok) {
        toast({ title: t('dlg.toast.projectDuplicated'), variant: 'success' })
        fetchProjects()
      } else {
        const err = await res.json()
        toast({ title: t('dlg.toast.failedDuplicate'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedDuplicate'), variant: 'destructive' })
    }
  }, [toast, fetchProjects])

  // Re-fetch environments for a project: deletes existing envs and re-analyzes
  // the project directory to regenerate dev/prod entries.
  // For local projects → calls /api/projects/:id/analyze?replace=true (LLM).
  // For remote projects → proxies to the device agent's /api/agent/projects/:id/analyze
  //   which reads package.json locally (no LLM needed).
  const handleReanalyzeProject = React.useCallback(async (project: Project) => {
    const hasExistingEnvs = (project.environments || []).length > 0
    const action = hasExistingEnvs ? 'Replacing' : 'Detecting'

    if (project.deviceId) {
      // Remote project → proxy to the device agent
      const device = devices.find((d) => d.id === project.deviceId)
      if (!device) {
        toast({ title: t('dlg.toast.deviceNotFound'), description: t('dlg.toast.deviceNotFoundDesc'), variant: 'destructive' })
        return
      }
      toast({ title: hasExistingEnvs ? t('dlg.toast.replaceEnvs') : t('dlg.toast.detectEnvs'), description: t('dlg.toast.analyzingOn', { project: project.name, device: device.name }) })
      try {
        const result = await proxyToAgent(
          { ip: device.ip, port: device.port, apiKey: device.apiKey },
          `/projects/${project.id}/analyze`,
          'POST',
          { replace: true }
        )
        if (result.ok) {
          const envCount = result.data.project?.environments?.length ?? 0
          toast({
            title: hasExistingEnvs ? t('dlg.toast.envsReplaced') : t('dlg.toast.envsDetected'),
            description: envCount > 0
              ? t('dlg.toast.envsCreatedDesc', { count: envCount, list: result.data.project.environments.map((e: { name: string; port: number }) => `${e.name} (:${e.port})`).join(', ') })
              : t('dlg.toast.noEnvsGenerated'),
            variant: 'success',
          })
          fetchProjects()
        } else {
          toast({ title: t('dlg.toast.refetchFailed'), description: result.data?.error || t('dlg.toast.agentReturned', { status: result.status }), variant: 'destructive' })
        }
      } catch (e: any) {
        toast({ title: t('dlg.toast.refetchFailed'), description: e?.message || t('dlg.common.networkError'), variant: 'destructive' })
      }
    } else {
      // Local project → harness-agent (deepseek-harness) full auto-debug analyze
      startHarnessAnalysis(project.id, project.name, project.path)
    }
  }, [toast, fetchProjects, devices, startHarnessAnalysis])

  const handleMoveProject = React.useCallback(async (projectId: string, targetDeviceId: string | null) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDeviceId }),
      })
      if (res.ok) {
        toast({ title: t('dlg.toast.projectMoved'), variant: 'success' })
        fetchProjects()
        setMoveProjectDialog(null)
      } else {
        const err = await res.json()
        toast({ title: t('dlg.toast.failedMove'), description: err.error || t('dlg.common.serverError'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedMove'), variant: 'destructive' })
    }
  }, [toast, fetchProjects])

  const handleSelectProject = React.useCallback((p: Project) => {
    // Fetch fresh data for the detail view
    fetch(`/api/projects/${p.id}`)
      .then((r) => r.json())
      .then((fresh) => {
        // API returns { project: { ... } } envelope — unwrap
        setSelectedProject(fresh?.project ?? fresh)
        setDetailOpen(true)
      })
      .catch(() => {
        setSelectedProject(p)
        setDetailOpen(true)
      })
  }, [])

  // Search results for dropdown
  const searchResults = React.useMemo(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) return []
    const q = searchQuery.toLowerCase()
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.environments || []).some((e) => e.name.toLowerCase().includes(q)) ||
        parseTags(p.tags).some((t) => t.toLowerCase().includes(q)) ||
        (p.deviceName && p.deviceName.toLowerCase().includes(q))
    ).slice(0, 6)
  }, [projects, searchQuery])

  // Export handlers
  const handleExportCSV = React.useCallback(() => {
    const headers = ['Name', 'Path', 'Description', 'Status', 'Environments']
    const rows = projects.map((p) => [
      `"${p.name}"`,
      `"${p.path}"`,
      `"${p.description.replace(/"/g, '""')}"`,
      getProjectStatus(p),
      p.environments.map((e) => `${e.name}(${e.status})`).join('; ')
    ].join(','))
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'projects-export.csv'
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: t('dlg.toast.exportedCsv'), variant: 'success' })
  }, [projects, toast])

  const handleExportJSON = React.useCallback(() => {
    const data = projects.map((p) => ({
      name: p.name,
      path: p.path,
      description: p.description,
      status: getProjectStatus(p),
      environments: p.environments.map((e) => ({ name: e.name, status: e.status, port: e.port, command: e.cmd })),
    }))
    const json = JSON.stringify(data, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'projects-export.json'
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: t('dlg.toast.exportedJson'), variant: 'success' })
  }, [projects, toast])

  const handleImportJSON = React.useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (!Array.isArray(data)) {
          toast({ title: t('dlg.toast.invalidFormat'), description: t('dlg.toast.invalidFormatDesc'), variant: 'destructive' })
          return
        }
        let importedCount = 0
        for (const item of data) {
          if (!item.name || !item.path) continue
          try {
            const res = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: item.name,
                path: item.path,
                description: item.description || '',
                icon: item.icon || 'folder',
                tags: Array.isArray(item.tags) ? item.tags : [],
              }),
            })
            if (res.ok) importedCount++
          } catch { /* skip failed */ }
        }
        toast({ title: importedCount === 1 ? t('dlg.toast.importedOne') : t('dlg.toast.importedCount', { count: importedCount }), variant: 'success' })
        fetchProjects()
      } catch {
        toast({ title: t('dlg.toast.parseJsonFailed'), description: t('dlg.toast.parseJsonFailedDesc'), variant: 'destructive' })
      }
    }
    input.click()
  }, [toast, fetchProjects])

  const handleEnvAction = React.useCallback(async (projectId: string, envId: string, action: string) => {
    const project = projects.find((p) => p.id === projectId)
    const env = project?.environments.find((e) => e.id === envId)
    const envLabel = env ? (env.name === 'development' ? 'dev' : env.name === 'production' ? 'prod' : env.name) : 'environment'
    // Block rebuild for dev environments — they use HMR
    if (action === 'rebuild' && env?.name === 'development') {
      toast({ title: t('dlg.toast.devHotReload'), description: t('dlg.toast.devHotReloadDesc'), variant: 'info' })
      return
    }
    // Prevent duplicate concurrent operations on the same environment
    const inFlight = pendingEnvOpsRef.current[envId]
    if (inFlight) {
      toast({
        title: t('dlg.toast.opInProgress'),
        description: t('dlg.toast.opInProgressDesc', {
          project: project?.name ?? t('dlg.toast.theProject'),
          env: envLabel,
          op: ['start', 'stop', 'restart', 'rebuild'].includes(inFlight) ? t(`dlg.op.${inFlight}` as Parameters<typeof t>[0]) : inFlight,
        }),
        variant: 'info',
      })
      return
    }
    setEnvOpPending(envId, action)
    const actionLabels: Record<string, string> = {
      start: t('dlg.actDone.start'),
      stop: t('dlg.actDone.stop'),
      rebuild: t('dlg.actDone.rebuild'),
      restart: t('dlg.actDone.restart'),
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/environments/${envId}/${action}`, { method: 'POST' })
      if (res.ok) {
        toast({ title: t(`dlg.toast.envDone.${action}` as Parameters<typeof t>[0], { env: envLabel, action: actionLabels[action] ?? `${action}ed` }), variant: 'success' })
        addAutoNotification(
          action === 'start' ? 'success' : action === 'stop' ? 'warning' : action === 'restart' ? 'info' : 'success',
          t('dlg.notif.envTitle', { action: actionLabels[action] ?? `${action}ed`, env: envLabel }),
          t('dlg.notif.envDesc', {
            env: envLabel,
            project: project?.name ?? t('dlg.toast.theProject'),
            action: ['start', 'stop', 'restart', 'rebuild'].includes(action) ? t(`dlg.actPast.${action}` as Parameters<typeof t>[0]) : `${action}ed`,
          }),
          project?.name
        )

        // Auto-start Hermes Bridge when Hermes Web dev/prod starts
        if (action === 'start' && project?.name === 'Hermes Web') {
          const bridgeProject = projects.find((p) => p.name === 'Hermes Bridge')
          const bridgeEnv = bridgeProject?.environments?.[0]
          if (bridgeProject && bridgeEnv && bridgeEnv.status !== 'running') {
            try {
              await fetch(`/api/projects/${bridgeProject.id}/environments/${bridgeEnv.id}/start`, { method: 'POST' })
              toast({ title: t('dlg.toast.hermesStarted'), variant: 'success' })
            } catch { /* best-effort */ }
          }
        }

        // Auto-stop Hermes Bridge when all Hermes Web environments are stopped
        if (action === 'stop' && project?.name === 'Hermes Web') {
          const hermesWeb = projects.find((p) => p.name === 'Hermes Web')
          const stillRunning = hermesWeb?.environments?.some((e) => e.id !== envId && e.status === 'running')
          if (!stillRunning) {
            const bridgeProject = projects.find((p) => p.name === 'Hermes Bridge')
            const bridgeEnv = bridgeProject?.environments?.[0]
            if (bridgeProject && bridgeEnv && bridgeEnv.status === 'running') {
              try {
                await fetch(`/api/projects/${bridgeProject.id}/environments/${bridgeEnv.id}/stop`, { method: 'POST' })
                toast({ title: t('dlg.toast.hermesStopped'), variant: 'success' })
              } catch { /* best-effort */ }
            }
          }
        }

        fetchProjects()
        // Refresh detail if open
        if (selectedProject?.id === projectId) {
          const fresh = await (await fetch(`/api/projects/${projectId}`)).json()
          setSelectedProject(fresh?.project ?? fresh)
        }
      } else {
        // 解析 API 返回的详细错误信息
        let errorDetail = t('dlg.toast.serverReturnedError')
        let repairJobIdFromResponse: string | null = null
        try {
          const errData = await res.json()
          const parts: string[] = []
          if (errData.error) parts.push(errData.error)
          if (errData.stderr) parts.push(`stderr:\n${errData.stderr}`)
          if (errData.stdout) parts.push(`stdout:\n${errData.stdout}`)
          if (parts.length > 0) errorDetail = parts.join('\n\n')
          // LLM auto-repair kicked in on the backend — show the live repair dialog
          if (errData.repair?.jobId && (action === 'start' || action === 'rebuild' || action === 'restart')) {
            repairJobIdFromResponse = errData.repair.jobId
          }
        } catch {
          // 响应不是 JSON，使用 statusText
          errorDetail = t('dlg.toast.serverErrorStatus', { status: res.status, text: res.statusText })
        }
        if (repairJobIdFromResponse) {
          setRepairJobId(repairJobIdFromResponse)
          setRepairDialogOpen(true)
          toast({
            title: action === 'rebuild' ? t('dlg.toast.repairAutoRebuild') : t('dlg.toast.repairAutoStart'),
            description: t('dlg.toast.repairAutoDesc', { project: project?.name ?? '', env: envLabel }),
            variant: 'warning',
          })
        } else {
          // 截断过长的错误信息用于 toast
          const toastDesc = errorDetail.length > 200
            ? errorDetail.slice(0, 200) + t('dlg.toast.clickForDetail')
            : errorDetail
          toast({
            title: t('dlg.toast.failedActionEnv', { action: ['start', 'stop', 'restart', 'rebuild'].includes(action) ? t(`dlg.act.${action}` as Parameters<typeof t>[0]) : action, env: envLabel }),
            description: toastDesc,
            variant: 'destructive',
            detail: errorDetail.length > 200 ? errorDetail : undefined,
          })
        }
      }
    } catch {
      toast({ title: t('dlg.toast.failedActionEnv', { action: ['start', 'stop', 'restart', 'rebuild'].includes(action) ? t(`dlg.act.${action}` as Parameters<typeof t>[0]) : action, env: envLabel }), description: t('dlg.toast.networkErrorDetail'), variant: 'destructive' })
    } finally {
      // NOTE: when LLM auto-repair kicks in, the backend keeps working in the
      // background — the env op itself has finished, so we release the lock.
      setEnvOpPending(envId, null)
    }
  }, [toast, t, fetchProjects, selectedProject, projects, setEnvOpPending])

  // Update project actions ref for keyboard shortcuts (after all handler definitions)
  React.useEffect(() => {
    projectActionsRef.current.selectProject = handleSelectProject
    projectActionsRef.current.editProject = handleEditProject
    projectActionsRef.current.envAction = handleEnvAction
  }, [handleSelectProject, handleEditProject, handleEnvAction])

  // 注册 toast 点击处理器 — 点击有 detail 的 toast 打开错误详情弹窗
  React.useEffect(() => {
    if (setToastClickHandler) {
      setToastClickHandler((detail: string, title: string) => {
        setErrorDialog({ title, detail })
      })
    }
  }, [])

  // 修复任务结束：成功 → 刷新项目状态并提示；失败 → 展示错误
  const handleRepairFinished = React.useCallback((job: RepairJobInfo) => {
    const envLabel = job.envName === 'development' ? 'dev' : job.envName === 'production' ? 'prod' : job.envName
    if (job.status === 'success') {
      toast({
        title: t('dlg.toast.repairSuccess'),
        description: t('dlg.toast.repairSuccessDesc', { project: job.projectName, env: envLabel }),
        variant: 'success',
      })
      addAutoNotification(
        'success',
        t('dlg.notif.repairSuccessTitle'),
        t('dlg.notif.repairSuccessDesc', { project: job.projectName, env: envLabel }),
        job.projectName,
      )
    } else {
      toast({
        title: t('dlg.toast.repairFailed'),
        description: (job.error || '').slice(0, 200) || t('dlg.toast.repairFailedDesc'),
        variant: 'destructive',
      })
    }
    fetchProjects()
  }, [toast, t, fetchProjects, addAutoNotification])

  // ---- LLM repair dialog plumbing -------------------------------------
  // The repair dialog can be backgrounded while a job keeps running. These
  // refs + callbacks let the dialog keep polling while hidden, re-open itself
  // when the LLM proposes a command that needs manual approval, and clean up
  // the job id once nothing is left to show.
  const repairJobRef = React.useRef<RepairJobInfo | null>(null)
  const repairDialogOpenRef = React.useRef(false)
  repairDialogOpenRef.current = repairDialogOpen

  const handleRepairJobUpdate = React.useCallback((data: RepairJobInfo | null) => {
    repairJobRef.current = data
  }, [])

  // The repair job paused for a manual approval while the dialog was hidden —
  // re-open it and surface a toast so the decision is not missed.
  const handleRepairApprovalNeeded = React.useCallback(() => {
    if (repairDialogOpenRef.current) return
    setRepairDialogOpen(true)
    toast({
      title: t('dlg.repair.approvalNeededTitle'),
      description: t('dlg.repair.approvalNeededDesc'),
      variant: 'warning',
    })
  }, [toast, t])

  const handleRepairFinishedNotified = React.useCallback((job: RepairJobInfo) => {
    handleRepairFinished(job)
    // Dialog hidden → nothing left to show; drop the id so the poller stops.
    if (!repairDialogOpenRef.current) setRepairJobId(null)
  }, [handleRepairFinished])

  const handleRepairDialogOpenChange = React.useCallback((open: boolean) => {
    setRepairDialogOpen(open)
    // Closing the dialog: while the job still runs we keep the id (background
    // mode keeps polling and can wake the user for approvals); once the job
    // has settled there is nothing left to poll → clear it.
    if (!open && repairJobRef.current?.status !== 'running') {
      setRepairJobId(null)
    }
  }, [])

  const handleSyncFromConfig = React.useCallback(async () => {
    if (!confirm(t('dlg.toast.syncConfirm'))) {
      return
    }
    try {
      const res = await fetch('/api/seed', { method: 'POST' })
      if (res.ok) {
        toast({ title: t('dlg.toast.synced'), variant: 'success' })
        fetchProjects()
      } else {
        toast({ title: t('dlg.toast.syncFailed'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.syncFailed'), variant: 'destructive' })
    }
  }, [toast, fetchProjects])

  const handleRebuildProject = React.useCallback(async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const envs = project.environments || []
    if (envs.length === 0) return
    // Skip dev environments — they use HMR and don't need rebuild
    const rebuildEnvs = envs.filter((e) => e.name !== 'development')
    if (rebuildEnvs.length === 0) {
      toast({ title: t('dlg.toast.noRebuildable'), description: t('dlg.toast.noRebuildableDesc'), variant: 'info' })
      return
    }
    // Guard against duplicate concurrent rebuilds of the same project
    if (rebuildingProjectIds.has(projectId)) {
      toast({ title: t('dlg.toast.rebuildInProgress'), description: t('dlg.toast.rebuildInProgressDesc', { name: project.name }), variant: 'info' })
      return
    }
    setRebuildingProjectIds((prev) => new Set(prev).add(projectId))
    // Mark each target env as pending so its row shows a progress spinner
    // and its action buttons are replaced while the rebuild runs.
    rebuildEnvs.forEach((env) => setEnvOpPending(env.id, 'rebuild'))
    try {
      let successCount = 0
      const errors: string[] = []
      let lastRepairJobId: string | null = null
      for (const env of rebuildEnvs) {
        const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/rebuild`, { method: 'POST' })
        if (res.ok) {
          successCount++
        } else {
          try {
            const errData = await res.json()
            const errMsg = errData.error || `HTTP ${res.status}`
            errors.push(`${env.name}: ${errMsg}`)
            if (errData.repair?.jobId) lastRepairJobId = errData.repair.jobId
          } catch {
            errors.push(`${env.name}: HTTP ${res.status}`)
          }
        }
      }
      if (lastRepairJobId) {
        // LLM auto-repair is running in the background — show live progress
        setRepairJobId(lastRepairJobId)
        setRepairDialogOpen(true)
        toast({
          title: t('dlg.toast.repairAutoRebuild'),
          description: t('dlg.toast.repairAutoDesc2', { project: project.name }),
          variant: 'warning',
        })
      } else if (successCount === rebuildEnvs.length) {
        toast({ title: t('dlg.toast.rebuildCompleted'), description: t('dlg.toast.rebuildCompletedDesc', { success: successCount, total: rebuildEnvs.length }), variant: 'success' })
      } else if (successCount > 0) {
        const detail = errors.join('\n')
        toast({
          title: t('dlg.toast.rebuildPartial'),
          description: t('dlg.toast.rebuildPartialDesc', { success: successCount, total: rebuildEnvs.length, failed: errors.length }),
          variant: 'destructive',
          detail,
        })
      } else {
        const detail = errors.join('\n')
        toast({
          title: t('dlg.toast.rebuildFailed'),
          description: t('dlg.toast.rebuildFailedDesc', { count: rebuildEnvs.length }),
          variant: 'destructive',
          detail,
        })
      }
      fetchProjects()
      if (selectedProject?.id === projectId) {
        const fresh = await (await fetch(`/api/projects/${projectId}`)).json()
        setSelectedProject(fresh?.project ?? fresh)
      }
    } catch {
      toast({ title: t('dlg.toast.failedRebuild'), description: t('dlg.common.networkError'), variant: 'destructive' })
    } finally {
      setRebuildingProjectIds((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      rebuildEnvs.forEach((env) => setEnvOpPending(env.id, null))
    }
  }, [toast, fetchProjects, projects, selectedProject, rebuildingProjectIds, setEnvOpPending])

  const handleAddEnv = React.useCallback((projectId: string) => {
    setAddEnvProjectId(projectId)
    setEnvFormMode('add')
    setEditingEnv(null)
    setEnvFormOpen(true)
  }, [])

  const handleEditEnv = React.useCallback((env: Environment) => {
    setEnvFormMode('edit')
    setEditingEnv(env)
    setEnvFormOpen(true)
  }, [])

  const handleEnvSubmit = React.useCallback(async (data: { name: string; cmd: string; port: number; envVars: Record<string, string> }) => {
    try {
      if (envFormMode === 'add') {
        const res = await fetch(`/api/projects/${addEnvProjectId}/environments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: t('dlg.toast.envCreated'), variant: 'success' })
          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: t('dlg.toast.failedCreateEnv'), description: err.error, variant: 'destructive' })
        }
      } else if (editingEnv) {
        const res = await fetch(`/api/projects/${editingEnv.projectId}/environments/${editingEnv.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: t('dlg.toast.envUpdated'), variant: 'success' })
          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: t('dlg.toast.failedUpdateEnv'), description: err.error, variant: 'destructive' })
        }
      }
    } catch {
      toast({ title: t('dlg.toast.opFailed'), variant: 'destructive' })
    }
  }, [envFormMode, addEnvProjectId, editingEnv, toast, fetchProjects])

  const handleDeleteEnv = React.useCallback(async (projectId: string, envId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/environments/${envId}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('dlg.toast.envDeleted'), variant: 'success' })
        fetchProjects()
        if (selectedProject?.id === projectId) {
          const fresh = await (await fetch(`/api/projects/${projectId}`)).json()
          setSelectedProject(fresh?.project ?? fresh)
        }
      } else {
        toast({ title: t('dlg.toast.failedDeleteEnv'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('dlg.toast.failedDeleteEnv'), variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject])

  const handleMarkNotifRead = React.useCallback(async (id?: string) => {
    if (id) {
      // Optimistically update UI
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n))
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
      } catch { /* ignore */ }
    } else {
      // Mark all as read
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markAll: true }),
        })
      } catch { /* ignore */ }
    }
  }, [])

  const handleClearNotifications = React.useCallback(() => {
    setNotifications([])
  }, [])

  const handleBatchAction = React.useCallback(async (action: string) => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return

    let successCount = 0
    for (const projectId of ids) {
      const project = projects.find((p) => p.id === projectId)
      if (!project) continue

      if (action === 'delete') {
        const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
        if (res.ok) successCount++
      } else {
        for (const env of project.environments) {
          if (action === 'start' && env.status !== 'running') {
            const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/start`, { method: 'POST' })
            if (res.ok) successCount++
          } else if (action === 'stop' && env.status === 'running') {
            const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/stop`, { method: 'POST' })
            if (res.ok) successCount++
          } else if (action === 'rebuild' && env.name !== 'development') {
            // Skip dev environments — they use HMR and don't need rebuild
            const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/rebuild`, { method: 'POST' })
            if (res.ok) successCount++
          }
        }
      }
    }

    toast({ title: t('dlg.toast.batchCompleted', { action: ['start', 'stop', 'rebuild', 'restart'].includes(action) ? t(`dlg.act.${action}` as Parameters<typeof t>[0]) : action }), description: t('dlg.toast.batchCompletedDesc', { count: successCount }), variant: 'success' })
    setSelectedIds(new Set())
    setBatchMode(false)
    fetchProjects()
  }, [selectedIds, projects, toast, fetchProjects])

  const toggleSelect = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = React.useCallback(() => {
    if (selectedIds.size === filteredProjects.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredProjects.map((p) => p.id)))
    }
  }, [selectedIds.size, filteredProjects])

  const sensors = useSensors(
    useSensor(DragHandleSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // NOTE: no React state is set on drag start anymore. Setting state here
  // re-rendered the whole 8k-line page component on every drag start,
  // which caused the noticeable hitch when picking up a card.

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    // Switch to "custom" sort so the manual drag order is respected instead of
    // being immediately overridden by newest/name/status sorting.
    setSortBy('custom')

    // Compute new order from filteredProjects (what the user sees and drags).
    // Use the ref for synchronous read — do NOT rely on setProjects updater
    // side-effects which may not have run yet in React 18 concurrent mode.
    const currentFiltered = filteredProjectsRef.current
    const oldIndex = currentFiltered.findIndex((p) => p.id === active.id)
    const newIndex = currentFiltered.findIndex((p) => p.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const movedFiltered = arrayMove(currentFiltered, oldIndex, newIndex)
    const newOrderIds = movedFiltered.map((p) => p.id)

    // Apply the same reorder to the full projects array, preserving
    // non-filtered items (e.g. Hermes Bridge) in their original positions.
    const filteredIdSet = new Set(newOrderIds)
    const newProjects: Project[] = []
    let filteredIdx = 0
    for (const p of projectsRef.current) {
      if (filteredIdSet.has(p.id)) {
        if (filteredIdx < movedFiltered.length) {
          newProjects.push(movedFiltered[filteredIdx])
          filteredIdx++
        }
      } else {
        newProjects.push(p)
      }
    }
    while (filteredIdx < movedFiltered.length) {
      newProjects.push(movedFiltered[filteredIdx])
      filteredIdx++
    }

    setProjects(newProjects)

    // Pause auto-refresh and persist to server
    reorderInFlightRef.current = true
    fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: newOrderIds.map((id) => ({ id })) }),
    })
      .then(() => {
        reorderInFlightRef.current = false
        fetchProjects()
      })
      .catch(() => {
        reorderInFlightRef.current = false
        fetchProjects()
      })
  }, [fetchProjects])

  // Session 11: Batch tag editor handler
  const handleCompareProject = React.useCallback((p: Project) => {
    setCompareProjectA(p)
    setCompareOpen(true)
  }, [])

  const handleBatchTagApply = React.useCallback(async () => {
    if (batchTagDraft.length === 0 && batchTagMode === 'replace') return
    setBatchTagApplying(true)
    let successCount = 0
    const ids = Array.from(selectedIds)
    for (const projectId of ids) {
      try {
        const project = projects.find((p) => p.id === projectId)
        if (!project) continue
        let newTags: string[]
        if (batchTagMode === 'replace') {
          newTags = batchTagDraft
        } else {
          const existingTags = parseTags(project.tags)
          newTags = [...new Set([...existingTags, ...batchTagDraft])]
        }
        const res = await fetch(`/api/projects/${projectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: JSON.stringify(newTags) }),
        })
        if (res.ok) successCount++
      } catch { /* skip */ }
    }
    toast({ title: successCount === 1 ? t('dlg.toast.tagsUpdatedOne') : t('dlg.toast.tagsUpdatedCount', { count: successCount }), variant: 'success' })
    setBatchTagEditorOpen(false)
    setBatchTagDraft([])
    setBatchTagApplying(false)
    fetchProjects()
  }, [batchTagDraft, batchTagMode, selectedIds, projects, toast, fetchProjects])

  // Session 11: Open batch tag editor
  const openBatchTagEditor = React.useCallback(() => {
    setBatchTagDraft([])
    setBatchTagMode('add')
    setBatchTagEditorOpen(true)
  }, [])

  // Session 11: Scroll-to-top FAB visibility
  React.useEffect(() => {
    const handleScroll = () => {
      setScrollTopVisible(window.scrollY > 400)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Active filters for breadcrumb bar
  const activeFilters = React.useMemo(() => {
    const filters: Array<{ label: string; onRemove: () => void }> = []
    if (filterStatus !== 'all') {
      filters.push({ label: t('surf.filterChipStatus', { value: t(`surf.${filterStatus}` as Parameters<typeof t>[0]) }), onRemove: () => setFilterStatus('all') })
    }
    filterTags.forEach((tag) => {
      filters.push({ label: t('surf.filterChipTag', { value: tag }), onRemove: () => setFilterTags((prev) => prev.filter((x) => x !== tag)) })
    })
    if (searchQuery.trim()) {
      filters.push({ label: t('surf.filterChipSearch', { value: searchQuery }), onRemove: () => setSearchQuery('') })
    }
    if (selectedDeviceId === 'local') {
      filters.push({ label: t('surf.filterChipDeviceLocal'), onRemove: () => setSelectedDeviceId(null) })
    } else if (selectedDeviceId) {
      const device = devices.find((d) => d.id === selectedDeviceId)
      filters.push({ label: t('surf.filterChipDevice', { name: device?.name ?? t('surf.unknown') }), onRemove: () => setSelectedDeviceId(null) })
    }
    return filters
  }, [filterStatus, filterTags, searchQuery, selectedDeviceId, devices, t])

  return (
    <div className="min-h-screen flex flex-col">
      {/* Layer-0 canvas: brand wash + fading dot grid, fixed behind all content */}
      <div className="page-backdrop" aria-hidden="true" />
      {/* ======================== HEADER ======================== */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-gradient-to-r from-background/90 via-background/85 to-background/90 backdrop-blur-2xl supports-backdrop-blur:bg-background/70 shadow-[0_1px_8px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.03)] dark:from-zinc-900/98 dark:via-zinc-900/95 dark:to-zinc-900/98 dark:border-b dark:border-zinc-800/60 dark:shadow-[0_1px_8px_rgba(0,0,0,0.3),0_4px_16px_rgba(0,0,0,0.15)]">
        <div className="header-hairline" aria-hidden="true" />
        <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shrink-0 shadow-sm shadow-primary/40 ring-1 ring-primary/30 ring-inset">
              <Zap className="h-4 w-4" />
            </div>
            <div className="hidden sm:flex flex-col">
              <h1 className="text-lg font-bold leading-tight">Dashboard</h1>
              <DashboardClockWidget />
            </div>
          </div>

          {/* Device Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 h-9 px-3 text-xs font-medium cursor-pointer transition-colors max-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50">
                <Monitor className="h-3.5 w-3.5 shrink-0 text-brand-strong" />
                <span className="truncate">
                  {selectedDeviceId === null ? t('topbar.devices.all') : selectedDeviceId === 'local' ? t('topbar.devices.thisMachine') : devices.find(d => d.id === selectedDeviceId)?.name || t('topbar.devices.unknown')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px] p-1.5 text-sm">
              <DropdownMenuItem onClick={() => setSelectedDeviceId(null)} className="px-2.5 py-2 text-sm rounded-md">
                <Layers className="h-3.5 w-3.5 mr-2.5 text-muted-foreground" />
                {t('topbar.devices.all')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSelectedDeviceId('local')} className="px-2.5 py-2 text-sm rounded-md">
                <Monitor className="h-3.5 w-3.5 mr-2.5 text-emerald-600 dark:text-emerald-400" />
                {t('topbar.devices.thisMachine')}
              </DropdownMenuItem>
              {devices.length > 0 && <DropdownMenuSeparator />}
              {devices.map((device) => (
                <DropdownMenuItem key={device.id} onClick={() => setSelectedDeviceId(device.id)} className="px-2.5 py-2 text-sm rounded-md">
                  {device.status === 'online' ? (
                    <CircleDot className="mr-2 h-3.5 w-3.5 text-emerald-500 fill-emerald-500" />
                  ) : device.status === 'error' ? (
                    <AlertTriangle className="mr-2 h-3.5 w-3.5 text-amber-500" />
                  ) : (
                    <CircleDot className="mr-2 h-3.5 w-3.5 text-red-400 fill-red-400" />
                  )}
                  <span className="truncate">{device.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{device.ip}:{device.port}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setAddDeviceFormOpen(true); setEditingDevice(null) }} className="px-2.5 py-2 text-sm rounded-md text-emerald-600 dark:text-emerald-400">
                <Plus className="h-3.5 w-3.5 mr-2.5" />
                {t('topbar.devices.add')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Search */}
          <div className="flex-1 max-w-md min-w-[130px] relative group/search">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within/search:text-brand" />
            <Input
              id="search-input"
              placeholder={t('topbar.search.placeholder')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchDropdownOpen(true) }}
              onFocus={() => { if (searchQuery.length >= 2) setSearchDropdownOpen(true) }}
              onBlur={() => { setTimeout(() => setSearchDropdownOpen(false), 200) }}
              className="pl-9 h-9 text-sm rounded-full bg-muted/40 border border-border/30 focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:border-brand/50 focus-visible:bg-background transition-all duration-200 placeholder:text-muted-foreground/70 dark:placeholder:text-zinc-400"
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center pointer-events-none px-1.5 py-0.5 text-[9px] text-muted-foreground dark:text-zinc-400 bg-muted dark:bg-zinc-800 rounded border border-border/50 dark:border-zinc-700/50 font-mono">⌘K</kbd>
            {/* Search results dropdown */}
            {searchDropdownOpen && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-lg shadow-lg z-50 overflow-hidden">
                {searchResults.map((p) => {
                  const pStatus = getProjectStatus(p)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors text-sm"
                      onClick={() => { setSearchQuery(''); setSearchDropdownOpen(false); handleSelectProject(p) }}
                    >
                      <span className={`h-2 w-2 rounded-full shrink-0 ${pStatus === 'running' ? 'bg-emerald-500' : pStatus === 'mixed' ? 'bg-amber-500' : 'bg-red-400'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{highlightText(p.name, searchQuery)}</div>
                        <div className="text-xs text-muted-foreground dark:text-zinc-400 truncate">{highlightText(p.path, searchQuery)}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{t('topbar.search.envs', { count: p.environments.length })}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Actions: [utility group] [separator] [primary action] */}
          <div className="flex items-center gap-1 ml-auto">
            {/* Notifications */}
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="inline-flex items-center justify-center rounded-md h-8 w-8 hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground cursor-pointer relative transition-all duration-150 active:scale-95">
                  <Bell className={`h-4 w-4 ${unreadNotifs > 0 ? 'bell-shake' : ''}`} />
                  {unreadNotifs > 0 && (
                    <motion.span
                      key={unreadNotifs}
                      initial={{ scale: 0.3 }}
                      animate={{ scale: [0.3, 1.2, 1] }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                      className="absolute -top-1 -right-1 min-h-[18px] min-w-[18px] rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-bold px-1 shadow-lg shadow-red-500/30 notif-badge-pulse"
                    >
                      {unreadNotifs > 99 ? '99+' : unreadNotifs}
                    </motion.span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
                  <span className="text-sm font-semibold">{t('topbar.notifications.title')}</span>
                  <div className="flex items-center gap-1">
                    {unreadNotifs > 0 && (
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] px-1.5 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300" onClick={() => handleMarkNotifRead()}>
                        <CheckCircle2 className="h-3 w-3 mr-0.5" />{t('topbar.notifications.markAllRead')}
                      </Button>
                    )}
                    {notifications.length > 0 && (
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] px-1.5 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" onClick={handleClearNotifications}>
                        <Trash2 className="h-3 w-3 mr-0.5" />{t('topbar.notifications.clearAll')}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 && (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p>{t('topbar.notifications.empty')}</p>
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {notifications.slice(0, 10).map((notif) => {
                      const NotifIconMap = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info }
                      const NotifColorMap: Record<string, string> = { success: 'text-emerald-500', warning: 'text-amber-500', error: 'text-red-500', info: 'text-cyan-500' }
                      const NotifBorderMap: Record<string, string> = { success: 'border-l-emerald-500', warning: 'border-l-amber-500', error: 'border-l-red-500', info: 'border-l-cyan-500' }
                      const NotifBgMap: Record<string, string> = { success: 'bg-emerald-50/50 dark:bg-emerald-950/20', warning: 'bg-amber-50/50 dark:bg-amber-950/20', error: 'bg-red-50/50 dark:bg-red-950/20', info: 'bg-cyan-50/50 dark:bg-cyan-950/20' }
                      const NIcon = NotifIconMap[notif.type]
                      return (
                        <motion.button
                          key={notif.id}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                          transition={{ duration: 0.2, ease: 'easeInOut' }}
                          className={`w-full flex items-start gap-2 p-2.5 text-left hover:bg-accent/50 transition-colors border-b last:border-0 border-l-2 ${NotifBorderMap[notif.type]} ${!notif.read ? NotifBgMap[notif.type] : ''}`}
                          onClick={() => {
                            if (!notif.read) handleMarkNotifRead(notif.id)
                            setNotifDetail(notif)
                            setNotifDetailOpen(true)
                          }}
                        >
                          <NIcon className={`h-4 w-4 mt-0.5 shrink-0 ${NotifColorMap[notif.type]}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-sm truncate ${!notif.read ? 'font-semibold' : 'font-medium'}`}>{notif.title}</span>
                              {!notif.read && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 20 }} className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{notif.message}</p>
                            <p className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{formatTimeAgo(notif.timestamp, t)}</p>
                          </div>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </div>
              </PopoverContent>
            </Popover>

            <Separator orientation="vertical" className="h-5 mx-0.5" />

            {/* View toggle */}
            <div className="hidden sm:flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild><button type="button" className={`inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer transition-all duration-150 active:scale-95 ${viewMode === 'grid' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground'}`} onClick={() => setViewMode('grid')}>
                    <LayoutGrid className="h-4 w-4" />
                  </button></TooltipTrigger>
                <TooltipContent>{t('topbar.view.grid')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild><button type="button" className={`inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer transition-all duration-150 active:scale-95 ${viewMode === 'list' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground'}`} onClick={() => setViewMode('list')}>
                    <List className="h-4 w-4" />
                  </button></TooltipTrigger>
                <TooltipContent>{t('topbar.view.list')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </div>

            <Separator orientation="vertical" className="h-5 mx-0.5 hidden sm:block" />

            <ThemeToggle />
            {/* Standalone language switcher (task 17) — the only language control */}
            <LanguageToggle />
            <UserMenu
              user={session.user}
              onLogout={session.logout}
              pendingCount={session.user.role === 'admin' ? adminPendingCount : 0}
              onOpenUserManagement={() => setUserMgmtOpen(true)}
              onOpenChangePassword={() => setChangePwOpen(true)}
            />
            <ThemeCustomizer />

            {/* Settings dropdown: Gateway, LLM, Export, Sync */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground transition-colors">
                <Settings className="h-4 w-4" />
              </button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => setSystemMonitorOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <Server className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.systemStatus')}
                </DropdownMenuItem>
                {session.user.role === 'admin' && (
                  <DropdownMenuItem onClick={() => setLlmOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                    <Bot className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.llmConfig')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setDepGraphOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <GitFork className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.dependencyMap')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHealthAlertsOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <AlertTriangle className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.healthAlerts')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDashboardCustomizeOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <LayoutGrid className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.customize')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSyncFromConfig} className="px-2.5 py-2 text-sm rounded-md">
                  <RefreshCw className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.sync')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExportCSV} className="px-2.5 py-2 text-sm rounded-md">
                  <Download className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.exportCsv')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportJSON} className="px-2.5 py-2 text-sm rounded-md">
                  <Download className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.exportJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleImportJSON} className="px-2.5 py-2 text-sm rounded-md">
                  <Upload className="h-3.5 w-3.5 mr-2.5" />{t('topbar.settings.importJson')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Separator between utility group and primary action */}
            <Separator orientation="vertical" className="h-5 mx-1.5" />

            {/* Primary action */}
            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" onClick={() => setRemoteProjectOpen(true)} disabled={devices.length === 0} className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              <MonitorSmartphone className="h-4 w-4" />
            </button></TooltipTrigger><TooltipContent>{devices.length === 0 ? t('topbar.remoteProject.noDevice') : t('topbar.remoteProject.tooltip')}</TooltipContent></Tooltip></TooltipProvider>
            <Button onClick={handleAddProject} className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground text-xs shadow-xs transition-colors">
              <Plus className="h-3.5 w-3.5 mr-1" />
              <span className="hidden sm:inline">{t('topbar.addProject')}</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ======================== FILTER / STATUS BAR ======================== */}
      <div className="border-b bg-muted/30 dark:bg-zinc-900/90 dark:border-b dark:border-zinc-700/50 backdrop-blur-lg bg-white/60 dark:bg-zinc-900/80">
        <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 py-2">
          {/* Filters + Batch select */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Updated timestamp */}
            <span className="text-[9px] text-muted-foreground dark:text-zinc-400 tabular-nums hidden sm:inline-flex items-center gap-1 shrink-0">
              {loading && <Loader2 className="h-3 w-3 animate-spin text-brand" />}
              {t('topbar.updated')} {formatTimeAgo(lastRefreshed, t)}
            </span>
            {/* Filter controls — wrap naturally, no horizontal scroll */}
            <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-md border ${filterStatus !== 'all' ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'} h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors`}>
                    <Filter className="h-3 w-3" />
                    {filterStatus === 'all' ? t('surf.filterStatus') : t(`surf.${filterStatus}` as Parameters<typeof t>[0])}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={filterStatus} onValueChange={(v) => setFilterStatus(v as FilterStatus)}>
                    <DropdownMenuRadioItem value="all">{t('surf.all')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="running">{t('surf.running')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="stopped">{t('surf.stopped')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-md border ${filterTags.length > 0 ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'} h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors`}>
                    <Tag className="h-3 w-3" />
                    {t('surf.tags')}{filterTags.length > 0 && ` (${filterTags.length})`}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {TAG_OPTIONS.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag.name}
                      checked={filterTags.includes(tag.name)}
                      onCheckedChange={(checked) => {
                        setFilterTags((prev) => checked ? [...prev, tag.name] : prev.filter((t) => t !== tag.name))
                      }}
                    >
                      {tag.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-md border ${sortBy !== 'custom' ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'} h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors`}>
                    <ArrowUpDown className="h-3 w-3" />
                    {sortBy === 'custom' ? t('surf.sortCustom') : sortBy === 'newest' ? t('surf.newest') : sortBy === 'name' ? t('surf.name') : sortBy === 'status' ? t('surf.filterStatus') : t('surf.sortPort')}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                    <DropdownMenuRadioItem value="port">{t('surf.sortPort')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="custom">{t('surf.sortCustom')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="newest">{t('surf.sortNewest')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">{t('surf.sortName')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="status">{t('surf.sortStatus')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Sort direction toggle — flips the active sort between its
                  natural forward order and reverse. Starred-first is unaffected. */}
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                      disabled={sortBy === 'custom'}
                      aria-label={sortDir === 'asc' ? t('surf.sortDirAsc') : t('surf.sortDirDesc')}
                      className={`inline-flex items-center justify-center rounded-md border h-7 w-7 text-xs cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sortDir === 'desc' ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}
                    >
                      {sortDir === 'asc' ? <ArrowUpNarrowWide className="h-3 w-3" /> : <ArrowDownWideNarrow className="h-3 w-3" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {sortDir === 'asc' ? t('surf.sortDirAsc') : t('surf.sortDirDesc')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-md border ${groupBy !== 'none' ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'} h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors`}>
                    <Layers className="h-3 w-3" />
                    {t('surf.groupLabel', { value: t(`surf.group${groupBy === 'device' ? 'Device' : groupBy === 'tags' ? 'Tags' : 'None'}` as Parameters<typeof t>[0]) })}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                    <DropdownMenuRadioItem value="device">{t('surf.groupByDevice')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="tags">{t('surf.groupByTags')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="none">{t('surf.groupFlat')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Filter indicator pills */}
              <AnimatePresence>
              {filterStatus !== 'all' && (
                <motion.button key="filter-status" type="button" onClick={() => setFilterStatus('all')} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                  initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  {filterStatus} <X className="h-2.5 w-2.5" />
                </motion.button>
              )}
              {filterTags.length > 0 && filterTags.map(tag => (
                <motion.button key={`tag-${tag}`} type="button" onClick={() => setFilterTags(prev => prev.filter(t => t !== tag))} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                  initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  {tag} <X className="h-2.5 w-2.5" />
                </motion.button>
              ))}
              </AnimatePresence>

              {/* Active filters breadcrumb — inline on same row */}
              {activeFilters.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <AnimatePresence>
                  {activeFilters.map((f, i) => (
                    <motion.div key={f.label} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                    <Badge variant="secondary" className="text-[10px] gap-1 pr-0.5">
                      {f.label}
                      <button onClick={f.onRemove} className="p-0.5 hover:bg-muted rounded"><X className="h-2.5 w-2.5" /></button>
                    </Badge>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                  <Button variant="ghost" size="sm" className="h-5 text-[10px] text-muted-foreground" onClick={() => { setFilterStatus('all'); setFilterTags([]); setSearchQuery('') }}>
                    {t('surf.clear')}
                  </Button>
                </div>
              )}
            </div>

            {/* Active filter count badge */}
            {(() => {
              const count = (filterStatus !== 'all' ? 1 : 0) + filterTags.length + (sortBy !== 'port' ? 1 : 0) + (groupBy !== 'none' ? 1 : 0)
              return count > 0 ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-semibold tabular-nums">{t('surf.activeCount', { count })}</span> : null
            })()}
            {/* Batch mode toggle — always right-aligned */}
            <label className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium gap-1.5 shrink-0 h-7 px-2.5 transition-colors cursor-pointer border ${
              batchMode
                ? 'bg-brand-soft text-brand-strong border-brand/40 hover:bg-brand-soft-strong'
                : 'border-input bg-background hover:bg-accent hover:text-accent-foreground'
            }`}>
              <input type="checkbox" className="sr-only" checked={batchMode} onChange={() => { setBatchMode(!batchMode); if (batchMode) setSelectedIds(new Set()) }} />
              <span className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[4px] border ${
                batchMode
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'border-input'
              }`}>
                {batchMode && (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              <span className="text-[10px] text-muted-foreground">{batchMode ? t('dlg.common.cancel') : t('surf.batchToggle')}</span>
            </label>
          </div>
          {/* Active Filter Chips (Session 13) */}
          {(filterStatus !== 'all' || filterTags.length > 0 || searchQuery) && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {searchQuery && (
                <Badge variant="secondary" className="text-[10px] gap-1 pr-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
                  {t('surf.filterChipSearch', { value: searchQuery })}
                  <button type="button" onClick={() => setSearchQuery('')} className="ml-0.5 p-0.5 rounded hover:bg-emerald-200/50 dark:hover:bg-emerald-800/30"><X className="h-2.5 w-2.5" /></button>
                </Badge>
              )}
              {filterStatus !== 'all' && (
                <Badge variant="secondary" className="text-[10px] gap-1 pr-1 bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 ring-1 ring-cyan-200/50 dark:ring-cyan-800/30">
                  {t('surf.filterChipStatus', { value: t(`surf.${filterStatus}` as Parameters<typeof t>[0]) })}
                  <button type="button" onClick={() => setFilterStatus('all')} className="ml-0.5 p-0.5 rounded hover:bg-cyan-200/50 dark:hover:bg-cyan-800/30"><X className="h-2.5 w-2.5" /></button>
                </Badge>
              )}
              {filterTags.map((tag) => (
                <Badge key={tag} variant="secondary" className={`text-[10px] gap-1 pr-1 ${getTagColor(tag)}`}>
                  {tag}
                  <button type="button" onClick={() => setFilterTags((prev) => prev.filter((t) => t !== tag))} className="ml-0.5 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"><X className="h-2.5 w-2.5" /></button>
                </Badge>
              ))}
              <button type="button" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterTags([]) }} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2">
                {t('surf.clearAll')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ======================== BATCH OPERATIONS BAR (bottom) ======================== */}
      <AnimatePresence>
        {batchMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-12 left-0 right-0 z-40 border-t border-brand/25 bg-white/95 dark:bg-zinc-900/98 backdrop-blur-xl shadow-[0_-8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.5)]"
          >
            <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Checkbox checked={selectedIds.size === filteredProjects.length && filteredProjects.length > 0} onCheckedChange={toggleSelectAll} />
                <span className="text-sm font-semibold">{selectedIds.size} <span className="font-normal text-muted-foreground">{t('surf.batchSelected')}</span></span>
                <Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground hover:text-foreground" onClick={toggleSelectAll}>
                  {selectedIds.size === filteredProjects.length && filteredProjects.length > 0 ? t('surf.deselectAll') : t('surf.selectAll')}
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('start')}><Play className="h-3 w-3 mr-1 text-emerald-500" />{t('dlg.detail.run')}</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('stop')}><Square className="h-3 w-3 mr-1 text-red-500" />{t('dlg.detail.stop')}</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openBatchTagEditor}><Tags className="h-3 w-3 mr-1 text-amber-500" />{t('dlg.batchTag.add')}</Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 text-xs text-destructive">
                      <Trash2 className="h-3 w-3 mr-1" />{t('dlg.deleteConfirm.deleteAll')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('dlg.deleteConfirm.batchTitle', { count: selectedIds.size })}</AlertDialogTitle>
                      <AlertDialogDescription>{t('dlg.deleteConfirm.batchDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('dlg.common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleBatchAction('delete')} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t('dlg.common.delete')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ======================== QUICK ACTIONS TOOLBAR (sticky top, batch mode) ======================== */}
      <AnimatePresence>
        {batchMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: -20, opacity: 0, height: 0 }}
            animate={{ y: 0, opacity: 1, height: 'auto' }}
            exit={{ y: -20, opacity: 0, height: 0 }}
            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
            className="sticky top-0 z-30 border-b border-brand/25 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-sm"
          >
            <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center justify-center h-6 w-6 rounded-full bg-brand text-brand-foreground text-xs font-bold shadow-sm">
                  {selectedIds.size}
                </div>
                <span className="text-sm font-semibold text-brand-strong">{t('dlg.batch.selected')}</span>
                <Button variant="ghost" size="sm" className="h-6 text-[10px] text-brand-strong hover:text-brand-strong hover:bg-brand-soft" onClick={toggleSelectAll}>
                  {selectedIds.size === filteredProjects.length && filteredProjects.length > 0 ? t('dlg.batch.deselectAll') : t('dlg.batch.selectAll')}
                </Button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <Button size="sm" className="h-7 text-xs bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm" onClick={() => handleBatchAction('start')}><Play className="h-3 w-3 mr-1" />{t('dlg.batch.startAll')}</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-brand/40 text-brand-strong hover:bg-brand-soft hover:text-brand-strong" onClick={() => handleBatchAction('stop')}><Square className="h-3 w-3 mr-1" />{t('dlg.batch.stopAll')}</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-brand/40 text-brand-strong hover:bg-brand-soft hover:text-brand-strong" onClick={openBatchTagEditor}><Tags className="h-3 w-3 mr-1" />{t('dlg.batch.addTags')}</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-brand/40 text-brand-strong hover:bg-brand-soft hover:text-brand-strong" onClick={() => {
                  // Move first selected project to device dialog
                  const firstSelected = projects.find(p => selectedIds.has(p.id))
                  if (firstSelected) setMoveProjectDialog(firstSelected)
                }}><ArrowRightLeft className="h-3 w-3 mr-1" />{t('dlg.batch.moveToDevice')}</Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 text-xs border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                      <Trash2 className="h-3 w-3 mr-1" />{t('dlg.deleteConfirm.deleteSelected')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('dlg.deleteConfirm.batchTitle', { count: selectedIds.size })}</AlertDialogTitle>
                      <AlertDialogDescription>{t('dlg.deleteConfirm.batchDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('dlg.common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleBatchAction('delete')} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t('dlg.common.delete')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ======================== MAIN CONTENT ======================== */}
      <main className="flex-1 w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 pb-10">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        {/* Quick Launch Bar (Session 13) */}
        {!loading && quickLaunchBarVisible && runningEnvsForQuickLaunch.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="mb-4 flex items-center gap-2 flex-wrap"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <Zap className="h-3 w-3 text-brand" />
              Quick Launch
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {runningEnvsForQuickLaunch.map((env) => {
                const host = currentHost || 'localhost'
                const url = `http://${host}:${env.port}`
                return (
                  <a
                    key={env.envId}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-zinc-200 dark:border-zinc-700 bg-card shadow-xs text-zinc-600 dark:text-zinc-300 hover:border-brand/40 dark:hover:border-brand/30 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="max-w-[80px] truncate">{env.projectName}</span>
                    <span className="text-zinc-300 dark:text-zinc-600">·</span>
                    <span className="truncate max-w-[50px]">{env.envName}</span>
                    <span className="text-[9px] font-mono text-zinc-500 dark:text-zinc-400 tabular-nums">:{env.port}</span>
                    <ExternalLink className="h-2.5 w-2.5 text-zinc-500 dark:text-zinc-400" />
                  </a>
                )
              })}
            </div>
            <button type="button" onClick={() => setQuickLaunchBarVisible(false)} className="ml-auto p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </motion.div>
        )}
        {/* Activity Feed Widget (Session 13) */}
        {!loading && activityFeedVisible && globalActivity.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.3 }}
            className="surface-card mb-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-card overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-zinc-50 dark:bg-zinc-800/60">
                  <Activity className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                </div>
                <span className="text-xs font-semibold text-foreground dark:text-zinc-200">{t('surf.recentActivity')}</span>
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{globalActivity.length}</Badge>
              </div>
              <button type="button" onClick={() => setActivityFeedVisible(false)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto custom-scrollbar">
              {globalActivity.map((event) => {
                const IconComp = ACTIVITY_ICONS[event.type] || Activity
                const colorClass = ACTIVITY_COLORS[event.type] || 'text-zinc-500 bg-zinc-100'
                return (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/30 dark:bg-zinc-800/40 shrink-0 hover:bg-muted/50 transition-colors cursor-default"
                  >
                    <div className={`p-1 rounded ${colorClass}`}>
                      <IconComp className="h-3 w-3" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium truncate max-w-[240px]">{event.message}</p>
                      <p className="text-[10px] text-muted-foreground">{formatTimeAgo(event.timestamp, t)}</p>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </motion.div>
        )}
        {loading ? (
          <LoadingSkeleton viewMode={viewMode} />
        ) : filteredProjects.length === 0 ? (
          projects.length === 0 ? (
            <EmptyState onAdd={handleAddProject} />
          ) : (
            <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="p-6 rounded-2xl bg-gradient-to-br from-muted/50 to-muted/30 ring-1 ring-border/30 shadow-inner mb-5">
              <SearchX className="h-16 w-16 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold mb-1 text-foreground">{t('surf.noResultsTitle')}</h3>
            <p className="text-sm text-muted-foreground dark:text-zinc-400 mb-4 max-w-xs">{t('surf.noResultsDesc')}</p>
            <Button variant="outline" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterTags([]) }} className="gap-1.5">
              <X className="h-4 w-4" />{t('surf.clearFilters')}
            </Button>
          </motion.div>
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filteredProjects.map((p) => p.id)} strategy={viewMode === 'list' ? verticalListSortingStrategy : rectSortingStrategy}>
              {/* Dashboard Overview Stats Cards */}
              {filteredProjects.length > 0 && (
                <div className={`grid gap-3 mb-5 relative ${visibleStats.size === 1 ? 'grid-cols-1 max-w-xs' : visibleStats.size === 2 ? 'grid-cols-2' : visibleStats.size === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'}`}>
                  {[
                    { key: 'totalProjects', label: t('dlg.customize.totalProjects'), value: dashboardStats.totalProjects, icon: Folder, sub: t('surf.statsEnvsRunning', { running: dashboardStats.runningEnvs, total: dashboardStats.totalEnvs }), miniChart: true, miniRunning: dashboardStats.runningEnvs, miniTotal: dashboardStats.totalEnvs, statusBars: true, runningCount: stats.running, mixedCount: stats.mixed, stoppedCount: stats.stopped },
                    { key: 'environments', label: t('dlg.customize.environments'), value: dashboardStats.runningEnvs, icon: Play, sub: t('card.preview.runningFraction', { running: dashboardStats.runningEnvs, total: dashboardStats.totalEnvs }), trend: dashboardStats.totalEnvs > 0 ? `${Math.round((dashboardStats.runningEnvs / dashboardStats.totalEnvs) * 100)}%` : '0%', envRing: true, envRunning: dashboardStats.runningEnvs, envTotal: dashboardStats.totalEnvs },
                    { key: 'devices', label: t('dlg.customize.devices'), value: dashboardStats.onlineDevices, icon: Server, sub: t('surf.devicesOnlineSub', { online: dashboardStats.onlineDevices, total: dashboardStats.totalDevices }), deviceDots: true },
                    { key: 'healthScore', label: t('dlg.customize.healthScore'), value: dashboardStats.healthScore, icon: Activity, sub: dashboardStats.healthScore >= 80 ? t('surf.healthy') : dashboardStats.healthScore >= 50 ? t('surf.warning') : t('surf.critical'), isPercent: true, sparkline: healthScoreHistory, trendArrow: true },
                  ].filter((card) => visibleStats.has(card.key)).map((card, i) => (
                    <motion.div
                      key={card.label}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="surface-card relative p-4 rounded-xl bg-card border border-zinc-200 dark:border-zinc-800 hover:border-brand/40 dark:hover:border-brand/30 cursor-default overflow-hidden"
                    >
                      <span className="stat-tab" aria-hidden="true" />
                      <div className="flex items-center gap-2 mb-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-brand/25 bg-brand-soft shadow-xs">
                          <card.icon className="h-3.5 w-3.5 text-brand-strong" />
                        </div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 dark:text-zinc-400">{card.label}</span>
                      </div>
                      <div className="flex items-end justify-between">
                        <div className="flex items-center gap-1">
                          <span className={`text-2xl font-bold tracking-tight tabular-nums ${card.isPercent && card.value < 50 ? 'text-red-600 dark:text-red-400' : 'text-foreground dark:text-zinc-100'}`}>
                            <AnimatedCounter target={card.value} />
                          </span>
                          {card.isPercent && <span className="text-sm text-muted-foreground ml-0.5">%</span>}
                          {card.trendArrow && healthScoreHistory.length >= 2 && (() => {
                            const prev = healthScoreHistory[healthScoreHistory.length - 2]
                            const curr = card.value
                            if (curr > prev) return <TrendingUp className="h-4 w-4 text-emerald-500" />
                            if (curr < prev) return <TrendingDown className="h-4 w-4 text-red-500" />
                            return null
                          })()}
                        </div>
                        {card.statusBars && (card.runningCount + card.mixedCount + card.stoppedCount > 0) && (() => {
                          const total = card.runningCount + card.mixedCount + card.stoppedCount
                          return (
                            <div className="flex gap-0.5 items-end h-6 shrink-0">
                              <div className="w-2 rounded-t-sm bg-emerald-400 transition-all" style={{ height: `${Math.max((card.runningCount / total) * 24, 2)}px` }} title={t('card.preview.runningCount', { count: card.runningCount })} />
                              <div className="w-2 rounded-t-sm bg-amber-400 transition-all" style={{ height: `${Math.max((card.mixedCount / total) * 24, 2)}px` }} title={`${card.mixedCount} ${t('surf.mixed')}`} />
                              <div className="w-2 rounded-t-sm bg-red-400 transition-all" style={{ height: `${Math.max((card.stoppedCount / total) * 24, 2)}px` }} title={t('card.preview.stoppedCount', { count: card.stoppedCount })} />
                            </div>
                          )
                        })()}
                        {card.envRing && card.envTotal > 0 && (() => {
                          const pct = (card.envRunning / card.envTotal) * 100
                          const r = 11
                          const circ = r * 2 * Math.PI
                          return (
                            <svg width={28} height={28} className="shrink-0 transform -rotate-90">
                              <circle cx={14} cy={14} r={r} fill="none" stroke="currentColor" strokeWidth={3} className="text-muted-foreground/15" />
                              <circle cx={14} cy={14} r={r} fill="none" stroke="var(--brand)" strokeWidth={3} strokeDasharray={`${(pct / 100) * circ} ${circ}`} strokeLinecap="round" />
                            </svg>
                          )
                        })()}
                        {card.deviceDots && (() => {
                          const allDevices = [{ status: 'online' }, ...devices]
                          return (
                            <div className="flex flex-wrap gap-0.5 max-w-[48px] shrink-0">
                              {allDevices.slice(0, 12).map((d, di) => (
                                <span key={di} className={`h-2 w-2 rounded-full ${d.status === 'online' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                              ))}
                              {allDevices.length > 12 && <span className="text-[8px] text-muted-foreground">+{allDevices.length - 12}</span>}
                            </div>
                          )
                        })()}
                        {card.miniChart && card.miniTotal > 0 && !card.statusBars && (
                          <svg width={28} height={28} className="shrink-0">
                            <circle cx={14} cy={14} r={11} fill="none" stroke="currentColor" strokeWidth={3} className="text-muted-foreground/15" />
                            <circle cx={14} cy={14} r={11} fill="none" stroke="var(--brand)" strokeWidth={3} strokeDasharray={`${(card.miniRunning / card.miniTotal) * 69.1} 69.1`} strokeLinecap="round" className="transform -rotate-90 origin-center" />
                          </svg>
                        )}
                        {card.sparkline && card.sparkline.length > 1 && (
                          <svg width={48} height={24} className="shrink-0" viewBox="0 0 48 24" preserveAspectRatio="none">
                            <polyline
                              fill="none"
                              stroke={healthStroke(card.value)}
                              strokeWidth={1.5}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              points={card.sparkline.map((v: number, si: number) => {
                                const x = (si / (card.sparkline.length - 1)) * 46 + 1
                                const y = 22 - (v / 100) * 20
                                return `${x},${y}`
                              }).join(' ')}
                            />
                          </svg>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground dark:text-zinc-400">{card.sub}</span>
                        {card.trend && (
                          <span className="text-[9px] font-medium text-brand-strong bg-brand-soft px-1 py-0 rounded-full">{card.trend}</span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                  {/* Quick Refresh Button */}
                  <button
                    type="button"
                    className="absolute -right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-card border shadow-sm hover:bg-accent hover:shadow-md transition-all ring-1 ring-border/30 text-muted-foreground hover:text-foreground"
                    onClick={() => fetchProjects()}
                    title={t('dlg.cmd.refresh')}
                  >
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              )}
              {/* ======================== PINNED PROJECTS SECTION (Session 11, Session 14 enhanced) ======================== */}
              {starredIds.size > 0 && filteredProjects.some((p) => starredIds.has(p.id)) && groupBy === 'none' && (
                <div className="mb-4">
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800">
                    <Pin className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-300 fill-current" />
                    <span className="text-sm font-semibold text-foreground dark:text-zinc-200">{t('surf.pinned')}</span>
                    <Badge variant="secondary" className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                      {filteredProjects.filter((p) => starredIds.has(p.id)).length}
                    </Badge>
                  </div>
                </div>
              )}
              {viewMode === 'grid' ? (
                <div key={`grid-${filterStatus}-${filterTags.join(',')}-${searchQuery}-${groupBy}`} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7 gap-3">
                  {groupBy === 'tags' ? (
                    <>
                      {tagGroupedProjects.map((group) => (
                        <React.Fragment key={group.tagName}>
                          <div className="col-span-full">
                            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-muted/60 via-muted/30 to-transparent dark:from-white/5 dark:via-white/3 dark:to-transparent border border-border/40 dark:border-zinc-700/30 border-l-2 border-l-brand/50 shadow-xs">
                              <Badge variant="secondary" className={`text-xs px-2.5 py-0.5 ${group.tagColor}`}>{group.tagName}</Badge>
                              <Badge variant="secondary" className="text-[10px] bg-muted/60">{group.projects.length}</Badge>
                            </div>
                          </div>
                          {group.projects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </React.Fragment>
                      ))}
                    </>
                  ) : groupBy === 'device' && selectedDeviceId === null && deviceGroupedProjects ? (
                    <>
                      {/* Local projects group */}
                      {deviceGroupedProjects.localProjects.length > 0 && (
                        <>
                          <div className="col-span-full">
                            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 border-l-2 border-l-brand/50 shadow-xs">
                              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-card dark:bg-zinc-800/60">
                                <Monitor className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                              </div>
                              <span className="text-sm font-semibold text-foreground dark:text-zinc-200">{t('surf.thisMachine')}</span>
                              <Badge variant="secondary" className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{deviceGroupedProjects.localProjects.length}</Badge>
                            </div>
                          </div>
                          {deviceGroupedProjects.localProjects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </>
                      )}
                      {/* Remote device groups */}
                      {deviceGroupedProjects.remoteGroups.map((group) => (
                        <React.Fragment key={group.device?.id ?? 'unknown'}>
                          <div className="col-span-full mt-4">
                            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 border-l-2 border-l-brand/50 shadow-xs">
                              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-card dark:bg-zinc-800/60">
                                <Server className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                              </div>
                              <AnimatedStatusDot status={group.device?.status === 'online' ? 'running' : 'offline'} size="md" />
                              <span className="text-sm font-semibold text-foreground dark:text-zinc-200">{group.device?.name ?? t('surf.unknownDevice')}</span>
                              <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                              <Badge variant="secondary" className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{group.projects.length}</Badge>
                            </div>
                          </div>
                          {group.projects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </React.Fragment>
                      ))}
                    </>
                  ) : (
                    filteredProjects.map((project, idx) => (
                      <SortableProjectCard
                        key={project.id}
                        project={project}
                        viewMode={viewMode}
                        searchQuery={searchQuery}
                        onSelect={handleSelectProject}
                        onEdit={handleEditProject}
                        onDelete={setDeleteProject}
                        onEnvAction={handleEnvAction}
                        onRebuildConfirm={setRebuildConfirmProject}
                        selected={selectedIds.has(project.id)}
                        onToggleSelect={toggleSelect}
                        rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                        starred={starredIds.has(project.id)}
                        onToggleStar={toggleStar}
                        lanIp={lanIp}
                        currentHost={currentHost}
                        index={idx}
                        batchMode={batchMode}
                        onDuplicate={handleDuplicateProject}
                        onMoveToDevice={setMoveProjectDialog}
                        devices={devices}
                        focused={focusedProjectIndex === idx}
                        cardDensity={cardDensity}
                        onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                      />
                    ))
                  )}
                </div>
              ) : (
                <div key={`list-${filterStatus}-${filterTags.join(',')}-${searchQuery}-${groupBy}`} className="space-y-2">
                  {groupBy === 'tags' ? (
                    <>
                      {tagGroupedProjects.map((group) => (
                        <React.Fragment key={group.tagName}>
                          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-gradient-to-r from-muted/60 via-muted/30 to-transparent dark:from-white/5 dark:via-white/3 dark:to-transparent border border-border/40 dark:border-zinc-700/30">
                            <Badge variant="secondary" className={`text-xs px-2.5 py-0.5 ${group.tagColor}`}>{group.tagName}</Badge>
                            <Badge variant="secondary" className="text-[10px] bg-muted/60">{group.projects.length}</Badge>
                          </div>
                          {group.projects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </React.Fragment>
                      ))}
                    </>
                  ) : groupBy === 'device' && selectedDeviceId === null && deviceGroupedProjects ? (
                    <>
                      {/* Local projects group */}
                      {deviceGroupedProjects.localProjects.length > 0 && (
                        <>
                          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800">
                            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-card dark:bg-zinc-800/60">
                              <Monitor className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                            </div>
                            <span className="text-sm font-semibold text-foreground dark:text-zinc-200">{t('surf.thisMachine')}</span>
                            <Badge variant="secondary" className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{deviceGroupedProjects.localProjects.length}</Badge>
                          </div>
                          {deviceGroupedProjects.localProjects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </>
                      )}
                      {/* Remote device groups */}
                      {deviceGroupedProjects.remoteGroups.map((group) => (
                        <React.Fragment key={group.device?.id ?? 'unknown'}>
                          <div className="flex items-center gap-2.5 px-3 py-2 mt-4 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800">
                            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-card dark:bg-zinc-800/60">
                              <Server className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                            </div>
                            <AnimatedStatusDot status={group.device?.status === 'online' ? 'running' : 'offline'} size="md" />
                            <span className="text-sm font-semibold text-foreground dark:text-zinc-200">{group.device?.name ?? t('surf.unknownDevice')}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                            <Badge variant="secondary" className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{group.projects.length}</Badge>
                          </div>
                          {group.projects.map((project, idx) => (
                            <SortableProjectCard
                              key={project.id}
                              project={project}
                              viewMode={viewMode}
                              searchQuery={searchQuery}
                              onSelect={handleSelectProject}
                              onEdit={handleEditProject}
                              onDelete={setDeleteProject}
                              onEnvAction={handleEnvAction}
                              onRebuildConfirm={setRebuildConfirmProject}
                              selected={selectedIds.has(project.id)}
                              onToggleSelect={toggleSelect}
                              rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </React.Fragment>
                      ))}
                    </>
                  ) : (
                    filteredProjects.map((project, idx) => (
                      <SortableProjectCard
                        key={project.id}
                        project={project}
                        viewMode={viewMode}
                        searchQuery={searchQuery}
                        onSelect={handleSelectProject}
                        onEdit={handleEditProject}
                        onDelete={setDeleteProject}
                        onEnvAction={handleEnvAction}
                        onRebuildConfirm={setRebuildConfirmProject}
                        selected={selectedIds.has(project.id)}
                        onToggleSelect={toggleSelect}
                        rebuilding={rebuildingProjectIds.has(project.id)}
                              pendingOps={pendingEnvOps}
                        starred={starredIds.has(project.id)}
                        onToggleStar={toggleStar}
                        lanIp={lanIp}
                        currentHost={currentHost}
                        index={idx}
                        batchMode={batchMode}
                        onDuplicate={handleDuplicateProject}
                        onMoveToDevice={setMoveProjectDialog}
                        devices={devices}
                        onHover={setHoveredProjectId}
                        focused={focusedProjectIndex === idx}
                        cardDensity={cardDensity}
                        onCompare={handleCompareProject}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                      />
                    ))
                  )}
                </div>
              )}
            </SortableContext>
          </DndContext>
        )}
        </motion.div>
      </main>

      {/* ======================== FOOTER ======================== */}
      <EnhancedFooter projects={projects} filteredCount={filteredProjects.length} onOpenDevices={() => setDeviceManagementOpen(true)} devices={devices} onOpenSystemMonitor={() => setSystemMonitorOpen(true)} onOpenPorts={() => setPortsPanelOpen(true)} onRefresh={() => fetchProjects({ fresh: true })} onAddProject={() => { setEditingProject(null); setProjectFormMode('add'); setProjectFormOpen(true) }} />

      {/* ======================== GLOBAL STATUS PANEL ======================== */}
      {!loading && projects.length > 0 && <GlobalStatusPanel projects={projects} />}

      {/* ======================== DIALOGS ======================== */}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteProject} onOpenChange={(v) => !v && setDeleteProject(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dlg.deleteConfirm.title', { name: deleteProject?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('dlg.deleteConfirm.desc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dlg.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteProject && handleDeleteProject(deleteProject.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('dlg.common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rebuild confirmation */}
      <AlertDialog open={!!rebuildConfirmProject} onOpenChange={(v) => !v && setRebuildConfirmProject(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dlg.rebuildConfirm.title', { name: rebuildConfirmProject?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('dlg.rebuildConfirm.desc', { count: rebuildConfirmProject?.environments?.filter((e) => e.name !== 'development').length ?? 0 })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dlg.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (rebuildConfirmProject) { handleRebuildProject(rebuildConfirmProject.id); setRebuildConfirmProject(null) } }} className="bg-teal-600 text-white hover:bg-teal-700">
              {t('dlg.rebuildConfirm.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move to Device dialog */}
      <Dialog open={!!moveProjectDialog} onOpenChange={(v) => !v && setMoveProjectDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-emerald-600" />
              {t('dlg.move.title', { name: moveProjectDialog?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('dlg.move.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            <button
              type="button"
              className="w-full flex items-center gap-2.5 p-3 rounded-lg border hover:bg-brand-soft hover:border-brand/40 transition-colors text-left"
              onClick={() => moveProjectDialog && handleMoveProject(moveProjectDialog.id, null)}
            >
              <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <div className="text-sm font-medium">{t('dlg.move.thisMachine')}</div>
                <div className="text-[10px] text-muted-foreground">{t('dlg.move.backToLocal')}</div>
              </div>
            </button>
            {devices.map((device) => (
              <button
                key={device.id}
                type="button"
                className="w-full flex items-center gap-2.5 p-3 rounded-lg border hover:bg-accent/50 transition-colors text-left"
                onClick={() => moveProjectDialog && handleMoveProject(moveProjectDialog.id, device.id)}
              >
                <Server className={`h-4 w-4 shrink-0 ${device.status === 'online' ? 'text-emerald-500' : 'text-red-400'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{device.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{device.ip}:{device.port}</div>
                </div>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${device.status === 'online' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>{device.status === 'online' ? t('dlg.common.online') : t('dlg.common.offline')}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Error detail dialog - shows full build error output */}
      <Dialog open={!!errorDialog} onOpenChange={(v) => !v && setErrorDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[80dvh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {errorDialog?.title ?? t('dlg.error.title')}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('dlg.error.desc')}
            </DialogDescription>
          </DialogHeader>
          {errorDialog?.detail && (
            <div className="flex-1 overflow-auto mt-2">
              <pre className="bg-muted/50 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed max-h-[60vh] overflow-auto">
                {errorDialog.detail}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => {
              if (errorDialog?.detail) {
                navigator.clipboard.writeText(errorDialog.detail).then(() => {
                  toast({ title: t('dlg.common.copied'), variant: 'success' })
                }).catch(() => {})
              }
            }}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              {t('dlg.common.copy')}
            </Button>
            <Button size="sm" onClick={() => setErrorDialog(null)}>{t('dlg.common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project form - key resets state when dialog opens */}
      <ProjectFormDialog
        key={projectFormOpen ? `open-${editingProject?.id ?? 'new'}` : 'project-form-closed'}
        open={projectFormOpen}
        onClose={() => setProjectFormOpen(false)}
        onSubmit={handleProjectSubmit}
        project={editingProject}
        mode={projectFormMode}
        devices={devices}
      />

      {/* Environment form - key resets state when dialog opens */}
      <EnvFormDialog
        key={envFormOpen ? `open-${editingEnv?.id ?? 'new'}` : 'env-form-closed'}
        open={envFormOpen}
        onClose={() => setEnvFormOpen(false)}
        onSubmit={handleEnvSubmit}
        env={editingEnv}
        mode={envFormMode}
      />

      {/* Detail sheet - key resets state when project changes */}
      <DetailSheet
        key={selectedProject?.id ?? 'none'}
        project={selectedProject}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onEnvAction={handleEnvAction}
        lanIp={lanIp}
        currentHost={currentHost}
        onRefresh={() => {
          fetchProjects({ fresh: true })
          if (selectedProject) {
            fetch(`/api/projects/${selectedProject.id}`)
              .then((r) => r.json())
              .then((fresh) => setSelectedProject(fresh?.project ?? fresh))
              .catch(() => {})
          }
        }}
        devices={devices}
        onOpenDeviceManagement={() => setDeviceManagementOpen(true)}
        onReanalyze={handleReanalyzeProject}
      />

      {/* Gateway monitor */}
      {/* System resource monitor (merged gateway + system monitoring, single surface) */}
      <SystemMonitorDialog open={systemMonitorOpen} onClose={() => setSystemMonitorOpen(false)} />

      {/* Live port occupancy panel */}
      <PortsPanel open={portsPanelOpen} onClose={() => setPortsPanelOpen(false)} onKilled={() => fetchProjects({ fresh: true })} />

      {/* LLM config */}
      <LlmConfigDialog open={llmOpen} onClose={() => setLlmOpen(false)} />
      <RepairDialog
        jobId={repairJobId}
        open={repairDialogOpen}
        onOpenChange={handleRepairDialogOpenChange}
        onFinished={handleRepairFinishedNotified}
        onApprovalNeeded={handleRepairApprovalNeeded}
        onJobUpdate={handleRepairJobUpdate}
      />

      {/* deepseek-harness agent analysis wizard (live progress + one-click start) */}
      <AnalyzeWizard
        session={harnessSession}
        onClose={closeHarnessWizard}
        onApplied={() => fetchProjects()}
        onStartEnv={(projectId, envId) => handleEnvAction(projectId, envId, 'start')}
        onRetry={harnessSession ? () => startHarnessAnalysis(harnessSession.projectId, harnessSession.name, harnessSession.path) : undefined}
      />

      {/* Remote project auto-debug analysis (device-side loop, LLM via dashboard gateway) */}
      <RemoteProjectDialog
        open={remoteProjectOpen}
        onClose={() => setRemoteProjectOpen(false)}
        devices={devices}
        lanIp={lanIp}
        onCompleted={() => { fetchProjects(); fetchDevices() }}
      />

      {/* Mesh pairing (one-command device join) */}
      <MeshPairingDialog
        open={meshPairingOpen}
        onClose={() => setMeshPairingOpen(false)}
        lanIp={lanIp}
        onPaired={() => { setMeshPairingOpen(false); fetchDevices(); fetchProjects(); addToast({ title: t('dlg.meshPairing.devicePaired'), description: t('dlg.meshPairing.devicePairedDesc'), variant: 'success' }) }}
      />

      {/* Join another dashboard's mesh by entering its pairing code in the web UI */}
      <JoinMeshDialog
        open={meshJoinOpen}
        onClose={() => setMeshJoinOpen(false)}
        onJoined={() => { fetchDevices(); fetchProjects() }}
      />

      {/* Command palette - key resets state when opened */}
      <CommandPalette
        key={commandPaletteOpen ? 'command-open' : 'command-closed'}
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        projects={projects}
        onSelectProject={handleSelectProject}
        onAddProject={handleAddProject}
        onRefresh={loadData}
        onToggleView={() => setViewMode((v) => v === 'grid' ? 'list' : 'grid')}
        devices={devices}
        onOpenDeviceManagement={() => setDeviceManagementOpen(true)}
        onFilterByDevice={(deviceId) => setSelectedDeviceId(deviceId)}
      />

      {/* Keyboard shortcuts */}
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Notification detail */}
      <NotificationDetailDialog
        notification={notifDetail}
        open={notifDetailOpen}
        onClose={() => { setNotifDetailOpen(false); setNotifDetail(null) }}
      />

      {/* Device management panel */}
      <DeviceManagementPanel
        open={deviceManagementOpen}
        onClose={() => setDeviceManagementOpen(false)}
        devices={devices}
        onAdd={() => { setAddDeviceFormOpen(true); setEditingDevice(null) }}
        onEdit={(device) => { setEditingDevice(device); setAddDeviceFormOpen(true) }}
        onDelete={handleDeleteDevice}
        onHealthCheck={handleCheckDeviceHealth}
        onOpenDeployGuide={() => { setDeviceManagementOpen(false); setAgentDeployGuideOpen(true) }}
        onOpenPairing={() => { setDeviceManagementOpen(false); setMeshPairingOpen(true) }}
        onOpenJoin={() => { setDeviceManagementOpen(false); setMeshJoinOpen(true) }}
        onOpenRemoteProject={() => { setDeviceManagementOpen(false); setRemoteProjectOpen(true) }}
      />

      {/* Device form dialog */}
      <DeviceFormDialog
        key={addDeviceFormOpen ? `device-form-${editingDevice?.id ?? 'new'}` : 'device-form-closed'}
        open={addDeviceFormOpen}
        onClose={() => { setAddDeviceFormOpen(false); setEditingDevice(null) }}
        onSubmit={(data) => {
          if (editingDevice) {
            handleUpdateDevice(editingDevice.id, data)
          } else {
            handleAddDevice(data)
          }
        }}
        device={editingDevice}
        mode={editingDevice ? 'edit' : 'add'}
      />

      {/* ======================== SCROLL-TO-TOP FAB (Session 11) ======================== */}
      <AnimatePresence>
        {scrollTopVisible && (
          <motion.button
            type="button"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="fixed bottom-16 right-4 z-40 h-10 w-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg transition-all active:scale-90 flex items-center justify-center"
            title={t('surf.scrollTop')}
          >
            <ArrowUp className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ======================== DEPENDENCY GRAPH DIALOG (Session 11) ======================== */}
      <Dialog open={depGraphOpen} onOpenChange={setDepGraphOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80dvh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitFork className="h-5 w-5 text-emerald-600" />
              {t('dlg.depGraph.title')}
            </DialogTitle>
            <DialogDescription>{t('dlg.depGraph.desc')}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {projects.length < 2 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <GitFork className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">{t('dlg.depGraph.needTwo')}</p>
              </div>
            ) : (() => {
              // Build nodes and edges
              const nodes = projects.map((p, i) => ({
                id: p.id,
                name: p.name,
                icon: ICON_MAP[p.icon] || Folder,
                status: getProjectStatus(p),
                tags: parseTags(p.tags),
                angle: (2 * Math.PI * i) / projects.length - Math.PI / 2,
              }))
              const edges: Array<{ from: number; to: number; tag: string }> = []
              for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                  const shared = nodes[i].tags.filter((t) => nodes[j].tags.includes(t))
                  shared.forEach((tag) => edges.push({ from: i, to: j, tag }))
                }
              }
              const cx = 250, cy = 200, r = 150
              const statusColor = (s: string) => s === 'running' ? '#10b981' : s === 'mixed' ? '#f59e0b' : '#ef4444'
              return (
                <div className="space-y-3">
                  <svg viewBox="0 0 500 400" className="w-full h-auto" style={{ maxHeight: 400 }}>
                    {/* Edges */}
                    {edges.map((edge, ei) => {
                      const from = nodes[edge.from]
                      const to = nodes[edge.to]
                      const x1 = cx + r * Math.cos(from.angle)
                      const y1 = cy + r * Math.sin(from.angle)
                      const x2 = cx + r * Math.cos(to.angle)
                      const y2 = cy + r * Math.sin(to.angle)
                      const mx = (x1 + x2) / 2
                      const my = (y1 + y2) / 2
                      return (
                        <g key={ei}>
                          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" className="text-muted-foreground/30" strokeWidth={1.5} strokeDasharray="4 4" />
                          <text x={mx} y={my - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">{edge.tag}</text>
                        </g>
                      )
                    })}
                    {/* Nodes */}
                    {nodes.map((node, ni) => {
                      const x = cx + r * Math.cos(node.angle)
                      const y = cy + r * Math.sin(node.angle)
                      return (
                        <g key={ni}>
                          <circle cx={x} cy={y} r={22} fill={statusColor(node.status)} fillOpacity={0.15} stroke={statusColor(node.status)} strokeWidth={2} />
                          <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[9px] font-semibold" style={{ pointerEvents: 'none' }}>
                            {node.name.length > 8 ? node.name.slice(0, 7) + '…' : node.name}
                          </text>
                        </g>
                      )
                    })}
                  </svg>
                  {/* Legend */}
                  <div className="flex items-center gap-4 justify-center text-[10px] text-muted-foreground pb-2">
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> {t('dlg.depGraph.running')}</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> {t('dlg.depGraph.mixed')}</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> {t('dlg.depGraph.stopped')}</span>
                    <span className="flex items-center gap-1"><span className="h-4 border-t border-dashed border-muted-foreground/40 w-6" /> {t('dlg.depGraph.sharedTag')}</span>
                  </div>
                  {edges.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center pb-2">{t('dlg.depGraph.noSharedTags')}</p>
                  )}
                </div>
              )
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* ======================== BATCH TAG EDITOR DIALOG (Session 11) ======================== */}
      <Dialog open={batchTagEditorOpen} onOpenChange={setBatchTagEditorOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tags className="h-5 w-5 text-amber-500" />
              {t('dlg.batchTag.title')}
            </DialogTitle>
            <DialogDescription>{t('dlg.batchTag.desc', { count: selectedIds.size })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Selected projects */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">{t('dlg.batchTag.selected')}</Label>
              <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                {Array.from(selectedIds).map((id) => {
                  const p = projects.find((proj) => proj.id === id)
                  return p ? (
                    <Badge key={id} variant="secondary" className="text-[10px]">{p.name}</Badge>
                  ) : null
                })}
              </div>
            </div>
            {/* Mode toggle */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">{t('dlg.batchTag.mode')}</Label>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant={batchTagMode === 'add' ? 'default' : 'outline'} className={batchTagMode === 'add' ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : ''} onClick={() => setBatchTagMode('add')}>{t('dlg.batchTag.add')}</Button>
                <Button type="button" size="sm" variant={batchTagMode === 'replace' ? 'default' : 'outline'} className={batchTagMode === 'replace' ? 'bg-amber-600 hover:bg-amber-700 text-white' : ''} onClick={() => setBatchTagMode('replace')}>{t('dlg.batchTag.replace')}</Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {batchTagMode === 'add' ? t('dlg.batchTag.addHint') : t('dlg.batchTag.replaceHint')}
              </p>
            </div>
            {/* Tag checkboxes */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">{t('dlg.batchTag.tags')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {TAG_OPTIONS.map((tag) => {
                  const checked = batchTagDraft.includes(tag.name)
                  return (
                    <label key={tag.name} className="flex items-center gap-2 cursor-pointer p-2 rounded-md border hover:bg-accent/50 transition-colors">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          if (v) setBatchTagDraft((prev) => [...prev, tag.name])
                          else setBatchTagDraft((prev) => prev.filter((t) => t !== tag.name))
                        }}
                      />
                      <Badge variant="secondary" className={`text-[10px] ${tag.color}`}>{tag.name}</Badge>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchTagEditorOpen(false)} disabled={batchTagApplying}>{t('dlg.common.cancel')}</Button>
            <Button onClick={handleBatchTagApply} disabled={batchTagApplying || (batchTagMode === 'replace' && batchTagDraft.length === 0)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {batchTagApplying && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t('dlg.batchTag.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== HEALTH ALERTS CONFIG (Session 12) ======================== */}
      <Dialog open={healthAlertsOpen} onOpenChange={setHealthAlertsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/15 ring-1 ring-amber-200/50 dark:ring-amber-800/30">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <DialogTitle>{t('dlg.health.title')}</DialogTitle>
            </div>
            <DialogDescription>{t('dlg.health.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Enable toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t('dlg.health.enable')}</Label>
                <p className="text-xs text-muted-foreground">{t('dlg.health.enableDesc')}</p>
              </div>
              <Switch checked={healthAlertEnabled} onCheckedChange={setHealthAlertEnabled} />
            </div>
            {/* Threshold slider */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{t('dlg.health.threshold')}</Label>
                <span className={`text-sm font-bold px-2.5 py-0.5 rounded-md ${healthAlertThreshold >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : healthAlertThreshold >= 50 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                  {healthAlertThreshold}%
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={90}
                step={5}
                value={healthAlertThreshold}
                onChange={(e) => setHealthAlertThreshold(parseInt(e.target.value, 10))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer bg-muted accent-amber-500"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{t('dlg.health.moreAlerts')}</span>
                <span>{t('dlg.health.fewerAlerts')}</span>
              </div>
            </div>
            {/* Current status */}
            <div className="p-3 rounded-lg border bg-muted/20 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t('dlg.health.currentScore')}</span>
                <span className={`font-bold ${healthColor(dashboardStats.healthScore)}`}>{dashboardStats.healthScore}%</span>
              </div>
              <Progress value={dashboardStats.healthScore} className="h-2" />
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${dashboardStats.healthScore <= healthAlertThreshold ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span className="text-[10px] text-muted-foreground">
                  {dashboardStats.healthScore <= healthAlertThreshold ? t('dlg.health.belowThreshold') : t('dlg.health.aboveThreshold')}
                </span>
              </div>
            </div>
            {/* Per-project health with severity groups (Session 14) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t('dlg.health.projectStatus')}</Label>
                {alertsAcknowledged && (
                  <Button variant="ghost" size="sm" className="h-5 text-[9px] px-1.5 btn-micro-click" onClick={() => { setAlertsAcknowledged(false); localStorage.setItem('dashboard-alerts-acknowledged', 'false') }}>{t('dlg.health.showAlerts')}</Button>
                )}
              </div>
              <div className="max-h-52 overflow-y-auto space-y-2 custom-scrollbar">
                {(() => {
                  const projectHealth = projects.map((p) => ({ project: p, score: calculateHealthScore(p), severity: getAlertSeverity(calculateHealthScore(p)) }))
                  const severityGroups: { key: AlertSeverity; items: typeof projectHealth }[] = [
                    { key: 'critical', items: projectHealth.filter((h) => h.severity === 'critical') },
                    { key: 'warning', items: projectHealth.filter((h) => h.severity === 'warning') },
                    { key: 'notice', items: projectHealth.filter((h) => h.severity === 'notice') },
                    { key: 'ok', items: projectHealth.filter((h) => h.severity === 'ok') },
                  ]
                  return severityGroups.filter((g) => g.items.length > 0).map((group) => {
                    const cfg = severityConfig(group.key)
                    return (
                      <SeverityGroup key={group.key} label={t(`dlg.health.severity.${group.key}` as Parameters<typeof t>[0])} color={cfg.color} dot={cfg.dot} count={group.items.length}>
                        {group.items.map(({ project: p, score }) => (
                          <div key={p.id} className={`flex items-center justify-between px-3 py-1.5 rounded-md text-xs ${cfg.bg} ${group.key === 'critical' ? 'alert-critical-pulse' : ''}`}>
                            <span className="truncate font-medium">{p.name}</span>
                            <div className="flex items-center gap-2">
                              <span className={`font-bold ${cfg.color}`}>{score}%</span>
                              {score <= healthAlertThreshold && healthAlertEnabled && (
                                <AlertTriangle className={`h-3 w-3 ${cfg.color}`} />
                              )}
                            </div>
                          </div>
                        ))}
                      </SeverityGroup>
                    )
                  })
                })()}
              </div>
            </div>
          </div>
          <DialogFooter>
            <div className="flex items-center gap-2">
              {!alertsAcknowledged && healthAlertEnabled && projects.some((p) => calculateHealthScore(p) <= healthAlertThreshold) && (
                <Button variant="outline" size="sm" className="text-xs h-8 btn-micro-click" onClick={() => { setAlertsAcknowledged(true); localStorage.setItem('dashboard-alerts-acknowledged', 'true') }}>
                  <AlertTriangle className="h-3 w-3 mr-1" />{t('dlg.health.acknowledge')}
                </Button>
              )}
            </div>
            <Button variant="outline" onClick={() => setHealthAlertsOpen(false)}>{t('dlg.common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== DASHBOARD CUSTOMIZE (Session 12) ======================== */}
      <Dialog open={dashboardCustomizeOpen} onOpenChange={setDashboardCustomizeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-cyan-50 to-sky-50 dark:from-cyan-900/20 dark:to-sky-900/15 ring-1 ring-cyan-200/50 dark:ring-cyan-800/30">
                <LayoutGrid className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
              </div>
              <DialogTitle>{t('dlg.customize.title')}</DialogTitle>
            </div>
            <DialogDescription>{t('dlg.customize.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Card Density */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t('dlg.customize.density')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['compact', 'comfortable', 'spacious'] as const).map((density) => (
                  <button
                    key={density}
                    type="button"
                    onClick={() => setCardDensity(density)}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all ${cardDensity === density ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20 ring-1 ring-emerald-500/30' : 'border-border hover:bg-accent/50'}`}
                  >
                    <div className={`w-full space-y-1 ${density === 'compact' ? 'p-1' : density === 'spacious' ? 'p-3' : 'p-2'}`}>
                      <div className="h-2 rounded bg-muted-foreground/20" />
                      <div className="h-2 rounded bg-muted-foreground/10 w-3/4" />
                    </div>
                    <span className="text-[10px] font-medium">{t(`dlg.customize.${density}` as Parameters<typeof t>[0])}</span>
                  </button>
                ))}
              </div>
            </div>
            {/* Visible Stats */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t('dlg.customize.visibleStats')}</Label>
              <div className="space-y-1.5">
                {[
                  { key: 'totalProjects', label: t('dlg.customize.totalProjects'), icon: Folder },
                  { key: 'environments', label: t('dlg.customize.environments'), icon: Play },
                  { key: 'devices', label: t('dlg.customize.devices'), icon: Server },
                  { key: 'healthScore', label: t('dlg.customize.healthScore'), icon: Activity },
                ].map(({ key, label, icon: Icon }) => (
                  <label key={key} className="flex items-center gap-3 p-2.5 rounded-lg border hover:bg-accent/50 cursor-pointer transition-colors">
                    <Checkbox
                      checked={visibleStats.has(key)}
                      onCheckedChange={(v) => {
                        setVisibleStats((prev) => {
                          const next = new Set(prev)
                          if (v) next.add(key)
                          else next.delete(key)
                          return next
                        })
                      }}
                    />
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>
            {/* Quick Actions */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t('dlg.customize.quickActions')}</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setQuickLaunchBarVisible(true) }}>
                  <Zap className="h-3 w-3 mr-1" />{t('dlg.customize.quickLaunch')}
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setActivityFeedVisible(true) }}>
                  <Activity className="h-3 w-3 mr-1" />{t('dlg.customize.activityFeed')}
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8 col-span-3" onClick={() => { setCardDensity('comfortable'); setVisibleStats(new Set(['totalProjects', 'environments', 'devices', 'healthScore'])) }}>
                  <RefreshCw className="h-3 w-3 mr-1" />{t('dlg.customize.resetDefaults')}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => setDashboardCustomizeOpen(false)}>{t('dlg.customize.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== PROJECT COMPARE (Session 12) ======================== */}
      <Dialog open={compareOpen} onOpenChange={(v) => { setCompareOpen(v); if (!v) { setCompareProjectA(null); setCompareProjectB(null) } }}>
        <DialogContent className="sm:max-w-2xl max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-900/20 dark:to-purple-900/15 ring-1 ring-violet-200/50 dark:ring-violet-800/30">
                <ArrowRightLeft className="h-5 w-5 text-violet-600 dark:text-violet-400" />
              </div>
              <DialogTitle>{t('dlg.compare.title')}</DialogTitle>
            </div>
            <DialogDescription>{t('dlg.compare.desc')}</DialogDescription>
          </DialogHeader>
          {!compareProjectA ? (
            <div className="py-6 text-center space-y-4">
              <p className="text-sm text-muted-foreground">{t('dlg.compare.selectTwo')}</p>
              <div className="grid grid-cols-2 gap-4">
                {[t('dlg.compare.projectA'), t('dlg.compare.projectB')].map((label, i) => (
                  <div key={label} className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
                    <Select onValueChange={(v) => { const p = projects.find((pr) => pr.id === v); if (i === 0) setCompareProjectA(p || null); else setCompareProjectB(p || null) }}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t('dlg.compare.selectProject')} /></SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Project selectors */}
              <div className="grid grid-cols-2 gap-3">
                <Select value={compareProjectA.id} onValueChange={(v) => setCompareProjectA(projects.find((p) => p.id === v) || null)}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={compareProjectB?.id || ''} onValueChange={(v) => setCompareProjectB(projects.find((p) => p.id === v) || null)}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t('dlg.compare.selectProject')} /></SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Comparison table */}
              {compareProjectB && (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left p-2.5 font-medium text-muted-foreground w-1/4">{t('dlg.compare.property')}</th>
                        <th className="text-left p-2.5 font-medium">{compareProjectA.name}</th>
                        <th className="text-left p-2.5 font-medium">{compareProjectB.name}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {[
                        { label: t('dlg.compare.status'), a: getProjectStatus(compareProjectA), b: getProjectStatus(compareProjectB), render: (v: string) => <Badge variant="secondary" className={`text-[10px] ${v === 'running' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : v === 'mixed' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>{t(`surf.${v}` as Parameters<typeof t>[0])}</Badge> },
                        { label: t('dlg.compare.health'), a: calculateHealthScore(compareProjectA), b: calculateHealthScore(compareProjectB), render: (v: number) => <span className={`font-bold ${healthColor(v)}`}>{v}%</span> },
                        { label: t('dlg.compare.environments'), a: (compareProjectA.environments || []).length, b: (compareProjectB.environments || []).length, render: (v: number) => <span>{v}</span> },
                        { label: t('dlg.compare.running'), a: (compareProjectA.environments || []).filter((e) => e.status === 'running').length, b: (compareProjectB.environments || []).filter((e) => e.status === 'running').length, render: (v: number) => <span className="text-emerald-600 dark:text-emerald-400">{v}</span> },
                        { label: t('dlg.compare.stopped'), a: (compareProjectA.environments || []).filter((e) => e.status !== 'running').length, b: (compareProjectB.environments || []).filter((e) => e.status !== 'running').length, render: (v: number) => <span className="text-red-500">{v}</span> },
                        { label: t('dlg.compare.tags'), a: parseTags(compareProjectA.tags), b: parseTags(compareProjectB.tags), render: (v: string[]) => <div className="flex flex-wrap gap-0.5">{v.map((t) => <Badge key={t} variant="secondary" className={`text-[8px] px-1 py-0 ${getTagColor(t)}`}>{t}</Badge>)}</div> },
                        { label: t('dlg.compare.path'), a: compareProjectA.path, b: compareProjectB.path, render: (v: string) => <span className="font-mono text-[10px] truncate max-w-[180px] inline-block">{v}</span> },
                        { label: t('dlg.compare.device'), a: compareProjectA.deviceName || t('dlg.compare.local'), b: compareProjectB.deviceName || t('dlg.compare.local'), render: (v: string) => <span>{v}</span> },
                        { label: t('dlg.compare.description'), a: compareProjectA.description || '—', b: compareProjectB.description || '—', render: (v: string) => <span className="truncate max-w-[180px] inline-block">{v}</span> },
                      ].map(({ label, a, b, render }) => (
                        <tr key={label} className="hover:bg-muted/20 transition-colors">
                          <td className="p-2.5 font-medium text-muted-foreground">{label}</td>
                          <td className="p-2.5">{render(a as never)}</td>
                          <td className="p-2.5">{render(b as never)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!compareProjectB && (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <ArrowRightLeft className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">{t('dlg.compare.selectSecond')}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCompareOpen(false); setCompareProjectA(null); setCompareProjectB(null) }}>{t('dlg.compare.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== AGENT DEPLOY GUIDE DIALOG ======================== */}
      <Dialog open={agentDeployGuideOpen} onOpenChange={setAgentDeployGuideOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85dvh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/50 dark:ring-teal-800/30">
                <Download className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              </div>
              {t('dlg.agentDeploy.title')}
            </DialogTitle>
            <DialogDescription>{t('dlg.agentDeploy.desc')}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
            {/* Platform Selection */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Monitor className="h-4 w-4 text-teal-600" />
                {t('dlg.agentDeploy.choosePlatform')}
              </h4>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'windows', label: 'Windows', icon: '🪟', desc: t('dlg.agentDeploy.winDesc'), active: true },
                  { key: 'macos', label: 'macOS', icon: '🍎', desc: t('dlg.agentDeploy.nodeDesc'), active: false },
                  { key: 'linux', label: 'Linux', icon: '🐧', desc: t('dlg.agentDeploy.nodeDesc'), active: false },
                ].map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={`rounded-lg border-2 p-3 text-left transition-all ${
                      p.active
                        ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-900/20 ring-1 ring-teal-500/30'
                        : 'border-muted hover:border-teal-300 dark:hover:border-teal-700'
                    }`}
                  >
                    <div className="text-lg mb-1">{p.icon}</div>
                    <div className="text-sm font-semibold">{p.label}</div>
                    <div className="text-[10px] text-muted-foreground">{p.desc}</div>
                    {p.active && <Badge className="mt-1.5 text-[9px] bg-teal-600 text-white">{t('dlg.agentDeploy.recommended')}</Badge>}
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            {/* Quick Start - Windows */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                {t('dlg.agentDeploy.quickStart')}
              </h4>

              {/* Step 1 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">1</span>
                  <span className="text-sm font-medium">{t('dlg.agentDeploy.step1')}</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">
                  {t('dlg.agentDeploy.step1DescBefore')} <code className="px-1.5 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[11px] font-mono">dashboard-agent-windows.zip</code> {t('dlg.agentDeploy.step1DescAfter')}
                </p>
                <div className="pl-7">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => {
                    window.open('/api/agent/download?platform=windows', '_blank')
                    addToast({ title: t('dlg.agentDeploy.downloading'), description: t('dlg.agentDeploy.downloadingDesc'), variant: 'success' })
                  }}>
                    <Download className="h-3 w-3" />
                    {t('dlg.agentDeploy.downloadBtn')}
                  </Button>
                </div>
              </div>

              {/* Step 2 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">2</span>
                  <span className="text-sm font-medium">{t('dlg.agentDeploy.step2')}</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">{t('dlg.agentDeploy.step2Desc')}</p>
                <div className="pl-7 mt-1.5">
                  <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                    <div className="text-emerald-400">{t('dlg.agentDeploy.optA')}</div>
                    <div className="text-zinc-300">node setup.js</div>
                    <div className="text-zinc-500 mt-2">{t('dlg.agentDeploy.optB')}</div>
                    <div className="text-zinc-300">start.bat</div>
                    <div className="text-zinc-500 mt-2">{t('dlg.agentDeploy.optC')}</div>
                    <div className="text-zinc-300">dashboard-agent-setup.exe</div>
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">3</span>
                  <span className="text-sm font-medium">{t('dlg.agentDeploy.step3')}</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">
                  {t('dlg.agentDeploy.step3Desc')}
                </p>
                <div className="pl-7 mt-1.5">
                  <Button size="sm" className="h-7 text-xs bg-teal-600 hover:bg-teal-700 text-white gap-1.5" onClick={() => {
                    setAgentDeployGuideOpen(false)
                    setTimeout(() => setAddDeviceFormOpen(true), 300)
                  }}>
                    <Plus className="h-3 w-3" />
                    {t('dlg.agentDeploy.addNow')}
                  </Button>
                </div>
              </div>
            </div>

            <Separator />

            {/* Installation Methods */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-violet-600" />
                {t('dlg.agentDeploy.installMethods')}
              </h4>

              <div className="grid gap-3">
                {/* Method 1: Simple */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-emerald-100 dark:bg-emerald-900/30">
                      <Terminal className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <span className="text-sm font-semibold">{t('dlg.agentDeploy.simple')}</span>
                    <Badge variant="secondary" className="text-[9px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{t('dlg.agentDeploy.easiest')}</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>{t('dlg.agentDeploy.m1s1Before')} <a href="https://nodejs.org" target="_blank" rel="noopener" className="text-teal-600 dark:text-teal-400 underline underline-offset-2">Node.js 18+</a></li>
                    <li>{t('dlg.agentDeploy.m1s2')}</li>
                    <li>{t('dlg.agentDeploy.m1s3Before')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">start.bat</code></li>
                    <li>{t('dlg.agentDeploy.m1s4')}</li>
                  </ol>
                </div>

                {/* Method 2: EXE Installer */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-violet-100 dark:bg-violet-900/30">
                      <Monitor className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <span className="text-sm font-semibold">{t('dlg.agentDeploy.exe')}</span>
                    <Badge variant="secondary" className="text-[9px] bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">{t('dlg.agentDeploy.professional')}</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>{t('dlg.agentDeploy.m2s1Before')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">build-installer.bat</code></li>
                    <li>{t('dlg.agentDeploy.m2s2Before')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">dashboard-agent-setup.exe</code></li>
                    <li>{t('dlg.agentDeploy.m2s3')}</li>
                    <li>{t('dlg.agentDeploy.m2s4')}</li>
                  </ol>
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-6">{t('dlg.agentDeploy.innoWarn')}</p>
                </div>

                {/* Method 3: Windows Service */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-amber-100 dark:bg-amber-900/30">
                      <Shield className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <span className="text-sm font-semibold">{t('dlg.agentDeploy.service')}</span>
                    <Badge variant="secondary" className="text-[9px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">{t('dlg.agentDeploy.production')}</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>{t('dlg.agentDeploy.m3s1')}</li>
                    <li>{t('dlg.agentDeploy.m3s2Before')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">.\install-service.ps1 -Port 3100</code></li>
                    <li>{t('dlg.agentDeploy.m3s3')}</li>
                    <li>{t('dlg.agentDeploy.m3s4Before')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">Start-Service DashboardAgent</code></li>
                  </ol>
                </div>
              </div>
            </div>

            <Separator />

            {/* Configuration Reference */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Settings className="h-4 w-4 text-zinc-500" />
                {t('dlg.agentDeploy.config')}
              </h4>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left p-2.5 font-medium text-muted-foreground">{t('dlg.agentDeploy.param')}</th>
                      <th className="text-left p-2.5 font-medium text-muted-foreground">{t('dlg.agentDeploy.default')}</th>
                      <th className="text-left p-2.5 font-medium text-muted-foreground">{t('dlg.agentDeploy.descCol')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {[
                      { param: '--port', default: '3100', desc: t('dlg.agentDeploy.cfg.port') },
                      { param: '--apiKey', default: t('dlg.agentDeploy.cfg.autoGenerated'), desc: t('dlg.agentDeploy.cfg.apiKey') },
                      { param: '--name', default: 'Hostname', desc: t('dlg.agentDeploy.cfg.name') },
                      { param: '--config', default: '—', desc: t('dlg.agentDeploy.cfg.config') },
                      { param: '--install-service', default: '—', desc: t('dlg.agentDeploy.cfg.installService') },
                      { param: '--uninstall-service', default: '—', desc: t('dlg.agentDeploy.cfg.uninstallService') },
                    ].map((row) => (
                      <tr key={row.param} className="hover:bg-muted/20 transition-colors">
                        <td className="p-2.5 font-mono text-teal-600 dark:text-teal-400">{row.param}</td>
                        <td className="p-2.5 text-muted-foreground">{row.default}</td>
                        <td className="p-2.5">{row.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <Separator />

            {/* Firewall Setup */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4 text-red-500" />
                {t('dlg.agentDeploy.firewall')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('dlg.agentDeploy.firewallDesc')}</p>
              <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                <div className="text-zinc-500">{t('dlg.agentDeploy.runAsAdmin')}</div>
                <div className="text-zinc-300">netsh advfirewall firewall add rule name=&quot;Dashboard Agent&quot; dir=in action=allow protocol=TCP localport=3100</div>
              </div>
            </div>

            <Separator />

            {/* File Structure */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Folder className="h-4 w-4 text-sky-500" />
                {t('dlg.agentDeploy.contents')}
              </h4>
              <div className="rounded-md bg-muted/30 dark:bg-zinc-800/30 p-3 font-mono text-xs space-y-0.5">
                <div className="text-zinc-500">📁 dashboard-agent-windows/</div>
                <div className="text-zinc-400 pl-4">📄 agent.js <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.agent')}</span></div>
                <div className="text-zinc-400 pl-4">📄 package.json <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.package')}</span></div>
                <div className="text-zinc-400 pl-4">📄 setup.js <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.setup')}</span></div>
                <div className="text-zinc-400 pl-4">📄 start.bat <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.start')}</span></div>
                <div className="text-zinc-400 pl-4">📄 install-service.ps1 <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.install')}</span></div>
                <div className="text-zinc-400 pl-4">📄 uninstall-service.ps1 <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.uninstall')}</span></div>
                <div className="text-zinc-400 pl-4">📄 agent-installer.iss <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.iss')}</span></div>
                <div className="text-zinc-400 pl-4">📄 build-installer.bat <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.build')}</span></div>
                <div className="text-zinc-400 pl-4">📁 prisma/ <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.prisma')}</span></div>
                <div className="text-zinc-400 pl-4">📄 .env.example <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.env')}</span></div>
                <div className="text-zinc-400 pl-4">📄 README.md <span className="text-zinc-600 ml-2">— {t('dlg.agentDeploy.file.readme')}</span></div>
              </div>
            </div>

            {/* Building EXE from source */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Hammer className="h-4 w-4 text-orange-500" />
                {t('dlg.agentDeploy.buildExe')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('dlg.agentDeploy.buildExeBefore')} <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">pkg</code>{t('dlg.agentDeploy.buildExeAfter')}</p>
              <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                <div className="text-zinc-500">{t('dlg.agentDeploy.pkgInstall')}</div>
                <div className="text-zinc-300">npm install -g pkg</div>
                <div className="text-zinc-500 mt-2">{t('dlg.agentDeploy.pkgBuild')}</div>
                <div className="text-zinc-300">npm run build:exe</div>
                <div className="text-zinc-500 mt-2">{t('dlg.agentDeploy.pkgOutput')}</div>
              </div>
              <p className="text-[10px] text-amber-600 dark:text-amber-400">{t('dlg.agentDeploy.buildExeWarn')}</p>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t pt-3">
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] text-muted-foreground">{t('dlg.agentDeploy.packageLocationBefore')} <code className="font-mono">mini-services/agent-windows/</code></span>
              <Button variant="outline" onClick={() => setAgentDeployGuideOpen(false)}>{t('dlg.common.close')}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auth dialogs: user management (admin) + change password */}
      <UserManagementDialog
        open={userMgmtOpen}
        onClose={() => setUserMgmtOpen(false)}
        onPendingChange={setAdminPendingCount}
      />
      <ChangePasswordDialog open={changePwOpen} onClose={() => setChangePwOpen(false)} />

      {/* Toast container */}
      <ToastContainer />
    </div>
  )
}

// ======================== AUTH GATE ========================
// Wraps the whole dashboard: session is fetched by <AuthProvider>, and this
// gate decides which surface renders — login screen, pending/rejected screen,
// or the full dashboard (only for approved users).

export default function DashboardPage() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}

function AuthGate() {
  const { user, status, showSeedHint, refresh, logout } = useAuth()
  if (status === 'loading') return <AuthLoadingSplash />
  if (!user) return <LoginScreen onAuthed={() => { void refresh() }} seedHint={showSeedHint} />
  if (user.status !== 'approved') return <AccountStatusScreen user={user} onLogout={() => { void logout() }} />
  return <DashboardInner session={{ user, refresh: () => { void refresh() }, logout: () => { void logout() } }} />
}
