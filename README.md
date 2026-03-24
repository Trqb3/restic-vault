# ResticVault

A self-hosted web UI for managing [restic](https://restic.net/) backup repositories and remote backup agents.

ResticVault lets you browse snapshots, monitor backup health, deploy agents to remote machines, and manage everything from a single dashboard — no CLI required.

![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![SvelteKit](https://img.shields.io/badge/SvelteKit-5-FF3E00?logo=svelte&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue)

---

## Features

### Repository Management
- **Browse existing repos** — point ResticVault at a directory of restic repositories and it indexes them automatically
- **Remote repos** — supports local, SFTP, S3, B2, Azure, Google Cloud, Rclone, and REST backends
- **Snapshot browser** — interactive file tree viewer for any snapshot with single-file download and directory-as-ZIP export
- **Statistics** — per-snapshot file change counts, restore sizes, deduplication ratios, and historical size charts
- **Snapshot management** — delete old snapshots directly from the UI

### Backup Sources (Remote Agents)
- **One-line agent install** — deploy a lightweight bash agent to any Linux server with a single `curl | bash` command
- **Push-based backups** — agents push backups to ResticVault via an embedded [rest-server](https://github.com/restic/rest-server)
- **Scheduling** — cron-based backup schedules configured from the UI
- **Retention policies** — keep-last, keep-daily, keep-weekly, keep-monthly, keep-yearly
- **Exclusion rules** — reusable exclusion profiles and per-source backup path configuration
- **Real-time progress** — live backup progress (%, files, bytes, current file) reported during backups
- **Filesystem discovery** — agents scan and report available paths with sizes
- **Remote commands** — trigger backup, discover paths, update agent, or uninstall from the UI
- **Agent self-update** — push agent updates remotely when a new version is available

### Security & Multi-User
- **Role-based access** — `admin` (full access) and `viewer` (read-only, per-repo permissions)
- **Two-factor authentication** — TOTP-based 2FA with QR code enrollment
- **Audit logging** — all logins, API calls, and admin actions are logged with IP and user agent
- **Rate limiting** — per-IP and per-user request throttling
- **Encrypted secrets** — repository passwords, SSH keys, and email credentials stored with AES-256-GCM
- **Token authentication** — agents authenticate with bcrypt-verified bearer tokens

### Notifications
- **Email providers** — SMTP, SendGrid, Mailgun, Resend, and AWS SES
- **Event-driven alerts** — backup failures, login anomalies, and more
- **Scheduled digests** — weekly or monthly summary emails
- **Flexible filters** — per-repository or per-source notification rules

---

## Quick Start

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)

### 1. Clone and configure

```bash
git clone https://github.com/youruser/restic-vault.git
cd restic-vault
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
# Required — use long random strings (32+ characters)
JWT_SECRET=your-jwt-secret-here
SECRET_KEY=your-encryption-key-here

# Path to your existing restic repositories on the host
HOST_REPO_DIR=/srv/restic-repos

# Public URL of your ResticVault instance (for agent install commands)
PUBLIC_URL=https://vault.example.com
```

### 2. Start the container

```bash
docker compose up -d
```

ResticVault starts on **http://localhost:3001**.

### 3. Log in

On first start, a default admin account is created and the credentials are printed to the container logs:

```bash
docker logs restic-vault 2>&1 | grep "Default admin"
```

Change the password immediately after logging in via **Settings > Change Password**.

### 4. Add repositories

ResticVault can work with your backups in two ways:

**Option A: Browse existing repositories**
Mount your existing restic repo directory via `HOST_REPO_DIR` in `.env`. ResticVault scans and indexes them automatically. Repositories are mounted **read-only** — ResticVault never modifies your existing backups.

**Option B: Deploy backup agents**
Create a Backup Source in the UI, then install the agent on any Linux server:

```bash
curl -fsSL https://vault.example.com/agent-install.sh | sudo bash -s -- \
  --server https://vault.example.com \
  --token rvs1_your-token-here \
  --name my-server \
  --paths /home,/etc
```

The agent runs as a systemd service and pushes backups to ResticVault on a configurable schedule.

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | Yes | — | Secret for signing JWT tokens (32+ chars) |
| `SECRET_KEY` | Yes | — | AES-256-GCM key for encrypting stored secrets (32+ chars) |
| `HOST_REPO_DIR` | No | `/volume1/backup` | Host path to existing restic repos (mounted read-only) |
| `REPO_BASE_DIR` | No | `/repos` | Mount point inside the container |
| `PUBLIC_URL` | No | — | Public URL for agent install commands |
| `SOURCES_DIR` | No | `/data/sources` | Directory for backup source repos (must be writable) |
| `PORT` | No | `3001` | Backend HTTP port |
| `DB_PATH` | No | `/data/restic-vault.db` | SQLite database file path |
| `REST_SERVER_BINARY` | No | `rest-server` | Path to rest-server binary |
| `REST_SERVER_PORT` | No | `8079` | Internal rest-server port (localhost only) |
| `RESTIC_BINARY` | No | `restic` | Path to restic binary |
| `RESTIC_TIMEOUT` | No | `120000` | Timeout for restic commands in ms |
| `BACKUP_UID` / `BACKUP_GID` | No | — | Run container as specific user/group (for file permissions) |

### Reverse Proxy (recommended)

ResticVault should sit behind a reverse proxy with TLS termination. Example Nginx config:

```nginx
server {
    listen 443 ssl http2;
    server_name vault.example.com;

    ssl_certificate     /etc/ssl/certs/vault.pem;
    ssl_certificate_key /etc/ssl/private/vault.key;

    client_max_body_size 0;  # unlimited — agents upload backup data

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for long-poll agent connections
        proxy_read_timeout 120s;
    }
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Container                         │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │   SvelteKit  │    │  Express.js  │    │  rest-server   │  │
│  │   Frontend   │◄──►│   Backend    │◄──►│  (embedded)    │  │
│  │  (static)    │    │              │    │  :8079         │  │
│  └──────────────┘    └──────┬───────┘    └───────┬───────┘  │
│                             │                     │          │
│                      ┌──────┴───────┐    ┌───────┴───────┐  │
│                      │   SQLite DB  │    │  /data/sources │  │
│                      │  /data/*.db  │    │  (agent repos) │  │
│                      └──────────────┘    └───────────────┘  │
│                             │                                │
│                      ┌──────┴───────┐                       │
│                      │  restic CLI  │──► /repos (read-only) │
│                      └──────────────┘                       │
└─────────────────────────────────────────────────────────────┘
         ▲                                      ▲
         │ HTTPS                                │ HTTPS
         │                                      │
    ┌────┴────┐                          ┌──────┴──────┐
    │ Browser │                          │ Agent (bash) │
    │  (User) │                          │ on remote    │
    └─────────┘                          │ servers      │
                                         └─────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | SvelteKit 5, Tailwind CSS 4, Chart.js |
| Backend | Express.js, TypeScript, Zod |
| Database | SQLite (better-sqlite3), WAL mode |
| Auth | JWT (HttpOnly cookies), bcrypt, TOTP 2FA |
| Encryption | AES-256-GCM (secrets at rest) |
| Backup Engine | restic 0.17.3, rest-server 0.13.0 |
| Container | Docker (multi-stage build), Node.js 22 |
| Agent | Pure bash + curl + grep (no dependencies beyond restic) |

---

## Agent

The ResticVault agent is a lightweight bash daemon that runs on remote Linux servers. It requires only `bash`, `curl`, and `restic`.

### How it works

1. **Install** — a single `curl | bash` command installs the agent as a systemd service
2. **Connect** — the agent authenticates with ResticVault using a bearer token
3. **Backup** — on schedule (or on demand), the agent runs `restic backup` and pushes data to ResticVault's embedded rest-server
4. **Report** — the agent reports real-time progress, backup results, and discovered filesystem paths

### Agent commands

From the UI, admins can:
- **Trigger backup** — start an immediate backup
- **Discover paths** — scan the remote filesystem for available backup paths
- **Update agent** — push the latest agent version (self-update)
- **Uninstall** — remove the agent and its systemd service

### Agent configuration

Backup paths, exclusion patterns, retention policies, and schedules are all configured from the ResticVault UI and fetched by the agent at runtime.

---

## Administration

### CLI: Create admin user

```bash
docker exec -it restic-vault resticvault-create-admin <username> <password>
```

### User roles

| Role | Capabilities |
|---|---|
| `admin` | Full access: manage repos, sources, users, settings, notifications |
| `viewer` | Read-only access to assigned repositories only |

### Admin Panel

The admin panel (`/admin`) provides:
- **Users** — create, delete, change passwords, assign roles
- **Permissions** — map viewers to specific repositories
- **SSH Connections** — manage SFTP credentials (encrypted private keys)
- **Settings** — indexing interval, repository base directory
- **Audit Logs** — searchable log of all security events
- **Notifications** — configure email providers and alert rules
- **Exclusion Profiles** — reusable backup exclusion pattern sets

---

## Development

### Prerequisites
- Node.js 22+
- Python 3 (for `better-sqlite3` native build)
- npm 10+

### Setup

```bash
git clone https://github.com/youruser/restic-vault.git
cd restic-vault
npm install
```

### Development server

```bash
npm run dev
```

This starts both the backend (Express on `:3001`) and frontend (Vite on `:5173`) concurrently with hot reload.

### Build

```bash
npm run build
```

### Project structure

```
restic-vault/
├── backend/
│   ├── src/
│   │   ├── db/              # SQLite schema & migrations
│   │   ├── middleware/       # Auth (JWT), validation (Zod)
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Business logic (restic, indexer, email, crypto)
│   │   ├── scripts/         # CLI tools
│   │   └── index.ts         # Server entry point
│   └── public/
│       └── agent-install.sh # Agent installer script
├── frontend/
│   ├── src/
│   │   ├── routes/          # SvelteKit pages
│   │   └── lib/             # API client, components, utilities
│   └── static/              # Static assets
├── Dockerfile               # Multi-stage production build
├── docker-compose.yml       # Docker Compose config
└── .env.example             # Environment template
```

---

## API

All endpoints are under `/api`. Authentication is via JWT in HttpOnly cookies.

### Core Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | Login (returns JWT cookie) |
| `POST` | `/api/auth/logout` | Any | Clear session |
| `GET` | `/api/auth/me` | Any | Current user info |
| `GET` | `/api/repos` | Any | List repositories |
| `GET` | `/api/repos/:id` | Any | Repository detail |
| `POST` | `/api/repos` | Admin | Add repository |
| `POST` | `/api/repos/:id/refresh` | Admin | Trigger re-index |
| `GET` | `/api/repos/:id/snapshots` | Any | List snapshots |
| `GET` | `/api/repos/:id/snapshots/:sid/files` | Any | Browse snapshot files |
| `GET` | `/api/sources` | Any | List backup sources |
| `POST` | `/api/sources` | Admin | Create backup source |
| `POST` | `/api/sources/:id/commands` | Admin | Send agent command |

### Agent Endpoints (token auth)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sources/agent/heartbeat` | Agent heartbeat |
| `GET` | `/api/sources/agent/poll` | Long-poll for commands (30s) |
| `POST` | `/api/sources/agent/backup-progress` | Report backup progress |
| `POST` | `/api/sources/agent/backup-result` | Report backup outcome |
| `POST` | `/api/sources/agent/discover` | Report discovered paths |
| `GET` | `/api/sources/agent/version` | Check latest agent version |

---

## Security Considerations

- **Always use HTTPS** in production (via reverse proxy)
- **Set strong secrets** — `JWT_SECRET` and `SECRET_KEY` should be 32+ character random strings
- **Change default credentials** immediately after first login
- **Enable 2FA** for all admin accounts
- **Use `BACKUP_UID`/`BACKUP_GID`** to run the container as a non-root user with appropriate file permissions
- **Repositories are read-only** — existing repos are mounted with `:ro` to prevent accidental modification
- **Tokens are non-reversible** — agent tokens are bcrypt-hashed; the plaintext is shown once at creation

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0)](LICENSE).

You are free to use, modify, and share this software for **non-commercial purposes** with appropriate attribution. Commercial use requires separate permission.
