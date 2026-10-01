# Agent Bridge

A small authenticated HTTPS relay for agent messages, selected filesystem context, and file attachments. Run a connector on each computer; your existing agent uses the `bridge` CLI through a project-local skill. No MCP server or hosted model is required.

```text
Laptop agent -> bridge CLI -> Railway relay <- VM connector -> shared VM folder
```

Both clients connect outward. File requests work while the connector is running, even if that computer's AI agent is idle. Agent messages remain in a mailbox until an active peer checks it. The bridge does not wake an existing chat, invoke a model, or share chat history automatically.

## Live deployment

Relay origin: `https://agent-bridge-production-2405.up.railway.app`. The [health check](https://agent-bridge-production-2405.up.railway.app/healthz) is public; API calls require a device token. Railway is connected to this repository's `main` branch, with successful GitHub checks required before automatic deployment.

On a laptop with the Railway CLI already signed in, register a device without printing the administrator secret:

```sh
bridge config set --url https://agent-bridge-production-2405.up.railway.app
npx @railway/cli run --service agent-bridge -- node dist/cli.js register laptop
```

Then select a shared root, install the skill into your participating project, and run `bridge connect` as shown below. Other computers need their own registered token and selected folders.

## Build and run locally

Requires Node.js 24 or newer on each computer. Clone this repo, then:

```sh
npm ci
npm run check
npm run build
npm link
```

Generate an administrator secret and keep it in your terminal environment:

```sh
export ADMIN_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export DATA_DIR="./data"
export HOST="127.0.0.1"
npm start
```

The server does not load `.env` automatically; use environment variables or Node's `--env-file` option with an ignored local file. On Railway, configure service variables in Railway. Never commit administrator secrets or client tokens.

## Set up each computer

In a second terminal on the laptop, with the same administrator secret temporarily available:

```sh
bridge config set --url http://127.0.0.1:3000
bridge register laptop --token-env ADMIN_TOKEN
bridge root add projects /absolute/path/to/shared/project
bridge skill install --project /absolute/path/to/participating/project
bridge connect
```

On the VM, use the Railway HTTPS URL and register a different device name:

```powershell
bridge config set --url https://YOUR-SERVICE.up.railway.app
bridge register vm --token-env ADMIN_TOKEN
bridge root add work 'C:\Work\Project'
bridge skill install --project 'C:\Work\Project'
bridge connect
```

Supply `ADMIN_TOKEN` through that terminal's environment for registration, then remove it after setup. Registration stores only the returned device token. `bridge connect` must remain running for remote folder requests. Each shared root is read-only; use dedicated folders rather than sharing your home directory. A connector refuses traversal, absolute paths, escaping symlinks, binary text reads, and common credential/build directories. These exclusions are safeguards, not a substitute for selecting folders you intend to share.

Local configuration defaults to `~/.agent-bridge/config.json`; set `BRIDGE_CONFIG` to choose another file, useful for two test devices on one machine. `bridge config show` redacts credentials. POSIX configuration permissions are restricted; on Windows keep it in your user profile with its normal user-only access controls. The copied skill is project-scoped, so install it into every participating project on each host. Install the CLI with `npm link` on each host as well.

## Ask with both contexts

```sh
bridge devices
bridge list --device vm --root work --path src
bridge search --device vm --root work --path src --query reconciliation
bridge read --device vm --root work --path src/reconciliation.ts
```

Your agent can combine these results with its local files. Results include source device, shared root, relative path, modification time, and truncation indicators. Text reads cap at 256 KiB; listings and searches cap at 100 results. A missing remote file or offline connector is reported explicitly.

## Transfer files and messages

```sh
# On the laptop. Record the returned file ID.
bridge upload ./report.xlsx
bridge send --to vm --text 'Compare this with your local export.' --attach FILE_ID

# On the VM.
bridge inbox --wait 25
bridge download FILE_ID --output ./context/report.xlsx

# Inspect and clean up attachments.
bridge files
bridge file FILE_ID
bridge delete FILE_ID
```

An ordinary inbox call advances the saved cursor after returning messages. Use `--after 0` to explicitly reread history; explicit cursor reads do not advance the saved cursor. Use the returned cursor for additional pages. A message submission can supply `--idempotency-key` for retries across separate CLI runs. The client retains generated keys across retries within one call.

Uploads and downloads stream file bytes; long polling carries small JSON messages and request metadata. Uploads become visible only after successful completion. Downloads verify the expected byte count and SHA-256 before finalizing the destination and refuse overwrites. File IDs are identifiers, not access credentials. All registered devices belong to one trusted workspace and can read its attachments; only the uploader can delete an attachment.

## Deploy to Railway

The repository includes a Dockerfile and `.railway/railway.ts` using Railway's current infrastructure format. Preview it with `npx @railway/cli config plan` and apply with `npx @railway/cli config apply`. It preserves secrets already configured on Railway. Deploy one service, mount a persistent volume at `/data`, set `ADMIN_TOKEN` to a new random secret of at least 32 characters, and set `DATA_DIR=/data`. Generate a public HTTPS domain. Keep one replica and disable serverless sleeping so connectors remain responsive. Configure volume ownership for the container's `node` user (UID 1000); Railway mounts can require `RAILWAY_RUN_UID=0` if ownership cannot be changed.

The service binds `0.0.0.0` and uses Railway's `PORT`. `/healthz` is the public health endpoint. SQLite metadata, uploads, and online database backups live on the volume. Daily SQLite backups retain seven snapshots; they do not independently back up attachment bytes. Railway full-volume backups, including attachment bytes, require the Pro plan. They are not enabled on the initial deployment's existing plan; the service's daily SQLite backups remain active. Volume deployment requires brief downtime; clients reconnect automatically.

For CLI deployment after `npx @railway/cli login`, use `railway init`, add the service and volume, set variables, apply the infrastructure configuration, then run `railway up` and `railway domain`. The Railway CLI can upload this checkout without GitHub integration. Alternatively connect the service to `henry-md/agent-bridge` on GitHub.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | required | Administrator registration/revocation secret, at least 32 characters |
| `DATA_DIR` | `./data` | Persistent SQLite, uploads, and backup directory |
| `HOST` | `0.0.0.0` | Listener host; use loopback for local development |
| `PORT` | `3000` | Railway supplies this automatically |
| `MAX_UPLOAD_BYTES` | `26214400` | 25 MiB maximum individual file |
| `UPLOAD_QUOTA_BYTES` | `1073741824` | 1 GiB total completed and in-progress upload quota |

For hundreds-of-megabytes or gigabyte transfers, add direct private object-storage uploads and resumable multipart transfer in a later version. Raising the application cap alone does not remove Railway's five-minute upload deadline.

## API and access model

See [docs/api.md](docs/api.md) for endpoints. Use bearer tokens in the `Authorization` header; credentials in URLs are unsupported. Device tokens are stored as hashes on the relay. Administrator credentials only register and revoke devices; use a device token for everyday operations.

The relay itself can see messages, attachments, and file results: HTTPS protects transit, not end-to-end encryption. Configure only work files that may be shared through the chosen deployment. Uploaded files are served as downloads, never executed by the server. Remote roots expose no shell or filesystem write operation.

The default poll is 25 seconds, heartbeat 15 seconds, offline threshold 60 seconds, and file-request lifetime 60 seconds. Read-only request leases allow a connector to recover after disconnect. Revoking a device cancels its access; delete attachments separately if you no longer need them.

## Validation

```sh
npm run check
npm run build
```

Tests cover real HTTP transfers and connector requests, checksums, unauthorized access, revocation, traversal and symlink escapes, interrupted/oversized uploads, duplicate retries, reconnects, request expiry, and restart persistence. GitHub Actions runs the same suite on macOS and Windows with Node 24. Passing native suites validates behavior on each OS; a live two-computer deployment additionally requires both hosts' connectors and authorized shared folders.
