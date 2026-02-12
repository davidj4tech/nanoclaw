# NanoClaw on Termux (Android) with Matrix

This guide covers running NanoClaw on Android via Termux, using Matrix as the messaging channel instead of WhatsApp, and running agents directly on the host without containers.

## Prerequisites

- [Termux](https://termux.dev) installed on Android
- [termux-services](https://wiki.termux.com/wiki/Termux-services) package installed (`pkg install termux-services`)
- Node.js 20+ (`pkg install nodejs`)
- SQLite (`pkg install sqlite`)
- A Matrix homeserver and bot account
- Claude Code CLI installed and authenticated

## 1. Clone and Install

```bash
cd ~/projects
git clone <repo-url> nanoclaw
cd nanoclaw
npm install
```

## 2. Configure Environment

Create `.env` in the project root:

```env
CLAUDE_CODE_OAUTH_TOKEN=<your-claude-token>

# Assistant Configuration
ASSISTANT_NAME=Pixie

# Matrix Configuration
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_USER_ID=@botname:example.com
MATRIX_PASSWORD=your-password

# Termux/Android: Use home directory for temp files
TMPDIR=/data/data/com.termux/files/home/.tmp
```

Create the temp directory:

```bash
mkdir -p ~/.tmp
```

### Getting the Claude Token

In a separate terminal:

```bash
claude setup-token
```

Follow the browser login flow, then copy the token into `.env`.

## 3. Authenticate Matrix

```bash
npm run auth
```

This will:
- Log in to your Matrix homeserver
- Save the session to `store/matrix-session.json`
- List all rooms the bot can see

**Important:** The bot's room must be **unencrypted**. The bot cannot decrypt E2EE messages without a full crypto store setup. If your room is encrypted, create a new unencrypted room.

## 4. Register Your Main Channel

Find the room ID from the `npm run auth` output (format: `!roomid:server`).

Create `data/registered_groups.json`:

```json
{
  "!YOUR_ROOM_ID:server": {
    "name": "main",
    "folder": "main",
    "trigger": "@YourBotName",
    "added_at": "2026-01-01T00:00:00.000Z",
    "requiresTrigger": false
  }
}
```

Create the group directory:

```bash
mkdir -p groups/main/logs
```

## 5. Build

```bash
npm run build
```

## 6. Test

Run in the foreground first to verify everything works:

```bash
npm run dev
```

You should see:
- "Database initialized"
- "Matrix client synced and ready"
- "NanoClaw running (trigger: @YourBotName)"

Send a message in your Matrix room. The bot should respond.

Press `Ctrl+C` to stop once verified.

## 7. Set Up as a Service

The service files are at:

```
$PREFIX/var/service/nanoclaw/run       # Main service script
$PREFIX/var/service/nanoclaw/log/run   # Log handler
```

Create the service directory:

```bash
mkdir -p $PREFIX/var/service/nanoclaw/log
```

Create `$PREFIX/var/service/nanoclaw/run`:

```sh
#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export TMPDIR=$HOME/.tmp
export PATH=/data/data/com.termux/files/usr/bin:$PATH

cd /data/data/com.termux/files/home/projects/nanoclaw
exec node dist/index.js 2>&1
```

Create `$PREFIX/var/service/nanoclaw/log/run`:

```sh
#!/data/data/com.termux/files/usr/bin/sh
pwd=${PWD%/*}
service=${pwd##*/}

mkdir -p "$LOGDIR/sv/$service"

exec svlogd -tt "$LOGDIR/sv/$service"
```

Make both executable:

```bash
chmod +x $PREFIX/var/service/nanoclaw/run
chmod +x $PREFIX/var/service/nanoclaw/log/run
```

## 8. Manage the Service

```bash
sv up nanoclaw        # Start
sv status nanoclaw    # Check status (shows PID and uptime)
sv stop nanoclaw      # Stop
sv restart nanoclaw   # Restart (after rebuilding)
sv down nanoclaw      # Stop and keep down
```

View logs:

```bash
cat $LOGDIR/sv/nanoclaw/current | tail -30
```

The service auto-restarts on crash and starts when Termux launches (if `termux-services` is running).

## Architecture Notes

### No-Container Mode

On Termux, NanoClaw runs agents directly on the host instead of in containers:

- The agent runner spawns `claude -` (Claude Code CLI reading from stdin)
- Working directory is set to the group's folder (`groups/main/`)
- No filesystem isolation between agents and the host

### Matrix Channel

The Matrix integration (`src/channels/matrix.ts`):

- Uses `matrix-js-sdk` for connection and messaging
- Auto-accepts room invites
- Handles both `m.room.message` and `m.room.encrypted` event types
- Supports typing indicators
- Queues outbound messages when disconnected

### Key Differences from Default Setup

| Feature | Default (macOS) | Termux |
|---------|----------------|--------|
| Channel | WhatsApp | Matrix |
| Container | Apple Container / Docker | None (direct host) |
| Service | launchd | termux-services (runit) |
| Temp dir | /tmp | ~/.tmp |

## Troubleshooting

### Build fails with EACCES /tmp

Ensure `TMPDIR` is set in your npm scripts (already configured in `package.json`):

```json
"build": "TMPDIR=$HOME/.tmp tsc"
```

### Bot doesn't receive messages

- Verify the room is **unencrypted** (encrypted messages show as `m.room.encrypted` with no body)
- Check the room ID matches what's in the database:
  ```bash
  sqlite3 store/messages.db "SELECT * FROM registered_groups;"
  ```
- Ensure the bot has joined the room (check logs for "Successfully joined room")

### Bot receives messages but doesn't respond

- Check agent logs: `ls -la groups/main/logs/`
- Read the latest log: `cat groups/main/logs/agent-*.log | tail -50`
- Verify `claude` CLI is installed and authenticated: `claude --version`

### zsh history expansion errors with `!`

When running sqlite3 commands containing `!` (Matrix room IDs):

```bash
# Option 1: Write SQL to a file
echo "SELECT * FROM registered_groups;" > query.sql
sqlite3 store/messages.db < query.sql

# Option 2: Disable history expansion
setopt NO_BANG_HIST
```

### Service won't start

Check the service logs:

```bash
cat $LOGDIR/sv/nanoclaw/current | tail -20
```

Verify the run script is executable:

```bash
ls -la $PREFIX/var/service/nanoclaw/run
```
