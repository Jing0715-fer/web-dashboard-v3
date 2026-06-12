'use client'

import * as React from 'react'
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
  Bot, ArrowUpDown,
  CircleDot, Download, Star, ExternalLink, Link2, Plug, PlugZap
} from 'lucide-react'

import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy
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
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ThemeToggle } from '@/components/theme-toggle'
import { useToast, addToast } from '@/hooks/use-toast'

// ======================== CUSTOM DnD SENSOR ========================
// A PointerSensor that only activates when the pointerdown target is a
// [data-dnd-drag-handle] element.  This prevents the sensor from
// intercepting clicks on the rest of the card.
const DragHandleSensor = class PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }, { onActivation }: { onActivation?: (args: { event: PointerEvent }) => void }) => {
        if (!(nativeEvent as PointerEvent).isPrimary || (nativeEvent as PointerEvent).button !== 0) {
          return false
        }
        const target = (nativeEvent as PointerEvent).target as HTMLElement | null
        if (!target || !target.closest('[data-dnd-drag-handle]')) {
          return false
        }
        onActivation?.({ event: nativeEvent as PointerEvent })
        return true
      },
    },
  ]
}

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
  type: 'deploy' | 'start' | 'stop' | 'restart' | 'rebuild' | 'config_change' | 'error' | 'create'
  message: string
  timestamp: string
  projectId: string
  metadata?: Record<string, unknown>
}

