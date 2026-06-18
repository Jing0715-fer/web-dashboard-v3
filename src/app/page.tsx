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
  Bot, ArrowUpDown, ArrowRightLeft,
  CircleDot, Download, Star, ExternalLink, Link2, Plug, PlugZap,
  Keyboard,
  Wifi, Gauge, MemoryStick, BarChart3, Upload, LayoutTemplate,
  TrendingUp, TrendingDown, Pin, PinOff, ArrowUp, GitFork, Tags, User, Clipboard,
  SearchX,
  Cloud, Container, Wrench, Building, House, Box,
  EyeOff,
} from 'lucide-react'

import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay
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
import { useToast, addToast } from '@/hooks/use-toast'

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

interface Deployment {
  id: string
  version: number
  timestamp: string
  status: 'success' | 'failed' | 'rolling-back'
  duration: string
  deployedBy: string
}

type AlertSeverity = 'critical' | 'warning' | 'notice' | 'ok'

type ViewMode = 'grid' | 'list'
type SortOption = 'newest' | 'name' | 'status'
type FilterStatus = 'all' | 'running' | 'stopped'
type GroupBy = 'device' | 'tags' | 'none'

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
  if (trend === 'up') return <span className="health-trend-icon inline-flex items-center text-emerald-500 text-xs font-bold leading-none ml-0.5" title="Health improving">▲</span>
  if (trend === 'down') return <span className="health-trend-icon inline-flex items-center text-red-500 text-xs font-bold leading-none ml-0.5" title="Health declining">▼</span>
  return <span className="health-trend-icon inline-flex items-center text-muted-foreground/60 text-xs leading-none ml-0.5" title="Health stable">◆</span>
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
  const safeScore = typeof score === 'number' && !isNaN(score) ? score : 0
  const offset = circumference - (safeScore / 100) * circumference

  return (
    <svg width={size} height={size} className="transform -rotate-90">
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
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central" className={`text-[10px] font-semibold ${healthColor(safeScore)}`} transform={`rotate(90, ${size / 2}, ${size / 2})`}>{safeScore}</text>
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
          <div className="font-semibold text-sm">Project Stats</div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Health Score</span>
            <span className={`font-medium ${healthColor(score)}`}>{score}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Uptime</span>
            <span className="font-medium">{totalEnvs > 0 ? Math.round((runningEnvs / totalEnvs) * 100) : 0}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Running Envs</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{runningEnvs}/{totalEnvs}</span>
          </div>
          {/* Status breakdown bar */}
          <div className="space-y-1">
            <span className="text-muted-foreground text-[10px]">Status Breakdown</span>
            <div className="h-2 rounded-full bg-muted overflow-hidden flex">
              {totalEnvs > 0 && runningEnvs > 0 && (
                <div className="bg-emerald-500 h-full rounded-l-full transition-all" style={{ width: `${(runningEnvs / totalEnvs) * 100}%` }} />
              )}
              {totalEnvs > 0 && totalEnvs - runningEnvs > 0 && (
                <div className="bg-red-400 h-full rounded-r-full transition-all" style={{ width: `${((totalEnvs - runningEnvs) / totalEnvs) * 100}%` }} />
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Running ({runningEnvs})</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Stopped ({totalEnvs - runningEnvs})</span>
            </div>
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

// ======================== PROJECT QUICK PREVIEW HOVER CARD ========================

function ProjectQuickPreview({
  project, children
}: {
  project: Project
  children: React.ReactNode
}) {
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
        <div className="p-3 border-b bg-gradient-to-r from-emerald-50/50 via-teal-50/30 to-transparent dark:from-emerald-950/30 dark:via-teal-950/20 dark:to-transparent">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
              <IconComp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
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
              <span className="text-xs text-muted-foreground">{runningEnvs}/{totalEnvs} running</span>
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
            <span>Updated {formatTimeAgo(project.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-1.5 pt-1">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
              <Play className="h-3 w-3" />Start
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-[11px] font-medium ring-1 ring-red-200/50 dark:ring-red-800/30">
              <Square className="h-3 w-3" />Stop
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/50 text-muted-foreground text-[11px] font-medium ring-1 ring-border/30">
              <ExternalLink className="h-3 w-3" />Open
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
    <span className="text-[10px] text-muted-foreground dark:text-gray-400 font-mono tabular-nums">
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

function AnimatedStatusDot({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' }) {
  const dotSize = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2'
  if (status === 'running') {
    return (
      <span className={`relative inline-flex ${dotSize}`}>
        {/* Outer pulse ring */}
        <motion.span
          className={`absolute inset-0 rounded-full bg-emerald-400/40`}
          animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 2, ease: 'easeInOut', repeat: Infinity }}
        />
        {/* Inner dot */}
        <motion.span
          className={`relative rounded-full bg-emerald-500 ${dotSize}`}
          animate={{ scale: [1, 1.15, 1], opacity: [1, 0.85, 1] }}
          transition={{ duration: 2, ease: 'easeInOut', repeat: Infinity }}
        />
      </span>
    )
  }
  // Stopped / offline — static dot, no animation
  return <span className={`inline-block rounded-full bg-red-400 ${dotSize}`} />
}

// ======================== SORTABLE PROJECT CARD ========================

function SortableProjectCard({
  project, viewMode, searchQuery, onSelect, onEdit, onDelete,
  onEnvAction, onRebuildConfirm, selected, onToggleSelect, rebuilding,
  starred, onToggleStar, lanIp, currentHost, index = 0,
  batchMode = false, onDuplicate, onMoveToDevice, devices, onHover,
  focused = false, cardDensity = 'comfortable', onCompare, pinOrder, onReanalyze
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
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const [expanded, setExpanded] = React.useState(false)
  const needsExpand = (project.environments || []).length > 3 || (project.description && project.description.length > 120)
  const style = {
    transform: isDragging
      ? `${CSS.Transform.toString(transform)} rotate(2deg) scale(1.02)`
      : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
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
  const statusBorderAccent = status === 'running' ? 'border-l-2 border-l-emerald-500 dark:border-l-emerald-400' : status === 'mixed' ? 'border-l-2 border-l-amber-500 dark:border-l-amber-400' : 'border-l-2 border-l-red-400 dark:border-l-red-500'
  const isRemote = !!(project.deviceId && project.deviceName)
  const deviceOnline = project.deviceStatus === 'online'

  const envLabel = (name: string) => name === 'development' ? 'dev' : name === 'production' ? 'prod' : name

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

  const densityClass = cardDensity === 'compact' ? 'p-2.5' : cardDensity === 'spacious' ? 'p-5' : 'p-3.5'
  const densityListClass = cardDensity === 'compact' ? 'p-2 gap-2' : cardDensity === 'spacious' ? 'p-5 gap-4' : 'p-3.5 gap-3'

  if (viewMode === 'list') {
    return (
      <div ref={setNodeRef} style={style} data-project-index={index} className={isDragging ? 'z-50 shadow-xl' : ''} onMouseEnter={() => onHover?.(project.id)} onMouseLeave={() => onHover?.(null)}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ delay: index * 0.05, duration: 0.35, ease: 'easeOut' }}
          whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}
          tabIndex={0}
          className={`group flex items-center ${densityListClass} rounded-lg border bg-card dark:bg-zinc-900/80 shadow-sm dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:shadow-md dark:hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] hover:bg-accent/50 dark:hover:bg-zinc-800/50 transition-all duration-200 cursor-pointer overflow-hidden border-border/60 dark:border-zinc-700/50 ${statusBorderAccent} ${focused ? 'ring-2 ring-emerald-500/50 shadow-md' : ''} ${statusChanged ? 'ring-2 ring-amber-400/50 animate-pulse' : ''} ${status === 'running' ? 'hover:border-emerald-300 dark:hover:border-emerald-700' : status === 'mixed' ? 'hover:border-amber-300 dark:hover:border-amber-700' : 'hover:border-red-300 dark:hover:border-red-700'}`}
          onClick={() => onSelect(project)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(project) } }}
        >
          <div {...attributes} {...listeners} data-dnd-drag-handle className="cursor-grab active:cursor-grabbing p-1.5 rounded hover:bg-muted/60 transition-colors group-hover:animate-pulse group-hover:shadow-sm" onClick={(e) => e.stopPropagation()} title="Drag to reorder">
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
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`shrink-0 cursor-pointer transition-colors hover:scale-110 active:scale-90 transition-transform duration-150 ${starred ? 'text-rose-500' : 'text-muted-foreground hover:text-rose-400'}`}>
            {starred ? <Pin className="h-4 w-4 fill-rose-500" /> : <Star className="h-4 w-4" />}
          </button>
          {starred && pinOrder != null && <span className="text-[8px] min-w-[14px] text-center px-0.5 py-0 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 font-bold tracking-wide shrink-0">#{pinOrder}</span>}
          <IconComp className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{highlightText(project.name, searchQuery)}</span>
              {isRemote && (
                <span className={`shrink-0 inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0 rounded-full font-medium ${deviceOnline ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-300/50 dark:ring-emerald-700/50' : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400 ring-1 ring-red-300/50 dark:ring-red-700/50'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${deviceOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  {project.deviceName}
                </span>
              )}
              <Badge variant={status === 'running' ? 'default' : 'secondary'} className={`text-xs font-medium shrink-0 ${status === 'running' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 animate-pulse' : 'text-foreground dark:text-zinc-200'}`}>
                <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : 'bg-red-400'} mr-1`} />
                {runningEnvs}/{totalEnvs} running
              </Badge>
              {project.name === 'Hermes Web' && <HermesBridgeToggle />}
            </div>
            <button type="button" className="text-xs text-muted-foreground dark:text-gray-400 truncate text-left cursor-pointer hover:text-foreground dark:hover:text-gray-200 transition-colors hover:underline decoration-dotted underline-offset-2" title={`${project.path} — Click to copy`} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(project.path); addToast({ title: 'Path copied', description: project.path, variant: 'success' }) }}>{highlightText(project.path, searchQuery)}</button>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 flex-wrap justify-end max-w-[200px]">
            {tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className={`text-[10px] px-1.5 cursor-default transition-transform duration-150 hover:scale-105 ${getTagColor(tag)}`}>{tag}</Badge>
            ))}
          </div>
          {/* List view: per-environment controls */}
          <div className="hidden md:flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            {(project.environments || []).slice(0, 3).map((env) => (
              <div key={env.id} className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted/30 transition-colors ${env.status === 'running' ? 'bg-emerald-50/30 dark:bg-emerald-900/5 animate-pulse-glow-emerald border-l-2 border-l-emerald-400 dark:border-l-emerald-500' : 'bg-muted/20 border-l-2 border-l-red-300 dark:border-l-red-400'}`}
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
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer text-amber-500 dark:text-amber-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={`Restart ${envLabel(env.name)}`}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Restart {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {env.name !== 'development' && (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-teal-50 dark:hover:bg-teal-900/20 cursor-pointer text-teal-500 dark:text-teal-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={`Rebuild ${envLabel(env.name)}`}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Rebuild {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
                {/* Start/Stop at rightmost position */}
                {env.status === 'running' ? (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer transition-all active:scale-90 shrink-0 ml-0.5" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={`Stop ${envLabel(env.name)}`}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Stop {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                ) : (
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-all active:scale-90 shrink-0 ml-0.5" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={`Start ${envLabel(env.name)}`}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Start {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                )}
              </div>
            ))}
            {(project.environments || []).length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{(project.environments || []).length - 3}</span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <div onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }} className={`cursor-pointer rounded-full transition-all hover:ring-2 hover:ring-emerald-300 dark:hover:ring-emerald-600 ${health > 0 && health < 50 ? 'animate-pulse ring-2 ring-red-400/50' : ''}`}>
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
                className="inline-flex items-center justify-center rounded-md h-7 px-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer gap-1 text-emerald-600 dark:text-emerald-400 transition-all hover:scale-105 active:scale-95"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">Open</span>
              </a></TooltipTrigger><TooltipContent>Open project in browser</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Re-fetch Environments — surfaced prominently when the project
                has no environments and is stranded in an unstartable state.
                Skipped for remote projects (analyze runs on the host machine). */}
            {totalEnvs === 0 && onReanalyze && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-amber-500 hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => onReanalyze(project)}>
                <RefreshCw className="h-3 w-3" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Re-fetch Env</span>
              </button></TooltipTrigger><TooltipContent>Detect dev/prod environments from package.json</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button. Hidden when
                there are zero environments (the Re-fetch button above takes that slot). */}
            {(project.environments || []).some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 border border-red-200 dark:border-red-800/50 bg-white dark:bg-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer gap-1.5 text-red-600 dark:text-red-400 transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => { (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Stop All</span>
              </button></TooltipTrigger><TooltipContent>Stop all running environments</TooltipContent></Tooltip></TooltipProvider>
            ) : totalEnvs > 0 ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => { (project.environments || []).filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Start All</span>
              </button></TooltipTrigger><TooltipContent>Start all stopped environments</TooltipContent></Tooltip></TooltipProvider>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent dark:hover:bg-white/10 cursor-pointer transition-colors"><MoreVertical className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />View Details</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate(project.id)} className="px-2.5 py-2 text-sm rounded-md"><Copy className="h-3.5 w-3.5 mr-2.5" />Duplicate</DropdownMenuItem>
                {!project.deviceId && onMoveToDevice && (
                  <DropdownMenuItem onClick={() => onMoveToDevice(project)} className="px-2.5 py-2 text-sm rounded-md"><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />Move to Device</DropdownMenuItem>
                )}
                {onReanalyze && (
                  <DropdownMenuItem onClick={() => onReanalyze(project)} className="px-2.5 py-2 text-sm rounded-md"><RefreshCw className="h-3.5 w-3.5 mr-2.5" />Re-fetch Environments</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {(project.environments || []).some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />Copy Proxy URL</DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => { (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />Restart All</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRebuildConfirm(project)} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />Rebuild All</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[180px] p-1.5 text-sm">
            {(project.environments || []).some((e) => e.status === 'running') && (
              <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) window.open(getOpenUrl(port), '_blank') }}><ExternalLink className="h-3.5 w-3.5 mr-2.5" />Open in Browser</ContextMenuItem>
            )}
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onSelect(project)}><Eye className="h-3.5 w-3.5 mr-2.5" />View Details</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onEdit(project)}><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onDuplicate(project.id)}><Copy className="h-3.5 w-3.5 mr-2.5" />Duplicate</ContextMenuItem>
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onToggleStar(project.id)}>{starred ? <><PinOff className="h-3.5 w-3.5 mr-2.5" />Unpin</> : <><Pin className="h-3.5 w-3.5 mr-2.5" />Pin to Top</>}</ContextMenuItem>
            {(project.environments || []).every((e) => e.status !== 'running') && (
              <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'start')) }}><Play className="h-3.5 w-3.5 mr-2.5" />Start All Environments</ContextMenuItem>
            )}
            {(project.environments || []).some((e) => e.status === 'running') && (
              <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}><Square className="h-3.5 w-3.5 mr-2.5" />Stop All Environments</ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onCompare?.(project)}><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />Compare</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" className="px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  return (
    <ProjectQuickPreview project={project}>
    <div ref={setNodeRef} style={style} data-project-index={index} onClick={() => onSelect(project)} className={isDragging ? 'z-50 shadow-xl' : ''} onMouseEnter={() => onHover?.(project.id)} onMouseLeave={() => onHover?.(null)}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ delay: index * 0.05, duration: 0.4, ease: 'easeOut' }}
        whileHover={{ y: -2 }}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(project) } }}
        className={`group relative flex flex-col ${densityClass} rounded-xl border bg-card dark:bg-zinc-900/80 shadow-md dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] hover:shadow-xl dark:hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-all duration-200 cursor-pointer overflow-hidden border-border/60 dark:border-zinc-700/50 ${statusBorderAccent} card-shimmer h-full ${focused ? 'ring-2 ring-emerald-500/50 shadow-xl' : ''} ${statusChanged ? 'ring-2 ring-amber-400/50 animate-pulse' : ''} ${status === 'running' ? 'hover:border-emerald-300 dark:hover:border-emerald-700' : status === 'mixed' ? 'hover:border-amber-300 dark:hover:border-amber-700' : 'hover:border-red-300 dark:hover:border-red-700'}`}
        onMouseEnter={(e) => {
          const tagColors: Record<string, string> = { Frontend: 'rgba(16,185,129,0.25)', Backend: 'rgba(20,184,166,0.25)', Fullstack: 'rgba(6,182,212,0.25)', DevOps: 'rgba(245,158,11,0.25)', Mobile: 'rgba(244,63,94,0.25)', API: 'rgba(139,92,246,0.25)', Database: 'rgba(249,115,22,0.25)', 'ML/AI': 'rgba(236,72,153,0.25)', Automation: 'rgba(100,116,139,0.25)' }
          const primaryTag = tags[0]
          const glowColor = primaryTag ? (tagColors[primaryTag] || 'rgba(16,185,129,0.2)') : 'rgba(16,185,129,0.2)'
          ;(e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px ${glowColor}`
        }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}
      >

        <div className="absolute top-2 left-2 z-10 flex gap-1 items-start" onClick={(e) => e.stopPropagation()}>
          <div {...attributes} {...listeners} data-dnd-drag-handle className="cursor-grab active:cursor-grabbing p-1.5 rounded-md bg-muted/80 hover:bg-muted border border-transparent hover:border-dashed hover:border-muted-foreground/30 transition-all duration-150 group-hover:animate-pulse group-hover:shadow-sm" title="Drag to reorder">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
          {batchMode && (
            <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(project.id)} className="bg-muted/80 rounded" />
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
                <div className="flex items-center gap-1.5 min-w-0">
                  <CardTitle className="text-[15px] font-extrabold truncate tracking-tight dark:text-zinc-100 leading-tight">{highlightText(project.name, searchQuery)}</CardTitle>
                  {isRemote && (
                    <span className={`shrink-0 inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0 rounded-full font-medium ${deviceOnline ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-300/50 dark:ring-emerald-700/50' : 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400 ring-1 ring-red-300/50 dark:ring-red-700/50'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${deviceOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {project.deviceName}
                    </span>
                  )}
                </div>
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
              <div className="flex items-center gap-0.5">
                <div onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }} className={`cursor-pointer rounded-full transition-all hover:ring-2 hover:ring-emerald-300 dark:hover:ring-emerald-600 ${health > 0 && health < 50 ? 'animate-pulse ring-2 ring-red-400/50' : ''}`}>
                  <HealthScoreHoverCard score={health} size={28} runningEnvs={runningEnvs} totalEnvs={totalEnvs} updatedAt={project.updatedAt} />
                </div>
                <HealthTrendIcon trend={healthTrend} />
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); onToggleStar(project.id) }} className={`cursor-pointer transition-all duration-200 hover:scale-110 active:scale-90 ml-0.5 ${starred ? 'text-rose-500' : 'text-muted-foreground hover:text-rose-400'}`}>
                {starred ? <Pin className="h-3 w-3 fill-rose-500" /> : <Star className="h-3 w-3" />}
              </button>
              {starred && pinOrder != null && <span className="text-[7px] min-w-[12px] text-center px-0.5 py-0 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 font-bold tracking-wider shrink-0">#{pinOrder}</span>}
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-5 sm:px-6 pb-4 flex-1">
          {project.description && (
            <p className={`text-[13px] text-muted-foreground/80 dark:text-zinc-300 mb-2.5 leading-relaxed ${!expanded && project.description && project.description.length > 120 ? 'line-clamp-2' : ''}`}>{highlightText(project.description, searchQuery)}</p>
          )}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className={`text-[10px] px-2 py-0.5 rounded-md cursor-default transition-transform duration-150 hover:scale-105 ${getTagColor(tag)}`}>{tag}</Badge>
            ))}
          </div>
          <div className="space-y-2">
            {(project.environments || []).slice(0, 3).map((env, envIdx) => (
              <div key={env.id} className={`flex items-center justify-between text-xs group/env min-w-0 gap-1.5 rounded-lg px-2 sm:px-2.5 py-2 sm:py-2.5 hover:bg-muted/30 dark:hover:bg-white/5 transition-all duration-150 ${env.status === 'running' ? 'bg-emerald-50/30 dark:bg-emerald-900/5 animate-pulse-glow-emerald border-l-2 border-l-emerald-400 dark:border-l-emerald-500' : 'bg-muted/20 border-l-2 border-l-red-300 dark:border-l-red-400'} ${envIdx < Math.min((project.environments || []).length, 3) - 1 ? 'border-b border-border/20 dark:border-zinc-700/20 pb-2 sm:pb-3' : ''}`}
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
                  <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="text-muted-foreground dark:text-zinc-400 font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-muted/40 dark:bg-white/5 hover:bg-muted/60 dark:hover:bg-white/10 cursor-pointer transition-colors ring-1 ring-border/20 dark:ring-white/10 min-w-[30px] text-center" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(env.port)); addToast({ title: 'Port copied', description: `Port ${env.port}`, variant: 'success' }) }} title="Click to copy port">:{env.port}</button></TooltipTrigger><TooltipContent>Click to copy port</TooltipContent></Tooltip></TooltipProvider>
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
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer text-amber-500 dark:text-amber-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={`Restart ${envLabel(env.name)}`}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Restart {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}
                  {env.name !== 'development' && (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-teal-50 dark:hover:bg-teal-900/20 cursor-pointer text-teal-500 dark:text-teal-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={`Rebuild ${envLabel(env.name)}`}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Rebuild {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}

                  {/* Start/Stop at rightmost position */}
                  {env.status === 'running' ? (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={`Stop ${envLabel(env.name)}`}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Stop {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  ) : (
                    <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={`Start ${envLabel(env.name)}`}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Start {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                  )}
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
                      <div key={env.id} className={`flex items-center justify-between text-xs group/env min-w-0 gap-1.5 rounded-lg px-2 sm:px-2.5 py-2 sm:py-2.5 hover:bg-muted/30 dark:hover:bg-white/5 transition-all duration-150 ${env.status === 'running' ? 'bg-emerald-50/30 dark:bg-emerald-900/5 animate-pulse-glow-emerald border-l-2 border-l-emerald-400 dark:border-l-emerald-500' : 'bg-muted/20 border-l-2 border-l-red-300 dark:border-l-red-400'} ${envIdx < (project.environments || []).length - 3 - 1 ? 'border-b border-border/20 dark:border-zinc-700/20 pb-2 sm:pb-3' : ''}`}
                        title={`${envLabel(env.name)} — port :${env.port} — ${env.status}${env.pid ? ` — PID ${env.pid}` : ''}`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0 shrink">
                          <AnimatedStatusDot status={env.status} />
                          {env.name === 'development' ? <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 font-semibold ring-1 ring-cyan-300/60 dark:ring-cyan-700/50">dev</span> : env.name === 'production' ? <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-semibold ring-1 ring-amber-300/60 dark:ring-amber-700/50">prod</span> : <span className="text-muted-foreground dark:text-gray-300 truncate max-w-[60px] text-[10px]">{envLabel(env.name)}</span>}
                          {env.name === 'development' && env.status === 'running' && <span className="shrink-0 text-[8px] px-1 py-0 rounded bg-emerald-100/60 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 font-medium tracking-wide" title="Hot Module Replacement — auto-reloads on file changes">HMR</span>}
                          {env.name === 'production' && <span className="shrink-0 text-[8px] px-1 py-0 rounded bg-amber-100/60 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400 font-medium tracking-wide" title="Production build — requires rebuild to apply changes">Build</span>}
                        </div>
                        <div className="flex items-center gap-1 sm:gap-1 shrink-0">
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="text-muted-foreground dark:text-zinc-400 font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-muted/40 dark:bg-white/5 hover:bg-muted/60 dark:hover:bg-white/10 cursor-pointer transition-colors ring-1 ring-border/20 dark:ring-white/10 min-w-[30px] text-center" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(env.port)); addToast({ title: 'Port copied', description: `Port ${env.port}`, variant: 'success' }) }} title="Click to copy port">:{env.port}</button></TooltipTrigger><TooltipContent>Click to copy port</TooltipContent></Tooltip></TooltipProvider>
                          {env.status === 'running' && (
                            <a href={getOpenUrl(env.port)} target="_blank" rel="noopener noreferrer" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-emerald-500 dark:text-emerald-400 transition-colors" onClick={(e) => e.stopPropagation()} title={`Open ${envLabel(env.name)} (${env.port})`}>
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                          {env.status === 'running' && (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer text-amber-500 dark:text-amber-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'restart') }} title={`Restart ${envLabel(env.name)}`}><RotateCw className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Restart {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                          {env.name !== 'development' && (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="hidden sm:inline-flex items-center justify-center rounded-md h-5 w-5 hover:bg-teal-50 dark:hover:bg-teal-900/20 cursor-pointer text-teal-500 dark:text-teal-400 transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'rebuild') }} title={`Rebuild ${envLabel(env.name)}`}><Hammer className="h-2.5 w-2.5" /></button></TooltipTrigger><TooltipContent>Rebuild {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                          {env.status === 'running' ? (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'stop') }} title={`Stop ${envLabel(env.name)}`}><Square className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Stop {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                          ) : (
                            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-5 w-5 sm:h-5 sm:w-5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-all active:scale-90 shrink-0" onClick={(e) => { e.stopPropagation(); onEnvAction(project.id, env.id, 'start') }} title={`Start ${envLabel(env.name)}`}><Play className="h-2.5 w-2.5 fill-current" /></button></TooltipTrigger><TooltipContent>Start {envLabel(env.name)}</TooltipContent></Tooltip></TooltipProvider>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {!expanded && (project.environments || []).length > 3 && (
              <p className="text-[10px] text-muted-foreground">+{(project.environments || []).length - 3} more</p>
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
            <Badge variant="outline" className={`text-[11px] font-medium px-2.5 py-0.5 ${status === 'running' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-900/10' : status === 'mixed' ? 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300 bg-amber-50/50 dark:bg-amber-900/10' : 'border-red-300 text-red-700 dark:border-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-900/10'} ${runningEnvs > 0 ? 'env-running-badge' : ''}`}>
              <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'mixed' ? 'bg-amber-500' : 'bg-red-400'} mr-1`} />
              {runningEnvs}/{totalEnvs} running
            </Badge>
            {project.name === 'Hermes Web' && <HermesBridgeToggle />}
            <span className="text-[10px] text-muted-foreground dark:text-gray-400 hidden sm:inline" title={new Date(project.createdAt).toLocaleString()}>{formatTimeAgo(project.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {(project.environments || []).some((e) => e.status === 'running') && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><a
                href={getOpenUrl((project.environments || []).find((e) => e.status === 'running')?.port || (project.environments || [])[0]?.port || 3000)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md h-7 px-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer gap-1 text-emerald-600 dark:text-emerald-400 transition-all hover:scale-105 active:scale-95"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                <span className="text-[11px] font-medium hidden sm:inline">Open</span>
              </a></TooltipTrigger><TooltipContent>Open project in browser</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Re-fetch Environments — surfaced prominently when the project
                has no environments and is stranded in an unstartable state.
                Skipped for remote projects (analyze runs on the host machine). */}
            {totalEnvs === 0 && onReanalyze && (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-amber-500 hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => onReanalyze(project)}>
                <RefreshCw className="h-3 w-3" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Re-fetch Env</span>
              </button></TooltipTrigger><TooltipContent>Detect dev/prod environments from package.json</TooltipContent></Tooltip></TooltipProvider>
            )}

            {/* Start All / Stop All - prominent rightmost button. Hidden when
                there are zero environments (the Re-fetch button above takes that slot). */}
            {(project.environments || []).some((e) => e.status === 'running') ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 border border-red-200 dark:border-red-800/50 bg-white dark:bg-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer gap-1.5 text-red-600 dark:text-red-400 transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => { (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}>
                <Square className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Stop All</span>
              </button></TooltipTrigger><TooltipContent>Stop all running environments</TooltipContent></Tooltip></TooltipProvider>
            ) : totalEnvs > 0 ? (
              <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-lg h-7 px-2.5 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-700 cursor-pointer gap-1.5 text-white transition-all hover:scale-105 active:scale-95 shadow-sm font-medium" onClick={() => { (project.environments || []).filter((e) => e.status !== 'running').forEach((env) => onEnvAction(project.id, env.id, 'start')) }}>
                <Play className="h-3 w-3 fill-current" />
                <span className="text-[11px] hidden sm:inline whitespace-nowrap">Start All</span>
              </button></TooltipTrigger><TooltipContent>Start all stopped environments</TooltipContent></Tooltip></TooltipProvider>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent dark:hover:bg-white/10 cursor-pointer transition-colors"><MoreVertical className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => onEdit(project)} className="px-2.5 py-2 text-sm rounded-md"><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSelect(project)} className="px-2.5 py-2 text-sm rounded-md"><Eye className="h-3.5 w-3.5 mr-2.5" />View Details</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate(project.id)} className="px-2.5 py-2 text-sm rounded-md"><Copy className="h-3.5 w-3.5 mr-2.5" />Duplicate</DropdownMenuItem>
                {!project.deviceId && onMoveToDevice && (
                  <DropdownMenuItem onClick={() => onMoveToDevice(project)} className="px-2.5 py-2 text-sm rounded-md"><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />Move to Device</DropdownMenuItem>
                )}
                {onReanalyze && (
                  <DropdownMenuItem onClick={() => onReanalyze(project)} className="px-2.5 py-2 text-sm rounded-md"><RefreshCw className="h-3.5 w-3.5 mr-2.5" />Re-fetch Environments</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {(project.environments || []).some((e) => e.status === 'running') && (
                  <DropdownMenuItem onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) navigator.clipboard.writeText(`${window.location.origin}/api/proxy/${port}/`) }} className="px-2.5 py-2 text-sm rounded-md"><Link2 className="h-3.5 w-3.5 mr-2.5" />Copy Proxy URL</DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => { (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'restart')) }} className="px-2.5 py-2 text-sm rounded-md"><RotateCw className="h-3.5 w-3.5 mr-2.5" />Restart All</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRebuildConfirm(project)} className="px-2.5 py-2 text-sm rounded-md"><Hammer className="h-3.5 w-3.5 mr-2.5" />Rebuild All</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Status-based hover gradient overlay */}
        <div className={`absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none ${
          status === 'running' ? 'bg-gradient-to-t from-emerald-500/[0.06] via-transparent to-emerald-500/[0.02] dark:from-emerald-500/[0.08] dark:via-transparent dark:to-emerald-500/[0.03]'
          : status === 'mixed' ? 'bg-gradient-to-t from-amber-500/[0.06] via-transparent to-amber-500/[0.02] dark:from-amber-500/[0.08] dark:via-transparent dark:to-amber-500/[0.03]'
          : 'bg-gradient-to-t from-red-500/[0.06] via-transparent to-red-500/[0.02] dark:from-red-500/[0.08] dark:via-transparent dark:to-red-500/[0.03]'
        }`} />
        {/* Subtle border glow on hover with accent color */}
        <div className={`absolute inset-0 rounded-xl border-2 border-transparent transition-all duration-300 pointer-events-none ${
          status === 'running' ? 'group-hover:border-emerald-300/50 dark:group-hover:border-emerald-500/30 group-hover:shadow-[0_0_12px_rgba(16,185,129,0.15)]'
          : status === 'mixed' ? 'group-hover:border-amber-300/50 dark:group-hover:border-amber-500/30 group-hover:shadow-[0_0_12px_rgba(245,158,11,0.15)]'
          : 'group-hover:border-red-300/50 dark:group-hover:border-red-500/30 group-hover:shadow-[0_0_12px_rgba(239,68,68,0.15)]'
        }`} />
      </motion.div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[220px] p-1.5 text-sm">
          {/* Actions section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Actions</div>
          {(project.environments || []).some((e) => e.status === 'running') && (
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { const port = (project.environments || []).find((e) => e.status === 'running')?.port; if (port) window.open(getOpenUrl(port), '_blank') }}><ExternalLink className="h-3.5 w-3.5 mr-2.5" />Open in Browser <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">Enter</kbd></ContextMenuItem>
          )}
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onSelect(project)}><Eye className="h-3.5 w-3.5 mr-2.5" />View Details <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">Enter</kbd></ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onEdit(project)}><Edit3 className="h-3.5 w-3.5 mr-2.5" />Edit Project <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">e</kbd></ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onToggleStar(project.id)}>{starred ? <><PinOff className="h-3.5 w-3.5 mr-2.5" />Unpin</> : <><Pin className="h-3.5 w-3.5 mr-2.5" />Pin to Top</>}</ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onDuplicate?.(project.id)}><Copy className="h-3.5 w-3.5 mr-2.5" />Duplicate Project</ContextMenuItem>
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { navigator.clipboard.writeText(project.path); addToast({ title: 'Path copied', variant: 'success' }) }}><Clipboard className="h-3.5 w-3.5 mr-2.5" />Copy Path</ContextMenuItem>
          <ContextMenuSeparator />
          {/* Environment section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Environment</div>
          {(project.environments || []).every((e) => e.status !== 'running') && (
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { (project.environments || []).forEach((env) => onEnvAction(project.id, env.id, 'start')) }}><Play className="h-3.5 w-3.5 mr-2.5" />Start All Environments <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">s</kbd></ContextMenuItem>
          )}
          {(project.environments || []).some((e) => e.status === 'running') && (
            <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => { (project.environments || []).filter((e) => e.status === 'running').forEach((env) => onEnvAction(project.id, env.id, 'stop')) }}><Square className="h-3.5 w-3.5 mr-2.5" />Stop All Environments <kbd className="ml-auto text-[9px] text-muted-foreground bg-muted px-1 rounded">x</kbd></ContextMenuItem>
          )}
          <ContextMenuItem className="px-2.5 py-2 text-sm rounded-md hover:bg-accent transition-colors" onClick={() => onCompare?.(project)}><ArrowRightLeft className="h-3.5 w-3.5 mr-2.5" />Compare</ContextMenuItem>
          <ContextMenuSeparator />
          {/* Dangerous section */}
          <div className="px-2 py-1 text-[9px] font-semibold text-red-500/60 uppercase tracking-wider">Dangerous</div>
          <ContextMenuItem variant="destructive" className="px-2.5 py-2 text-sm rounded-md" onClick={() => onDelete(project)}><Trash2 className="h-3.5 w-3.5 mr-2.5" />Delete Project <kbd className="ml-auto text-[9px] text-red-400/60 bg-red-50 dark:bg-red-900/20 px-1 rounded">Del</kbd></ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
    </ProjectQuickPreview>
  )
}

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
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Focus input when dialog opens (key on parent resets this component)
  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  const commands = [
    { id: 'add', label: 'Add New Project', icon: Plus, category: 'Actions', action: onAddProject, shortcut: '⌘N' },
    { id: 'refresh', label: 'Refresh Data', icon: RefreshCw, category: 'Actions', action: onRefresh, shortcut: '⌘⇧R' },
    { id: 'toggle-view', label: 'Toggle Grid/List View', icon: LayoutGrid, category: 'Actions', action: onToggleView, shortcut: 'G G/L' },
    { id: 'gateway', label: 'Open Gateway Monitor', icon: Server, category: 'Actions', action: () => {}, shortcut: '' },
    { id: 'llm', label: 'Configure LLM Settings', icon: Bot, category: 'Actions', action: () => {}, shortcut: '' },
    { id: 'device-mgmt', label: 'Go to Device Management', icon: Monitor, category: 'Actions', action: onOpenDeviceManagement, shortcut: '⌘D' },
  ]

  const projectItems = projects.map((p) => ({
    id: `project-${p.id}`,
    label: p.name,
    icon: Folder,
    category: 'Projects',
    action: () => onSelectProject(p),
  }))

  const deviceItems = [
    ...devices.map((d) => [
      {
        id: `device-health-${d.id}`,
        label: `Check Health: ${d.name}`,
        icon: Activity,
        category: 'Devices',
        action: () => {
          fetch(`http://${d.ip}:${d.port}/api/agent/health`, {
            headers: { 'Authorization': `Bearer ${d.apiKey}` },
          })
            .then((r) => addToast({ title: `${d.name} is ${r.ok ? 'online' : 'offline'}`, variant: r.ok ? 'success' : 'destructive' }))
            .catch(() => addToast({ title: `${d.name} is unreachable`, variant: 'destructive' }))
        },
      },
      {
        id: `device-filter-${d.id}`,
        label: `Filter by ${d.name}`,
        icon: Filter,
        category: 'Devices',
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
  const shortcuts = [
    { keys: '⌘/Ctrl + K', description: 'Focus search' },
    { keys: '⌘/Ctrl + N', description: 'Add new project' },
    { keys: '⌘/Ctrl + Shift + A', description: 'Add new project (global)' },
    { keys: '⌘/Ctrl + Shift + R', description: 'Refresh data' },
    { keys: '⌘/Ctrl + P', description: 'Command palette' },
    { keys: '⌘/Ctrl + D', description: 'Device management' },
    { keys: 'G then G', description: 'Grid view' },
    { keys: 'G then L', description: 'List view' },
    { keys: '↑ / ↓', description: 'Navigate between project cards' },
    { keys: 'Home / End', description: 'First / last project card' },
    { keys: 'Enter', description: 'Open project details (on hover/focus)' },
    { keys: 'e', description: 'Edit project (on hover)' },
    { keys: 's', description: 'Start all envs (on hover)' },
    { keys: 'x', description: 'Stop all envs (on hover)' },
    { keys: 'Delete', description: 'Delete project (on hover)' },
    { keys: 'Escape', description: 'Close dialog / sheet' },
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
      <DialogContent className="sm:max-w-md flex flex-col p-0 max-h-[calc(100vh-2rem)] gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>{mode === 'add' ? 'Add New Project' : 'Edit Project'}</DialogTitle>
          <DialogDescription>{mode === 'add' ? 'Create a new project to manage.' : 'Update project details.'}</DialogDescription>
        </DialogHeader>
        <form id="project-form" onSubmit={handleSubmit} className="space-y-3 px-6 pb-6 overflow-y-auto flex-1 min-h-0">
          {/* Templates - only shown when adding a new project */}
          {mode === 'add' && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5"><LayoutTemplate className="h-3.5 w-3.5" />Templates</Label>
              <div className="grid grid-cols-5 gap-1.5">
                {([
                  { label: 'Web App', icon: Globe, tpl: { name: 'Web App', icon: 'globe', tags: ['Frontend', 'Fullstack'], description: 'Modern web application' } },
                  { label: 'API Server', icon: Server, tpl: { name: 'API Server', icon: 'server', tags: ['Backend', 'API'], description: 'RESTful API server' } },
                  { label: 'ML Project', icon: CpuIcon, tpl: { name: 'ML Project', icon: 'cpu', tags: ['ML/AI', 'Backend'], description: 'Machine learning project' } },
                  { label: 'Mobile App', icon: Smartphone, tpl: { name: 'Mobile App', icon: 'smartphone', tags: ['Mobile', 'Fullstack'], description: 'Cross-platform mobile application' } },
                  { label: 'DevOps', icon: Terminal, tpl: { name: 'DevOps', icon: 'terminal', tags: ['DevOps', 'Automation'], description: 'DevOps automation pipeline' } },
                ] as const).map(({ label, icon: TplIcon, tpl }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => { setName(tpl.name); setIcon(tpl.icon); setSelectedTags(tpl.tags); setDescription(tpl.description) }}
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
          <div className="space-y-1">
            <Label>Device</Label>
            <Select value={selectedDeviceId ?? 'local'} onValueChange={(v) => setSelectedDeviceId(v === 'local' ? null : v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="This machine (local)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">This machine (local)</SelectItem>
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
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="project-form" disabled={!name.trim() || !path.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleSubmit}>
            {mode === 'add' ? 'Create' : 'Update'}
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
  const [status, setStatus] = React.useState<GatewayStatus | null>(null)
  const [networkInfo, setNetworkInfo] = React.useState<{ hostname: string; platform: string; arch: string; cpus: number } | null>(null)
  const [loading, setLoading] = React.useState(false)

  const fetchStatus = React.useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, netRes] = await Promise.all([
        fetch('/api/gateway/status'),
        fetch('/api/network-info'),
      ])
      if (statusRes.ok) setStatus(await statusRes.json())
      if (netRes.ok) setNetworkInfo(await netRes.json())
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
      <DialogContent className="sm:max-w-xl max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-emerald-600" />
            System Resource Monitor
          </DialogTitle>
          <DialogDescription>Real-time system resource monitoring. Auto-refreshes every 10 seconds.</DialogDescription>
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
                  <span className="text-sm font-semibold">CPU Usage</span>
                </div>
                <div className="flex items-center justify-center">
                  <CircularGauge value={status.cpuUsage.percentage} size={88} label="CPU" color={cpuColor(status.cpuUsage.percentage)} />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between"><span>Cores</span><span className="font-medium text-foreground">{status.cpuUsage.cores}</span></div>
                  <div className="flex justify-between"><span>Load Avg</span><span className="font-medium text-foreground font-mono">{status.cpuUsage.loadAverage.map((l) => l.toFixed(2)).join(', ')}</span></div>
                </div>
              </div>
              <div className="p-4 rounded-xl border bg-gradient-to-br from-teal-50/50 to-cyan-50/30 dark:from-teal-950/20 dark:to-cyan-950/10">
                <div className="flex items-center gap-2 mb-3">
                  <MemoryStick className="h-4 w-4 text-teal-500" />
                  <span className="text-sm font-semibold">Memory Usage</span>
                </div>
                <div className="flex items-center justify-center">
                  <CircularGauge value={status.memoryUsage.percentage} size={88} label="Memory" color={memColor(status.memoryUsage.percentage)} />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between"><span>Used / Total</span><span className="font-medium text-foreground">{status.memoryUsage.used}MB / {status.memoryUsage.total}MB</span></div>
                  <div className="flex justify-between"><span>Process RSS</span><span className="font-medium text-foreground">{status.processMemory?.rss ?? '—'} MB</span></div>
                </div>
              </div>
            </div>

            {/* Network info */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-cyan-50/50 to-sky-50/30 dark:from-cyan-950/20 dark:to-sky-950/10">
              <div className="flex items-center gap-2 mb-3">
                <Wifi className="h-4 w-4 text-cyan-500" />
                <span className="text-sm font-semibold">Network</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Hostname</span><span className="font-medium">{networkInfo?.hostname ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Platform</span><span className="font-medium">{networkInfo?.platform ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Architecture</span><span className="font-medium">{networkInfo?.arch ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Gateway</span><span className="font-medium">:{status.gatewayPort}</span></div>
              </div>
            </div>

            {/* Uptime */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-emerald-50/50 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold">Uptime</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Gateway</span><span className="font-medium">{status.uptime}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">System</span><span className="font-medium">{status.systemUptime}</span></div>
              </div>
            </div>

            {/* Disk Usage (real data from df) */}
            <div className="p-4 rounded-xl border bg-gradient-to-br from-violet-50/50 to-purple-50/30 dark:from-violet-950/20 dark:to-purple-950/10">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="h-4 w-4 text-violet-500" />
                <span className="text-sm font-semibold">Disk Usage</span>
              </div>
              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Usage</span>
                    <span className="font-medium">{status.diskUsage?.percentage ?? 0}%</span>
                  </div>
                  <Progress value={status.diskUsage?.percentage ?? 0} className="h-2" />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Used: {status.diskUsage?.used ?? 0}MB / {status.diskUsage?.total ?? 0}MB</span>
                  <span>Free: {status.diskUsage?.free ?? 0}MB</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={fetchStatus}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
              <span className="text-[10px] text-muted-foreground">Last checked: {formatTimeAgo(status.lastChecked)}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">Failed to load system status.</div>
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

// ======================== ENHANCED ACTIVITY TIMELINE ========================

function ActivityTimeline({ activity }: { activity: ActivityEvent[] }) {
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
      { label: 'Just now', events: [] },
      { label: 'Today', events: [] },
      { label: 'Yesterday', events: [] },
      { label: 'Earlier', events: [] },
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
  }, [filteredActivity])

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
    { key: 'all', label: 'All' },
    { key: 'deploys', label: 'Deploys' },
    { key: 'startstop', label: 'Start/Stop' },
    { key: 'errors', label: 'Errors' },
  ]

  if (activity.length === 0) {
    return <div className="text-center py-8 text-muted-foreground text-sm">No activity recorded yet.</div>
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
        <span className="text-[10px] text-muted-foreground ml-auto">{filteredActivity.length} events</span>
      </div>

      {/* Grouped timeline */}
      <div className="relative">
        <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-emerald-500/50 to-teal-500/50" />
        <div className="space-y-4">
          {groupedActivity.map((group) => (
            <div key={group.label}>
              <div className="relative pl-10 mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground dark:text-zinc-500">{group.label}</span>
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
                          <p className="text-[10px] text-muted-foreground">{formatTimeAgo(event.timestamp)}</p>
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
  // Deployment history state (Session 14)
  const [deployments, setDeployments] = React.useState<Deployment[]>(() => {
    try { return JSON.parse(localStorage.getItem(`deployments-${project?.id}`) || '[]') } catch { return [] }
  })
  const [deploying, setDeploying] = React.useState(false)
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
        toast({ title: 'Tags updated', variant: 'success' })
        setEditingTags(false)
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: 'Failed to update tags', description: err.error || 'Server error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to update tags', variant: 'destructive' })
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
        toast({ title: 'Description updated', variant: 'success' })
        setEditingDescription(false)
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: 'Failed to update description', description: err.error || 'Server error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to update description', variant: 'destructive' })
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
      addToast({ title: 'Notes saved', variant: 'success' })
    } catch {
      addToast({ title: 'Failed to save notes', variant: 'destructive' })
    }
    setSavingNotes(false)
  }, [notesDraft, project])

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
        toast({ title: 'Environment variables saved', variant: 'success' })
        setEditingEnvVars(null)
        // Refresh the project data so the detail sheet shows updated env vars
        onRefresh?.()
      } else {
        const err = await res.json()
        toast({ title: 'Failed to save env vars', description: err.error || 'Server error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to save env vars', variant: 'destructive' })
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
        <SheetHeader className="px-4 pt-4 pb-2 border-b shrink-0 bg-gradient-to-r from-emerald-50/50 via-teal-50/30 to-transparent dark:from-emerald-950/30 dark:via-teal-950/20 dark:to-transparent">
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
              <TabsTrigger value="deployments" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-rose-50 data-[state=active]:text-rose-700 dark:data-[state=active]:bg-rose-900/30 dark:data-[state=active]:text-rose-300 rounded-full transition-colors">Deployments</TabsTrigger>
              <TabsTrigger value="timeline" className="px-3 pb-1.5 pt-1 text-xs data-[state=active]:shadow-none data-[state=active]:bg-cyan-50 data-[state=active]:text-cyan-700 dark:data-[state=active]:bg-cyan-900/30 dark:data-[state=active]:text-cyan-300 rounded-full transition-colors">Timeline</TabsTrigger>
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
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1">Description</h4>
                <div className="flex-1" />
                {!editingDescription && !descCollapsed && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEditingDescription() }}>
                    <Edit3 className="h-2.5 w-2.5 mr-0.5" />Edit
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
                          placeholder="Add a description..."
                          className="text-sm min-h-[80px] resize-none"
                          autoFocus
                        />
                        <div className="flex items-center gap-1.5 justify-end">
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingDescription(false)} disabled={savingDesc}>Cancel</Button>
                          <Button size="sm" className="h-6 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveDescription} disabled={savingDesc}>
                            {savingDesc && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      project.description ? (
                        <p className="text-sm">{project.description}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No description</p>
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
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Device</h4>
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
                              {project.deviceStatus === 'online' ? 'Online' : 'Offline'}
                            </Badge>
                          </div>
                          {(() => {
                            const device = devices?.find((d) => d.id === project.deviceId)
                            if (!device) return null
                            return (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground pl-5">
                                <span>IP:Port</span>
                                <span className="font-mono text-foreground dark:text-zinc-200">{device.ip}:{device.port}</span>
                                <span>Last Seen</span>
                                <span className="font-mono text-foreground dark:text-zinc-200">{device.lastSeen ? formatTimeAgo(device.lastSeen) : 'Never'}</span>
                              </div>
                            )
                          })()}
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => { onOpenDeviceManagement?.(); onClose() }}>
                              <ExternalLink className="h-2.5 w-2.5 mr-0.5" />Go to Device
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <span className="text-sm font-medium">💻 This Machine</span>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300">Local</Badge>
                          </div>
                          {localNetworkInfo && (
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground pl-6">
                              <span>Hostname</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.hostname}</span>
                              <span>Platform</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.platform} {localNetworkInfo.arch}</span>
                              <span>CPU Cores</span><span className="font-mono text-foreground dark:text-zinc-200">{localNetworkInfo.cpus}</span>
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
              <div
                role="button"
                tabIndex={0}
                className="flex items-center gap-2 w-full text-left cursor-pointer rounded-md hover:bg-muted/30 transition-colors px-1 -mx-1"
                onClick={() => setTagsCollapsed(!tagsCollapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTagsCollapsed(!tagsCollapsed) } }}
              >
                <div className="h-1 w-3 rounded-full bg-emerald-500" />
                <h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">
                  Tags{tagsCollapsed && tags.length > 0 ? ` (${tags.length})` : ''}
                </h4>
                <div className="flex-1" />
                {!editingTags && !tagsCollapsed && (
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEditingTags() }}>
                    <Edit3 className="h-2.5 w-2.5 mr-0.5" />Edit
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
                          {tagDraft.length === 0 && <span className="text-xs text-muted-foreground italic">No tags selected</span>}
                        </div>
                        <Popover open={tagSearchOpen} onOpenChange={setTagSearchOpen}>
                          <PopoverTrigger render={<Button variant="outline" size="sm" className="h-6 text-[10px] w-full justify-start" />}>
                            <Tag className="h-2.5 w-2.5 mr-1" />Add tag...
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="start">
                            <Input
                              placeholder="Search tags..."
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
                                <p className="text-[10px] text-muted-foreground text-center py-2">No more tags available</p>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                        <div className="flex items-center gap-1.5 justify-end">
                          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingTags(false)} disabled={savingTags}>Cancel</Button>
                          <Button size="sm" className="h-6 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveTags} disabled={savingTags}>
                            {savingTags && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {tags.length > 0 ? tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className={`cursor-default ${getTagColor(tag)}`}>{tag}</Badge>
                        )) : <span className="text-xs text-muted-foreground">No tags</span>}
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
                  <h4 className="text-sm font-semibold">Notes</h4>
                </div>
                <div className="flex items-center gap-2">
                  {projectNotes && (
                    <Badge variant="secondary" className="text-[9px] bg-amber-100/60 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                      {projectNotes.length} chars
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
                        placeholder="Add notes, annotations, or reminders for this project..."
                        className="min-h-[80px] text-xs resize-y"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">{notesDraft.length} characters</span>
                        <div className="flex gap-1.5">
                          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => { setNotesDraft(projectNotes); setEditingNotes(false) }}>Cancel</Button>
                          <Button size="sm" className="h-6 text-[10px] bg-amber-600 hover:bg-amber-700 text-white" onClick={handleSaveNotes} disabled={savingNotes}>
                            {savingNotes && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
                            Save Notes
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
                  <p className="text-[10px] text-muted-foreground/60 italic">No notes yet. Click to add.</p>
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
                  Environments Summary{envSummaryCollapsed && envs.length > 0 ? ` (${envs.length})` : ''}
                </h4>
                <div className="flex-1" />
                {!envSummaryCollapsed && (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { const ports = envs.map((e) => String(e.port)).join(', '); navigator.clipboard.writeText(ports); toast({ title: 'Ports copied', description: ports, variant: 'success' }) }}
                      title="Copy all ports"
                    ><Copy className="h-2.5 w-2.5" />Copy All Ports</button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { envs.filter((e) => e.status === 'running').forEach((env) => { let url: string; if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1' && !currentHost.startsWith('192.168.') && !currentHost.startsWith('10.') && !/^172\.(1[6-9]|2\d|3[01])\./.test(currentHost)) { url = `/api/proxy/${env.port}/` } else { const host = currentHost || 'localhost'; url = `http://${host}:${env.port}` } window.open(url, '_blank') }) }}
                      title="Open all running URLs"
                    ><ExternalLink className="h-2.5 w-2.5" />Open All Running</button>
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
                      {envs.length === 0 && <span className="text-xs text-muted-foreground">No environments</span>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Access URLs Section */}
            {envs.some((e) => e.status === 'running') && (
              <div>
                <div className="flex items-center gap-2"><div className="h-1 w-3 rounded-full bg-emerald-500" /><h4 className="text-xs font-semibold text-muted-foreground dark:text-zinc-200 mb-1.5">Access URLs</h4></div>
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
                      <Play className="h-3 w-3 mr-1 text-emerald-500" />Start All Stopped ({envs.filter((e) => e.status !== 'running').length})
                    </Button>
                  )}
                  {envs.filter((e) => e.status === 'running').length > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { envs.filter((e) => e.status === 'running').forEach((e) => onEnvAction(project.id, e.id, 'stop')) }}>
                      <Square className="h-3 w-3 mr-1 text-red-500" />Stop All Running ({envs.filter((e) => e.status === 'running').length})
                    </Button>
                  )}
                  {envs.some((e) => e.status === 'running') && (
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { envs.forEach((e) => { if (e.status === 'running') onEnvAction(project.id, e.id, 'restart') }) }}>
                      <RotateCw className="h-3 w-3 mr-1 text-amber-500" />Restart All ({envs.filter((e) => e.status === 'running').length})
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => { const ports = envs.map((e) => `:${e.port}`).join(', '); navigator.clipboard.writeText(ports); toast({ title: 'Ports copied', description: ports, variant: 'success' }) }}>
                    <Copy className="h-3 w-3 mr-1 text-teal-500" />Copy All Ports
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
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-red-500" onClick={() => onEnvAction(project.id, env.id, 'stop')}><Square className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>Stop</TooltipContent></Tooltip></TooltipProvider>
                          <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-amber-500" onClick={() => onEnvAction(project.id, env.id, 'restart')}><RotateCw className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>Restart</TooltipContent></Tooltip></TooltipProvider>
                        </>
                      ) : (
                        <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-emerald-500" onClick={() => onEnvAction(project.id, env.id, 'start')}><Play className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>Start</TooltipContent></Tooltip></TooltipProvider>
                      )}
                      {env.name !== 'development' && (
                        <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent dark:hover:bg-white/10 cursor-pointer text-teal-500" onClick={() => onEnvAction(project.id, env.id, 'rebuild')}><Hammer className="h-3 w-3" /></button></TooltipTrigger><TooltipContent>Rebuild</TooltipContent></Tooltip></TooltipProvider>
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
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-xs text-muted-foreground">Environment Variables</div>
                          {editingEnvVars !== env.id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 text-[10px] px-1.5 gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                              onClick={() => startEditingEnvVars(env.id, env.envVars)}
                            >
                              <Edit3 className="h-2.5 w-2.5" />
                              Edit
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
                                Cancel
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 text-[10px] px-1.5 gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                                onClick={() => saveEnvVars(env.id)}
                                disabled={savingEnvVars}
                              >
                                {savingEnvVars ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
                                Save
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
                              <div className="text-xs text-muted-foreground text-center py-1">No variables — add one below</div>
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
                            )) : <span className="text-xs text-muted-foreground">No environment variables set</span>}
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
            {envs.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm mb-3">No environments yet</p>
                {project && onReanalyze && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => onReanalyze(project)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Detect environments
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
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                    return (
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">{filtered.length} logs</Badge>
                    )
                  })()}
                  <div className="flex-1" />
                  <div className="relative">
                    <Search className="h-3 w-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={logSearchQuery}
                      onChange={(e) => setLogSearchQuery(e.target.value)}
                      placeholder="Search logs..."
                      className="h-6 text-[10px] pl-6 w-32"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground">Auto-scroll</span>
                    <Switch checked={logAutoScroll} onCheckedChange={setLogAutoScroll} className="scale-75" />
                  </div>
                  <TooltipProvider><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
                    const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                    const text = filtered.map((log) => `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.level.toUpperCase()}] ${log.source}: ${log.message}`).join('\n')
                    navigator.clipboard.writeText(text)
                    toast({ title: 'Logs copied', variant: 'success' })
                  }} />}><Copy className="h-3 w-3" /></TooltipTrigger><TooltipContent>Copy visible logs</TooltipContent></Tooltip></TooltipProvider>
                </div>
                {/* Log entries */}
                <div className="rounded-lg bg-zinc-950 dark:bg-zinc-950 border border-zinc-800 overflow-hidden shadow-inner">
                  <div ref={logContainerRef} className="max-h-80 overflow-y-auto font-mono text-[11px] leading-5 custom-scrollbar">
                    {(() => {
                      const filtered = logs.filter((log) => (logLevelFilter === 'all' || log.level === logLevelFilter) && (!logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())))
                      if (filtered.length === 0) {
                        return (
                          <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
                            <Filter className="h-6 w-6 mb-2 opacity-40" />
                            <p className="text-xs">No logs found</p>
                            {(logLevelFilter !== 'all' || logSearchQuery) && <p className="text-[10px] mt-1">Try adjusting your filters</p>}
                          </div>
                        )
                      }
                      return filtered.map((log, idx) => (
                        <div key={log.id} className={`flex gap-0 border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors ${log.level === 'error' ? 'bg-red-950/20' : log.level === 'warn' ? 'bg-amber-950/10' : ''}`}>
                          <span className="px-2 py-0.5 text-zinc-600 select-none shrink-0 text-right w-8 border-r border-zinc-800/50">{idx + 1}</span>
                          <span className="px-1.5 py-0.5 text-zinc-500 shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
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

          {/* ======================== DEPLOYMENTS TAB (Session 14) ======================== */}
          <TabsContent value="deployments" className="p-4 mt-0 overflow-y-auto flex-1 min-h-0">
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <div className="space-y-4">
                {/* Deploy button */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-rose-500" />
                    <span className="text-sm font-semibold">Deployment History</span>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{deployments.length}</Badge>
                  </div>
                  <Button
                    size="sm"
                    className="btn-micro-click bg-rose-500 hover:bg-rose-600 text-white h-7 text-xs"
                    disabled={deploying}
                    onClick={() => {
                      setDeploying(true)
                      const version = deployments.length > 0 ? Math.max(...deployments.map((d) => d.version)) + 1 : 1
                      const duration = `${(Math.random() * 30 + 5).toFixed(0)}s`
                      setTimeout(() => {
                        const success = Math.random() < 0.8
                        const newDeploy: Deployment = {
                          id: `dep_${Date.now()}`,
                          version,
                          timestamp: new Date().toISOString(),
                          status: success ? 'success' : 'failed',
                          duration,
                          deployedBy: Math.random() > 0.3 ? 'You' : 'Auto-deploy',
                        }
                        const next = [newDeploy, ...deployments]
                        setDeployments(next)
                        localStorage.setItem(`deployments-${project.id}`, JSON.stringify(next))
                        toast({ title: success ? 'Deployment successful' : 'Deployment failed', variant: success ? 'success' : 'destructive' })
                        setDeploying(false)
                      }, 2000)
                    }}
                  >
                    {deploying ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Deploying...</> : <><Upload className="h-3 w-3 mr-1" />Deploy</>}
                  </Button>
                </div>

                {/* Deployment timeline */}
                {deployments.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <GitBranch className="h-10 w-10 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">No deployments yet</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Click Deploy to create your first deployment</p>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {deployments.map((dep, idx) => (
                      <div key={dep.id} className="relative pl-8 pb-4">
                        {idx < deployments.length - 1 && <div className="deployment-timeline-line" />}
                        <div className={`absolute left-1.5 top-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ${
                          dep.status === 'success' ? 'bg-emerald-100 dark:bg-emerald-900/30 ring-emerald-300 dark:ring-emerald-700/50'
                          : dep.status === 'failed' ? 'bg-red-100 dark:bg-red-900/30 ring-red-300 dark:ring-red-700/50'
                          : 'bg-amber-100 dark:bg-amber-900/30 ring-amber-300 dark:ring-amber-700/50'
                        }`}>
                          {dep.status === 'success' ? <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                           : dep.status === 'failed' ? <XCircle className="h-3 w-3 text-red-600 dark:text-red-400" />
                           : <RotateCw className="h-3 w-3 text-amber-600 dark:text-amber-400 animate-spin" />}
                        </div>
                        <div className="rounded-lg border bg-muted/20 px-3 py-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold">v{dep.version}</span>
                              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
                                dep.status === 'success' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300'
                                : dep.status === 'failed' ? 'border-red-300 text-red-700 dark:border-red-600 dark:text-red-300'
                                : 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300'
                              }`}>{dep.status === 'rolling-back' ? 'Rolling Back' : dep.status}</Badge>
                            </div>
                            <div className="flex items-center gap-2">
                              {dep.status === 'success' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 text-[9px] text-amber-600 hover:text-amber-700 dark:text-amber-400 px-1.5 btn-micro-click"
                                  onClick={() => {
                                    const rollback: Deployment = {
                                      id: `dep_${Date.now()}`,
                                      version: dep.version,
                                      timestamp: new Date().toISOString(),
                                      status: 'rolling-back',
                                      duration: '-',
                                      deployedBy: 'You',
                                    }
                                    const next = [rollback, ...deployments]
                                    setDeployments(next)
                                    localStorage.setItem(`deployments-${project.id}`, JSON.stringify(next))
                                    toast({ title: 'Rollback initiated', variant: 'warning' })
                                  }}
                                >
                                  <RotateCw className="h-2.5 w-2.5 mr-0.5" />Rollback
                                </Button>
                              )}
                              <span className="text-[10px] text-muted-foreground">{formatTimeAgo(dep.timestamp)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                            <span className="flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />{dep.duration}</span>
                            <span className="flex items-center gap-0.5"><User className="h-2.5 w-2.5" />{dep.deployedBy}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
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

function getTimelineStatusLabel(oldStatus: string, newStatus: string): { text: string; className: string } {
  if (oldStatus === 'stopped' && newStatus === 'running') return { text: 'Started', className: 'text-emerald-600 dark:text-emerald-400' }
  if (oldStatus === 'running' && newStatus === 'stopped') return { text: 'Stopped', className: 'text-red-600 dark:text-red-400' }
  if (oldStatus === 'running' && newStatus === 'running') return { text: 'Restarted', className: 'text-amber-600 dark:text-amber-400' }
  return { text: `${oldStatus} → ${newStatus}`, className: 'text-muted-foreground' }
}

function ProjectStatusTimeline({ project }: { project: Project }) {
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
          <span className="text-sm font-semibold">Status Timeline</span>
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
            addToast({ title: 'Timeline refreshed', variant: 'success' })
          }}
        >
          <RefreshCw className="h-3 w-3 mr-1" />Regenerate
        </Button>
      </div>

      {timelineEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Clock className="h-10 w-10 text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground">No timeline events yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Events will appear when environments are started, stopped, or restarted</p>
        </div>
      ) : (
        <div className="relative pl-7 space-y-0">
          {/* Vertical line */}
          <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border/40 dark:bg-zinc-700/40" />
          {timelineEvents.map((event, idx) => {
            const label = getTimelineStatusLabel(event.oldStatus, event.newStatus)
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
                    <span className="text-[10px] text-muted-foreground shrink-0">{formatTimeAgo(event.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground/70">
                    <span className="flex items-center gap-0.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${event.oldStatus === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      {event.oldStatus}
                    </span>
                    <span>→</span>
                    <span className="flex items-center gap-0.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${event.newStatus === 'running' ? 'bg-emerald-500' : 'bg-red-400'}`} />
                      {event.newStatus}
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

function EnhancedFooter({ projects, filteredCount, onOpenDevices, devices, onOpenSystemMonitor, onRefresh, onAddProject }: { projects: Project[]; filteredCount: number; onOpenDevices: () => void; devices: Device[]; onOpenSystemMonitor: () => void; onRefresh?: () => void; onAddProject?: () => void }) {
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
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-gradient-to-r from-background/95 via-background/98 to-background/95 backdrop-blur-2xl shadow-[0_-4px_20px_rgba(0,0,0,0.08)] dark:from-zinc-900/98 dark:via-zinc-900/95 dark:to-zinc-900/98 dark:border-t dark:border-zinc-800/60"
    >
      <div className="px-4 py-2.5 flex items-center justify-between text-xs text-foreground/80 dark:text-zinc-300">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1.5">
            {/* Animated pulse dot when envs running */}
            <span className="relative flex h-2 w-2">
              {runningEnvs > 0 && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${runningEnvs > 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
            </span>
            <span className="font-bold dark:text-zinc-200">{runningEnvs}/{totalEnvs}</span>
            <span className="text-muted-foreground dark:text-zinc-400">running</span>
          </span>
          {/* Mini health bar */}
          <div className="hidden sm:flex items-center gap-1.5">
            <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${healthRatio >= 80 ? 'bg-emerald-500' : healthRatio >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${healthRatio}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground">{healthRatio}%</span>
          </div>
          <span className="text-muted-foreground dark:text-zinc-500 hidden sm:inline">·</span>
          <span className="dark:text-zinc-300 font-medium">{projects.length} projects</span>
          {filteredCount !== projects.length && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Showing {filteredCount}/{projects.length}</span>
          )}
          <span className="text-muted-foreground dark:text-zinc-500 hidden sm:inline">·</span>
          <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground dark:text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${totalDevices === 0 ? 'bg-zinc-400' : onlineDevices > 0 ? 'bg-emerald-500' : 'bg-red-400'}`} />
            {onlineDevices}/{totalDevices + 1} devices online
          </span>
          <span className="text-muted-foreground dark:text-zinc-500 hidden sm:inline">·</span>
          <span className="hidden sm:inline text-[11px] text-muted-foreground dark:text-zinc-400">Last updated: {lastRefreshAgo}s ago</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Network status indicator */}
          <span className={`hidden md:inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${isOnline ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400'}`}>
            <Wifi className="h-2.5 w-2.5" />
            {isOnline ? 'Connected' : 'Offline'}
          </span>
          {/* Current time */}
          <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground dark:text-zinc-400 tabular-nums">
            <Clock className="h-2.5 w-2.5" />
            {currentTime ?? '--:--'}
          </span>
          {/* Keyboard shortcut hints */}
          <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-muted-foreground dark:text-zinc-500">
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">⌘K</kbd>
            <span>Search</span>
            <span className="mx-0.5">·</span>
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">?</kbd>
            <span>Shortcuts</span>
            <span className="mx-0.5">·</span>
            <kbd className="px-1 py-0.5 rounded bg-muted/60 dark:bg-zinc-800/60 border border-border/30 dark:border-zinc-700/30 font-mono">↑↓</kbd>
            <span>Navigate</span>
          </div>
          {/* Quick action buttons */}
          {onRefresh && (
            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all active:scale-90" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent>Refresh</TooltipContent></Tooltip></TooltipProvider>
          )}
          {onAddProject && (
            <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent dark:hover:bg-white/10 text-muted-foreground hover:text-foreground transition-all active:scale-90" onClick={onAddProject}><Plus className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent>Add Project</TooltipContent></Tooltip></TooltipProvider>
          )}
          <button className="flex items-center gap-1.5 hover:text-foreground transition-all px-3 py-1.5 rounded-md bg-gradient-to-r from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/15 text-teal-700 dark:text-teal-400 hover:from-teal-100 hover:to-cyan-100 dark:hover:from-teal-900/30 dark:hover:to-cyan-900/20 font-medium ring-1 ring-teal-200/50 dark:ring-teal-800/30 hover:scale-105 active:scale-95" onClick={onOpenDevices}>
            <Plug className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">Devices</span>
            {totalDevices > 0 && (
              <span className="text-[9px] px-1 py-0 rounded-full bg-teal-200/60 dark:bg-teal-800/40 text-teal-700 dark:text-teal-300 font-semibold">{onlineDevices}/{totalDevices}</span>
            )}
          </button>
          <button className="flex items-center gap-1.5 hover:text-foreground transition-all px-3 py-1.5 rounded-md bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/15 text-emerald-700 dark:text-emerald-400 hover:from-emerald-100 hover:to-teal-100 dark:hover:from-emerald-900/30 dark:hover:to-teal-900/20 font-medium ring-1 ring-emerald-200/50 dark:ring-emerald-800/30 hover:scale-105 active:scale-95" onClick={onOpenSystemMonitor}>
            <Monitor className="h-3.5 w-3.5" />
            <span className="font-medium text-xs">System</span>
          </button>
        </div>
      </div>
    </motion.footer>
  )
}

// ======================== DEVICE MANAGEMENT PANEL ========================

function DeviceManagementPanel({
  open, onClose, devices, onAdd, onEdit, onDelete, onHealthCheck, onOpenDeployGuide
}: {
  open: boolean
  onClose: () => void
  devices: Device[]
  onAdd: () => void
  onEdit: (device: Device) => void
  onDelete: (id: string) => void
  onHealthCheck: (id: string) => Promise<{ status: string } | null>
  onOpenDeployGuide: () => void
}) {
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
              <SheetTitle>Device Management</SheetTitle>
              <SheetDescription className="text-xs">Manage connected devices and remote agents</SheetDescription>
            </div>
            <Button size="sm" variant="outline" onClick={onOpenDeployGuide} className="h-7 text-xs border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20">
              <Download className="h-3 w-3 mr-1" />Deploy Agent
            </Button>
            <Button size="sm" onClick={onAdd} className="bg-teal-600 hover:bg-teal-700 text-white h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" />Add Device
            </Button>
          </div>
        </SheetHeader>

        {/* Device Stats Bar */}
        {devices.length > 0 && (
          <div className="px-4 py-3 border-b bg-muted/20 dark:bg-zinc-800/20">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-lg font-bold dark:text-zinc-100">{devices.length}</div>
                <div className="text-[10px] text-muted-foreground dark:text-zinc-400 font-medium">Total</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{onlineCount}</div>
                <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/60 font-medium">Online</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-red-500 dark:text-red-400">{offlineCount}</div>
                <div className="text-[10px] text-red-500/70 dark:text-red-400/60 font-medium">Offline</div>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-6 rounded-2xl bg-gradient-to-br from-teal-50/80 to-cyan-50/60 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/30 dark:ring-teal-800/20 shadow-inner mb-4">
                <Plug className="h-12 w-12 text-teal-600/70 dark:text-teal-400/60" />
              </div>
              <h3 className="text-sm font-semibold mb-1">No devices registered</h3>
              <p className="text-xs text-muted-foreground dark:text-gray-400 mb-4 max-w-xs">Add a remote device to monitor and manage projects on other machines.</p>
              <div className="flex items-center gap-2">
                <Button onClick={onAdd} size="sm" className="bg-teal-600 hover:bg-teal-700 text-white">
                  <Plus className="h-3 w-3 mr-1" />Add Device
                </Button>
                <Button onClick={onOpenDeployGuide} size="sm" variant="outline" className="border-teal-300 text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-400 dark:hover:bg-teal-900/20">
                  <Download className="h-3 w-3 mr-1" />Deploy Agent
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
                  <AnimatedStatusDot status={device.status === 'online' ? 'running' : 'stopped'} size="md" />
                  <span className="font-medium text-sm truncate">{device.name}</span>
                  <Badge variant="outline" className={`text-[9px] ml-auto shrink-0 ${device.status === 'online' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20' : device.status === 'error' ? 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20' : 'border-red-300 text-red-600 dark:border-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'}`}>
                    {device.status === 'online' ? 'Online' : device.status === 'error' ? 'Error' : 'Offline'}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Globe className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-muted-foreground dark:text-zinc-400">{device.ip}:{device.port}</span>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-muted dark:hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
                      onClick={() => { navigator.clipboard.writeText(`${device.ip}:${device.port}`); addToast({ title: 'Copied', description: `${device.ip}:${device.port}`, variant: 'success' }) }}
                      title="Copy IP:Port"
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Folder className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground dark:text-zinc-400">{device.projectCount ?? 0} projects</span>
                    {device.projectCount !== undefined && device.projectCount > 0 && (
                      <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5 bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{device.projectCount}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 col-span-2">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground dark:text-zinc-400">Last seen: {device.lastSeen ? formatTimeAgo(device.lastSeen) : 'Never'}</span>
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
                      ? `✓ Connected in ${testResults[device.id]!.latency}ms`
                      : `✗ Unreachable (${testResults[device.id]!.latency}ms timeout)`
                    }
                  </motion.div>
                )}
                <div className="flex items-center gap-1.5 pt-1">
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => onEdit(device)}>
                    <Edit3 className="h-3 w-3 mr-1" />Edit
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => handleTestConnection(device)} disabled={testingIds.has(device.id)}>
                    {testingIds.has(device.id) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}
                    Test
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => handleHealthCheck(device.id)} disabled={healthCheckingIds.has(device.id)}>
                    {healthCheckingIds.has(device.id) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Activity className="h-3 w-3 mr-1" />}
                    Health
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:bg-red-50 dark:hover:bg-red-900/20 px-2" />}>
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
  onSubmit: (data: { name: string; ip: string; port: number; apiKey: string; icon?: string }) => void
  device?: Device | null
  mode: 'add' | 'edit'
}) {
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
    { key: 'monitor',     Icon: Monitor,     label: 'Desktop' },
    { key: 'server',      Icon: Server,      label: 'Server' },
    { key: 'smartphone',  Icon: Smartphone,  label: 'Mobile' },
    { key: 'cloud',       Icon: Cloud,       label: 'Cloud' },
    { key: 'container',   Icon: Container,   label: 'Container' },
    { key: 'wrench',      Icon: Wrench,      label: 'Workstation' },
    { key: 'zap',         Icon: Zap,         label: 'Fast' },
    { key: 'building',    Icon: Building,    label: 'Office' },
    { key: 'home',        Icon: House,       label: 'Home' },
    { key: 'globe',       Icon: Globe,       label: 'Network' },
    { key: 'database',    Icon: Database,    label: 'Database' },
    { key: 'cpu',         Icon: CpuIcon,     label: 'Hardware' },
    { key: 'plug-zap',    Icon: PlugZap,     label: 'Connected' },
    { key: 'shield',      Icon: Shield,      label: 'Secure' },
    { key: 'box',         Icon: Box,         label: 'Generic' },
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
          <DialogTitle>{mode === 'add' ? 'Add Device' : 'Edit Device'}</DialogTitle>
          <DialogDescription>{mode === 'add' ? 'Register a remote device to monitor and manage its projects.' : 'Update device connection settings.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label>Device Icon</Label>
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
            <Label htmlFor="device-name">Name *</Label>
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
            <Label htmlFor="device-ip">IP Address *</Label>
            <Input id="device-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-port">Port</Label>
            <Input id="device-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3100" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="device-apikey">API Key</Label>
            <div className="relative">
              <Input
                id="device-apikey"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Auto-generated if empty"
                className="pr-10 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                title={showApiKey ? 'Hide API key' : 'Show API key'}
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                aria-pressed={showApiKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
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

function ProjectCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card dark:bg-zinc-900/80 overflow-hidden border-border/60 dark:border-zinc-700/50 border-l-2 border-l-zinc-300 dark:border-l-zinc-600 relative skeleton-card">
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
      <div className="h-px bg-border/30 dark:bg-zinc-700/30" />
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
  )
}

function LoadingSkeleton({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3.5 rounded-lg border bg-card dark:bg-zinc-900/80 relative overflow-hidden">
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
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <motion.div
        className="p-8 rounded-2xl bg-gradient-to-br from-emerald-50/80 via-teal-50/40 to-cyan-50/60 dark:from-emerald-900/20 dark:via-teal-900/10 dark:to-cyan-900/15 ring-1 ring-emerald-200/30 dark:ring-emerald-800/20 shadow-inner mb-6"
        animate={{ y: [0, -12, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
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
  const [viewMode, setViewMode] = React.useState<ViewMode>(() => {
    try { const v = localStorage.getItem('dashboard-viewMode'); return v === 'grid' || v === 'list' ? v : 'grid' } catch { return 'grid' }
  })
  const [sortBy, setSortBy] = React.useState<SortOption>(() => {
    try { const v = localStorage.getItem('dashboard-sortBy'); return v === 'newest' || v === 'name' || v === 'status' || v === 'custom' ? v : 'custom' } catch { return 'custom' }
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
  const [gatewayOpen, setGatewayOpen] = React.useState(false)
  const [systemMonitorOpen, setSystemMonitorOpen] = React.useState(false)
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
  const [welcomeDismissed, setWelcomeDismissed] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-welcome-dismissed') === 'true' } catch { return false }
  })
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
    try { const v = localStorage.getItem('dashboard-card-density'); return v === 'compact' || v === 'spacious' ? v : 'comfortable' } catch { return 'comfortable' }
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
  const [healthBannerExpanded, setHealthBannerExpanded] = React.useState(false)
  const [projectCountHistory, setProjectCountHistory] = React.useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem('project-count-history') || '[]') } catch { return [] }
  })
  const [runningEnvsHistory, setRunningEnvsHistory] = React.useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem('running-envs-history') || '[]') } catch { return [] }
  })
  const [analyticsPeriod, setAnalyticsPeriod] = React.useState<'1h' | '6h' | '24h'>('1h')
  const [analyticsVisible, setAnalyticsVisible] = React.useState<boolean>(() => {
    try { return localStorage.getItem('dashboard-analytics-visible') !== 'false' } catch { return true }
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
  React.useEffect(() => { localStorage.setItem('dashboard-selectedDeviceId', selectedDeviceId ?? 'null') }, [selectedDeviceId])
  React.useEffect(() => { localStorage.setItem('dashboard-groupBy', groupBy) }, [groupBy])
  React.useEffect(() => { localStorage.setItem('dashboard-health-alert-threshold', String(healthAlertThreshold)) }, [healthAlertThreshold])
  React.useEffect(() => { localStorage.setItem('dashboard-health-alert-enabled', String(healthAlertEnabled)) }, [healthAlertEnabled])
  React.useEffect(() => { localStorage.setItem('dashboard-card-density', cardDensity) }, [cardDensity])
  React.useEffect(() => { localStorage.setItem('dashboard-visible-stats', JSON.stringify([...visibleStats])) }, [visibleStats])
  React.useEffect(() => { localStorage.setItem('dashboard-quicklaunch-visible', String(quickLaunchBarVisible)) }, [quickLaunchBarVisible])
  React.useEffect(() => { localStorage.setItem('dashboard-activity-feed-visible', String(activityFeedVisible)) }, [activityFeedVisible])
  React.useEffect(() => { localStorage.setItem('dashboard-analytics-visible', String(analyticsVisible)) }, [analyticsVisible])

  const { toast } = useToast()

  // Ref to track whether a reorder POST is in flight — used to pause
  // auto-refresh from overwriting local drag order with stale DB data.
  const reorderInFlightRef = React.useRef(false)

  // Data fetching
  const fetchProjects = React.useCallback(async () => {
    // If a reorder POST is in flight, skip this auto-refresh cycle so we
    // don't overwrite the locally-reordered state with stale DB data.
    if (reorderInFlightRef.current) return
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
    // fetchGlobalActivity will be triggered by the projects-changed effect below
    setLoading(false)
  }, [fetchProjects, fetchNotifications, fetchDevices])

  // Initial load
  React.useEffect(() => {
    const id = requestAnimationFrame(() => { loadData() })
    return () => cancelAnimationFrame(id)
  }, []) // Initial load only

  // Fetch global activity when projects change (but not on initial empty state)
  React.useEffect(() => {
    if (projects.length > 0) {
      fetchGlobalActivity()
    }
  }, [projects, fetchGlobalActivity])

  // Auto-refresh every 5 seconds to keep status up-to-date
  React.useEffect(() => {
    const interval = setInterval(() => {
      fetchProjects()
    }, 5000)
    return () => clearInterval(interval)
  }, [fetchProjects])

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
    const pollDeviceHealth = async () => {
      for (const device of devices) {
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
          setDevices((prev) => prev.map((d) =>
            d.id === device.id
              ? { ...d, status: isOnline ? 'online' : 'offline', lastSeen: isOnline ? new Date().toISOString() : d.lastSeen }
              : d
          ))
          // Generate notification for status changes
          if (prevStatus && prevStatus !== (isOnline ? 'online' : 'offline')) {
            addAutoNotification(
              isOnline ? 'success' : 'error',
              isOnline ? 'Device Online' : 'Device Offline',
              `${device.name} (${device.ip}:${device.port}) is now ${isOnline ? 'online' : 'unreachable'}.`
            )
          }
        } catch {
          const prevStatus = prevDeviceStatusRef.current[device.id]
          setDevices((prev) => prev.map((d) =>
            d.id === device.id ? { ...d, status: 'offline' } : d
          ))
          if (prevStatus && prevStatus === 'online') {
            addAutoNotification(
              'error',
              'Device Offline',
              `${device.name} (${device.ip}:${device.port}) is now unreachable.`
            )
          }
        }
      }
    }
    pollDeviceHealth()
    const interval = setInterval(pollDeviceHealth, 30000)
    return () => clearInterval(interval)
  }, [devices.length, addAutoNotification])

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
      groups.push({ tagName: 'Untagged', tagColor: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400', projects: untagged })
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
        const next = [...prev, dashboardStats.healthScore].slice(-20)
        localStorage.setItem('health-score-history', JSON.stringify(next))
        return next
      })
    }
    pushScore()
    const id = setInterval(pushScore, 30000)
    return () => clearInterval(id)
  }, [dashboardStats.healthScore])

  // Project count and running envs history (Session 14)
  React.useEffect(() => {
    const pushHistory = () => {
      setProjectCountHistory((prev) => {
        const next = [...prev, dashboardStats.totalProjects].slice(-20)
        localStorage.setItem('project-count-history', JSON.stringify(next))
        return next
      })
      setRunningEnvsHistory((prev) => {
        const next = [...prev, dashboardStats.runningEnvs].slice(-20)
        localStorage.setItem('running-envs-history', JSON.stringify(next))
        return next
      })
    }
    pushHistory()
    const id = setInterval(pushHistory, 30000)
    return () => clearInterval(id)
  }, [dashboardStats.totalProjects, dashboardStats.runningEnvs])

  // Health alert: toast when health drops below threshold (Session 14: replaced per-project spam with banner)
  const prevHealthScoreRef = React.useRef(dashboardStats.healthScore)
  React.useEffect(() => {
    if (!healthAlertEnabled) return
    if (prevHealthScoreRef.current > healthAlertThreshold && dashboardStats.healthScore <= healthAlertThreshold && prevHealthScoreRef.current !== dashboardStats.healthScore) {
      toast({
        title: '⚠️ Health Alert',
        description: `System health dropped to ${dashboardStats.healthScore}% (threshold: ${healthAlertThreshold}%)`,
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
          toast({ title: 'Project created', variant: 'success' })
          addAutoNotification('success', 'Project Created', `Project "${data.name}" has been created successfully.`, data.name)

          // Auto-analyze local projects to detect environments (dev/prod)
          if (newProjectId && !data.deviceId) {
            toast({ title: 'Analyzing project...', description: 'Detecting startup commands and environments.' })
            try {
              const analyzeRes = await fetch(`/api/projects/${newProjectId}/analyze`, { method: 'POST' })
              if (analyzeRes.ok) {
                toast({ title: 'Analysis complete', description: 'Dev and production environments have been configured.', variant: 'success' })
              }
            } catch {
              // Non-blocking: project was created even if analysis fails
            }
          }

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
        } else {
          const err = await res.json()
          toast({ title: 'Failed to update project', description: err.error, variant: 'destructive' })
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
        addAutoNotification('warning', 'Project Deleted', `A project has been deleted.`, undefined)
        fetchProjects()
        setDeleteProject(null)
        if (selectedProject?.id === id) { setSelectedProject(null); setDetailOpen(false) }
      } else {
        toast({ title: 'Failed to delete project', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to delete', variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject])

  const handleDuplicateProject = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, { method: 'POST' })
      if (res.ok) {
        toast({ title: 'Project duplicated', variant: 'success' })
        fetchProjects()
      } else {
        const err = await res.json()
        toast({ title: 'Failed to duplicate project', description: err.error || 'Server error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to duplicate project', variant: 'destructive' })
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
        toast({ title: 'Device not found', description: 'Cannot locate the remote device for this project.', variant: 'destructive' })
        return
      }
      toast({ title: `${action} environments...`, description: `${project.name} — analyzing on ${device.name}` })
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
            title: hasExistingEnvs ? 'Environments replaced' : 'Environments detected',
            description: envCount > 0
              ? `Created ${envCount} environment${envCount === 1 ? '' : 's'}: ${result.data.project.environments.map((e: { name: string; port: number }) => `${e.name} (:${e.port})`).join(', ')}`
              : 'No environments were generated — check that the project has package.json or similar manifest.',
            variant: 'success',
          })
          fetchProjects()
        } else {
          toast({ title: 'Re-fetch failed', description: result.data?.error || `Agent returned ${result.status}`, variant: 'destructive' })
        }
      } catch (e: any) {
        toast({ title: 'Re-fetch failed', description: e?.message || 'Network error', variant: 'destructive' })
      }
    } else {
      // Local project → LLM analyze
      toast({ title: `${action} environments...`, description: `${project.name} — analyzing package.json` })
      try {
        const res = await fetch(`/api/projects/${project.id}/analyze?replace=true`, { method: 'POST' })
        if (res.ok) {
          const data = await res.json()
          const envCount = data.analysis?.environments?.length ?? 0
          toast({
            title: hasExistingEnvs ? 'Environments replaced' : 'Environments detected',
            description: envCount > 0
              ? `Created ${envCount} environment${envCount === 1 ? '' : 's'}: ${data.analysis.environments.map((e: { name: string; port: number }) => `${e.name} (:${e.port})`).join(', ')}`
              : 'No environments were generated — check that the project has package.json or similar manifest.',
            variant: 'success',
          })
          fetchProjects()
        } else {
          const err = await res.json().catch(() => ({}))
          toast({ title: 'Re-fetch failed', description: err.error || `HTTP ${res.status}`, variant: 'destructive' })
        }
      } catch (e: any) {
        toast({ title: 'Re-fetch failed', description: e?.message || 'Network error', variant: 'destructive' })
      }
    }
  }, [toast, fetchProjects, devices])

  const handleMoveProject = React.useCallback(async (projectId: string, targetDeviceId: string | null) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDeviceId }),
      })
      if (res.ok) {
        toast({ title: 'Project moved', variant: 'success' })
        fetchProjects()
        setMoveProjectDialog(null)
      } else {
        const err = await res.json()
        toast({ title: 'Failed to move project', description: err.error || 'Server error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to move project', variant: 'destructive' })
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

  // Update project actions ref for keyboard shortcuts (moved after all handler definitions)
  // This will be set up after handleEnvAction is defined
  // placeholder - actual implementation is further down
  const _projectActionsUpdateRef = React.useRef<(() => void) | null>(null)

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
          toast({ title: 'Invalid format', description: 'Expected a JSON array of projects', variant: 'destructive' })
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
        toast({ title: `Imported ${importedCount} project${importedCount !== 1 ? 's' : ''}`, variant: 'success' })
        fetchProjects()
      } catch {
        toast({ title: 'Failed to parse JSON', description: 'Please check the file format', variant: 'destructive' })
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
        addAutoNotification(
          action === 'start' ? 'success' : action === 'stop' ? 'warning' : action === 'restart' ? 'info' : 'success',
          `${actionLabels[action] ?? `${action}ed`} ${envLabel}`,
          `${envLabel} for ${project?.name ?? 'project'} has been ${actionLabels[action]?.toLowerCase() ?? action + 'ed'}.`,
          project?.name
        )

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
      } else {
        // 解析 API 返回的详细错误信息
        let errorDetail = 'Server returned an error'
        try {
          const errData = await res.json()
          const parts: string[] = []
          if (errData.error) parts.push(errData.error)
          if (errData.stderr) parts.push(`stderr:\n${errData.stderr}`)
          if (errData.stdout) parts.push(`stdout:\n${errData.stdout}`)
          if (parts.length > 0) errorDetail = parts.join('\n\n')
        } catch {
          // 响应不是 JSON，使用 statusText
          errorDetail = `Server error: ${res.status} ${res.statusText}`
        }
        // 截断过长的错误信息用于 toast
        const toastDesc = errorDetail.length > 200
          ? errorDetail.slice(0, 200) + '… (点击查看详情)'
          : errorDetail
        toast({
          title: `Failed to ${action} ${envLabel}`,
          description: toastDesc,
          variant: 'destructive',
          detail: errorDetail.length > 200 ? errorDetail : undefined,
        })
      }
    } catch {
      toast({ title: `Failed to ${action} ${envLabel}`, description: 'Network error — check console for details', variant: 'destructive' })
    }
  }, [toast, fetchProjects, selectedProject, projects])

  // Update project actions ref for keyboard shortcuts (after all handler definitions)
  React.useEffect(() => {
    projectActionsRef.current.selectProject = handleSelectProject
    projectActionsRef.current.editProject = handleEditProject
    projectActionsRef.current.envAction = handleEnvAction
  }, [handleSelectProject, handleEditProject, handleEnvAction])

  // 注册 toast 点击处理器 — 点击有 detail 的 toast 打开错误详情弹窗
  React.useEffect(() => {
    const { setToastClickHandler } = require('@/components/ui/toaster')
    if (setToastClickHandler) {
      setToastClickHandler((detail: string, title: string) => {
        setErrorDialog({ title, detail })
      })
    }
  }, [])

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
    if (!project) return
    const envs = project.environments || []
    if (envs.length === 0) return
    setRebuildingProjectIds((prev) => new Set(prev).add(projectId))
    try {
      let successCount = 0
      // Skip dev environments — they use HMR and don't need rebuild
      const rebuildEnvs = envs.filter((e) => e.name !== 'development')
      if (rebuildEnvs.length === 0) {
        toast({ title: 'No rebuildable environments', description: 'Dev environments use hot-reload and do not need rebuild', variant: 'info' })
        return
      }
      const errors: string[] = []
      for (const env of rebuildEnvs) {
        const res = await fetch(`/api/projects/${projectId}/environments/${env.id}/rebuild`, { method: 'POST' })
        if (res.ok) {
          successCount++
        } else {
          try {
            const errData = await res.json()
            const errMsg = errData.error || `HTTP ${res.status}`
            errors.push(`${env.name}: ${errMsg}`)
          } catch {
            errors.push(`${env.name}: HTTP ${res.status}`)
          }
        }
      }
      if (successCount === rebuildEnvs.length) {
        toast({ title: `Rebuild completed`, description: `${successCount}/${rebuildEnvs.length} environments rebuilt`, variant: 'success' })
      } else if (successCount > 0) {
        const detail = errors.join('\n')
        toast({
          title: `Rebuild partial failure`,
          description: `${successCount}/${rebuildEnvs.length} succeeded. ${errors.length} failed (点击查看详情)`,
          variant: 'destructive',
          detail,
        })
      } else {
        const detail = errors.join('\n')
        toast({
          title: `Rebuild failed`,
          description: `All ${rebuildEnvs.length} environments failed (点击查看详情)`,
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
      toast({ title: 'Failed to rebuild project', description: 'Network error', variant: 'destructive' })
    } finally {
      setRebuildingProjectIds((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
    }
  }, [toast, fetchProjects, projects, selectedProject])

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
          toast({ title: 'Environment created', variant: 'success' })
          fetchProjects()
        } else {
          const err = await res.json()
          toast({ title: 'Failed to create environment', description: err.error, variant: 'destructive' })
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
        } else {
          const err = await res.json()
          toast({ title: 'Failed to update environment', description: err.error, variant: 'destructive' })
        }
      }
    } catch {
      toast({ title: 'Operation failed', variant: 'destructive' })
    }
  }, [envFormMode, addEnvProjectId, editingEnv, toast, fetchProjects])

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
      } else {
        toast({ title: 'Failed to delete environment', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to delete environment', variant: 'destructive' })
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
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const [activeDragId, setActiveDragId] = React.useState<string | null>(null)

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    // Switch to "custom" sort so the manual drag order is respected instead of
    // being immediately overridden by newest/name/status sorting.
    setSortBy('custom')

    // Compute new order synchronously from the latest ref — do NOT rely on
    // setProjects updater side-effects, which may not have run yet in
    // React 18 concurrent mode.
    const prev = projectsRef.current
    const oldIndex = prev.findIndex((p) => p.id === active.id)
    const newIndex = prev.findIndex((p) => p.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const moved = arrayMove(prev, oldIndex, newIndex)
    const newOrderIds = moved.map((p) => p.id)

    // Update local state immediately (visual reorder)
    setProjects(moved)

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

  // Session 11: Welcome widget dismiss handler
  const dismissWelcome = React.useCallback(() => {
    setWelcomeDismissed(true)
    try { localStorage.setItem('dashboard-welcome-dismissed', 'true') } catch { /* ignore */ }
  }, [])

  // Session 11: Batch tag editor handler
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
    toast({ title: `Tags updated for ${successCount} project${successCount !== 1 ? 's' : ''}`, variant: 'success' })
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

  // Session 11: Greeting based on time of day
  const greeting = React.useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 17) return 'Good afternoon'
    return 'Good evening'
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
      <header className="sticky top-0 z-30 border-b border-border/50 bg-gradient-to-r from-background/90 via-background/80 to-background/90 backdrop-blur-2xl supports-backdrop-blur:bg-background/60 shadow-[0_1px_8px_rgba(0,0,0,0.06),0_4px_16px_rgba(0,0,0,0.03)] dark:from-zinc-900/98 dark:via-zinc-900/95 dark:to-zinc-900/98 dark:border-b dark:border-zinc-800/60 dark:shadow-[0_1px_8px_rgba(0,0,0,0.3),0_4px_16px_rgba(0,0,0,0.15)]">
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
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 h-9 px-3 text-xs font-medium cursor-pointer transition-colors max-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50">
                <Monitor className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="truncate">
                  {selectedDeviceId === null ? 'All Devices' : selectedDeviceId === 'local' ? '💻 This Machine' : devices.find(d => d.id === selectedDeviceId)?.name || 'Unknown'}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
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
              className="pl-9 h-9 text-sm rounded-full bg-muted/40 border border-border/30 search-focus-glow focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:border-emerald-500/50 focus-visible:bg-background transition-all duration-200 placeholder:text-muted-foreground/70 dark:placeholder:text-zinc-500"
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
                  <span className="text-sm font-semibold">Notifications</span>
                  <div className="flex items-center gap-1">
                    {unreadNotifs > 0 && (
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] px-1.5 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300" onClick={() => handleMarkNotifRead()}>
                        <CheckCircle2 className="h-3 w-3 mr-0.5" />Mark all read
                      </Button>
                    )}
                    {notifications.length > 0 && (
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] px-1.5 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" onClick={handleClearNotifications}>
                        <Trash2 className="h-3 w-3 mr-0.5" />Clear all
                      </Button>
                    )}
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 && (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      <p>No notifications</p>
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
                            <p className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{formatTimeAgo(notif.timestamp)}</p>
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
                <TooltipContent>Grid view (G+G)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild><button type="button" className={`inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer transition-all duration-150 active:scale-95 ${viewMode === 'list' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground'}`} onClick={() => setViewMode('list')}>
                    <List className="h-4 w-4" />
                  </button></TooltipTrigger>
                <TooltipContent>List view (G+L)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </div>

            <Separator orientation="vertical" className="h-5 mx-0.5 hidden sm:block" />

            <ThemeToggle />

            {/* Settings dropdown: Gateway, LLM, Export, Sync */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="inline-flex items-center justify-center rounded-md h-8 w-8 cursor-pointer hover:bg-accent dark:hover:bg-white/10 hover:text-accent-foreground transition-colors">
                <Settings className="h-4 w-4" />
              </button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px] p-1.5 text-sm">
                <DropdownMenuItem onClick={() => setGatewayOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <Server className="h-3.5 w-3.5 mr-2.5" />Gateway Monitor
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLlmOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <Bot className="h-3.5 w-3.5 mr-2.5" />LLM Configuration
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDepGraphOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <GitFork className="h-3.5 w-3.5 mr-2.5" />Dependency Map
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHealthAlertsOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <AlertTriangle className="h-3.5 w-3.5 mr-2.5" />Health Alerts
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDashboardCustomizeOpen(true)} className="px-2.5 py-2 text-sm rounded-md">
                  <LayoutGrid className="h-3.5 w-3.5 mr-2.5" />Customize Dashboard
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
                <DropdownMenuItem onClick={handleImportJSON} className="px-2.5 py-2 text-sm rounded-md">
                  <Upload className="h-3.5 w-3.5 mr-2.5" />Import JSON
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
      <div className="border-b bg-muted/30 dark:bg-zinc-900/90 dark:border-b dark:border-zinc-700/50 backdrop-blur-lg bg-white/60 dark:bg-zinc-900/80">
        <div className="max-w-7xl mx-auto px-4 py-2">
          {/* Filters + Batch select */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Updated timestamp */}
            <span className="text-[9px] text-muted-foreground dark:text-zinc-500 tabular-nums hidden sm:inline-flex items-center gap-1 shrink-0">
              {loading && <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />}
              Updated {formatTimeAgo(lastRefreshed)}
            </span>
            {/* Filter controls — wrap naturally, no horizontal scroll */}
            <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-lg border-2 ${filterStatus !== 'all' ? 'border-emerald-400 dark:border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : 'border-zinc-300 dark:border-zinc-600 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-800 dark:to-zinc-850 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750'} h-7 px-2.5 text-xs font-semibold cursor-pointer transition-all duration-150 shadow-sm hover:shadow-md`}>
                    <Filter className="h-3 w-3" />
                    {filterStatus === 'all' ? 'Status' : filterStatus}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
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
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-lg border-2 ${filterTags.length > 0 ? 'border-teal-400 dark:border-teal-500 bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300' : 'border-zinc-300 dark:border-zinc-600 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-800 dark:to-zinc-850 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750'} h-7 px-2.5 text-xs font-semibold cursor-pointer transition-all duration-150 shadow-sm hover:shadow-md`}>
                    <Tag className="h-3 w-3" />
                    Tags{filterTags.length > 0 && ` (${filterTags.length})`}
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
                  <button type="button" className={`inline-flex items-center gap-1 rounded-lg border-2 ${sortBy !== 'newest' ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300' : 'border-zinc-300 dark:border-zinc-600 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-800 dark:to-zinc-850 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750'} h-7 px-2.5 text-xs font-semibold cursor-pointer transition-all duration-150 shadow-sm hover:shadow-md`}>
                    <ArrowUpDown className="h-3 w-3" />
                    {sortBy === 'newest' ? 'Newest' : sortBy === 'name' ? 'Name' : 'Status'}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                    <DropdownMenuRadioItem value="custom">Custom Order</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="newest">Newest First</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">By Name</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="status">By Status</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`inline-flex items-center gap-1 rounded-lg border-2 ${groupBy !== 'none' ? 'border-purple-400 dark:border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' : 'border-zinc-300 dark:border-zinc-600 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-800 dark:to-zinc-850 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750'} h-7 px-2.5 text-xs font-semibold cursor-pointer transition-all duration-150 shadow-sm hover:shadow-md`}>
                    <Layers className="h-3 w-3" />
                    Group: {groupBy === 'device' ? 'Device' : groupBy === 'tags' ? 'Tags' : 'None'}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                    <DropdownMenuRadioItem value="device">By Device</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="tags">By Tags</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="none">None (Flat)</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Filter indicator pills */}
              <AnimatePresence>
              {filterStatus !== 'all' && (
                <motion.button key="filter-status" type="button" onClick={() => setFilterStatus('all')} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60 transition-colors"
                  initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  {filterStatus} <X className="h-2.5 w-2.5" />
                </motion.button>
              )}
              {filterTags.length > 0 && filterTags.map(tag => (
                <motion.button key={`tag-${tag}`} type="button" onClick={() => setFilterTags(prev => prev.filter(t => t !== tag))} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 hover:bg-teal-200 dark:hover:bg-teal-900/60 transition-colors"
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
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {/* Active filter count badge */}
            {(() => {
              const count = (filterStatus !== 'all' ? 1 : 0) + filterTags.length + (sortBy !== 'newest' ? 1 : 0) + (groupBy !== 'none' ? 1 : 0)
              return count > 0 ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-bold">{count} active</span> : null
            })()}
            {/* Batch mode toggle — always right-aligned */}
            <label className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium gap-1.5 shrink-0 h-7 px-2.5 transition-colors cursor-pointer border ${
              batchMode
                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border-secondary'
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
              <span className="text-[10px] text-muted-foreground">{batchMode ? 'Cancel' : 'Batch'}</span>
            </label>
          </div>
          {/* Active Filter Chips (Session 13) */}
          {(filterStatus !== 'all' || filterTags.length > 0 || searchQuery) && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {searchQuery && (
                <Badge variant="secondary" className="text-[10px] gap-1 pr-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
                  Search: {searchQuery}
                  <button type="button" onClick={() => setSearchQuery('')} className="ml-0.5 p-0.5 rounded hover:bg-emerald-200/50 dark:hover:bg-emerald-800/30"><X className="h-2.5 w-2.5" /></button>
                </Badge>
              )}
              {filterStatus !== 'all' && (
                <Badge variant="secondary" className="text-[10px] gap-1 pr-1 bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 ring-1 ring-cyan-200/50 dark:ring-cyan-800/30">
                  Status: {filterStatus}
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
                Clear all
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
            className="fixed bottom-12 left-0 right-0 z-40 border-t border-emerald-200 dark:border-emerald-800/40 bg-white/95 dark:bg-zinc-900/98 backdrop-blur-xl shadow-[0_-8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.5)]"
          >
            <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Checkbox checked={selectedIds.size === filteredProjects.length && filteredProjects.length > 0} onCheckedChange={toggleSelectAll} />
                <span className="text-sm font-semibold">{selectedIds.size} <span className="font-normal text-muted-foreground">selected</span></span>
                <Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground hover:text-foreground" onClick={toggleSelectAll}>
                  {selectedIds.size === filteredProjects.length && filteredProjects.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('start')}><Play className="h-3 w-3 mr-1 text-emerald-500" />Start All</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleBatchAction('stop')}><Square className="h-3 w-3 mr-1 text-red-500" />Stop All</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openBatchTagEditor}><Tags className="h-3 w-3 mr-1 text-amber-500" />Edit Tags</Button>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="outline" className="h-7 text-xs text-destructive" />}>
                    <Trash2 className="h-3 w-3 mr-1" />Delete All
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

      {/* ======================== QUICK ACTIONS TOOLBAR (sticky top, batch mode) ======================== */}
      <AnimatePresence>
        {batchMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: -20, opacity: 0, height: 0 }}
            animate={{ y: 0, opacity: 1, height: 'auto' }}
            exit={{ y: -20, opacity: 0, height: 0 }}
            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
            className="sticky top-0 z-30 border-b border-emerald-200 dark:border-emerald-800/40 bg-gradient-to-r from-emerald-50 via-emerald-50/90 to-teal-50 dark:from-emerald-950/60 dark:via-emerald-950/50 dark:to-teal-950/40 backdrop-blur-xl shadow-sm"
          >
            <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex items-center justify-center h-6 w-6 rounded-full bg-emerald-500 text-white text-xs font-bold shadow-sm">
                  {selectedIds.size}
                </div>
                <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">selected</span>
                <Button variant="ghost" size="sm" className="h-6 text-[10px] text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100 hover:bg-emerald-100/50 dark:hover:bg-emerald-800/30" onClick={toggleSelectAll}>
                  {selectedIds.size === filteredProjects.length && filteredProjects.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm" onClick={() => handleBatchAction('start')}><Play className="h-3 w-3 mr-1" />Start All</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/30" onClick={() => handleBatchAction('stop')}><Square className="h-3 w-3 mr-1" />Stop All</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/30" onClick={openBatchTagEditor}><Tags className="h-3 w-3 mr-1" />Add Tags</Button>
                <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/30" onClick={() => {
                  // Move first selected project to device dialog
                  const firstSelected = projects.find(p => selectedIds.has(p.id))
                  if (firstSelected) setMoveProjectDialog(firstSelected)
                }}><ArrowRightLeft className="h-3 w-3 mr-1" />Move to Device</Button>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="outline" className="h-7 text-xs border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" />}>
                    <Trash2 className="h-3 w-3 mr-1" />Delete Selected
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
        {/* Quick Launch Bar (Session 13) */}
        {!loading && quickLaunchBarVisible && runningEnvsForQuickLaunch.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="mb-4 flex items-center gap-2 flex-wrap"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <Zap className="h-3 w-3 text-emerald-500" />
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/15 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30 hover:from-emerald-100 hover:to-teal-100 dark:hover:from-emerald-900/30 dark:hover:to-teal-900/20 hover:shadow-sm transition-all duration-150 hover:scale-105 active:scale-95"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="max-w-[80px] truncate">{env.projectName}</span>
                    <span className="text-emerald-500/60">·</span>
                    <span className="truncate max-w-[50px]">{env.envName}</span>
                    <span className="text-[9px] font-mono text-emerald-500/70">:{env.port}</span>
                    <ExternalLink className="h-2.5 w-2.5 text-emerald-500/50" />
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
            className="mb-5 rounded-xl border bg-card dark:bg-zinc-900/80 shadow-sm border-border/60 dark:border-zinc-700/50 overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 dark:border-zinc-700/30">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-900/20 dark:to-purple-900/15 ring-1 ring-violet-200/50 dark:ring-violet-800/30">
                  <Activity className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                </div>
                <span className="text-xs font-semibold text-foreground dark:text-zinc-200">Recent Activity</span>
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{globalActivity.length}</Badge>
              </div>
              <button type="button" onClick={() => setActivityFeedVisible(false)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto custom-scrollbar">
              {globalActivity.map((event, idx) => {
                const IconComp = ACTIVITY_ICONS[event.type] || Activity
                const colorClass = ACTIVITY_COLORS[event.type] || 'text-gray-500 bg-gray-100'
                return (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/30 dark:bg-zinc-800/40 shrink-0 hover:bg-muted/50 transition-colors cursor-default"
                  >
                    <div className={`p-1 rounded ${colorClass}`}>
                      <IconComp className="h-3 w-3" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium truncate max-w-[240px]">{event.message}</p>
                      <p className="text-[10px] text-muted-foreground">{formatTimeAgo(event.timestamp)}</p>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </motion.div>
        )}
        {/* ======================== HEALTH ALERT SUMMARY BANNER (Session 14) ======================== */}
        {!loading && healthAlertEnabled && !alertsAcknowledged && (() => {
          const alertProjects = projects.filter((p) => {
            const score = calculateHealthScore(p)
            return score <= healthAlertThreshold
          })
          if (alertProjects.length === 0) return null
          const grouped = { critical: [] as typeof alertProjects, warning: [] as typeof alertProjects, notice: [] as typeof alertProjects }
          alertProjects.forEach((p) => {
            const score = calculateHealthScore(p)
            const sev = getAlertSeverity(score)
            if (sev === 'critical') grouped.critical.push(p)
            else if (sev === 'warning') grouped.warning.push(p)
            else if (sev === 'notice') grouped.notice.push(p)
          })
          return (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 }}
              className="mb-4"
            >
              <div className={`rounded-xl border shadow-sm overflow-hidden ${grouped.critical.length > 0 ? 'border-red-200 dark:border-red-800/50 bg-gradient-to-r from-red-50 via-red-50/50 to-transparent dark:from-red-950/30 dark:via-red-950/15' : 'border-amber-200 dark:border-amber-800/50 bg-gradient-to-r from-amber-50 via-amber-50/50 to-transparent dark:from-amber-950/30 dark:via-amber-950/15'}`}>
                <div
                  role="button"
                  tabIndex={0}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/20 transition-colors cursor-pointer"
                  onClick={() => setHealthBannerExpanded(!healthBannerExpanded)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHealthBannerExpanded(!healthBannerExpanded) } }}
                >
                  <AlertTriangle className={`h-4 w-4 shrink-0 ${grouped.critical.length > 0 ? 'text-red-500 alert-critical-pulse' : 'text-amber-500'}`} />
                  <span className="text-sm font-semibold">{alertProjects.length} project{alertProjects.length !== 1 ? 's' : ''} below health threshold ({healthAlertThreshold}%)</span>
                  <div className="flex items-center gap-1.5 ml-2">
                    {grouped.critical.length > 0 && <Badge className="text-[9px] px-1.5 py-0 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">{grouped.critical.length} Critical</Badge>}
                    {grouped.warning.length > 0 && <Badge className="text-[9px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">{grouped.warning.length} Warning</Badge>}
                    {grouped.notice.length > 0 && <Badge className="text-[9px] px-1.5 py-0 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">{grouped.notice.length} Notice</Badge>}
                  </div>
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2 mr-1 btn-micro-click" onClick={(e) => { e.stopPropagation(); setAlertsAcknowledged(true); localStorage.setItem('dashboard-alerts-acknowledged', 'true') }}>Acknowledge All</Button>
                  {healthBannerExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </div>
                <AnimatePresence>
                  {healthBannerExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-3 space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                        {(['critical', 'warning', 'notice'] as const).map((sev) => {
                          const items = grouped[sev]
                          if (items.length === 0) return null
                          const cfg = severityConfig(sev)
                          return (
                            <div key={sev}>
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
                                <span className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
                                <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5">{items.length}</Badge>
                              </div>
                              <div className="space-y-1">
                                {items.map((p) => {
                                  const score = calculateHealthScore(p)
                                  return (
                                    <div key={p.id} className={`flex items-center justify-between px-3 py-1.5 rounded-md text-xs ${cfg.bg} ${sev === 'critical' ? 'alert-critical-pulse' : ''}`}>
                                      <span className="truncate font-medium">{p.name}</span>
                                      <span className={`font-bold ml-2 ${cfg.color}`}>{score}%</span>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )
        })()}
        {/* ======================== ANALYTICS WIDGET (Session 14) ======================== */}
        {!loading && analyticsVisible && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.25 }}
            className="mb-5 rounded-xl border bg-card dark:bg-zinc-900/80 shadow-sm border-border/60 dark:border-zinc-700/50 overflow-hidden hover-glow"
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 dark:border-zinc-700/30 gradient-section-header">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/15 ring-1 ring-rose-200/50 dark:ring-rose-800/30">
                  <BarChart3 className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                </div>
                <span className="text-xs font-semibold text-foreground dark:text-zinc-200">Analytics</span>
              </div>
              <div className="flex items-center gap-1.5">
                {(['1h', '6h', '24h'] as const).map((period) => (
                  <button
                    key={period}
                    type="button"
                    onClick={() => setAnalyticsPeriod(period)}
                    className={`px-2 py-0.5 rounded-md text-[10px] transition-colors ${analyticsPeriod === period ? 'font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 ring-1 ring-emerald-300/50 dark:ring-emerald-700/50' : 'font-medium bg-muted/40 text-muted-foreground hover:bg-muted/60'}`}
                  >
                    {period}
                  </button>
                ))}
                <button type="button" onClick={() => setAnalyticsVisible(false)} className="ml-1 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
            <div className="px-4 py-3 grid grid-cols-3 gap-4">
              {/* Project Count Trend */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Projects</span>
                <span className="text-lg font-bold text-rose-600 dark:text-rose-400">{dashboardStats.totalProjects}</span>
                <MiniSparkline data={projectCountHistory.slice(analyticsPeriod === '1h' ? -4 : analyticsPeriod === '6h' ? -12 : -20)} color="#f43f5e" />
              </div>
              {/* Running Envs Trend */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Running Envs</span>
                <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{dashboardStats.runningEnvs}</span>
                <MiniSparkline data={runningEnvsHistory.slice(analyticsPeriod === '1h' ? -4 : analyticsPeriod === '6h' ? -12 : -20)} color="#10b981" />
              </div>
              {/* Health Score Trend */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Health</span>
                <span className={`text-lg font-bold ${healthColor(dashboardStats.healthScore)}`}>{dashboardStats.healthScore}%</span>
                <MiniSparkline data={healthScoreHistory.slice(analyticsPeriod === '1h' ? -4 : analyticsPeriod === '6h' ? -12 : -20)} color={dashboardStats.healthScore >= 80 ? '#10b981' : dashboardStats.healthScore >= 50 ? '#f59e0b' : '#ef4444'} />
              </div>
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
            <h3 className="text-lg font-semibold mb-1 text-foreground">No projects found</h3>
            <p className="text-sm text-muted-foreground dark:text-gray-400 mb-4 max-w-xs">Your current filters didn't match any projects. Try adjusting your search or clearing the filters.</p>
            <Button variant="outline" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterTags([]) }} className="gap-1.5">
              <X className="h-4 w-4" />Clear Filters
            </Button>
          </motion.div>
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <SortableContext items={filteredProjects.map((p) => p.id)} strategy={viewMode === 'list' ? verticalListSortingStrategy : rectSortingStrategy}>
              {/* ======================== WELCOME WIDGET (Session 11) ======================== */}
              {filteredProjects.length > 0 && !welcomeDismissed && projects.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className="mb-5 relative overflow-hidden rounded-xl welcome-gradient-animate bg-gradient-to-r from-emerald-50 via-teal-50 to-cyan-50 dark:from-emerald-950/40 dark:via-teal-950/30 dark:to-cyan-950/40 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30 shadow-sm"
                >
                  <div className="relative z-10 p-4 flex items-start gap-3">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
                      className="p-2 rounded-lg bg-white/60 dark:bg-white/10 shadow-sm ring-1 ring-emerald-200/40 dark:ring-emerald-700/30 shrink-0"
                    >
                      <Zap className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </motion.div>
                    <div className="flex-1 min-w-0">
                      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 }}>
                        <h3 className="text-sm font-bold text-emerald-900 dark:text-emerald-200">{greeting} 👋</h3>
                      </motion.div>
                      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 }}>
                        <p className="text-xs text-emerald-700/80 dark:text-emerald-300/70 mt-0.5">
                          {stats.running === stats.total && stats.total > 0
                            ? `🎉 All ${stats.total} projects running, ${stats.environments} environments active!`
                            : `${stats.running} of ${stats.total} projects running, ${stats.environments} environments active`
                          }
                        </p>
                      </motion.div>
                      {stats.stopped > 0 && (
                        <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 }} className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {stats.stopped} project{stats.stopped !== 1 ? 's' : ''} need attention
                        </motion.p>
                      )}
                      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-[11px] text-emerald-600/70 dark:text-emerald-400/60 mt-1">
                        Last refreshed: {formatTimeAgo(lastRefreshed)}
                      </motion.p>
                    </div>
                    <button
                      type="button"
                      onClick={dismissWelcome}
                      className="p-1 rounded-md hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 text-emerald-600/60 dark:text-emerald-400/50 hover:text-emerald-800 dark:hover:text-emerald-200 transition-colors shrink-0"
                      title="Dismiss"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {/* Decorative background circles */}
                  <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-emerald-200/20 dark:bg-emerald-800/10" />
                  <div className="absolute -bottom-4 -left-4 w-16 h-16 rounded-full bg-teal-200/20 dark:bg-teal-800/10" />
                </motion.div>
              )}

              {/* Dashboard Overview Stats Cards */}
              {filteredProjects.length > 0 && (
                <div className={`grid gap-3 mb-5 relative ${visibleStats.size === 1 ? 'grid-cols-1 max-w-xs' : visibleStats.size === 2 ? 'grid-cols-2' : visibleStats.size === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'}`}>
                  {[
                    { key: 'totalProjects', label: 'Total Projects', value: dashboardStats.totalProjects, icon: Folder, iconColor: 'text-emerald-600 dark:text-emerald-400', gradient: 'from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20', ring: 'ring-emerald-200/50 dark:ring-emerald-800/30', sub: `${dashboardStats.runningEnvs} of ${dashboardStats.totalEnvs} envs running`, subIcon: Activity, miniChart: true, miniRunning: dashboardStats.runningEnvs, miniTotal: dashboardStats.totalEnvs, glowColor: 'rgba(16,185,129,0.3)', statusBars: true, runningCount: stats.running, mixedCount: stats.mixed, stoppedCount: stats.stopped },
                    { key: 'environments', label: 'Environments', value: dashboardStats.runningEnvs, icon: Play, iconColor: 'text-cyan-600 dark:text-cyan-400', gradient: 'from-cyan-50 to-sky-50 dark:from-cyan-950/30 dark:to-sky-950/20', ring: 'ring-cyan-200/50 dark:ring-cyan-800/30', sub: `${dashboardStats.runningEnvs} / ${dashboardStats.totalEnvs} running`, trend: dashboardStats.totalEnvs > 0 ? `${Math.round((dashboardStats.runningEnvs / dashboardStats.totalEnvs) * 100)}%` : '0%', glowColor: 'rgba(6,182,212,0.3)', envRing: true, envRunning: dashboardStats.runningEnvs, envTotal: dashboardStats.totalEnvs },
                    { key: 'devices', label: 'Devices', value: dashboardStats.onlineDevices, icon: Server, iconColor: 'text-teal-600 dark:text-teal-400', gradient: 'from-teal-50 to-cyan-50 dark:from-teal-950/30 dark:to-cyan-950/20', ring: 'ring-teal-200/50 dark:ring-teal-800/30', sub: `${dashboardStats.onlineDevices} / ${dashboardStats.totalDevices} online`, glowColor: 'rgba(20,184,166,0.3)', deviceDots: true },
                    { key: 'healthScore', label: 'Health Score', value: dashboardStats.healthScore, icon: Activity, iconColor: healthColor(dashboardStats.healthScore), gradient: dashboardStats.healthScore >= 80 ? 'from-emerald-50 to-green-50 dark:from-emerald-950/30 dark:to-green-950/20' : dashboardStats.healthScore >= 50 ? 'from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/20' : 'from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/20', ring: dashboardStats.healthScore >= 80 ? 'ring-emerald-200/50 dark:ring-emerald-800/30' : dashboardStats.healthScore >= 50 ? 'ring-amber-200/50 dark:ring-amber-800/30' : 'ring-red-200/50 dark:ring-red-800/30', sub: dashboardStats.healthScore >= 80 ? 'Healthy' : dashboardStats.healthScore >= 50 ? 'Warning' : 'Critical', isPercent: true, sparkline: healthScoreHistory, glowColor: dashboardStats.healthScore >= 80 ? 'rgba(16,185,129,0.3)' : dashboardStats.healthScore >= 50 ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)', trendArrow: true },
                  ].filter((card) => visibleStats.has(card.key)).map((card, i) => (
                    <motion.div
                      key={card.label}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.1, duration: 0.4, ease: 'easeOut' }}
                      whileHover={{ scale: 1.02, y: -2 }}
                      className={`relative p-4 rounded-xl bg-gradient-to-br ${card.gradient} ring-1 ${card.ring} shadow-sm transition-shadow cursor-default overflow-hidden backdrop-blur-md`}
                      style={{ '--glow-color': card.glowColor } as React.CSSProperties}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = `0 4px 20px ${card.glowColor}` }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '' }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <div className="p-1.5 rounded-lg bg-white/60 dark:bg-white/10 shadow-sm">
                          <card.icon className={`h-3.5 w-3.5 ${card.iconColor}`} />
                        </div>
                        <span className="text-[11px] font-medium text-muted-foreground dark:text-zinc-400">{card.label}</span>
                      </div>
                      <div className="flex items-end justify-between">
                        <div className="flex items-center gap-1">
                          <span className={`text-2xl font-bold tracking-tight ${card.isPercent && card.value < 50 ? 'text-red-700 dark:text-red-300' : 'text-foreground dark:text-zinc-100'}`} style={card.isPercent && card.value < 50 ? { textShadow: '0 0 8px rgba(239,68,68,0.3), 0 1px 2px rgba(255,255,255,0.8)' } : undefined}>
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
                              <div className="w-2 rounded-t-sm bg-emerald-400 transition-all" style={{ height: `${Math.max((card.runningCount / total) * 24, 2)}px` }} title={`${card.runningCount} running`} />
                              <div className="w-2 rounded-t-sm bg-amber-400 transition-all" style={{ height: `${Math.max((card.mixedCount / total) * 24, 2)}px` }} title={`${card.mixedCount} mixed`} />
                              <div className="w-2 rounded-t-sm bg-red-400 transition-all" style={{ height: `${Math.max((card.stoppedCount / total) * 24, 2)}px` }} title={`${card.stoppedCount} stopped`} />
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
                              <circle cx={14} cy={14} r={r} fill="none" stroke="#10b981" strokeWidth={3} strokeDasharray={`${(pct / 100) * circ} ${circ}`} strokeLinecap="round" />
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
                            <circle cx={14} cy={14} r={11} fill="none" stroke="#10b981" strokeWidth={3} strokeDasharray={`${(card.miniRunning / card.miniTotal) * 69.1} 69.1`} strokeLinecap="round" className="transform -rotate-90 origin-center" />
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
                        <span className="text-[10px] text-muted-foreground dark:text-zinc-500">{card.sub}</span>
                        {card.trend && (
                          <span className="text-[9px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/20 px-1 py-0 rounded-full">{card.trend}</span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                  {/* Quick Refresh Button */}
                  <button
                    type="button"
                    className="absolute -right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-card border shadow-sm hover:bg-accent hover:shadow-md transition-all ring-1 ring-border/30 text-muted-foreground hover:text-foreground"
                    onClick={() => fetchProjects()}
                    title="Refresh data"
                  >
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              )}
              {/* ======================== PINNED PROJECTS SECTION (Session 11, Session 14 enhanced) ======================== */}
              {starredIds.size > 0 && filteredProjects.some((p) => starredIds.has(p.id)) && groupBy === 'none' && (
                <div className="mb-4">
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-rose-50/60 via-rose-50/30 to-transparent dark:from-rose-900/20 dark:via-rose-900/10 dark:to-transparent border border-rose-200/50 dark:border-rose-800/30">
                    <Pin className="h-3.5 w-3.5 text-rose-500 fill-rose-500" />
                    <span className="text-sm font-semibold text-rose-700 dark:text-rose-300">Pinned</span>
                    <Badge variant="secondary" className="text-[10px] bg-rose-100/60 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                      {filteredProjects.filter((p) => starredIds.has(p.id)).length}
                    </Badge>
                  </div>
                </div>
              )}
              {viewMode === 'grid' ? (
                <div key={`grid-${filterStatus}-${filterTags.join(',')}-${searchQuery}-${groupBy}`} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {groupBy === 'tags' ? (
                    <>
                      {tagGroupedProjects.map((group) => (
                        <React.Fragment key={group.tagName}>
                          <div className="col-span-full">
                            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-muted/60 via-muted/30 to-transparent dark:from-white/5 dark:via-white/3 dark:to-transparent border border-border/40 dark:border-zinc-700/30">
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
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-gradient-to-r from-emerald-50/60 via-emerald-50/30 to-transparent dark:from-emerald-900/20 dark:via-emerald-900/10 dark:to-transparent border border-emerald-100/50 dark:border-emerald-800/20">
                              <div className="p-1 rounded-md bg-emerald-100 dark:bg-emerald-800/30">
                                <Monitor className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              </div>
                              <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">💻 This Machine</span>
                              <Badge variant="secondary" className="text-[10px] bg-emerald-100/60 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{deviceGroupedProjects.localProjects.length}</Badge>
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
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                            <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border ${
                              group.device?.status === 'online'
                                ? 'bg-gradient-to-r from-teal-50/60 via-teal-50/30 to-transparent dark:from-teal-900/20 dark:via-teal-900/10 dark:to-transparent border-teal-100/50 dark:border-teal-800/20'
                                : 'bg-gradient-to-r from-red-50/40 via-red-50/20 to-transparent dark:from-red-900/15 dark:via-red-900/8 dark:to-transparent border-red-100/50 dark:border-red-800/20'
                            }`}>
                              <div className={`p-1 rounded-md ${group.device?.status === 'online' ? 'bg-teal-100 dark:bg-teal-800/30' : 'bg-red-100 dark:bg-red-800/30'}`}>
                                <Server className={`h-3.5 w-3.5 ${group.device?.status === 'online' ? 'text-teal-600 dark:text-teal-400' : 'text-red-500 dark:text-red-400'}`} />
                              </div>
                              <AnimatedStatusDot status={group.device?.status === 'online' ? 'running' : 'stopped'} size="md" />
                              <span className={`text-sm font-semibold ${group.device?.status === 'online' ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{group.device?.name ?? 'Unknown Device'}</span>
                              <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                              <Badge variant="secondary" className={`text-[10px] ${group.device?.status === 'online' ? 'bg-teal-100/60 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' : 'bg-red-100/60 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>{group.projects.length}</Badge>
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
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                        onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-gradient-to-r from-emerald-50/60 via-emerald-50/30 to-transparent dark:from-emerald-900/20 dark:via-emerald-900/10 dark:to-transparent border border-emerald-100/50 dark:border-emerald-800/20">
                            <div className="p-1 rounded-md bg-emerald-100 dark:bg-emerald-800/30">
                              <Monitor className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">💻 This Machine</span>
                            <Badge variant="secondary" className="text-[10px] bg-emerald-100/60 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{deviceGroupedProjects.localProjects.length}</Badge>
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
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
                              pinOrder={starredIds.has(project.id) ? [...filteredProjects].filter((p) => starredIds.has(p.id)).findIndex((p) => p.id === project.id) + 1 : undefined}
                              onReanalyze={handleReanalyzeProject}
                            />
                          ))}
                        </>
                      )}
                      {/* Remote device groups */}
                      {deviceGroupedProjects.remoteGroups.map((group) => (
                        <React.Fragment key={group.device?.id ?? 'unknown'}>
                          <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border mt-4 ${
                            group.device?.status === 'online'
                              ? 'bg-gradient-to-r from-teal-50/60 via-teal-50/30 to-transparent dark:from-teal-900/20 dark:via-teal-900/10 dark:to-transparent border-teal-100/50 dark:border-teal-800/20'
                              : 'bg-gradient-to-r from-red-50/40 via-red-50/20 to-transparent dark:from-red-900/15 dark:via-red-900/8 dark:to-transparent border-red-100/50 dark:border-red-800/20'
                          }`}>
                            <div className={`p-1 rounded-md ${group.device?.status === 'online' ? 'bg-teal-100 dark:bg-teal-800/30' : 'bg-red-100 dark:bg-red-800/30'}`}>
                              <Server className={`h-3.5 w-3.5 ${group.device?.status === 'online' ? 'text-teal-600 dark:text-teal-400' : 'text-red-500 dark:text-red-400'}`} />
                            </div>
                            <AnimatedStatusDot status={group.device?.status === 'online' ? 'running' : 'stopped'} size="md" />
                            <span className={`text-sm font-semibold ${group.device?.status === 'online' ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{group.device?.name ?? 'Unknown Device'}</span>
                            <span className="text-[10px] text-muted-foreground font-mono">{group.device?.ip}:{group.device?.port}</span>
                            <Badge variant="secondary" className={`text-[10px] ${group.device?.status === 'online' ? 'bg-teal-100/60 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' : 'bg-red-100/60 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>{group.projects.length}</Badge>
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
                              onDuplicate={handleDuplicateProject}
                              onMoveToDevice={setMoveProjectDialog}
                              devices={devices}
                              onHover={setHoveredProjectId}
                              focused={focusedProjectIndex === idx}
                              cardDensity={cardDensity}
                              onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
                        onCompare={(p) => { setCompareProjectA(p); setCompareOpen(true) }}
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
      <EnhancedFooter projects={projects} filteredCount={filteredProjects.length} onOpenDevices={() => setDeviceManagementOpen(true)} devices={devices} onOpenSystemMonitor={() => setSystemMonitorOpen(true)} onRefresh={() => fetchProjects()} onAddProject={() => { setEditingProject(null); setProjectFormMode('add'); setProjectFormOpen(true) }} />

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

      {/* Move to Device dialog */}
      <Dialog open={!!moveProjectDialog} onOpenChange={(v) => !v && setMoveProjectDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-emerald-600" />
              Move &quot;{moveProjectDialog?.name}&quot; to Device
            </DialogTitle>
            <DialogDescription>Select a target device to move this project to.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            <button
              type="button"
              className="w-full flex items-center gap-2.5 p-3 rounded-lg border hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:border-emerald-300 dark:hover:border-emerald-700 transition-colors text-left"
              onClick={() => moveProjectDialog && handleMoveProject(moveProjectDialog.id, null)}
            >
              <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <div className="text-sm font-medium">This Machine (Local)</div>
                <div className="text-[10px] text-muted-foreground">Move back to this machine</div>
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
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${device.status === 'online' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>{device.status === 'online' ? 'Online' : 'Offline'}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Error detail dialog - shows full build error output */}
      <Dialog open={!!errorDialog} onOpenChange={(v) => !v && setErrorDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {errorDialog?.title ?? 'Error'}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              完整的错误输出，用于排查问题
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
                  toast({ title: '已复制到剪贴板', variant: 'success' })
                }).catch(() => {})
              }
            }}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              复制
            </Button>
            <Button size="sm" onClick={() => setErrorDialog(null)}>关闭</Button>
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
          fetchProjects()
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
      <GatewayMonitorDialog open={gatewayOpen} onClose={() => setGatewayOpen(false)} />

      {/* System resource monitor */}
      <SystemMonitorDialog open={systemMonitorOpen} onClose={() => setSystemMonitorOpen(false)} />

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
            className="fixed bottom-16 right-4 z-40 h-10 w-10 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/30 hover:shadow-emerald-500/50 transition-all active:scale-90 flex items-center justify-center"
            title="Scroll to top"
          >
            <ArrowUp className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ======================== DEPENDENCY GRAPH DIALOG (Session 11) ======================== */}
      <Dialog open={depGraphOpen} onOpenChange={setDepGraphOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitFork className="h-5 w-5 text-emerald-600" />
              Project Dependency Map
            </DialogTitle>
            <DialogDescription>Projects connected by shared tags. Lines represent shared tag relationships.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {projects.length < 2 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <GitFork className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">Need at least 2 projects to show dependencies</p>
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
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Running</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Mixed</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> Stopped</span>
                    <span className="flex items-center gap-1"><span className="h-4 border-t border-dashed border-muted-foreground/40 w-6" /> Shared Tag</span>
                  </div>
                  {edges.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center pb-2">No shared tags found between projects</p>
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
              Batch Edit Tags
            </DialogTitle>
            <DialogDescription>Modify tags for {selectedIds.size} selected project{selectedIds.size !== 1 ? 's' : ''}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Selected projects */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Selected Projects</Label>
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
              <Label className="text-xs text-muted-foreground mb-2 block">Mode</Label>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant={batchTagMode === 'add' ? 'default' : 'outline'} className={batchTagMode === 'add' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''} onClick={() => setBatchTagMode('add')}>Add Tags</Button>
                <Button type="button" size="sm" variant={batchTagMode === 'replace' ? 'default' : 'outline'} className={batchTagMode === 'replace' ? 'bg-amber-600 hover:bg-amber-700 text-white' : ''} onClick={() => setBatchTagMode('replace')}>Replace Tags</Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {batchTagMode === 'add' ? 'Appends selected tags to existing tags' : 'Replaces all existing tags with selected tags'}
              </p>
            </div>
            {/* Tag checkboxes */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Tags</Label>
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
            <Button variant="outline" onClick={() => setBatchTagEditorOpen(false)} disabled={batchTagApplying}>Cancel</Button>
            <Button onClick={handleBatchTagApply} disabled={batchTagApplying || (batchTagMode === 'replace' && batchTagDraft.length === 0)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {batchTagApplying && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Apply Tags
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
              <DialogTitle>Health Alerts</DialogTitle>
            </div>
            <DialogDescription>Configure health monitoring alerts for your dashboard</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Enable toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Enable Health Alerts</Label>
                <p className="text-xs text-muted-foreground">Get notified when health drops below threshold</p>
              </div>
              <Switch checked={healthAlertEnabled} onCheckedChange={setHealthAlertEnabled} />
            </div>
            {/* Threshold slider */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Alert Threshold</Label>
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
                <span>10% (More alerts)</span>
                <span>90% (Fewer alerts)</span>
              </div>
            </div>
            {/* Current status */}
            <div className="p-3 rounded-lg border bg-muted/20 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Current Health Score</span>
                <span className={`font-bold ${healthColor(dashboardStats.healthScore)}`}>{dashboardStats.healthScore}%</span>
              </div>
              <Progress value={dashboardStats.healthScore} className="h-2" />
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${dashboardStats.healthScore <= healthAlertThreshold ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span className="text-[10px] text-muted-foreground">
                  {dashboardStats.healthScore <= healthAlertThreshold ? 'Below threshold — alerts active' : 'Above threshold — all clear'}
                </span>
              </div>
            </div>
            {/* Per-project health with severity groups (Session 14) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Project Health Status</Label>
                {alertsAcknowledged && (
                  <Button variant="ghost" size="sm" className="h-5 text-[9px] px-1.5 btn-micro-click" onClick={() => { setAlertsAcknowledged(false); localStorage.setItem('dashboard-alerts-acknowledged', 'false') }}>Show Alerts</Button>
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
                      <SeverityGroup key={group.key} label={cfg.label} color={cfg.color} dot={cfg.dot} count={group.items.length}>
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
                  <AlertTriangle className="h-3 w-3 mr-1" />Acknowledge All
                </Button>
              )}
            </div>
            <Button variant="outline" onClick={() => setHealthAlertsOpen(false)}>Close</Button>
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
              <DialogTitle>Customize Dashboard</DialogTitle>
            </div>
            <DialogDescription>Personalize your dashboard layout and preferences</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Card Density */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Card Density</Label>
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
                    <span className="text-[10px] font-medium capitalize">{density}</span>
                  </button>
                ))}
              </div>
            </div>
            {/* Visible Stats */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Visible Stats Cards</Label>
              <div className="space-y-1.5">
                {[
                  { key: 'totalProjects', label: 'Total Projects', icon: Folder },
                  { key: 'environments', label: 'Environments', icon: Play },
                  { key: 'devices', label: 'Devices', icon: Server },
                  { key: 'healthScore', label: 'Health Score', icon: Activity },
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
              <Label className="text-sm font-medium">Quick Actions</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setWelcomeDismissed(false); localStorage.removeItem('dashboard-welcome-dismissed') }}>
                  <Zap className="h-3 w-3 mr-1" />Show Welcome
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setQuickLaunchBarVisible(true) }}>
                  <Zap className="h-3 w-3 mr-1" />Quick Launch
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setActivityFeedVisible(true) }}>
                  <Activity className="h-3 w-3 mr-1" />Activity Feed
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => { setAnalyticsVisible(true) }}>
                  <BarChart3 className="h-3 w-3 mr-1" />Analytics
                </Button>
                <Button variant="outline" size="sm" className="text-xs h-8 col-span-2" onClick={() => { setCardDensity('comfortable'); setVisibleStats(new Set(['totalProjects', 'environments', 'devices', 'healthScore'])) }}>
                  <RefreshCw className="h-3 w-3 mr-1" />Reset Defaults
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setDashboardCustomizeOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== PROJECT COMPARE (Session 12) ======================== */}
      <Dialog open={compareOpen} onOpenChange={(v) => { setCompareOpen(v); if (!v) { setCompareProjectA(null); setCompareProjectB(null) } }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-900/20 dark:to-purple-900/15 ring-1 ring-violet-200/50 dark:ring-violet-800/30">
                <ArrowRightLeft className="h-5 w-5 text-violet-600 dark:text-violet-400" />
              </div>
              <DialogTitle>Compare Projects</DialogTitle>
            </div>
            <DialogDescription>Side-by-side project comparison</DialogDescription>
          </DialogHeader>
          {!compareProjectA ? (
            <div className="py-6 text-center space-y-4">
              <p className="text-sm text-muted-foreground">Select two projects to compare</p>
              <div className="grid grid-cols-2 gap-4">
                {['Project A', 'Project B'].map((label, i) => (
                  <div key={label} className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
                    <Select onValueChange={(v) => { const p = projects.find((pr) => pr.id === v); if (i === 0) setCompareProjectA(p || null); else setCompareProjectB(p || null) }}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select project..." /></SelectTrigger>
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
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select project..." /></SelectTrigger>
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
                        <th className="text-left p-2.5 font-medium text-muted-foreground w-1/4">Property</th>
                        <th className="text-left p-2.5 font-medium">{compareProjectA.name}</th>
                        <th className="text-left p-2.5 font-medium">{compareProjectB.name}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {[
                        { label: 'Status', a: getProjectStatus(compareProjectA), b: getProjectStatus(compareProjectB), render: (v: string) => <Badge variant="secondary" className={`text-[10px] ${v === 'running' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : v === 'mixed' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>{v}</Badge> },
                        { label: 'Health', a: calculateHealthScore(compareProjectA), b: calculateHealthScore(compareProjectB), render: (v: number) => <span className={`font-bold ${healthColor(v)}`}>{v}%</span> },
                        { label: 'Environments', a: (compareProjectA.environments || []).length, b: (compareProjectB.environments || []).length, render: (v: number) => <span>{v}</span> },
                        { label: 'Running', a: (compareProjectA.environments || []).filter((e) => e.status === 'running').length, b: (compareProjectB.environments || []).filter((e) => e.status === 'running').length, render: (v: number) => <span className="text-emerald-600 dark:text-emerald-400">{v}</span> },
                        { label: 'Stopped', a: (compareProjectA.environments || []).filter((e) => e.status !== 'running').length, b: (compareProjectB.environments || []).filter((e) => e.status !== 'running').length, render: (v: number) => <span className="text-red-500">{v}</span> },
                        { label: 'Tags', a: parseTags(compareProjectA.tags), b: parseTags(compareProjectB.tags), render: (v: string[]) => <div className="flex flex-wrap gap-0.5">{v.map((t) => <Badge key={t} variant="secondary" className={`text-[8px] px-1 py-0 ${getTagColor(t)}`}>{t}</Badge>)}</div> },
                        { label: 'Path', a: compareProjectA.path, b: compareProjectB.path, render: (v: string) => <span className="font-mono text-[10px] truncate max-w-[180px] inline-block">{v}</span> },
                        { label: 'Device', a: compareProjectA.deviceName || 'Local', b: compareProjectB.deviceName || 'Local', render: (v: string) => <span>{v}</span> },
                        { label: 'Description', a: compareProjectA.description || '—', b: compareProjectB.description || '—', render: (v: string) => <span className="truncate max-w-[180px] inline-block">{v}</span> },
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
                  <p className="text-sm text-muted-foreground">Select a second project to compare</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCompareOpen(false); setCompareProjectA(null); setCompareProjectB(null) }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ======================== AGENT DEPLOY GUIDE DIALOG ======================== */}
      <Dialog open={agentDeployGuideOpen} onOpenChange={setAgentDeployGuideOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/15 ring-1 ring-teal-200/50 dark:ring-teal-800/30">
                <Download className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              </div>
              Deploy Agent to Remote Device
            </DialogTitle>
            <DialogDescription>Install Dashboard Agent on Windows, macOS, or Linux devices to manage them remotely.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
            {/* Platform Selection */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Monitor className="h-4 w-4 text-teal-600" />
                Choose Platform
              </h4>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'windows', label: 'Windows', icon: '🪟', desc: 'EXE Installer / Service', active: true },
                  { key: 'macos', label: 'macOS', icon: '🍎', desc: 'Bun / Node.js', active: false },
                  { key: 'linux', label: 'Linux', icon: '🐧', desc: 'Bun / Node.js', active: false },
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
                    {p.active && <Badge className="mt-1.5 text-[9px] bg-teal-600 text-white">Recommended</Badge>}
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            {/* Quick Start - Windows */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                Quick Start (3 Steps)
              </h4>

              {/* Step 1 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">1</span>
                  <span className="text-sm font-medium">Download & Extract</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">
                  Download the <code className="px-1.5 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[11px] font-mono">dashboard-agent-windows.zip</code> package and extract it to your desired location.
                </p>
                <div className="pl-7">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => {
                    window.open('/api/agent/download?platform=windows', '_blank')
                    addToast({ title: 'Downloading Agent Package', description: 'dashboard-agent-windows.zip is being downloaded...', variant: 'success' })
                  }}>
                    <Download className="h-3 w-3" />
                    Download Agent Package
                  </Button>
                </div>
              </div>

              {/* Step 2 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">2</span>
                  <span className="text-sm font-medium">Install & Configure</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">Run the setup wizard to install dependencies and configure the agent:</p>
                <div className="pl-7 mt-1.5">
                  <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                    <div className="text-emerald-400">:: Option A: Interactive Setup</div>
                    <div className="text-zinc-300">node setup.js</div>
                    <div className="text-zinc-500 mt-2">:: Option B: Quick Start</div>
                    <div className="text-zinc-300">start.bat</div>
                    <div className="text-zinc-500 mt-2">:: Option C: EXE Installer</div>
                    <div className="text-zinc-300">dashboard-agent-setup.exe</div>
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="rounded-lg border bg-muted/20 dark:bg-zinc-800/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-teal-600 text-white text-[10px] font-bold shrink-0">3</span>
                  <span className="text-sm font-medium">Add Device to Dashboard</span>
                </div>
                <p className="text-xs text-muted-foreground pl-7">
                  Copy the generated API Key, then add the device in the Dashboard using the device&apos;s IP address and port.
                </p>
                <div className="pl-7 mt-1.5">
                  <Button size="sm" className="h-7 text-xs bg-teal-600 hover:bg-teal-700 text-white gap-1.5" onClick={() => {
                    setAgentDeployGuideOpen(false)
                    setTimeout(() => setAddDeviceFormOpen(true), 300)
                  }}>
                    <Plus className="h-3 w-3" />
                    Add Device Now
                  </Button>
                </div>
              </div>
            </div>

            <Separator />

            {/* Installation Methods */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-violet-600" />
                Installation Methods
              </h4>

              <div className="grid gap-3">
                {/* Method 1: Simple */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-emerald-100 dark:bg-emerald-900/30">
                      <Terminal className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <span className="text-sm font-semibold">Simple (ZIP + start.bat)</span>
                    <Badge variant="secondary" className="text-[9px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">Easiest</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>Install <a href="https://nodejs.org" target="_blank" rel="noopener" className="text-teal-600 dark:text-teal-400 underline underline-offset-2">Node.js 18+</a></li>
                    <li>Download & extract the agent package</li>
                    <li>Double-click <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">start.bat</code></li>
                    <li>Copy the generated API Key</li>
                  </ol>
                </div>

                {/* Method 2: EXE Installer */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-violet-100 dark:bg-violet-900/30">
                      <Monitor className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <span className="text-sm font-semibold">EXE Installer (Inno Setup)</span>
                    <Badge variant="secondary" className="text-[9px] bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">Professional</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>Build the installer on a Windows machine: <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">build-installer.bat</code></li>
                    <li>Distribute <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">dashboard-agent-setup.exe</code></li>
                    <li>Run the installer wizard on target device</li>
                    <li>Configure port &amp; API Key during setup</li>
                  </ol>
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-6">⚠ Requires Inno Setup installed on build machine</p>
                </div>

                {/* Method 3: Windows Service */}
                <div className="rounded-lg border p-3.5 space-y-2 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded bg-amber-100 dark:bg-amber-900/30">
                      <Shield className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <span className="text-sm font-semibold">Windows Service (Auto-start)</span>
                    <Badge variant="secondary" className="text-[9px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">Production</Badge>
                  </div>
                  <ol className="text-xs text-muted-foreground space-y-1 pl-6 list-decimal">
                    <li>Run PowerShell as Administrator</li>
                    <li>Execute: <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">.\install-service.ps1 -Port 3100</code></li>
                    <li>Agent starts automatically with Windows</li>
                    <li>Manage: <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">Start-Service DashboardAgent</code></li>
                  </ol>
                </div>
              </div>
            </div>

            <Separator />

            {/* Configuration Reference */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Settings className="h-4 w-4 text-zinc-500" />
                Configuration
              </h4>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left p-2.5 font-medium text-muted-foreground">Parameter</th>
                      <th className="text-left p-2.5 font-medium text-muted-foreground">Default</th>
                      <th className="text-left p-2.5 font-medium text-muted-foreground">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {[
                      { param: '--port', default: '3100', desc: 'HTTP server port' },
                      { param: '--apiKey', default: 'Auto-generated', desc: 'Authentication token for Dashboard' },
                      { param: '--name', default: 'Hostname', desc: 'Agent display name' },
                      { param: '--config', default: '—', desc: 'Path to JSON config file' },
                      { param: '--install-service', default: '—', desc: 'Install as Windows Service (admin)' },
                      { param: '--uninstall-service', default: '—', desc: 'Remove Windows Service (admin)' },
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
                Firewall Configuration
              </h4>
              <p className="text-xs text-muted-foreground">Open the Agent port in Windows Firewall to allow Dashboard connections:</p>
              <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                <div className="text-zinc-500">:: Run as Administrator</div>
                <div className="text-zinc-300">netsh advfirewall firewall add rule name=&quot;Dashboard Agent&quot; dir=in action=allow protocol=TCP localport=3100</div>
              </div>
            </div>

            <Separator />

            {/* File Structure */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Folder className="h-4 w-4 text-sky-500" />
                Package Contents
              </h4>
              <div className="rounded-md bg-muted/30 dark:bg-zinc-800/30 p-3 font-mono text-xs space-y-0.5">
                <div className="text-zinc-500">📁 dashboard-agent-windows/</div>
                <div className="text-zinc-400 pl-4">📄 agent.js <span className="text-zinc-600 ml-2">— Main agent server</span></div>
                <div className="text-zinc-400 pl-4">📄 package.json <span className="text-zinc-600 ml-2">— Dependencies</span></div>
                <div className="text-zinc-400 pl-4">📄 setup.js <span className="text-zinc-600 ml-2">— Interactive setup wizard</span></div>
                <div className="text-zinc-400 pl-4">📄 start.bat <span className="text-zinc-600 ml-2">— Quick start script</span></div>
                <div className="text-zinc-400 pl-4">📄 install-service.ps1 <span className="text-zinc-600 ml-2">— Windows Service installer</span></div>
                <div className="text-zinc-400 pl-4">📄 uninstall-service.ps1 <span className="text-zinc-600 ml-2">— Service uninstaller</span></div>
                <div className="text-zinc-400 pl-4">📄 agent-installer.iss <span className="text-zinc-600 ml-2">— Inno Setup script</span></div>
                <div className="text-zinc-400 pl-4">📄 build-installer.bat <span className="text-zinc-600 ml-2">— Build EXE installer</span></div>
                <div className="text-zinc-400 pl-4">📁 prisma/ <span className="text-zinc-600 ml-2">— Database schema</span></div>
                <div className="text-zinc-400 pl-4">📄 .env.example <span className="text-zinc-600 ml-2">— Environment template</span></div>
                <div className="text-zinc-400 pl-4">📄 README.md <span className="text-zinc-600 ml-2">— Documentation</span></div>
              </div>
            </div>

            {/* Building EXE from source */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Hammer className="h-4 w-4 text-orange-500" />
                Build Standalone EXE
              </h4>
              <p className="text-xs text-muted-foreground">Create a single-file executable using <code className="px-1 py-0.5 rounded bg-muted dark:bg-zinc-700 text-[10px] font-mono">pkg</code>:</p>
              <div className="rounded-md bg-zinc-900 dark:bg-zinc-950 p-3 font-mono text-xs text-zinc-300 overflow-x-auto">
                <div className="text-zinc-500">:: Install pkg globally</div>
                <div className="text-zinc-300">npm install -g pkg</div>
                <div className="text-zinc-500 mt-2">:: Build for Windows x64</div>
                <div className="text-zinc-300">npm run build:exe</div>
                <div className="text-zinc-500 mt-2">:: Output: dist/dashboard-agent.exe</div>
              </div>
              <p className="text-[10px] text-amber-600 dark:text-amber-400">⚠ Note: Prisma native binaries need to be bundled alongside the exe. Use the Inno Setup method for a complete installer.</p>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t pt-3">
            <div className="flex items-center justify-between w-full">
              <span className="text-[10px] text-muted-foreground">Package location: <code className="font-mono">mini-services/agent-windows/</code></span>
              <Button variant="outline" onClick={() => setAgentDeployGuideOpen(false)}>Close</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toast container */}
      <ToastContainer />
    </div>
  )
}
