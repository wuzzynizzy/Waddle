# Install and run

Waddle has no runtime npm dependencies or build step. You need **Node.js 20 or newer**. The quick
installers fetch the source, save a launcher, start Waddle, and open it in your default browser.
Keep the terminal window open; press `Ctrl+C` to stop it.

## One-command install

### macOS or Linux

```sh
curl -fsSL https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.ps1 | iex
```

macOS and Linux also need `curl` and `tar`. Windows uses PowerShell's built-in download and ZIP
support. By default, the source and launcher go in `~/.local/share/waddle` on macOS/Linux or
`%LOCALAPPDATA%\Waddle` on Windows. Re-running the installer updates the source and keeps the `data`
directory.

If you want to inspect an installer before running it, download it first, read it, then run it:

```sh
curl -fsSL https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.sh -o install-waddle.sh
less install-waddle.sh
sh install-waddle.sh
```

The scripts are available at `/install.sh` and `/install.ps1` on a running Waddle. The planned
`waddle.wisp.uno` deployment is **not verified** from this checkout; use the GitHub URLs above unless
you have independently confirmed that domain is live and trusted.

## Start it again later

The installer leaves a small launcher in its install directory. Run it whenever you want to start
Waddle again; it opens the browser when desktop integration is available.

- macOS/Linux: `~/.local/share/waddle/run-waddle.sh`
- Windows: `"%LOCALAPPDATA%\Waddle\run-waddle.cmd"` from Command Prompt, or
  `& "$env:LOCALAPPDATA\Waddle\run-waddle.cmd"` from PowerShell

## Run from a source checkout

```sh
git clone https://github.com/wuzzynizzy/Waddle.git
cd Waddle
./start-waddle.sh
```

On Windows, run `start-waddle.cmd` from Command Prompt or PowerShell. These launchers use the `small`
profile and a 320 MB V8 heap limit by default, then open `http://localhost:8080`. To start without
opening a browser, set `WADDLE_OPEN_BROWSER=0`. Developers can still use `npm start`.

## Keep it private

By default Waddle listens only on this machine at `127.0.0.1:8080`. To share it on a LAN, set a
strong `WADDLE_PASSWORD` and bind to `0.0.0.0`. For internet access, put it behind HTTPS as well.
Do not expose an unauthenticated Waddle or send passwords over plain HTTP. See
[Security](security.md) before sharing it.

## Resource profile

The launchers select `WADDLE_PROFILE=small`, which reduces background pool work and cache sizes. The
320 MB Node heap is a limit on the V8 heap, **not** a cap on total process memory. Neither peak RAM nor
disk use has been benchmarked on a target host, so treat these defaults as starting points, not a
512 MB RAM or 1 GB storage guarantee. Waddle saves settings and live proxy/resolver state as JSON in
`data`; raw source archives, page data and request logs are not persisted.

## Backup and migration

Open **Settings → General → Backup & migration** and choose **Export full backup**. The versioned JSON
includes server settings and sources plus this browser's bookmarks, saved addresses, history, tabs and
appearance preferences. It excludes session cookies, request logs, live proxies, DNS cache and private
server state. Keep the backup private because it may contain browsing history and custom sources.

Choose **Restore backup** on another Waddle to migrate. The importer validates the format and
sanitizes settings and URLs. It replaces the destination's server settings and this browser's local
library, tabs and preferences. If browser storage is full or the server rejects the restore, local
browser data is rolled back on a best-effort basis. See [the API description](api.md#server-settings-backup)
for server-only backups.

## Optional environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Listening port; default `8080`. |
| `HOST` | Bind address; default `127.0.0.1`. |
| `WADDLE_PASSWORD` | Require HTTP Basic authentication; set before sharing Waddle. |
| `WADDLE_USER` | Basic-auth username; default `waddle`. |
| `WADDLE_PROFILE` | `small` for lower default background work; `standard` for larger hosts. |
| `WADDLE_HOME` | Installer destination. |
| `WADDLE_OPEN_BROWSER` | Set to `0` to keep launchers from opening a browser. |

See [Configuration](configuration.md) for advanced settings.
