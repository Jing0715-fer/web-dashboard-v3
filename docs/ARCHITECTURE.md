# System Architecture

This document provides an overview of the web-dashboard-v3 project architecture.

## Overview

web-dashboard-v3 is a Next.js 16 dashboard application that manages both local and remote development environments. It provides a unified interface for managing projects, environments, devices, and LLM configurations across multiple machines.

## Application Structure

### Next.js 16 App Router

The application uses Next.js 16 with the App Router pattern. The main page surface consists of approximately 10,000 lines of page.tsx code distributed across various pages and components.

Key directories:
- `src/app/` - Next.js App Router pages and API routes
- `src/components/` - Reusable UI components
- `src/lib/` - Core application logic and utilities
- `src/types/` - TypeScript type definitions

### API Routes

The application exposes numerous API routes under `src/app/api/` for handling various functionalities:

- **Authentication**: `/api/auth/*` - User login, registration, session management, and Google OAuth
- **Device Management**: `/api/devices/*` - Device registration, health checks, and remote project management
- **Project Management**: `/api/projects/*` - Project CRUD operations, environment management, and analysis
- **LLM Integration**: `/api/llm/*` - LLM configuration and chat completions
- **Harness Engine**: `/api/harness/*` - Project analysis and repair engine
- **Mesh Relay**: `/api/mesh/*` - Device discovery and communication
- **Activity Feed**: `/api/activity` - Global activity logging
- **Admin Functions**: `/api/admin/*` - User management and system settings

## Core Library Layer

The `src/lib/` directory contains the core application logic organized into several modules:

### Authentication & Session Management (`src/lib/auth/`)
- User authentication with credentials and Google OAuth
- Session management and validation
- Role-based access control (admin/user)
- Password hashing and verification

### Database Layer (`src/lib/db/`)
- Prisma client setup and configuration
- Database operations for all models
- Data access patterns

### Activity Logging (`src/lib/activity/`)
- Event logging system for user actions and system events
- Activity feed generation
- Event serialization for remote devices

### Remote Sync (`src/lib/remote-sync/`)
- Device registration and discovery
- Remote project caching
- Device push notifications
- API key management

### Agent Lifecycle (`src/lib/agent-lifecycle/`)
- Local agent detection and management
- Network interface discovery
- Agent health monitoring

### LLM Gateway (`src/lib/llm-gateway/`)
- OpenAI-compatible API endpoint
- Model listing and chat completions
- API key management and masking

### Harness Engine (`src/lib/harness/`)
- Project analysis engine
- Repair workflow management
- Session management for analysis jobs
- Auto-apply functionality

### Process Management (`src/lib/process-manager/`)
- Process lifecycle management (start/stop/restart)
- Log collection and management
- Port management

### Repair Engine (`src/lib/llm-repair/`)
- LLM-based project repair
- CLI delegation for repair tasks
- Repair job management

### Port Management (`src/lib/ports/`)
- Port detection and allocation
- Process identification by port
- Port conflict resolution

### Git Integration (`src/lib/git-branches/`, `src/lib/git-update-check/`)
- Branch listing and management
- Git operations (pull, branch switch)
- Update checking

### Command Allowlisting (`src/lib/cmd-allowlist/`)
- Security controls for allowed commands
- Command validation

## Data Model

The application uses Prisma with SQLite for data persistence. The main models are:

### User Management
- `User` - User accounts with roles and status
- `Session` - User sessions for authentication

### Device Registry
- `Device` - Registered remote devices
- `Project` - Projects associated with devices

### Project Management
- `Project` - Project definitions and metadata
- `Environment` - Project environments with commands and ports

### System Configuration
- `LlmConfig` - LLM provider and repair settings

### Activity Tracking
- `ActivityEvent` - System activity log

## Mini-Services Agents

The system integrates with lightweight agents running on Windows, macOS, and Linux machines:

### Agent Registration
- Agents register with the dashboard via API key authentication
- Device information including IP, port, and status is stored
- Agents maintain heartbeat connections for status updates

### Agent Functionality
- Project environment management
- Local process management
- Git operations
- LLM integration
- Health reporting

### Communication
- Agents communicate with the dashboard over HTTP
- WebSocket connections for real-time updates
- Secure API key authentication

## Runtime Topology

### Development Mode
- Single-process Next.js application running in dev mode
- In-memory SQLite database (or file-based for persistence)
- Local agent process running on the same machine
- All mini-services co-located

### Production Mode
- Next.js application running as a standalone service
- Persistent SQLite database
- Remote agents running on separate machines
- Load balancing and horizontal scaling possible

### Network Topology
- Dashboard serves as central coordination point
- Agents register and communicate via HTTP API
- Mesh relay enables device discovery
- WebSocket connections for real-time updates

## Security

- Authentication via credentials or Google OAuth
- Role-based access control
- API key management for device authentication
- Command allowlisting for security
- Secure session management

## Integration Points

- Git repositories for project management
- LLM providers for analysis and repair
- Local system processes for environment management
- Network services for device communication
