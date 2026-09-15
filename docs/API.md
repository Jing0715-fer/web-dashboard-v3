# REST API Reference

This document provides a complete reference for all REST API endpoints in the web-dashboard-v3 project. All API responses are in JSON format.

## Authentication Requirements
- **Public**: No authentication required
- **Approved User**: Requires a valid session from an approved user
- **Admin**: Requires admin privileges

## Table of Contents
- [Authentication](#authentication)
- [Projects](#projects)
- [Environments](#environments)
- [Devices](#devices)
- [LLM Configuration](#llm-configuration)
- [Harness Analysis](#harness-analysis)
- [Mesh Network](#mesh-network)
- [Admin](#admin)
- [Other](#other)

## Authentication

### Login
- **POST** `/api/auth/login`
  - **Auth**: Public
  - **Body**: `{ email: string, password: string }`
  - **Response**: `{ ok: boolean, user: PublicUser }` or `{ error: string }`

### Logout
- **POST** `/api/auth/logout`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean, revoked: boolean }`

### Register
- **POST** `/api/auth/register`
  - **Auth**: Public
  - **Body**: `{ name: string, email: string, password: string }`
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Change Password
- **POST** `/api/auth/change-password`
  - **Auth**: Approved User
  - **Body**: `{ currentPassword: string, newPassword: string }`
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Session
- **GET** `/api/auth/session`
  - **Auth**: Approved User
  - **Response**: `{ user: PublicUser | null, showSeedHint: boolean }`

### Google OAuth
- **GET** `/api/auth/google`
  - **Auth**: Public
  - **Response**: 302 redirect to Google OAuth or 501 error if not configured
- **GET** `/api/auth/google/callback`
  - **Auth**: Public
  - **Response**: 302 redirect with session cookie or error
- **GET** `/api/auth/google/status`
  - **Auth**: Public
  - **Response**: `{ configured: boolean, redirectUri: string, clientIdMasked: string | null }`

### Sessions Management
- **GET** `/api/auth/sessions[?scope=all]`
  - **Auth**: Approved User
  - **Response**: `{ sessions: SessionInfo[], count: number }`
- **DELETE** `/api/auth/sessions/[id]`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`

## Projects

### Project Operations
- **GET** `/api/projects`
  - **Auth**: Approved User
  - **Response**: `{ projects: Project[], count: number }`
- **POST** `/api/projects`
  - **Auth**: Approved User
  - **Body**: `{ name: string, path: string, deviceId?: string }`
  - **Response**: `{ project: Project }` or `{ error: string }`
- **GET** `/api/projects/[id]`
  - **Auth**: Approved User
  - **Response**: `{ project: Project }` or 404
- **PUT** `/api/projects/[id]`
  - **Auth**: Approved User
  - **Body**: `{ name?: string, description?: string, notes?: string }`
  - **Response**: `{ project: Project }` or `{ error: string }`
- **DELETE** `/api/projects/[id]`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`
- **POST** `/api/projects/[id]/duplicate`
  - **Auth**: Approved User
  - **Response**: `{ project: Project }` or `{ error: string }`
- **POST** `/api/projects/[id]/move`
  - **Auth**: Approved User
  - **Body**: `{ targetDeviceId: string | null }`
  - **Response**: `{ project: Project }` or `{ error: string }`
- **POST** `/api/projects/reorder`
  - **Auth**: Approved User
  - **Body**: `{ order: Array<{ id: string }> }`
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Project Activity
- **GET** `/api/projects/[id]/activity`
  - **Auth**: Approved User
  - **Response**: `{ events: SerializedActivityEvent[] }`

### Project Analysis
- **POST** `/api/projects/[id]/analyze`
  - **Auth**: Approved User
  - **Query**: `?replace=true` (optional)
  - **Body**: `{ maxAttempts?: number }`
  - **Response**: `{ analysisId: string }` or `{ error: string }`
- **POST** `/api/projects/[id]/analyze-cli`
  - **Auth**: Approved User
  - **Query**: `?replace=true` (optional)
  - **Response**: `{ analysisId: string }` or `{ error: string }`
- **POST** `/api/projects/[id]/apply-analysis`
  - **Auth**: Approved User
  - **Body**: `{ analysis: { projectName: string, description: string, icon: string, environments: Array, summary: string } }`
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Project Git Operations
- **GET** `/api/projects/[id]/branches[?fetch=1]`
  - **Auth**: Approved User
  - **Response**: `{ branches: Array<{ name: string, current: boolean }> }` or `{ error: string }`
- **POST** `/api/projects/[id]/pull`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean, branch?: string }` or `{ error: string }`

### Project Logs
- **GET** `/api/projects/[id]/logs`
  - **Auth**: Approved User
  - **Query**: `?limit=N` (optional)
  - **Response**: `{ logs: LogEntry[] }`

## Environments

### Environment Operations
- **GET** `/api/projects/[id]/environments`
  - **Auth**: Approved User
  - **Response**: `{ environments: Environment[] }`
- **POST** `/api/projects/[id]/environments`
  - **Auth**: Approved User
  - **Body**: `{ name: string, cmd: string, port: number, envVars: Record<string, string> }`
  - **Response**: `{ environment: Environment }` or `{ error: string }`
- **GET** `/api/projects/[id]/environments/[envId]`
  - **Auth**: Approved User
  - **Response**: `{ environment: Environment }` or 404
- **PUT** `/api/projects/[id]/environments/[envId]`
  - **Auth**: Approved User
  - **Body**: `{ name?: string, cmd?: string, port?: number, envVars?: Record<string, string> }`
  - **Response**: `{ environment: Environment }` or `{ error: string }`
- **DELETE** `/api/projects/[id]/environments/[envId]`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Environment Control
- **POST** `/api/projects/[id]/environments/[envId]/start`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`
- **POST** `/api/projects/[id]/environments/[envId]/stop`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`
- **POST** `/api/projects/[id]/environments/[envId]/restart`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`
- **POST** `/api/projects/[id]/environments/[envId]/rebuild`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Environment Logs
- **GET** `/api/projects/[id]/environments/[envId]/logs`
  - **Auth**: Approved User
  - **Query**: `?limit=N` (optional)
  - **Response**: `{ logs: LogEntry[] }`

## Devices

### Device Management
- **GET** `/api/devices`
  - **Auth**: Approved User
  - **Response**: `{ devices: Device[], count: number }`
- **POST** `/api/devices`
  - **Auth**: Approved User
  - **Body**: `{ name: string, ip: string, port: number }`
  - **Response**: `{ device: Device }` or `{ error: string }`
- **GET** `/api/devices/[id]`
  - **Auth**: Approved User
  - **Response**: `{ device: Device }` or 404
- **PUT** `/api/devices/[id]`
  - **Auth**: Approved User
  - **Body**: `{ name?: string, ip?: string, port?: number }`
  - **Response**: `{ device: Device }` or `{ error: string }`
- **DELETE** `/api/devices/[id]`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Device Health
- **POST** `/api/devices/[id]/health`
  - **Auth**: Approved User
  - **Response**: `{ status: 'online' | 'offline', detectedPort?: number }` or `{ error: string }`

### Remote Analysis
- **POST** `/api/devices/[id]/analyze-remote`
  - **Auth**: Approved User
  - **Body**: `{ path: string, name?: string, usedPorts?: number[] }`
  - **Response**: `{ jobId: string }` or `{ error: string }`
- **GET** `/api/devices/[id]/analyze-remote?jobId=...`
  - **Auth**: Approved User
  - **Response**: `{ status: string, result?: any }` or `{ error: string }`

## LLM Configuration

### LLM Settings
- **GET** `/api/llm-config`
  - **Auth**: Approved User
  - **Response**: `{ config: LlmConfig }`
- **PUT** `/api/llm-config`
  - **Auth**: Admin
  - **Body**: `{ provider: string, apiKey: string, baseUrl: string, model: string, repairMode: 'legacy' | 'cli', repairCli: string }`
  - **Response**: `{ config: LlmConfig }` or `{ error: string }`

### LLM Models
- **GET** `/api/llm-config/models?provider=X&apiKey=Y&baseUrl=Z`
  - **Auth**: Approved User
  - **Response**: `{ models: Model[], warning?: string }`

### Repair CLI Detection
- **GET** `/api/llm-config/detect-repair-cli`
  - **Auth**: Approved User
  - **Response**: `{ clis: Array<{ id: string, name: string, version: string, installed: boolean }> }`

### LLM Gateway
- **GET** `/api/llm/v1/models`
  - **Auth**: Public
  - **Response**: `{ data: Model[] }`
- **POST** `/api/llm/v1/chat/completions`
  - **Auth**: Public
  - **Body**: `{ model: string, messages: Array<{ role: string, content: string }>, temperature?: number, max_tokens?: number }`
  - **Response**: `{ id: string, object: string, created: number, model: string, choices: Array<{ message: { role: string, content: string } }>, usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number } }` or `{ error: string }`

## Harness Analysis

### Engine Health
- **GET** `/api/harness/health`
  - **Auth**: Approved User
  - **Response**: `{ status: 'healthy' | 'unhealthy', details?: string }`

### Analysis Sessions
- **POST** `/api/harness/analyze`
  - **Auth**: Approved User
  - **Body**: `{ path: string, name?: string, usedPorts?: number[], maxAttempts?: number, projectId?: string }`
  - **Response**: `{ sessionId: string, ...sessionView }` or `{ error: string }`
- **GET** `/api/harness/sessions`
  - **Auth**: Approved User
  - **Response**: `{ sessions: SessionView[], count: number }`
- **GET** `/api/harness/sessions/[id]`
  - **Auth**: Approved User
  - **Response**: `{ session: SessionView }` or 404
- **POST** `/api/harness/sessions/[id]/cancel`
  - **Auth**: Approved User
  - **Response**: `{ session: SessionView }` or 404
- **GET** `/api/harness/sessions/[id]/events`
  - **Auth**: Approved User
  - **Response**: SSE stream of session events

## Mesh Network

### Mesh Operations
- **POST** `/api/mesh/[action]`
  - **Auth**: Approved User
  - **Actions**: `discover`, `ping`, `info`
  - **Response**: Varies by action
- **POST** `/api/mesh/apply-remote`
  - **Auth**: Approved User
  - **Body**: `{ device: { id: string, ip: string, port: number, apiKey: string }, path: string, name: string, analysis: any, autoStart: boolean }`
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Network Information
- **GET** `/api/network-info`
  - **Auth**: Approved User
  - **Response**: `{ interfaces: Array<{ name: string, addresses: string[] }> }`

## Admin

### Admin Settings
- **GET** `/api/admin/settings`
  - **Auth**: Admin
  - **Response**: `{ google: { configured: boolean, clientIdMasked: string | null }, registration: boolean }`
- **PUT** `/api/admin/settings`
  - **Auth**: Admin
  - **Body**: `{ google?: { clientId: string, clientSecret: string }, registration: boolean }`
  - **Response**: `{ settings: AdminSettings }` or `{ error: string }`

### User Management
- **GET** `/api/admin/users`
  - **Auth**: Admin
  - **Response**: `{ users: AdminUser[], pendingCount: number }`
- **PATCH** `/api/admin/users/[id]`
  - **Auth**: Admin
  - **Body**: `{ action: 'approve' | 'reject' | 'setRole' | 'reactivate', reason?: string, role?: 'admin' | 'user' }`
  - **Response**: `{ user: AdminUser }` or `{ error: string }`

### Activity Feed
- **GET** `/api/activity`
  - **Auth**: Approved User
  - **Response**: `{ events: SerializedActivityEvent[] }`

## Other

### Ports
- **GET** `/api/ports`
  - **Auth**: Approved User
  - **Response**: `{ ports: Array<{ pid: number, port: number, command: string, project?: string, environment?: string }> }`
- **POST** `/api/ports/kill`
  - **Auth**: Approved User
  - **Body**: `{ pid?: number, port?: number }` (exactly one required)
  - **Response**: `{ ok: boolean }` or `{ error: string }`

### Notifications
- **GET** `/api/notifications`
  - **Auth**: Approved User
  - **Response**: `{ notifications: Notification[] }`
- **POST** `/api/notifications/read/[id]`
  - **Auth**: Approved User
  - **Response**: `{ ok: boolean }`

### Health Check
- **GET** `/api/health-check?ports=...`
  - **Auth**: Approved User
  - **Query**: `ports` (comma-separated list)
  - **Response**: `{ status: 'ok' | 'error', details?: string }` or `{ error: string }`

### Gateway Status
- **GET** `/api/gateway/status`
  - **Auth**: Approved User
  - **Response**: `{ status: 'running', uptime: string, version: string }`

### OpenClaw Integration
- **GET** `/api/openclaw/dashboard-url`
  - **Auth**: Approved User
  - **Response**: `{ url: string }` or `{ error: string }`
- **GET** `/api/openclaw/proxy?path=...`
  - **Auth**: Approved User
  - **Response**: Proxy response from OpenClaw
- **ALL** `/api/openclaw-proxy/*`
  - **Auth**: Approved User
  - **Response**: Proxy response from OpenClaw
