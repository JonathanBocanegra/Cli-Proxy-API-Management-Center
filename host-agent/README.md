# WSL host agent

The Host Monitor page reads live Linux and WSL metrics from a small, read-only companion service.
It samples `/proc`, `/sys`, filesystem statistics, and three service states; it cannot execute browser
requests as shell commands or mutate the host.

The agent listens on `127.0.0.1:8320` by default and protects telemetry with the same bearer key as
CLI Proxy API. Its default key file is `~/.config/cliproxyapi/management-key`.

## Install

```bash
bun install --frozen-lockfile
bun run host-agent:build
install -Dm755 build/cliproxy-host-agent ~/.local/bin/cliproxy-host-agent
install -Dm644 host-agent/cliproxy-host-agent.service \
  ~/.config/systemd/user/cliproxy-host-agent.service
systemctl --user daemon-reload
systemctl --user enable --now cliproxy-host-agent.service
```

Publish it as a path beside the management UI, restricted to the tailnet by Tailscale Serve:

```bash
tailscale serve --bg --https=8317 --set-path=/host http://127.0.0.1:8320
```

The browser then requests `/host/v1/snapshot` on the current management origin. No additional
credential is stored in the UI.

## Configuration

The service accepts these optional environment variables:

- `HOST_AGENT_HOST` — bind address, default `127.0.0.1`
- `HOST_AGENT_PORT` — listen port, default `8320`
- `HOST_AGENT_KEY_FILE` — bearer-key file, default `~/.config/cliproxyapi/management-key`

Keep the bind address on loopback when using the supplied Tailscale route. The unauthenticated
`/healthz` endpoint only returns a static status; `/v1/snapshot` always requires the bearer key.
