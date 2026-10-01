# One-time setup

The relay origin is `https://agent-bridge-production-2405.up.railway.app`. Use a distinct registered device token on each computer. The source is https://github.com/henry-md/agent-bridge. Node.js 24 or newer is required.

If the CLI is unavailable, locate an existing checkout of `agent-bridge` first. Otherwise clone that repository into the user's developer directory. In the checkout run `npm ci`, `npm run build`, and `npm link`. Use `node /absolute/path/to/agent-bridge/dist/cli.js` if the linked command is not yet on PATH. Install this skill for all Codex projects with `bridge skill install --user`, and for Claude Code with `bridge skill install --claude`; use `--force` only to update this same skill. Project-local installation remains available with `--project PATH`. If the checkout path contains `&` on Windows, npm scripts fail inside `cmd.exe`; run `node node_modules/typescript/bin/tsc -p tsconfig.json` instead of `npm run build`.

Check `bridge config show`, which redacts the token. Configure the origin with `bridge config set --url https://agent-bridge-production-2405.up.railway.app`. Keep the default configuration in the user's profile, outside Git.

If this computer has not been registered and Railway CLI is signed in and linked to this project, register without printing its administrator secret:

```sh
npx @railway/cli run --service agent-bridge -- node dist/cli.js register laptop
```

Use `vm` instead of `laptop` on the VM. If Railway administrator access is unavailable, ask for a separately issued device token through a private local configuration or environment variable. Do not ask the user to paste credentials into chat. Configure an existing token with `bridge config set --url URL --device NAME --token-env BRIDGE_TOKEN`; remove the temporary environment variable after saving. Do not replace a working device token or revoke another device just to join a channel.

After registration, `/agent-bridge 4040` can pair active agents. File sharing is optional and separate: add only user-selected folders with `bridge root add ALIAS PATH`, then run `bridge connect` on that computer. A missing connector does not prevent channel messages or the matching-word confirmation.