interface LogEntry {
  id: string
  timestamp: string
  level: string
  source: string
  message: string
  projectId: string
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

type ViewMode = 'grid' | 'list'
type SortOption = 'newest' | 'name' | 'status'
type FilterStatus = 'all' | 'running' | 'stopped'

const TAG_OPTIONS = [
  { name: 'Frontend', color: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-200/40 dark:ring-emerald-700/30' },
  { name: 'Backend', color: 'bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-300 ring-1 ring-teal-200/40 dark:ring-teal-700/30' },
  { name: 'Fullstack', color: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-900/40 dark:text-cyan-300 ring-1 ring-cyan-200/40 dark:ring-cyan-700/30' },
  { name: 'DevOps', color: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300 ring-1 ring-amber-200/40 dark:ring-amber-700/30' },
  { name: 'Mobile', color: 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-300 ring-1 ring-rose-200/40 dark:ring-rose-700/30' },
  { name: 'API', color: 'bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-300 ring-1 ring-violet-200/40 dark:ring-violet-700/30' },
  { name: 'Database', color: 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-300 ring-1 ring-orange-200/40 dark:ring-orange-700/30' },
  { name: 'ML/AI', color: 'bg-pink-100 text-pink-900 dark:bg-pink-900/40 dark:text-pink-300 ring-1 ring-pink-200/40 dark:ring-pink-700/30' },
  { name: 'Automation', color: 'bg-slate-200 text-slate-900 dark:bg-slate-800/40 dark:text-slate-300 ring-1 ring-slate-300/40 dark:ring-slate-600/30' },
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
  return found?.color || 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400'
}

function getProjectStatus(project: Project): 'running' | 'stopped' | 'mixed' {
  const envs = project.environments || []
  if (envs.length === 0) return 'stopped'
  const running = envs.filter((e) => e.status === 'running').length
  if (running === envs.length) return 'running'
  if (running === 0) return 'stopped'
  return 'mixed'
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

function healthStroke(score: number): string {
  if (score >= 80) return '#10b981'
  if (score >= 50) return '#f59e0b'
  return '#ef4444'
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
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
      <mark key={i} className="bg-emerald-200 dark:bg-emerald-800/60 rounded px-0.5">{part}</mark>
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
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (score / 100) * circumference
  const [animatedOffset, setAnimatedOffset] = React.useState(offset)
  const prevOffset = React.useRef(offset)

  React.useEffect(() => {
    if (prevOffset.current !== offset) {
      setAnimatedOffset(offset)
      prevOffset.current = offset
    }
  }, [offset])

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted-foreground/20 dark:text-muted-foreground/20" />
      <motion.circle
        cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke={healthStroke(score)}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeLinecap="round"
        animate={{ strokeDashoffset: animatedOffset }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central" className={`text-[10px] font-semibold ${healthColor(score)}`} transform={`rotate(90, ${size / 2}, ${size / 2})`}>{score}</text>
    </svg>
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
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<div className="cursor-pointer" />}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <HealthScoreCircle score={score} size={size} />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        className="w-48 p-3 text-xs"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="space-y-2">
          <div className="font-semibold text-sm">Project Stats</div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Health Score</span>
            <span className={`font-medium ${healthColor(score)}`}>{score}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Running Envs</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{runningEnvs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Envs</span>
            <span className="font-medium">{totalEnvs}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last Updated</span>
            <span className="font-medium">{formatTimeAgo(updatedAt)}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ======================== DASHBOARD CLOCK WIDGET ========================

function DashboardClockWidget() {
  const [time, setTime] = React.useState('')

  React.useEffect(() => {
    const update = () => {
      const now = new Date()
      setTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  if (!time) return <span className="text-[10px] text-muted-foreground font-mono">--:--:--</span>
  return (
    <span className="text-[10px] text-muted-foreground dark:text-gray-400 font-mono tabular-nums">{time}</span>
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
      className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-md font-semibold tracking-wide ${bridgeRunning ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-200/60 dark:ring-emerald-700/50' : 'bg-gray-100 text-gray-500 dark:bg-zinc-800/60 dark:text-zinc-500 ring-1 ring-gray-200/50 dark:ring-zinc-700/40'}`}
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

function AnimatedStatusDot({ status }: { status: string }) {
  return (
    <motion.span
      className={`h-2 w-2 rounded-full inline-block ${status === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`}
      initial={{ scale: 1 }}
      animate={status === 'running'
        ? { scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }
        : { scale: [1, 1.8, 1], opacity: [1, 0.7, 1] }
      }
      transition={status === 'running'
        ? { duration: 2, ease: 'easeInOut', repeat: Infinity }
        : { duration: 0.4, ease: 'easeInOut' }
      }
      key={status}
    />
  )
}

// ======================== SORTABLE PROJECT CARD ========================

function SortableProjectCard({
  project, viewMode, searchQuery, onSelect, onEdit, onDelete,
  onEnvAction, onRebuildConfirm, selected, onToggleSelect, rebuilding,
  starred, onToggleStar, lanIp, currentHost, index = 0,
  batchMode = false
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
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const [expanded, setExpanded] = React.useState(false)
  const needsExpand = project.environments.length > 3 || (project.description && project.description.length > 120)
  const style = {
    transform: isDragging
      ? `${CSS.Transform.toString(transform)} rotate(2deg) scale(0.98)`
      : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const status = getProjectStatus(project)
  const health = calculateHealthScore(project)
  const tags = parseTags(project.tags)
  const runningEnvs = project.environments.filter((e) => e.status === 'running').length
  const totalEnvs = project.environments.length
  const IconComp = ICON_MAP[project.icon] || Folder
  const statusBorderAccent = status === 'running' ? 'border-l-2 border-l-emerald-500 dark:border-l-emerald-400' : status === 'mixed' ? 'border-l-2 border-l-amber-500 dark:border-l-amber-400' : 'border-l-2 border-l-red-400 dark:border-l-red-500'
  const isRemote = !!(project.deviceId && project.deviceName)
  const deviceOnline = project.deviceStatus === 'online'

  const envLabel = (name: string) => name === 'development' ? 'dev' : name === 'production' ? 'prod' : name

  // Smart URL: use proxy path for external access (ngrok), direct URL for local/LAN
  const getOpenUrl = (port: number) => {
    if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) {
      // External access (ngrok or similar) — use proxy path
      return `/api/proxy/${port}/`
    }
    // Local/LAN access — use direct URL
    const host = currentHost || 'localhost'
    return `http://${host}:${port}`
  }

  if (viewMode === 'list') {
    return (
      <div ref={setNodeRef} style={style}>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ delay: index * 0.05 }}
          whileHover={{ y: -1, boxShadow: '0 6px 16px rgba(0,0,0,0.1)' }}
          className={`group flex items-center gap-3 p-3.5 rounded-lg border bg-card dark:bg-zinc-900/80 shadow-sm dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:shadow-md dark:hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] hover:bg-accent/50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer overflow-hidden border-border/60 dark:border-zinc-700/50 ${statusBorderAccent}`}
          onClick={() => onSelect(project)}
        >
          <div {...attributes} {...listeners} data-dnd-drag-handle className="cursor-grab active:cursor-grabbing p-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()} title="Drag to reorder">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
          {batchMode && (
            <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(project.id)} onClick={(e) => e.stopPropagation()} className="shrink-0" />
          )}
          {project.name === 'Hermes Web' && (
            <span onClick={(e) => e.stopPropagation()}>
              <HermesBridgeToggle />
            </span>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`shrink-0 cursor-pointer transition-colors hover:scale-110 active:scale-90 transition-transform duration-150 ${starred ? 'text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`}>
            <Star className={`h-4 w-4 ${starred ? 'fill-amber-400' : ''}`} />
          </button>
          <IconComp className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{highlightText(project.name, searchQuery)}</span>
              {isRemote && (
                <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${deviceOnline ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400'}`}>
                  {deviceOnline ? '🟢' : '🔴'} {project.deviceName}
                </Badge>
              )}
              <Badge variant={status === 'running' ? 'default' : 'secondary'} className={`text-xs shrink-0 ${status === 'running' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`}>
                <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : 'bg-red-400'} mr-1`} />
                {runningEnvs}/{totalEnvs} running
              </Badge>
            </div>
            <button type="button" className="text-xs text-muted-foreground dark:text-gray-400 truncate text-left cursor-pointer hover:text-foreground dark:hover:text-gray-200 transition-colors hover:underline decoration-dotted underline-offset-2" title={`${project.path} — Click to copy`} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(project.path); addToast({ title: 'Path copied', description: project.path, variant: 'success' }) }}>{highlightText(project.path, searchQuery)}</button>
          </div>
          <div className="hidden sm:flex items-center gap-1 flex-wrap justify-end max-w-[200px]">
            {tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className={`text-[10px] px-1.5 cursor-default ${getTagColor(tag)}`}>{tag}</Badge>
            ))}
          </div>
          {/* List view: per-environment controls */}
          <div className="hidden md:flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            {project.environments.slice(0, 3).map((env) => (
              <div key={env.id} className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${env.status === 'running' ? 'bg-emerald-50/30 dark:bg-emerald-900/5' : 'bg-muted/20'}`}
                title={`${envLabel(env.name)} — port :${env.port} — ${env.status}${env.pid ? ` — PID ${env.pid}` : ''}`}
              >
                <AnimatedStatusDot status={env.status} />
                {env.name === 'development' ? <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 font-semibold ring-1 ring-cyan-300/60 dark:ring-cyan-700/50 shrink-0">dev</span> : env.name === 'production' ? <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-semibold ring-1 ring-amber-300/60 dark:ring-amber-700/50 shrink-0">prod</span> : <span className="text-[10px] text-muted-foreground dark:text-gray-300 max-w-[40px] truncate">{envLabel(env.name)}</span>}
                {env.name === 'development' && env.status === 'running' && <span className="text-[8px] px-1 py-0 rounded bg-emerald-100/60 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 font-medium tracking-wide shrink-0" title="Hot Module Replacement — auto-reloads on file changes">HMR</span>}
                {env.name === 'production' && <span className="text-[8px] px-1 py-0 rounded bg-amber-100/60 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 font-medium tracking-wide shrink-0" title="Production build — requires rebuild to apply changes">Build</span>}
                {env.status === 'running' && (
                  <a
                    href={getOpenUrl(env.port)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-md h-4 w-4 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-emerald-500 dark:text-emerald-400 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    title={`Open ${envLabel(env.name)} (${env.port})`}
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
                {env.status === 'running' && (
                  <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer text-amber-500 dark:text-amber-400 transition-all active:scale-90 shrink-0" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={`Restart ${envLabel(env.name)}`}><RotateCw className="h-2.5 w-2.5" /></TooltipTrigger><TooltipContent>Restart {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {env.name !== 'development' && (
                  <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-teal-50 dark:hover:bg-teal-900/20 cursor-pointer text-teal-500 dark:text-teal-400 transition-all active:scale-90 shrink-0" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={`Rebuild ${envLabel(env.name)}`}><Hammer className="h-2.5 w-2.5" /></TooltipTrigger><TooltipContent>Rebuild {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {/* Start/Stop at rightmost position */}
                {env.status === 'running' ? (
                  <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 cursor-pointer text-red-500 dark:text-red-400 transition-all active:scale-90 shrink-0 ring-1 ring-red-200 dark:ring-red-800/30 ml-0.5" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={`Stop ${envLabel(env.name)}`}><Square className="h-2.5 w-2.5 fill-current" /></TooltipTrigger><TooltipContent>Stop {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                ) : (
                  <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 cursor-pointer text-emerald-500 dark:text-emerald-400 transition-all active:scale-90 shrink-0 ring-1 ring-emerald-200 dark:ring-emerald-800/30 ml-0.5" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={`Start ${envLabel(env.name)}`}><Play className="h-2.5 w-2.5 fill-current" /></TooltipTrigger><TooltipContent>Start {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
              </div>
            ))}
            {project.environments.length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{project.environments.length - 3}</span>
            )}
          </div>
          <HealthScoreHoverCard score={health} size={32} runningEnvs={runningEnvs} totalEnvs={totalEnvs} updatedAt={project.updatedAt} />
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {project.environments.some((e) => e.status === 'running') && (
              <TooltipProvider><Tooltip><TooltipTrigger render={<a
                href={getOpenUrl(project.environments.find((e) => e.status === 'running')?.port || project.environments[0]?.port || 3000)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md h-7 px-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer gap-1 text-emerald-600 dark:text-emerald-400 transition-all hover:scale-105 active:scale-95"
              />} onClick={(e) => e.stopPropagation()}>
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">Open</span>
              </TooltipTrigger><TooltipContent>Open project in browser</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button */}
            {project.environments.some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 border border-red-200 dark:border-red-800/50 bg-white dark:bg-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer gap-1.5 text-red-600 dark:text-red-400 transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" />} onClick={() => { project.environments.filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Stop All</span>
              </TooltipTrigger><TooltipContent>Stop all running environments</TooltipContent></Tooltip></TooltipProvider>
            ) : (
              <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" />} onClick={() => { project.environments.filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Start All</span>
              </TooltipTrigger><TooltipContent>Start all stopped environments</TooltipContent></Tooltip></TooltipProvider>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent dark:hover:bg-white/10 cursor-pointer transition-colors" />}><MoreVertical className="h-3.5 w-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />View Details</DropdownMenuItem>
                <DropdownMenuSeparator />
                {project.environments.some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = project.environments.find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />Copy Proxy URL</DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => { project.environments.forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />Restart All</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRebuildConfirm(project)} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />Rebuild All</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} onClick={() => onSelect(project)}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ delay: index * 0.05 }}
        className={`group relative flex flex-col rounded-xl border bg-card dark:bg-zinc-900/80 shadow-md dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:shadow-xl dark:hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-all duration-200 cursor-pointer overflow-hidden border-border/60 dark:border-zinc-700/50 ${statusBorderAccent}`}
      >

        <div className="absolute top-5 left-2 z-10 flex gap-1 items-start" onClick={(e) => e.stopPropagation()}>
          <div {...attributes} {...listeners} data-dnd-drag-handle className="cursor-grab active:cursor-grabbing p-1 rounded bg-muted/80 hover:bg-muted" title="Drag to reorder">
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          {batchMode && (
            <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(project.id)} className="bg-muted/80 rounded" />
          )}
          {isRemote && (
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-5 ${deviceOnline ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50/80 dark:bg-emerald-900/30' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400 bg-red-50/80 dark:bg-red-900/30'}`}>
              {deviceOnline ? '🟢' : '🔴'} {project.deviceName}
            </Badge>
          )}
        </div>

        {/* Hermes Bridge toggle is rendered in the bottom action row, not the card top */}

        <CardHeader className="pb-3 pt-5 px-5 sm:px-6">
          <div className="flex items-start gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30 shrink-0 shadow-sm group-hover:scale-105 transition-transform duration-200">
                <IconComp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-[15px] font-extrabold truncate tracking-tight dark:text-zinc-100 leading-tight">{highlightText(project.name, searchQuery)}</CardTitle>
                <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                  <button type="button" className="text-xs text-muted-foreground dark:text-gray-400 truncate min-w-0 text-left cursor-pointer hover:text-foreground dark:hover:text-gray-200 transition-colors hover:underline decoration-dotted underline-offset-2" title={`${project.path} — Click to copy`} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(project.path); addToast({ title: 'Path copied', description: project.path, variant: 'success' }) }}>
                    {highlightText(project.path, searchQuery)}
                  </button>
                  {totalEnvs > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] px-1 py-0 rounded bg-muted text-muted-foreground dark:text-gray-400 dark:bg-white/5">
                      <Layers className="h-2.5 w-2.5" />{totalEnvs}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center shrink-0">
              <HealthScoreHoverCard score={health} size={28} runningEnvs={runningEnvs} totalEnvs={totalEnvs} updatedAt={project.updatedAt} />
              <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`cursor-pointer transition-all duration-200 hover:scale-110 active:scale-90 ml-0.5 ${starred ? 'text-amber-400' : 'text-muted-foreground hover:text-amber-400'}`}>
                <Star className={`h-3 w-3 ${starred ? 'fill-amber-400' : ''}`} />
              </button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-5 sm:px-6 pb-4 flex-1">
          {project.description && (
            <p className={`text-[13px] text-muted-foreground/80 dark:text-zinc-300 mb-2.5 leading-relaxed ${!expanded && project.description && project.description.length > 120 ? 'line-clamp-2' : ''}`}>{highlightText(project.description, searchQuery)}</p>
          )}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className={`text-[10px] px-2 py-0.5 rounded-md cursor-default ${getTagColor(tag)}`}>{tag}</Badge>
            ))}
          </div>
          <div className="space-y-2">
            {(expanded ? project.environments : project.environments.slice(0, 3)).map((env, envIdx) => (
              <div key={env.id} className={`flex items-center justify-between text-xs group/env min-w-0 gap-1.5 rounded-lg px-2 sm:px-2.5 py-2 sm:py-2.5 hover:bg-accent/40 dark:hover:bg-white/5 transition-all duration-150 ${env.status === 'running' ? 'bg-emerald-50/30 dark:bg-emerald-900/5' : 'bg-muted/20'} ${envIdx < (expanded ? project.environments.length - 1 : Math.min(project.environments.length, 3) - 1) ? 'border-b border-border/20 dark:border-zinc-700/20 pb-2 sm:pb-3' : ''}`}
                title={`${envLabel(env.name)} — port :${env.port} — ${env.status}${env.pid ? ` — PID ${env.pid}` : ''}`}
              >
                <div className="flex items-center gap-1.5 min-w-0 shrink">
                  <AnimatedStatusDot status={env.status} />
                  {env.name === 'development' ? <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 font-semibold ring-1 ring-cyan-300/60 dark:ring-cyan-700/50">dev</span> : env.name === 'production' ? <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-semibold ring-1 ring-amber-300/60 dark:ring-amber-700/50">prod</span> : <span className="text-muted-foreground dark:text-gray-300 truncate max-w-[60px] text-[10px]">{envLabel(env.name)}</span>}
                  {/* Hermes Bridge badge (only on Hermes Web dev env, inline with dev tag) */}
                  {project.name === 'Hermes Web' && env.name === 'development' && (
                    <HermesBridgeToggle />
                  )}
                  {env.name === 'development' && env.status === 'running' && <span className="shrink-0 text-[8px] px-1 py-0 rounded bg-emerald-100/60 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 font-medium tracking-wide" title="Hot Module Replacement — auto-reloads on file changes">HMR</span>}
                  {env.name === 'production' && <span className="shrink-0 text-[8px] px-1 py-0 rounded bg-amber-100/60 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 font-medium tracking-wide" title="Production build — requires rebuild to apply changes">Build</span>}
                </div>
                <div className="flex items-center gap-1 sm:gap-1 shrink-0">
                  <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="text-muted-foreground dark:text-zinc-400 font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-muted/40 dark:bg-white/5 hover:bg-muted/60 dark:hover:bg-white/10 cursor-pointer transition-colors ring-1 ring-border/20 dark:ring-white/10 min-w-[28px] text-center" />} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(env.port)); addToast({ title: 'Port copied', description: `Port ${env.port}`, variant: 'success' }) }} title="Click to copy port">{env.port}</TooltipTrigger><TooltipContent>Click to copy port</TooltipContent></Tooltip></TooltipProvider>
                  {env.status === 'running' && (
                    <a
                      href={getOpenUrl(env.port)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-emerald-500 dark:text-emerald-400 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                      title={`Open ${envLabel(env.name)} (${env.port})`}
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                  {env.status === 'running' && (
                    <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer text-amber-500 dark:text-amber-400 transition-all active:scale-90 shrink-0" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={`Restart ${envLabel(env.name)}`}><RotateCw className="h-2.5 w-2.5" /></TooltipTrigger><TooltipContent>Restart {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}
                  {env.name !== 'development' && (
                    <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-teal-50 dark:hover:bg-teal-900/20 cursor-pointer text-teal-500 dark:text-teal-400 transition-all active:scale-90 shrink-0" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={`Rebuild ${envLabel(env.name)}`}><Hammer className="h-2.5 w-2.5" /></TooltipTrigger><TooltipContent>Rebuild {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}

                  {/* Start/Stop at rightmost position */}
                  {env.status === 'running' ? (
                    <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 cursor-pointer text-red-500 dark:text-red-400 transition-all active:scale-90 shrink-0 ring-1 ring-red-200 dark:ring-red-800/30" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={`Stop ${envLabel(env.name)}`}><Square className="h-2.5 w-2.5 fill-current" /></TooltipTrigger><TooltipContent>Stop {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  ) : (
                    <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 cursor-pointer text-emerald-500 dark:text-emerald-400 transition-all active:scale-90 shrink-0 ring-1 ring-emerald-200 dark:ring-emerald-800/30" />} onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={`Start ${envLabel(env.name)}`}><Play className="h-2.5 w-2.5 fill-current" /></TooltipTrigger><TooltipContent>Start {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}
                </div>
              </div>
            ))}
            {!expanded && project.environments.length > 3 && (
              <p className="text-[10px] text-muted-foreground">+{project.environments.length - 3} more</p>
            )}
          </div>

          {/* Expand/Collapse toggle */}
          {needsExpand && (
            <button
              type="button"
              className="mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            >
              {expanded ? <><ChevronUp className="h-3 w-3" />Show less</> : <><ChevronDown className="h-3 w-3" />Show more</>}
            </button>
          )}
        </CardContent>

        {/* Action bar */}
        <div className="border-t border-border/30 dark:border-zinc-700/30" />
        <div className="px-4 sm:px-5 pb-3 pt-2 flex items-center justify-between min-w-0 rounded-b-xl">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[11px] px-2.5 py-0.5 ${status === 'running' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-900/10' : status === 'mixed' ? 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300 bg-amber-50/50 dark:bg-amber-900/10' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-900/10'}`}>
              <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'mixed' ? 'bg-amber-500' : 'bg-red-400'} mr-1`} />
              {runningEnvs}/{totalEnvs} running
            </Badge>
            <span className="text-[10px] text-muted-foreground dark:text-gray-400 hidden sm:inline" title={new Date(project.createdAt).toLocaleString()}>{formatTimeAgo(project.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {project.environments.some((e) => e.status === 'running') && (
              <TooltipProvider><Tooltip><TooltipTrigger render={<a
                href={getOpenUrl(project.environments.find((e) => e.status === 'running')?.port || project.environments[0]?.port || 3000)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md h-7 px-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer gap-1 text-emerald-600 dark:text-emerald-400 transition-all hover:scale-105 active:scale-95"
              />} onClick={(e) => e.stopPropagation()}>
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">Open</span>
              </TooltipTrigger><TooltipContent>Open project in browser</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button */}
            {project.environments.some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 border border-red-200 dark:border-red-800/50 bg-white dark:bg-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer gap-1.5 text-red-600 dark:text-red-400 transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" />} onClick={() => { project.environments.filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Stop All</span>
              </TooltipTrigger><TooltipContent>Stop all running environments</TooltipContent></Tooltip></TooltipProvider>
            ) : (
              <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" />} onClick={() => { project.environments.filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Start All</span>
              </TooltipTrigger><TooltipContent>Start all stopped environments</TooltipContent></Tooltip></TooltipProvider>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent dark:hover:bg-white/10 cursor-pointer transition-colors" />}><MoreVertical className="h-3.5 w-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />View Details</DropdownMenuItem>
                <DropdownMenuSeparator />
                {project.environments.some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = project.environments.find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />Copy Proxy URL</DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => { project.environments.forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />Restart All</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRebuildConfirm(project)} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />Rebuild All</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Subtle hover overlay */}
        <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none bg-gradient-to-br from-emerald-500/[0.02] via-transparent to-teal-500/[0.02] dark:from-emerald-500/[0.03] dark:via-transparent dark:to-teal-500/[0.03]" />
        {/* Subtle border color transition on hover */}
        <div className="absolute inset-0 rounded-xl border-2 border-transparent group-hover:border-emerald-200/30 dark:group-hover:border-emerald-700/20 transition-colors duration-300 pointer-events-none" />
      </motion.div>
    </div>
  )
}

// ======================== COMMAND PALETTE ========================

function CommandPalette({
  open, onClose, projects, onSelectProject, onAddProject, onRefresh, onToggleView
}: {
  open: boolean
  onClose: () => void
  projects: Project[]
  onSelectProject: (p: Project) => void
  onAddProject: () => void
  onRefresh: () => void
  onToggleView: () => void
}) {
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Focus input when dialog opens (key on parent resets this component)
  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  const commands = [
    { id: 'add', label: 'Add New Project', icon: Plus, category: 'Actions', action: onAddProject },
    { id: 'refresh', label: 'Refresh Data', icon: RefreshCw, category: 'Actions', action: onRefresh },
    { id: 'toggle-view', label: 'Toggle Grid/List View', icon: LayoutGrid, category: 'Actions', action: onToggleView },
    { id: 'gateway', label: 'Open Gateway Monitor', icon: Server, category: 'Actions', action: () => {} },
    { id: 'llm', label: 'Configure LLM Settings', icon: Bot, category: 'Actions', action: () => {} },
  ]

  const projectItems = projects.map((p) => ({
    id: `project-${p.id}`,
    label: p.name,
    icon: Folder,
    category: 'Projects',
    action: () => onSelectProject(p),
  }))

  const allItems = [...commands, ...projectItems]
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
            placeholder="Type a command or search projects..."
            className="flex-1 py-3 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">ESC</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">No results found.</div>
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
  const shortcuts = [
    { keys: 'Ctrl + K', description: 'Focus search' },
    { keys: 'Ctrl + N', description: 'Add new project' },
    { keys: 'Ctrl + Shift + R', description: 'Refresh data' },
    { keys: 'Ctrl + P', description: 'Command palette' },
    { keys: 'G then G', description: 'Grid view' },
    { keys: 'G then L', description: 'List view' },
    { keys: '?', description: 'Show shortcuts' },
  ]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>Use these shortcuts to navigate faster.</DialogDescription>
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
          <div className="flex justify-between"><span className="text-muted-foreground">Type</span><Badge variant="outline" className="capitalize">{notification.type}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Time</span><span>{new Date(notification.timestamp).toLocaleString()}</span></div>
          {notification.projectName && (
            <div className="flex justify-between"><span className="text-muted-foreground">Project</span><span>{notification.projectName}</span></div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant={notification.read ? 'secondary' : 'default'}>{notification.read ? 'Read' : 'Unread'}</Badge></div>
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
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
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
  open, onClose, onSubmit, project, mode
}: {
  open: boolean
  onClose: () => void
  onSubmit: (data: { name: string; path: string; description: string; icon: string; tags: string[] }) => void
  project?: Project | null
  mode: 'add' | 'edit'
}) {
  // Initialize from props - key on parent component resets this when dialog opens
  const [name, setName] = React.useState(() => mode === 'edit' && project ? project.name : '')
  const [path, setPath] = React.useState(() => mode === 'edit' && project ? project.path : '')
  const [description, setDescription] = React.useState(() => mode === 'edit' && project ? project.description : '')
  const [icon, setIcon] = React.useState(() => mode === 'edit' && project ? project.icon : 'folder')
  const [selectedTags, setSelectedTags] = React.useState<string[]>(() => mode === 'edit' && project ? parseTags(project.tags) : [])

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !path.trim()) return
    onSubmit({ name: name.trim(), path: path.trim(), description: description.trim(), icon, tags: selectedTags })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? 'Add New Project' : 'Edit Project'}</DialogTitle>
          <DialogDescription>{mode === 'add' ? 'Create a new project to manage.' : 'Update project details.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="proj-name">Name *</Label>
            <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proj-path">Path *</Label>
            <Input id="proj-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/user/projects/my-project" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proj-desc">Description</Label>
            <Textarea id="proj-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Project description..." rows={2} />
          </div>
          <div className="space-y-1">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(ICON_MAP).map(([key, Ic]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  className={`p-2 rounded-md border transition-colors ${icon === key ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-border hover:bg-accent'}`}
                >
                  <Ic className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Tags</Label>
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !path.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {mode === 'add' ? 'Create' : 'Update'}
            </Button>
          </DialogFooter>
        </form>
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
          <DialogTitle>{mode === 'add' ? 'Add Environment' : 'Edit Environment'}</DialogTitle>
          <DialogDescription>{mode === 'add' ? 'Create a new environment.' : 'Update environment settings.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="env-name">Name *</Label>
            <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="development" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-cmd">Command *</Label>
            <Input id="env-cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm run dev" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-port">Port *</Label>
            <Input id="env-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" />
          </div>
          <div className="space-y-2">
            <Label>Environment Variables</Label>
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
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !cmd.trim() || !port} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {mode === 'add' ? 'Create' : 'Update'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ======================== GATEWAY MONITOR DIALOG ========================

function GatewayMonitorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = React.useState<GatewayStatus | null>(null)
  const [loading, setLoading] = React.useState(false)

  const fetchStatus = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/gateway/status')
      if (res.ok) setStatus(await res.json())
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  React.useEffect(() => {
    if (open) {
      // Schedule fetch to avoid synchronous setState in effect
      const id = requestAnimationFrame(() => { fetchStatus() })
      return () => cancelAnimationFrame(id)
    }
  }, [open, fetchStatus])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5 text-emerald-600" />
            Gateway Monitor
          </DialogTitle>
          <DialogDescription>Real-time gateway and system status.</DialogDescription>
        </DialogHeader>
        {loading && !status ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : status ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border bg-emerald-50 dark:bg-emerald-950/30">
                <div className="text-xs text-muted-foreground">Caddy</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`h-2 w-2 rounded-full ${status.caddyRunning ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium">{status.caddyRunning ? 'Running' : 'Stopped'}</span>
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">v{status.caddyVersion}</div>
              </div>
              <div className="p-3 rounded-lg border">
                <div className="text-xs text-muted-foreground">Uptime</div>
                <div className="text-sm font-medium mt-1">{status.uptime}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">System: {status.systemUptime}</div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5"><Cpu className="h-4 w-4 text-amber-500" /> CPU</span>
                <span className="font-medium">{status.cpuUsage.percentage}%</span>
              </div>
              <Progress value={status.cpuUsage.percentage} className="h-2" />
              <div className="text-[10px] text-muted-foreground">{status.cpuUsage.cores} cores &middot; Load: {status.cpuUsage.loadAverage.map((l) => l.toFixed(2)).join(', ')}</div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5"><HardDrive className="h-4 w-4 text-teal-500" /> Memory</span>
                <span className="font-medium">{status.memoryUsage.percentage}%</span>
              </div>
              <Progress value={status.memoryUsage.percentage} className="h-2" />
              <div className="text-[10px] text-muted-foreground">{status.memoryUsage.used}MB / {status.memoryUsage.total}MB</div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Services</h4>
              {status.services.map((svc) => (
                <div key={svc.name} className="flex items-center justify-between p-2 rounded border text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${svc.status === 'running' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    <span className="font-medium">{svc.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {svc.port > 0 && <span>:{svc.port}</span>}
                    <span>PID {svc.pid}</span>
                    <span>{svc.memory}MB</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={fetchStatus}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
              <span className="text-[10px] text-muted-foreground">Last checked: {formatTimeAgo(status.lastChecked)}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">Failed to load gateway status.</div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ======================== LLM CONFIG DIALOG ========================

function LlmConfigDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, setConfig] = React.useState<LlmConfig | null>(null)
  const [provider, setProvider] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const { toast } = useToast()

  React.useEffect(() => {
    if (open) {
      // Use requestAnimationFrame to avoid synchronous setState in effect
      const id = requestAnimationFrame(() => {
        setLoading(true)
        fetch('/api/llm-config')
          .then((r) => r.json())
          .then((data) => {
            setConfig(data)
            setProvider(data.provider || '')
            setApiKey(data.apiKey || '')
            setBaseUrl(data.baseUrl || '')
            setModel(data.model || '')
          })
          .catch(() => {})
          .finally(() => setLoading(false))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [open])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, baseUrl, model }),
      })
      if (res.ok) {
        toast({ title: 'LLM Config Saved', variant: 'success' })
        onClose()
      }
    } catch {
      toast({ title: 'Failed to save config', variant: 'destructive' })
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-emerald-600" />
            LLM Configuration
          </DialogTitle>
          <DialogDescription>Configure your AI provider settings.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google AI</SelectItem>
                  <SelectItem value="local">Local (Ollama)</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>API Key</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
            </div>
            <div className="space-y-1">
              <Label>Base URL</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </div>
            <div className="space-y-1">
              <Label>Model</Label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ======================== DETAIL SHEET ========================

function DetailSheet({
  project, open, onClose, onEnvAction, lanIp, currentHost
}: {
  project: Project | null
  open: boolean
  onClose: () => void
  onEnvAction: (projectId: string, envId: string, action: string) => void
  lanIp: string
  currentHost: string
}) {
  const [activeTab, setActiveTab] = React.useState('overview')
  const [activity, setActivity] = React.useState<ActivityEvent[]>([])
  const [logs, setLogs] = React.useState<LogEntry[]>([])
  const [loadingActivity, setLoadingActivity] = React.useState(false)
  const [loadingLogs, setLoadingLogs] = React.useState(false)
  const [expandedEnv, setExpandedEnv] = React.useState<string | null>(null)
  const [editingPort, setEditingPort] = React.useState<string | null>(null)
  const [portValue, setPortValue] = React.useState('')
  const [healthResult, setHealthResult] = React.useState<HealthCheckResult | null>(null)
  const { toast } = useToast()

  React.useEffect(() => {
    if (project && activeTab === 'activity' && open) {
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
        fetch(`/api/projects/${project.id}/logs`)
          .then((r) => r.json())
          .then(setLogs)
          .catch(() => {})
          .finally(() => setLoadingLogs(false))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [project, activeTab, open])

  const runHealthCheck = React.useCallback(async () => {
    if (!project) return
    const ports = project.environments.map((e) => e.port).join(',')
    if (!ports) return
    try {
      const res = await fetch(`/api/health-check?ports=${ports}`)
      if (res.ok) {
        const data = await res.json()
        setHealthResult(data)
        toast({ title: 'Health check complete', description: `Overall: ${data.overallStatus}`, variant: data.overallStatus === 'healthy' ? 'success' : 'destructive' })
      }
    } catch { /* ignore */ }
  }, [project, toast])

  const savePort = async (envId: string, newPort: number) => {
    if (!project) return
    try {
      const res = await fetch(`/api/projects/${project.id}/environments/${envId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: newPort }),
      })
      if (res.ok) {
        toast({ title: 'Port updated', variant: 'success' })
      }
    } catch { /* ignore */ }
    setEditingPort(null)
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: `${label} copied!`, variant: 'success' })
  }

  if (!project) return null

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
        <SheetHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
              <IconComp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="truncate">{project.name}</SheetTitle>
              <SheetDescription className="truncate text-xs">{project.path}</SheetDescription>
            </div>
            <Badge variant={status === 'running' ? 'default' : 'secondary'} className={`shrink-0 ${status === 'running' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`}>
              {status}
            </Badge>
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="border-b px-4 shrink-0">
            <TabsList className="h-9 w-full justify-start bg-transparent p-0 gap-2">
              <TabsTrigger value="overview" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 dark:data-[state=active]:bg-emerald-900/30 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">Overview</TabsTrigger>
              <TabsTrigger value="environments" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 dark:data-[state=active]:bg-emerald-900/30 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">Environments</TabsTrigger>
              <TabsTrigger value="activity" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 dark:data-[state=active]:bg-emerald-900/30 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">Activity</TabsTrigger>
              <TabsTrigger value="logs" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700 dark:data-[state=active]:bg-emerald-900/30 dark:data-[state=active]:text-emerald-300 rounded-full transition-colors">Logs</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="p-4 space-y-4 mt-0 overflow-y-auto flex-1 min-h-0">
            {project.description && (
              <div>
                <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1">Description</h4></div>
                <p className="text-sm">{project.description}</p>
              </div>
            )}
            {/* Device info row */}
            <div>
              <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Device</h4></div>
              <div className="p-2.5 rounded-lg border bg-muted/30">
                {project.deviceId && project.deviceName ? (
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${project.deviceStatus === 'online' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                    <span className="text-sm font-medium">{project.deviceName}</span>
                    <span className="text-xs text-muted-foreground font-mono">({project.deviceStatus === 'online' ? '🟢' : '🔴'} {project.deviceStatus ?? 'unknown'})</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="text-sm font-medium">💻 This Machine</span>
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border">
                <div className="text-xs text-muted-foreground">Path</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="text-sm font-mono truncate">{project.path}</span>
                  <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => copyToClipboard(project.path, 'Path')}><Copy className="h-3 w-3" /></Button>
                </div>
              </div>
              <div className="p-3 rounded-lg border">
                <div className="text-xs text-muted-foreground">Created</div>
                <div className="text-sm mt-0.5">{new Date(project.createdAt).toLocaleDateString()}</div>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Tags</h4></div>
              <div className="flex flex-wrap gap-1">
                {tags.length > 0 ? tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className={`cursor-default ${getTagColor(tag)}`}>{tag}</Badge>
                )) : <span className="text-xs text-muted-foreground">No tags</span>}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Environments Summary</h4></div>
              <div className="space-y-1">
                {project.environments.map((env) => (
                  <div key={env.id} className="flex items-center justify-between p-2 rounded border text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${env.status === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      <span>{env.name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <button className="font-mono hover:text-foreground transition-colors" onClick={() => copyToClipboard(String(env.port), `Port :${env.port}`)}>:{env.port}</button>
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
                {project.environments.length === 0 && <span className="text-xs text-muted-foreground">No environments</span>}
              </div>
            </div>
            {/* Access URLs Section */}
            {project.environments.some((e) => e.status === 'running') && (
              <div>
                <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Access URLs</h4></div>
                <div className="space-y-1.5">
                  {project.environments.filter((e) => e.status === 'running').map((env) => {
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
                            <span className="text-[9px] text-muted-foreground w-10 shrink-0">Local</span>
                            <a href={`http://localhost:${env.port}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline font-mono truncate">http://localhost:{env.port}</a>
                            <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(`http://localhost:${env.port}`, 'URL copied')}><Copy className="h-2.5 w-2.5" /></button>
                          </div>
                          {/* LAN */}
                          {lanIp && (
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className="text-[9px] text-muted-foreground w-10 shrink-0">LAN</span>
                              <a href={`http://${lanIp}:${env.port}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline font-mono truncate">http://{lanIp}:{env.port}</a>
                              <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(`http://${lanIp}:${env.port}`, 'URL copied')}><Copy className="h-2.5 w-2.5" /></button>
                            </div>
                          )}
                          {/* Proxy (ngrok) */}
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-[9px] text-muted-foreground w-10 shrink-0">Proxy</span>
                            <a href={`/api/proxy/${env.port}/`} target="_blank" rel="noopener noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline font-mono truncate">/api/proxy/{env.port}/</a>
                            <button type="button" className="shrink-0 h-3.5 w-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => { const url = `${window.location.origin}/api/proxy/${env.port}/`; copyToClipboard(url, 'Proxy URL copied') }}><Copy className="h-2.5 w-2.5" /></button>
                            <span className="text-[9px] text-muted-foreground italic">via ngrok</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  <Link2 className="h-3 w-3 inline mr-0.5" />
                  Proxy route forwards requests through the dashboard — works with a single ngrok tunnel. 
                  Note: some SPA apps may not work fully via proxy due to path rewriting.
                </p>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={runHealthCheck} className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0">
              <Activity className="h-3.5 w-3.5 mr-1" /> Run Health Check
            </Button>
            {healthResult && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={healthResult.overallStatus === 'healthy' ? 'default' : 'destructive'} className={healthResult.overallStatus === 'healthy' ? 'bg-emerald-100 text-emerald-800' : ''}>
                    {healthResult.overallStatus}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{new Date(healthResult.checkedAt).toLocaleTimeString()}</span>
                </div>
                {healthResult.results.map((r) => (
                  <div key={r.port} className="flex items-center justify-between p-2 rounded border text-xs">
                    <div className="flex items-center gap-2">
                      <span className={r.status === 'healthy' ? 'text-emerald-500' : 'text-red-500'}>:{r.port}</span>
                      <span className="capitalize">{r.status}</span>
                    </div>
                    <span className="text-muted-foreground">{r.responseTime}ms</span>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="environments" className="p-4 space-y-3 mt-0 overflow-y-auto flex-1 min-h-0">
            {project.environments.map((env) => {
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
                          title="Click to edit port"
                        >
                          :{env.port}
                        </button>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(`:${env.port}`, `Port :${env.port}`)}><Copy className="h-3 w-3" /></Button>
                      {env.status === 'running' ? (
                        <>
                          <TooltipProvider><Tooltip><TooltipTrigger render={<a
                            href={(() => {
                              if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) {
                                return `/api/proxy/${env.port}/`
                              }
                              const host = currentHost || 'localhost'
                              return `http://${host}:${env.port}`
                            })()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer text-emerald-500 dark:text-emerald-400"
                          />} onClick={(e: React.MouseEvent) => e.stopPropagation()}><ExternalLink className="h-3 w-3" /></TooltipTrigger><TooltipContent>Open in browser</TooltipContent></Tooltip></TooltipProvider>
                          <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-red-500" />} onClick={() => onEnvAction(project.id, env.id, 'stop')}><Square className="h-3 w-3" /></TooltipTrigger><TooltipContent>Stop</TooltipContent></Tooltip></TooltipProvider>
                          <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-amber-500" />} onClick={() => onEnvAction(project.id, env.id, 'restart')}><RotateCw className="h-3 w-3" /></TooltipTrigger><TooltipContent>Restart</TooltipContent></Tooltip></TooltipProvider>
                        </>
                      ) : (
                        <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-emerald-500" />} onClick={() => onEnvAction(project.id, env.id, 'start')}><Play className="h-3 w-3" /></TooltipTrigger><TooltipContent>Start</TooltipContent></Tooltip></TooltipProvider>
                      )}
                      {env.name !== 'development' && (
                        <TooltipProvider><Tooltip><TooltipTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-teal-500" />} onClick={() => onEnvAction(project.id, env.id, 'rebuild')}><Hammer className="h-3 w-3" /></TooltipTrigger><TooltipContent>Rebuild</TooltipContent></Tooltip></TooltipProvider>
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
                        <div><span className="text-muted-foreground">Command:</span> <span className="font-mono">{env.cmd}</span></div>
                        <div><span className="text-muted-foreground">PID:</span> {env.pid || 'N/A'}</div>
                        <div><span className="text-muted-foreground">Status:</span> <span className={env.status === 'running' ? 'text-emerald-600' : 'text-red-500'}>{env.status}</span></div>
                        <div><span className="text-muted-foreground">Created:</span> {new Date(env.createdAt).toLocaleDateString()}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Environment Variables</div>
                        <div className="rounded bg-muted/50 p-2 space-y-1 max-h-32 overflow-y-auto">
                          {Object.entries(envVars).length > 0 ? Object.entries(envVars).map(([k, v]) => (
                            <div key={k} className="flex items-center gap-2 text-xs font-mono">
                              <span className="text-emerald-600 dark:text-emerald-400">{k}</span>
                              <span className="text-muted-foreground">=</span>
                              <span className="text-foreground">{v}</span>
                              <Button variant="ghost" size="icon" className="h-4 w-4 ml-auto" onClick={() => copyToClipboard(`${k}=${v}`, k)}><Copy className="h-2.5 w-2.5" /></Button>
                            </div>
                          )) : <span className="text-xs text-muted-foreground">No environment variables set</span>}
                        </div>
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
                                <div className={`h-full rounded-full transition-all ${env.status === 'running' ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`} style={{ width: `${cpuPercent}%` }} />
                              </div>
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-muted-foreground">Memory</span>
                                <span className="font-medium">{memPercent}%</span>
                              </div>
                              <div className="h-1 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${env.status === 'running' ? 'bg-teal-500' : 'bg-gray-300 dark:bg-gray-600'}`} style={{ width: `${memPercent}%` }} />
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
            {project.environments.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No environments yet</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="activity" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            {loadingActivity ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
            ) : (
              <div className="relative">
                <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-emerald-500/50 to-teal-500/50" />
                <div className="space-y-3">
                  {activity.map((event, idx) => {
                    const ActivityIcon = ACTIVITY_ICONS[event.type] || Activity
                    const colorClass = ACTIVITY_COLORS[event.type] || 'text-muted-foreground bg-muted'
                    return (
                      <motion.div
                        key={event.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 30 }}
                        className="relative pl-10 hover:bg-accent/30 transition-colors rounded p-1"
                      >
                        <div className={`absolute left-2 top-0.5 p-1.5 rounded-full ${colorClass}`}>
                          <ActivityIcon className="h-3 w-3" />
                        </div>
                        <div className="absolute left-[15px] top-[5px] h-1 w-1 rounded-full bg-background ring-2 ring-emerald-500/30" />
                        <div>
                          <p className="text-sm">{event.message}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{formatTimeAgo(event.timestamp)}</p>
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="logs" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            {loadingLogs ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
            ) : (
              <div className="rounded-lg bg-muted/50 border overflow-hidden">
                <div className="max-h-80 overflow-y-auto p-2 font-mono text-xs space-y-0.5">
                  {logs.map((log) => (
                    <div key={log.id} className={`flex gap-2 py-0.5 px-1 rounded hover:bg-accent/20 transition-colors border-l-2 ${log.level === 'error' ? 'border-l-red-500' : log.level === 'warn' ? 'border-l-amber-500' : log.level === 'info' ? 'border-l-cyan-500' : 'border-l-gray-400'} ${log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-amber-500' : log.level === 'debug' ? 'text-muted-foreground' : 'text-foreground'}`}>
                      <span className="text-muted-foreground shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      <span className={`uppercase w-10 shrink-0 font-semibold ${log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-amber-500' : 'text-emerald-600'}`}>{log.level}</span>
                      <span className="text-cyan-600 dark:text-cyan-400 shrink-0 w-16 truncate">{log.source}</span>
                      <span className="truncate">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

// ======================== GLOBAL STATUS PANEL ========================

function GlobalStatusPanel({ projects }: { projects: Project[] }) {
  const [collapsed, setCollapsed] = React.useState(true)
  const totalEnvs = projects.reduce((a, p) => a + (p.environments?.length || 0), 0)
  const runningEnvs = projects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0)
  const healthScore = totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0

  if (collapsed) {
    return (
      <motion.button
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        className="fixed bottom-20 right-4 sm:bottom-4 z-40 h-8 w-8 sm:h-10 sm:w-10 rounded-full bg-card border shadow-lg ring-1 ring-border/30 flex items-center justify-center hover:bg-accent transition-colors"
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
      className="fixed bottom-20 right-4 sm:bottom-4 z-40 rounded-lg border shadow-xl backdrop-blur-sm bg-card/95 p-3 sm:max-w-xs max-w-[calc(100vw-2rem)] ring-1 ring-border/30 max-h-[60vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5"><Zap className="h-3 w-3 text-emerald-500" /><span className="text-xs font-semibold dark:text-gray-200 text-emerald-700 dark:text-emerald-400">System Health</span></div>
        <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md hover:bg-accent" onClick={() => setCollapsed(true)}><ChevronDown className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-gray-400">Projects</span>
          <span className="font-medium dark:text-gray-200">{projects.length}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-gray-400">Environments</span>
          <span className="font-medium dark:text-gray-200">{runningEnvs}/{totalEnvs} running</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground dark:text-gray-400">Health</span>
          <span className={`font-semibold ${healthColor(healthScore)}`}>{healthScore}%</span>
        </div>
        <Progress value={healthScore} className="h-1.5" />
      </div>
    </motion.div>
  )
}

// ======================== ENHANCED FOOTER ========================

function EnhancedFooter({ projects, onOpenDevices }: { projects: Project[]; onOpenDevices: () => void }) {
  const [expanded, setExpanded] = React.useState(false)
  const [networkInfo, setNetworkInfo] = React.useState<{ hostname: string; totalMemory: number; freeMemory: number; cpus: number; uptime: number } | null>(null)
  const [gatewayStatus, setGatewayStatus] = React.useState<GatewayStatus | null>(null)

  React.useEffect(() => {
    if (expanded) {
      fetch('/api/network-info').then((r) => r.json()).then(setNetworkInfo).catch(() => {})
      fetch('/api/gateway/status').then((r) => r.json()).then(setGatewayStatus).catch(() => {})
    }
  }, [expanded])

  const totalEnvs = projects.reduce((a, p) => a + (p.environments?.length || 0), 0)
  const runningEnvs = projects.reduce((a, p) => a + (p.environments?.filter((e) => e.status === 'running').length || 0), 0)

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-background/95 backdrop-blur-md shadow-[0_-4px_20px_rgba(0,0,0,0.08)] dark:bg-zinc-900/95 dark:border-t dark:border-zinc-800/60">
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-2 grid grid-cols-2 md:grid-cols-4 gap-5 text-xs">
              <div className="space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5 dark:text-zinc-200"><Cpu className="h-3.5 w-3.5 text-amber-500" />CPU</div>
                <Progress value={gatewayStatus?.cpuUsage.percentage ?? 0} className="h-1.5" />
                <div className="text-muted-foreground dark:text-zinc-400 leading-relaxed">{gatewayStatus?.cpuUsage.percentage ?? '—'}%<br />{gatewayStatus?.cpuUsage.cores ?? networkInfo?.cpus ?? '—'} cores · load {gatewayStatus?.cpuUsage.loadAverage?.[0]?.toFixed(1) ?? '—'}</div>
              </div>
              <div className="space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5 dark:text-zinc-200"><HardDrive className="h-3.5 w-3.5 text-teal-500" />Memory</div>
                <Progress value={gatewayStatus?.memoryUsage.percentage ?? 0} className="h-1.5" />
                <div className="text-muted-foreground dark:text-zinc-400 leading-relaxed">{gatewayStatus?.memoryUsage.used ?? '—'} / {gatewayStatus?.memoryUsage.total ?? '—'} MB<br />({gatewayStatus?.memoryUsage.percentage ?? '—'}%)</div>
              </div>
              <div className="space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5 dark:text-zinc-200"><Server className="h-3.5 w-3.5 text-emerald-500" />Gateway</div>
                <div className="text-muted-foreground dark:text-zinc-400 leading-relaxed">{gatewayStatus?.caddyRunning ? 'Running' : 'Stopped'}<br />v{gatewayStatus?.caddyVersion ?? '—'}</div>
              </div>
              <div className="space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5 dark:text-zinc-200"><Clock className="h-3.5 w-3.5 text-cyan-500" />Uptime</div>
                <div className="text-muted-foreground dark:text-zinc-400 leading-relaxed">{gatewayStatus?.uptime ?? '—'}<br />RSS {gatewayStatus?.processMemory?.rss ?? '—'} MB</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="px-4 py-3 flex items-center justify-between text-xs text-foreground/80 dark:text-zinc-300">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-1"><CircleDot className={`h-2.5 w-2.5 ${runningEnvs > 0 ? 'text-emerald-500' : 'text-red-400'}`} /><span className="font-bold dark:text-zinc-200">{runningEnvs}/{totalEnvs}</span> running</span>
          <span className="dark:text-zinc-300 font-medium">{projects.length} projects</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 hover:text-foreground transition-colors px-3 py-1.5 rounded-md bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/30 font-medium" onClick={onOpenDevices}>
            <Plug className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">Devices</span>
          </button>
          <button className="flex items-center gap-1.5 hover:text-foreground transition-colors px-3 py-1.5 rounded-md bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 font-medium" onClick={() => setExpanded(!expanded)}>
            <Monitor className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">System</span>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </footer>
  )
}

// ======================== DEVICE MANAGEMENT PANEL ========================

function DeviceManagementPanel({
  open, onClose, devices, onAdd, onEdit, onDelete, onHealthCheck
}: {
  open: boolean
  onClose: () => void
  devices: Device[]
  onAdd: () => void
  onEdit: (device: Device) => void
  onDelete: (id: string) => void
  onHealthCheck: (id: string) => Promise<{ status: string } | null>
}) {
  const [healthCheckingIds, setHealthCheckingIds] = React.useState<Set<string>>(new Set())

  const handleHealthCheck = async (id: string) => {
    setHealthCheckingIds((prev) => new Set(prev).add(id))
    await onHealthCheck(id)
    setHealthCheckingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-hidden p-0 flex flex-col dark:bg-zinc-900/98 dark:border-l dark:border-zinc-800/60">
        <SheetHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-teal-50 dark:bg-teal-900/20">
              <Plug className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle>Device Management</SheetTitle>
              <SheetDescription className="text-xs">Manage connected devices and remote agents</SheetDescription>
            </div>
            <Button size="sm" onClick={onAdd} className="bg-teal-600 hover:bg-teal-700 text-white h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" />Add Device
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-6 rounded-2xl bg-gradient-to-br from-teal-50/80 to-cyan-50/60 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/30 dark:ring-teal-800/20 shadow-inner mb-4">
                <Plug className="h-12 w-12 text-teal-600/70 dark:text-teal-400/60" />
              </div>
              <h3 className="text-sm font-semibold mb-1">No devices registered</h3>
              <p className="text-xs text-muted-foreground dark:text-gray-400 mb-4 max-w-xs">Add a remote device to monitor and manage projects on other machines.</p>
              <Button onClick={onAdd} size="sm" className="bg-teal-600 hover:bg-teal-700 text-white">
                <Plus className="h-3 w-3 mr-1" />Add Device
              </Button>
            </div>
          ) : (
            devices.map((device) => (
              <motion.div
                key={device.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg border p-3 space-y-2 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${device.status === 'online' ? 'bg-emerald-500' : device.status === 'error' ? 'bg-amber-500' : 'bg-red-400'}`} />
                  <span className="font-medium text-sm truncate">{device.name}</span>
                  <Badge variant="outline" className={`text-[9px] ml-auto shrink-0 ${device.status === 'online' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20' : device.status === 'error' ? 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'}`}>
                    {device.status === 'online' ? '🟢 Online' : device.status === 'error' ? '⚠️ Error' : '🔴 Offline'}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Globe className="h-3 w-3" />
                    <span className="font-mono">{device.ip}:{device.port}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Folder className="h-3 w-3" />
                    <span>{device.projectCount ?? 0} projects</span>
                  </div>
                  <div className="flex items-center gap-1 col-span-2">
                    <Clock className="h-3 w-3" />
                    <span>Last seen: {device.lastSeen ? formatTimeAgo(device.lastSeen) : 'Never'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 pt-1">
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => onEdit(device)}>
                    <Edit3 className="h-3 w-3 mr-1" />Edit
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => handleHealthCheck(device.id)} disabled={healthCheckingIds.has(device.id)}>
                    {healthCheckingIds.has(device.id) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Activity className="h-3 w-3 mr-1" />}
                    Health
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:bg-red-50 dark:hover:bg-red-900/20" />}>
                      <Trash2 className="h-3 w-3" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete &quot;{device.name}&quot;?</AlertDialogTitle>
                        <AlertDialogDescription>This will remove the device. Remote projects from this device will no longer appear.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(device.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
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
  onSubmit: (data: { name: string; ip: string; port: number; apiKey: string }) => void
  device?: Device | null
  mode: 'add' | 'edit'
}) {
  const [name, setName] = React.useState(() => mode === 'edit' && device ? device.name : '')
  const [ip, setIp] = React.useState(() => mode === 'edit' && device ? device.ip : '')
  const [port, setPort] = React.useState(() => mode === 'edit' && device ? String(device.port) : '3100')
  const [apiKey, setApiKey] = React.useState(() => mode === 'edit' && device ? device.apiKey : '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !ip.trim()) return
    onSubmit({ name: name.trim(), ip: ip.trim(), port: parseInt(port) || 3100, apiKey: apiKey.trim() })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? 'Add Device' : 'Edit Device'}</DialogTitle>
          <DialogDescription>{mode === 'add' ? 'Register a remote device to monitor and manage its projects.' : 'Update device connection settings.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="device-name">Name *</Label>
            <Input id="device-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook Pro" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-ip">IP Address *</Label>
            <Input id="device-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-port">Port</Label>
            <Input id="device-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-apikey">API Key</Label>
            <Input id="device-apikey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Auto-generated if empty" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !ip.trim()} className="bg-teal-600 hover:bg-teal-700 text-white">
              {mode === 'add' ? 'Add Device' : 'Update'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ======================== SKELETON LOADING ========================

function LoadingSkeleton({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
            <div className="h-4 w-4 rounded animate-shimmer" style={{ animationDelay: '0ms' }} />
            <div className="h-5 w-5 rounded animate-shimmer" style={{ animationDelay: '0ms' }} />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-32 rounded animate-shimmer" style={{ animationDelay: '100ms' }} />
              <div className="h-3 w-48 rounded animate-shimmer" style={{ animationDelay: '200ms' }} />
            </div>
            <div className="h-8 w-8 rounded-full animate-shimmer" style={{ animationDelay: '100ms' }} />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card overflow-hidden">
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2"><div className="h-8 w-8 rounded-lg animate-shimmer" style={{ animationDelay: '0ms' }} /><div className="flex-1 space-y-1"><div className="h-4 w-24 rounded animate-shimmer" style={{ animationDelay: '0ms' }} /><div className="h-3 w-32 rounded animate-shimmer" style={{ animationDelay: '100ms' }} /></div><div className="h-9 w-9 rounded-full animate-shimmer" style={{ animationDelay: '100ms' }} /></div>
            <div className="space-y-1">
              <div className="h-3 w-full rounded animate-shimmer" style={{ animationDelay: '100ms' }} />
              <div className="h-3 w-2/3 rounded animate-shimmer" style={{ animationDelay: '150ms' }} />
              <div className="h-3 w-1/2 rounded animate-shimmer" style={{ animationDelay: '200ms' }} />
            </div>
            <div className="flex gap-1"><div className="h-4 w-14 rounded animate-shimmer" style={{ animationDelay: '150ms' }} /><div className="h-4 w-14 rounded animate-shimmer" style={{ animationDelay: '200ms' }} /></div>
          </div>
          <div className="h-px mx-5 bg-gradient-to-r from-transparent via-border/50 dark:via-zinc-700/40 to-transparent" />
          <div className="px-4 py-2 flex items-center justify-between">
            <div className="h-4 w-20 rounded animate-shimmer" style={{ animationDelay: '200ms' }} />
            <div className="flex gap-1"><div className="h-6 w-14 rounded animate-shimmer" style={{ animationDelay: '200ms' }} /><div className="h-6 w-6 rounded animate-shimmer" style={{ animationDelay: '200ms' }} /></div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ======================== EMPTY STATE ========================

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <motion.div
        className="p-8 rounded-2xl bg-gradient-to-br from-emerald-50/80 via-teal-50/40 to-cyan-50/60 dark:from-emerald-900/20 dark:via-teal-900/10 dark:to-cyan-900/15 ring-1 ring-emerald-200/30 dark:ring-emerald-800/20 shadow-inner mb-6"
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Folder className="h-16 w-16 text-emerald-600/70 dark:text-emerald-400/60" />
      </motion.div>
      <h3 className="text-lg font-semibold mb-1 text-foreground">No projects yet</h3>
      <p className="text-sm text-muted-foreground dark:text-gray-400 mb-5 max-w-xs">Get started by creating your first project. You can add environments and manage them from here.</p>
      <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
        <Button onClick={onAdd} className="bg-emerald-600 hover:bg-emerald-700 text-white h-10 px-6 text-sm font-semibold shadow-md shadow-emerald-200/50 dark:shadow-emerald-900/30 hover:shadow-lg hover:shadow-emerald-300/60 dark:hover:shadow-emerald-800/40 transition-all">
          <Plus className="h-4 w-4 mr-2" />Create Project
        </Button>
      </motion.div>
    </div>
  )
}

// ======================== MAIN PAGE COMPONENT ========================

export default function DashboardPage() {
  // State
  const [projects, setProjects] = React.useState<Project[]>([])
  const [notifications, setNotifications] = React.useState<Notification[]>([])
  const [loading, setLoading] = React.useState(true)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [viewMode, setViewMode] = React.useState<ViewMode>('grid')
  const [sortBy, setSortBy] = React.useState<SortOption>('newest')
  const [filterStatus, setFilterStatus] = React.useState<FilterStatus>('all')
  const [filterTags, setFilterTags] = React.useState<string[]>([])
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
  const [gatewayOpen, setGatewayOpen] = React.useState(false)
  const [llmOpen, setLlmOpen] = React.useState(false)
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
  const [lastRefreshed, setLastRefreshed] = React.useState<string>(new Date().toISOString())
  const [starredIds, setStarredIds] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('starred-projects') || '[]')) } catch { return new Set() }
  })
  const [lanIp, setLanIp] = React.useState<string>('')
  const [currentHost, setCurrentHost] = React.useState<string>('')
  const [devices, setDevices] = React.useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(null) // null = all, 'local' = this machine
  const [deviceManagementOpen, setDeviceManagementOpen] = React.useState(false)
  const [addDeviceFormOpen, setAddDeviceFormOpen] = React.useState(false)
  const [editingDevice, setEditingDevice] = React.useState<Device | null>(null)

  const toggleStar = React.useCallback((id: string) => {
    setStarredIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('starred-projects', JSON.stringify([...next]))
      return next
    })
  }, [])

  const { toast } = useToast()

  // Data fetching
  const fetchProjects = React.useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (res.ok) {
        const data = await res.json()
        const parsed = (data.projects ?? []).map((p: Record<string, unknown>) => ({
          ...p,
          tags: parseTags(p.tags as string),
        }))
        setProjects(parsed)
        setLastRefreshed(new Date().toISOString())
        // Publish projects for cross-component consumers (e.g. HermesBridgeToggle)
        try {
          window.__dashboardProjects = parsed
          window.dispatchEvent(new CustomEvent('projects-updated'))
        } catch {
          // ignore
        }
      }
    } catch { /* ignore */ }
  }, [])

  const fetchNotifications = React.useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (res.ok) setNotifications(await res.json())
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
        toast({ title: 'Device added', variant: 'success' })
        fetchDevices()
      } else {
        const err = await res.json()
        toast({ title: 'Failed to add device', description: err.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to add device', variant: 'destructive' })
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
        toast({ title: 'Device updated', variant: 'success' })
        fetchDevices()
      } else {
        toast({ title: 'Failed to update device', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to update device', variant: 'destructive' })
    }
  }, [toast, fetchDevices])

  const handleDeleteDevice = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: 'Device deleted', variant: 'success' })
        fetchDevices()
        if (selectedDeviceId === id) setSelectedDeviceId(null)
      } else {
        toast({ title: 'Failed to delete device', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to delete device', variant: 'destructive' })
    }
  }, [toast, fetchDevices, selectedDeviceId])

  const handleCheckDeviceHealth = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/devices/${id}/health`)
      if (res.ok) {
        const data = await res.json()
        toast({ title: `Device ${data.status === 'online' ? 'is online' : 'is offline'}`, variant: data.status === 'online' ? 'success' : 'destructive' })
        fetchDevices()
        return data
      } else {
        toast({ title: 'Health check failed', variant: 'destructive' })
        return null
      }
    } catch {
      toast({ title: 'Health check failed', variant: 'destructive' })
      return null
    }
  }, [toast, fetchDevices])

  const loadData = React.useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchProjects(), fetchNotifications(), fetchDevices()])
    setLoading(false)
  }, [fetchProjects, fetchNotifications, fetchDevices])

  // Initial load
  React.useEffect(() => {
    const id = requestAnimationFrame(() => { loadData() })
    return () => cancelAnimationFrame(id)
  }, [loadData])

  // Auto-refresh every 5 seconds to keep status up-to-date
  React.useEffect(() => {
    const interval = setInterval(() => {
      fetchProjects()
    }, 5000)
    return () => clearInterval(interval)
  }, [fetchProjects])

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
        if (e.shiftKey && (e.key === 'R' || e.key === 'r')) { e.preventDefault(); loadData() }
        if (e.key === 'p') { e.preventDefault(); setCommandPaletteOpen(true) }
      }

      if (e.key === '?' && !e.ctrlKey && !e.metaKey) { setShortcutsOpen(true) }

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
  }, [gSequence, handleAddProject, loadData])

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
          p.description.toLowerCase().includes(q)
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

    // Sort
    if (sortBy === 'newest') result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    else if (sortBy === 'name') result.sort((a, b) => a.name.localeCompare(b.name))
    else if (sortBy === 'status') {
      result.sort((a, b) => {
        const sa = getProjectStatus(a)
        const sb = getProjectStatus(b)
        const order = { running: 0, mixed: 1, stopped: 2 }
        return (order[sa] ?? 3) - (order[sb] ?? 3)
      })
    }

    // Starred projects always appear first (stable sort)
    const starred = result.filter((p) => starredIds.has(p.id))
    const unstarred = result.filter((p) => !starredIds.has(p.id))
    result = [...starred, ...unstarred]

    return result
  }, [projects, searchQuery, filterStatus, filterTags, sortBy, starredIds, selectedDeviceId])

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
  }), [filteredProjects])

  const unreadNotifs = React.useMemo(() => notifications.filter((n) => !n.read).length, [notifications])

  const handleEditProject = React.useCallback((p: Project) => {
    setProjectFormMode('edit')
    setEditingProject(p)
    setProjectFormOpen(true)
  }, [])

  const handleProjectSubmit = React.useCallback(async (data: { name: string; path: string; description: string; icon: string; tags: string[] }) => {
    try {
      if (projectFormMode === 'add') {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: 'Project created', variant: 'success' })
          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: 'Failed to create project', description: err.error, variant: 'destructive' })
        }
      } else if (editingProject) {
        const res = await fetch(`/api/projects/${editingProject.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: 'Project updated', variant: 'success' })
          fetchProjects()
        }
      }
    } catch {
      toast({ title: 'Operation failed', variant: 'destructive' })
    }
  }, [projectFormMode, editingProject, toast, fetchProjects])

  const handleDeleteProject = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: 'Project deleted', variant: 'success' })
        fetchProjects()
        setDeleteProject(null)
        if (selectedProject?.id === id) { setSelectedProject(null); setDetailOpen(false) }
      }
    } catch {
      toast({ title: 'Failed to delete', variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject])

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
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
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
    toast({ title: 'Exported as CSV', variant: 'success' })
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
    toast({ title: 'Exported as JSON', variant: 'success' })
  }, [projects, toast])

  const handleEnvAction = React.useCallback(async (projectId: string, envId: string, action: string) => {
    const project = projects.find((p) => p.id === projectId)
    const env = project?.environments.find((e) => e.id === envId)
    const envLabel = env ? (env.name === 'development' ? 'dev' : env.name === 'production' ? 'prod' : env.name) : 'environment'
    // Block rebuild for dev environments — they use HMR
    if (action === 'rebuild' && env?.name === 'development') {
      toast({ title: 'Dev environments use hot-reload', description: 'No rebuild needed — file changes are applied automatically via HMR', variant: 'info' })
      return
    }
    const actionLabels: Record<string, string> = {
      start: 'Started',
      stop: 'Stopped',
      rebuild: 'Rebuilt',
      restart: 'Restarted',
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/environments/${envId}/${action}`, { method: 'POST' })
      if (res.ok) {
        toast({ title: `${actionLabels[action] ?? `${action}ed`} ${envLabel}`, variant: 'success' })

        // Auto-start Hermes Bridge when Hermes Web dev/prod starts
        if (action === 'start' && project?.name === 'Hermes Web') {
          const bridgeProject = projects.find((p) => p.name === 'Hermes Bridge')
          const bridgeEnv = bridgeProject?.environments?.[0]
          if (bridgeProject && bridgeEnv && bridgeEnv.status !== 'running') {
            try {
              await fetch(`/api/projects/${bridgeProject.id}/environments/${bridgeEnv.id}/start`, { method: 'POST' })
              toast({ title: 'Hermes Bridge auto-started', variant: 'success' })
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
                toast({ title: 'Hermes Bridge auto-stopped', variant: 'success' })
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
      }
    } catch {
      toast({ title: `Failed to ${action} ${envLabel}`, variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject, projects])

  const handleSyncFromConfig = React.useCallback(async () => {
    if (!confirm('This will REPLACE all projects and environments with the contents of projects.config.json. Any unsaved changes will be lost. Continue?')) {
      return
    }
    try {
      const res = await fetch('/api/seed', { method: 'POST' })
      if (res.ok) {
        toast({ title: 'Projects synced from config', variant: 'success' })
        fetchProjects()
      } else {
        toast({ title: 'Failed to sync projects', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to sync projects', variant: 'destructive' })
    }
  }, [toast, fetchProjects])

  const handleRebuildProject = React.useCallback(async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId)
    if (!project || project.environments.length === 0) return
    setRebuildingProjectIds((prev) => new Set(prev).add(projectId))
    try {
      let successCount = 0
      // Skip dev environments — they use HMR and don't need rebuild
      const rebuildEnvs = project.environments.filter((e) => e.name !== 'development')
      if (rebuildEnvs.length === 0) {
        toast({ title: 'No rebuildable environments', description: 'Dev environments use hot-reload and do not need rebuild', variant: 'info' })
        return
      }
      for (const env of rebuildEnvs) {
        const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/rebuild`, { method: 'POST' })
        if (res.ok) successCount++
      }
      toast({ title: `Rebuild completed`, description: `${successCount}/${rebuildEnvs.length} environments rebuilt (dev skipped — HMR)`, variant: 'success' })
      fetchProjects()
      if (selectedProject?.id === projectId) {
        const fresh = await (await fetch(`/api/projects/${projectId}`)).json()
        setSelectedProject(fresh?.project ?? fresh)
      }
    } catch {
      toast({ title: 'Failed to rebuild project', variant: 'destructive' })
    } finally {
      setRebuildingProjectIds((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }, [toast, fetchProjects, projects, selectedProject])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleAddEnv = React.useCallback((projectId: string) => {
    setAddEnvProjectId(projectId)
    setEnvFormMode('add')
    setEditingEnv(null)
    setEnvFormOpen(true)
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
          toast({ title: 'Environment created', variant: 'success' })
          fetchProjects()
        }
      } else if (editingEnv) {
        const res = await fetch(`/api/projects/${editingEnv.projectId}/environments/${editingEnv.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (res.ok) {
          toast({ title: 'Environment updated', variant: 'success' })
          fetchProjects()
        }
      }
    } catch {
      toast({ title: 'Operation failed', variant: 'destructive' })
    }
  }, [envFormMode, addEnvProjectId, editingEnv, toast, fetchProjects])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleDeleteEnv = React.useCallback(async (projectId: string, envId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/environments/${envId}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: 'Environment deleted', variant: 'success' })
        fetchProjects()
        if (selectedProject?.id === projectId) {
          const fresh = await (await fetch(`/api/projects/${projectId}`)).json()
          setSelectedProject(fresh?.project ?? fresh)
        }
      }
    } catch {
      toast({ title: 'Failed to delete environment', variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject])

  const handleMarkNotifRead = React.useCallback(async (id?: string) => {
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id } : { markAll: true }),
      })
      fetchNotifications()
    } catch { /* ignore */ }
  }, [fetchNotifications])

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

    toast({ title: `Batch ${action} completed`, description: `${successCount} operations succeeded`, variant: 'success' })
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
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    let nextOrder: string[] = []
    setProjects((prev) => {
      const oldIndex = prev.findIndex((p) => p.id === active.id)
      const newIndex = prev.findIndex((p) => p.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      const moved = arrayMove(prev, oldIndex, newIndex)
      nextOrder = moved.map((p) => p.id)
      return moved
    })

    // Persist the new order to the server in the background.
    // We don't block on it — visual order is updated immediately, and the
    // next fetchProjects() call will fetch the canonical order from the DB.
    if (nextOrder.length > 0) {
      fetch('/api/projects/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: nextOrder.map((id) => ({ id })) }),
      }).catch(() => {
        // Silent failure — the next 5s auto-refresh will reflect server truth.
        // The local state is already in the right order, so user sees no jitter.
      })
    }
  }, [])

  // Active filters for breadcrumb bar
  const activeFilters = React.useMemo(() => {
    const filters: Array<{ label: string; onRemove: () => void }> = []
    if (filterStatus !== 'all') {
      filters.push({ label: `Status: ${filterStatus}`, onRemove: () => setFilterStatus('all') })
    }
    filterTags.forEach((tag) => {
      filters.push({ label: `Tag: ${tag}`, onRemove: () => setFilterTags((prev) => prev.filter((t) => t !== tag)) })
    })
    if (searchQuery.trim()) {
      filters.push({ label: `Search: "${searchQuery}"`, onRemove: () => setSearchQuery('') })
    }
    if (selectedDeviceId === 'local') {
      filters.push({ label: 'Device: This Machine', onRemove: () => setSelectedDeviceId(null) })
    } else if (selectedDeviceId) {
      const device = devices.find((d) => d.id === selectedDeviceId)
      filters.push({ label: `Device: ${device?.name ?? 'Unknown'}`, onRemove: () => setSelectedDeviceId(null) })
    }
    return filters
  }, [filterStatus, filterTags, searchQuery, selectedDeviceId, devices])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* ======================== HEADER ======================== */}
      <header className="sticky top-0 z-30 border-b border-border/50 bg-background/80 backdrop-blur-xl supports-backdrop-blur:bg-background/60 shadow-[0_1px_8px_rgba(0,0,0,0.06)] dark:bg-zinc-900/95 dark:border-b dark:border-zinc-800/60 dark:shadow-[0_1px_8px_rgba(0,0,0,0.3)]">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/40 shadow-sm ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
              <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="hidden sm:flex flex-col">
              <h1 className="text-lg font-bold leading-tight">Dashboard</h1>
              <DashboardClockWidget />
            </div>
          </div>

          {/* Device Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background hover:bg-muted dark:hover:bg-white/10 h-9 px-2.5 text-xs font-medium cursor-pointer transition-colors max-w-[180px]" />}>
              <Monitor className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="truncate">
                {selectedDeviceId === null ? 'All Devices' : selectedDeviceId === 'local' ? '💻 This Machine' : devices.find(d => d.id === selectedDeviceId)?.name || 'Unknown'}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px] p-1.5 text-sm">
              <DropdownMenuItem onClick={() => setSelectedDeviceId(null)} className="px-2.5 py-2 text-sm rounded-md">
                <Layers className="h-3.5 w-3.5 mr-2.5 text-muted-foreground" />
                All Devices
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSelectedDeviceId('local')} className="px-2.5 py-2 text-sm rounded-md">
                <Monitor className="h-3.5 w-3.5 mr-2.5 text-emerald-600 dark:text-emerald-400" />
                💻 This Machine
              </DropdownMenuItem>
              {devices.length > 0 && <DropdownMenuSeparator />}
              {devices.map((device) => (
                <DropdownMenuItem key={device.id} onClick={() => setSelectedDeviceId(device.id)} className="px-2.5 py-2 text-sm rounded-md">
                  <span className={`mr-2 ${device.status === 'online' ? 'text-emerald-500' : device.status === 'error' ? 'text-amber-500' : 'text-red-400'}`}>
                    {device.status === 'online' ? '🟢' : device.status === 'error' ? '⚠️' : '🔴'}
                  </span>
                  <span className="truncate">{device.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{device.ip}:{device.port}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setAddDeviceFormOpen(true); setEditingDevice(null) }} className="px-2.5 py-2 text-sm rounded-md text-emerald-600 dark:text-emerald-400">
                <Plus className="h-3.5 w-3.5 mr-2.5" />
                Add Device
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Search */}
          <div className="flex-1 max-w-md relative group/search">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within/search:text-emerald-500" />
            <Input
              id="search-input"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchDropdownOpen(true) }}
              onFocus={() => { if (searchQuery.length >= 2) setSearchDropdownOpen(true) }}
              onBlur={() => { setTimeout(() => setSearchDropdownOpen(false), 200) }}
              className="pl-9 h-9 text-sm rounded-full bg-muted/40 border border-border/30 focus-visible:ring-2 focus-visible:ring-emerald-500/30 focus-visible:border-emerald-500/50 focus-visible:bg-background transition-all duration-200"
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center pointer-events-none px-1.5 py-0.5 text-[9px] text-muted-foreground dark:text-zinc-500 bg-muted dark:bg-zinc-800 rounded border border-border/50 dark:border-zinc-700/50 font-mono">⌘K</kbd>
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
                        <div className="text-xs text-muted-foreground dark:text-gray-400 truncate">{highlightText(p.path, searchQuery)}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{p.environments.length} envs</span>
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
              <PopoverTrigger nativeButton render={<button type="button" className="inline-flex items-center justify-center rounded-md h-8 w-8 hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground cursor-pointer relative transition-all duration-150 active:scale-95" />}>
                  <Bell className="h-4 w-4" />
                  {unreadNotifs > 0 && (
                    <motion.span key={unreadNotifs} initial={{ scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 25 }} className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold">{unreadNotifs}</motion.span>
                  )}
                </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b">
                  <span className="text-sm font-semibold">Notifications</span>
                  {unreadNotifs > 0 && (
                    <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleMarkNotifRead()}>Mark all read</Button>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {notifications.slice(0, 8).map((notif) => {
                    const IconMap = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info }
                    const ColorMap: Record<string, string> = { success: 'text-emerald-500', warning: 'text-amber-500', error: 'text-red-500', info: 'text-cyan-500' }
                    const NIcon = IconMap[notif.type]
                    return (
                      <button
                        key={notif.id}
                        className={`w-full flex items-start gap-2 p-2.5 text-left hover:bg-accent/50 transition-colors border-b last:border-0 border-l-2 ${notif.type === 'success' ? 'border-l-emerald-500' : notif.type === 'warning' ? 'border-l-amber-500' : notif.type === 'error' ? 'border-l-red-500' : 'border-l-cyan-500'}`}
                        onClick={() => {
                          if (!notif.read) handleMarkNotifRead(notif.id)
                          setNotifDetail(notif)
                          setNotifDetailOpen(true)
                        }}
                      >
                        <NIcon className={`h-4 w-4 mt-0.5 shrink-0 ${ColorMap[notif.type]}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium truncate">{notif.title}</span>
                            {!notif.read && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{notif.message}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{formatTimeAgo(notif.timestamp)}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </PopoverContent>
            </Popover>

            <Separator orientation="vertical" className="h-5 mx-0.5" />

            {/* View toggle */}
            <div className="hidden sm:flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<button type="button" className={`inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer transition-all duration-150 active:scale-95 ${viewMode === 'grid' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground'}`} />} onClick={() => setViewMode('grid')}>
                    <LayoutGrid className="h-4 w-4" />
                  </TooltipTrigger>
                <TooltipContent>Grid view (G+G)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<button type="button" className={`inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer transition-all duration-150 active:scale-95 ${viewMode === 'list' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground'}`} />} onClick={() => setViewMode('list')}>
                    <List className="h-4 w-4" />
                  </TooltipTrigger>
                <TooltipContent>List view (G+L)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </div>

            <Separator orientation="vertical" className="h-5 mx-0.5 hidden sm:block" />

            <ThemeToggle />

            {/* Settings dropdown: Gateway, LLM, Export, Sync */}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground transition-colors" />}>
                <Settings className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => setGatewayOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <Server className="h-3.5 w-3.5 mr-2.5" />Gateway Monitor
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLlmOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <Bot className="h-3.5 w-3.5 mr-2.5" />LLM Configuration
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSyncFromConfig} className="px-2.5 py-2 text-sm rounded-md">
                  <RefreshCw className="h-3.5 w-3.5 mr-2.5" />Sync from config
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExportCSV} className="px-2.5 py-2 text-sm rounded-md">
                  <Download className="h-3.5 w-3.5 mr-2.5" />Export as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportJSON} className="px-2.5 py-2 text-sm rounded-md">
                  <Download className="h-3.5 w-3.5 mr-2.5" />Export as JSON
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Separator between utility group and primary action */}
            <Separator orientation="vertical" className="h-5 mx-1.5" />

            {/* Primary action */}
            <Button onClick={handleAddProject} className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white text-xs shadow-sm hover:shadow-md shadow-emerald-200/50 dark:shadow-emerald-900/30 hover:shadow-emerald-300/60 dark:hover:shadow-emerald-800/40 transition-all">
              <Plus className="h-3.5 w-3.5 mr-1" />
              <span className="hidden sm:inline">Add Project</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ======================== FILTER / STATUS BAR ======================== */}
      <div className="border-b bg-muted/30 dark:bg-zinc-900/80 dark:border-b dark:border-zinc-800/50">
        <div className="max-w-7xl mx-auto px-4 py-2 space-y-2">
          {/* Row 1: Stats + Updated timestamp */}
          <div className="flex items-center gap-2 text-xs dark:text-gray-300">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/60 dark:bg-white/5 border border-border/50 shadow-sm cursor-default">
              <Folder className="h-3 w-3 text-emerald-600" />
              {loading && <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />}
              <AnimatedCounter target={stats.total} /> projects
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/60 dark:bg-white/5 border border-border/50 shadow-sm cursor-default">
              <Play className="h-3 w-3 text-emerald-500" />
              <AnimatedCounter target={stats.running} /> running
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/60 dark:bg-white/5 border border-border/50 shadow-sm cursor-default hidden sm:inline-flex">
              <Square className="h-3 w-3 text-red-400" />
              <AnimatedCounter target={stats.stopped} /> stopped
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/60 dark:bg-white/5 border border-border/50 shadow-sm cursor-default hidden md:inline-flex">
              <Layers className="h-3 w-3 text-teal-500" />
              <AnimatedCounter target={stats.environments} /> envs
            </span>
            <span className="text-[9px] text-muted-foreground dark:text-zinc-500 tabular-nums ml-auto hidden sm:inline">
              Updated {formatTimeAgo(lastRefreshed)}
            </span>
          </div>

          {/* Row 2: Filters + Batch select (right-aligned) */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Filter controls — wrap naturally, no horizontal scroll */}
            <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center rounded-md border border-border bg-background hover:bg-muted dark:hover:bg-white/10 hover:text-foreground h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors" />}>
                  <Filter className="h-3 w-3 mr-1" />
                  {filterStatus === 'all' ? 'Status' : filterStatus}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={filterStatus} onValueChange={(v) => setFilterStatus(v as FilterStatus)}>
                    <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="running">Running</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="stopped">Stopped</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center rounded-md border border-border bg-background hover:bg-muted dark:hover:bg-white/10 hover:text-foreground h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors" />}>
                  <Tag className="h-3 w-3 mr-1" />
                  Tags {filterTags.length > 0 && `(${filterTags.length})`}
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
                <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center rounded-md border border-border bg-background hover:bg-muted dark:hover:bg-white/10 hover:text-foreground h-7 px-2.5 text-xs font-medium cursor-pointer transition-colors" />}>
                  <ArrowUpDown className="h-3 w-3 mr-1" />
                  {sortBy === 'newest' ? 'Newest' : sortBy === 'name' ? 'Name' : 'Status'}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                    <DropdownMenuRadioItem value="newest">Newest First</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">By Name</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="status">By Status</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Filter indicator pills */}
              {filterStatus !== 'all' && (
                <button type="button" onClick={() => setFilterStatus('all')} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60 transition-colors">
                  {filterStatus} <X className="h-2.5 w-2.5" />
                </button>
              )}
              {filterTags.length > 0 && filterTags.map(tag => (
                <button key={tag} type="button" onClick={() => setFilterTags(prev => prev.filter(t => t !== tag))} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 hover:bg-teal-200 dark:hover:bg-teal-900/60 transition-colors">
                  {tag} <X className="h-2.5 w-2.5" />
                </button>
              ))}

              {/* Active filters breadcrumb — inline on same row */}
              {activeFilters.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {activeFilters.map((f, i) => (
                    <Badge key={i} variant="secondary" className="text-[10px] gap-1 pr-0.5">
                      {f.label}
                      <button onClick={f.onRemove} className="p-0.5 hover:bg-muted rounded"><X className="h-2.5 w-2.5" /></button>
                    </Badge>
                  ))}
                  <Button variant="ghost" size="sm" className="h-5 text-[10px] text-muted-foreground" onClick={() => { setFilterStatus('all'); setFilterTags([]); setSearchQuery('') }}>
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {/* Batch mode toggle — always right-aligned */}
            <Button
              variant={batchMode ? 'secondary' : 'outline'}
              className="h-7 px-2.5 text-xs font-medium gap-1.5 shrink-0 hover:text-foreground transition-colors"
              onClick={() => { setBatchMode(!batchMode); if (batchMode) setSelectedIds(new Set()) }}
              title="Batch select"
            >
              <Checkbox checked={batchMode} className="h-3 w-3" />
              {batchMode ? 'Cancel' : 'Batch'}
            </Button>
          </div>
        </div>
      </div>

      {/* ======================== BATCH OPERATIONS BAR ======================== */}
      <AnimatePresence>
        {batchMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b bg-emerald-50 dark:bg-emerald-950/30 overflow-hidden"
          >
            <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox checked={selectedIds.size === filteredProjects.length && filteredProjects.length > 0} onCheckedChange={toggleSelectAll} />
                <span className="text-sm font-medium">{selectedIds.size} selected</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('start')}><Play className="h-3 w-3 mr-1 text-emerald-500" />Start</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('stop')}><Square className="h-3 w-3 mr-1 text-red-500" />Stop</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('rebuild')}><Hammer className="h-3 w-3 mr-1 text-teal-500" />Rebuild</Button>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="outline" className="h-7 text-xs text-destructive" />}>
                    <Trash2 className="h-3 w-3 mr-1" />Delete
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {selectedIds.size} projects?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. All environments and data will be permanently removed.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleBatchAction('delete')} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ======================== MAIN CONTENT ======================== */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-4 pb-20">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        {loading ? (
          <LoadingSkeleton viewMode={viewMode} />
        ) : filteredProjects.length === 0 ? (
          projects.length === 0 ? (
            <EmptyState onAdd={handleAddProject} />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="p-6 rounded-2xl bg-gradient-to-br from-muted/50 to-muted/30 ring-1 ring-border/30 shadow-inner mb-5">
                <Folder className="h-16 w-16 text-muted-foreground/60" />
              </div>
              <h3 className="text-lg font-semibold mb-1 text-foreground">No projects found</h3>
              <p className="text-sm text-muted-foreground dark:text-gray-400 mb-4">Try adjusting your search or filters</p>
              <Button variant="outline" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterTags([]) }}>
                <X className="h-4 w-4 mr-1" />Clear Filters
              </Button>
            </div>
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filteredProjects.map((p) => p.id)} strategy={viewMode === 'list' ? verticalListSortingStrategy : verticalListSortingStrategy}>
              {/* Mini Status Summary */}
              {filteredEnvStats.total > 0 && (
                <div className="flex items-center gap-3 mb-4 px-1">
                  <span className="text-xs font-medium text-muted-foreground dark:text-zinc-400">Environments</span>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{filteredEnvStats.running} running</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <span className="h-2 w-2 rounded-full bg-red-400 inline-block" />
                    <span className="font-medium text-red-500 dark:text-red-400">{filteredEnvStats.stopped} stopped</span>
                  </span>
                  {filteredEnvStats.mixed > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
                      <span className="font-medium text-amber-600 dark:text-amber-400">{filteredEnvStats.mixed} mixed</span>
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground dark:text-zinc-500">of {filteredEnvStats.total}</span>
                  <span className="text-[10px] text-muted-foreground/60 dark:text-zinc-600 ml-auto hidden sm:inline">
                    <RefreshCw className="h-2.5 w-2.5 inline mr-0.5" />{formatTimeAgo(lastRefreshed)}
                  </span>
                </div>
              )}
              {viewMode === 'grid' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {selectedDeviceId === null && deviceGroupedProjects ? (
                    <>
                      {/* Local projects group */}
                      {deviceGroupedProjects.localProjects.length > 0 && (
                        <>
                          <div className="col-span-full">
                            <div className="flex items-center gap-2 px-1 py-2">
                              <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                              <span className="text-sm font-semibold">💻 This Machine</span>
                              <Badge variant="secondary" className="text-[10px]">{deviceGroupedProjects.localProjects.length}</Badge>
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
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                            />
                          ))}
                        </>
                      )}
                      {/* Remote device groups */}
                      {deviceGroupedProjects.remoteGroups.map((group) => (
                        <React.Fragment key={group.device?.id ?? 'unknown'}>
                          <div className="col-span-full">
                            <div className="flex items-center gap-2 px-1 py-2">
                              <span className={group.device?.status === 'online' ? 'text-emerald-500' : 'text-red-400'}>
                                {group.device?.status === 'online' ? '🟢' : '🔴'}
                              </span>
                              <span className="text-sm font-semibold">{group.device?.name ?? 'Unknown Device'}</span>
                              <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                              <Badge variant="secondary" className="text-[10px]">{group.projects.length}</Badge>
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
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
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
                        starred={starredIds.has(project.id)}
                        onToggleStar={toggleStar}
                        lanIp={lanIp}
                        currentHost={currentHost}
                        index={idx}
                        batchMode={batchMode}
                      />
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedDeviceId === null && deviceGroupedProjects ? (
                    <>
                      {/* Local projects group */}
                      {deviceGroupedProjects.localProjects.length > 0 && (
                        <>
                          <div className="flex items-center gap-2 px-1 py-1.5">
                            <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            <span className="text-sm font-semibold">💻 This Machine</span>
                            <Badge variant="secondary" className="text-[10px]">{deviceGroupedProjects.localProjects.length}</Badge>
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
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
                            />
                          ))}
                        </>
                      )}
                      {/* Remote device groups */}
                      {deviceGroupedProjects.remoteGroups.map((group) => (
                        <React.Fragment key={group.device?.id ?? 'unknown'}>
                          <div className="flex items-center gap-2 px-1 py-1.5 mt-2">
                            <span className={group.device?.status === 'online' ? 'text-emerald-500' : 'text-red-400'}>
                              {group.device?.status === 'online' ? '🟢' : '🔴'}
                            </span>
                            <span className="text-sm font-semibold">{group.device?.name ?? 'Unknown Device'}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                            <Badge variant="secondary" className="text-[10px]">{group.projects.length}</Badge>
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
                              starred={starredIds.has(project.id)}
                              onToggleStar={toggleStar}
                              lanIp={lanIp}
                              currentHost={currentHost}
                              index={idx}
                              batchMode={batchMode}
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
                        starred={starredIds.has(project.id)}
                        onToggleStar={toggleStar}
                        lanIp={lanIp}
                        currentHost={currentHost}
                        index={idx}
                        batchMode={batchMode}
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
      <EnhancedFooter projects={projects} onOpenDevices={() => setDeviceManagementOpen(true)} />

      {/* ======================== GLOBAL STATUS PANEL ======================== */}
      {!loading && projects.length > 0 && <GlobalStatusPanel projects={projects} />}

      {/* ======================== DIALOGS ======================== */}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteProject} onOpenChange={(v) => !v && setDeleteProject(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteProject?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the project and all its environments. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteProject && handleDeleteProject(deleteProject.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rebuild confirmation */}
      <AlertDialog open={!!rebuildConfirmProject} onOpenChange={(v) => !v && setRebuildConfirmProject(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild {rebuildConfirmProject?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This will rebuild {rebuildConfirmProject?.environments?.filter((e) => e.name !== 'development').length ?? 0} production environments. Dev environments are skipped (they use hot-reload). Running services will be temporarily stopped.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (rebuildConfirmProject) { handleRebuildProject(rebuildConfirmProject.id); setRebuildConfirmProject(null) } }} className="bg-teal-600 text-white hover:bg-teal-700">
              Rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Project form - key resets state when dialog opens */}
      <ProjectFormDialog
        key={projectFormOpen ? `open-${editingProject?.id ?? 'new'}` : 'project-form-closed'}
        open={projectFormOpen}
        onClose={() => setProjectFormOpen(false)}
        onSubmit={handleProjectSubmit}
        project={editingProject}
        mode={projectFormMode}
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
      />

      {/* Gateway monitor */}
      <GatewayMonitorDialog open={gatewayOpen} onClose={() => setGatewayOpen(false)} />

      {/* LLM config */}
      <LlmConfigDialog open={llmOpen} onClose={() => setLlmOpen(false)} />

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

      {/* Toast container */}
      <ToastContainer />
    </div>
  )
}
