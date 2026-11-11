# Install and self-host

Waddle is a small Node.js application with no runtime npm dependencies or build step. The platform
installers are single script files that download the source and write a launcher; a standalone native
binary is not currently provided. **Node.js 20 or newer** is required on Windows, macOS and Linux.

## Windows, macOS and Linux installers

The install scripts need internet access to GitHub and Node 20+. On macOS and Linux they also need
`curl` and `tar`; Windows uses PowerShell's built-in download and ZIP support.

### macOS and Linux

Review the script before running it if you prefer not to pipe downloaded code into a shell:

```sh
curl -fsSL https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.sh -o install-waddle.sh
less install-waddle.sh
sh install-waddle.sh
```

Or run the one-command installer:

```sh
curl -fsSL https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.sh | sh
```

It installs under `~/.local/share/waddle` by default. Start Waddle with:

```sh
~/.local/share/waddle/run-waddle.sh
```

To choose another absolute install path, set `WADDLE_HOME` before running the installer. The launcher
uses the `small` resource profile and a 320 MB Node.js heap by default; existing `NODE_OPTIONS` and
`WADDLE_PROFILE` values are respected.

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/wuzzynizzy/Waddle/main/install.ps1 | iex
& "$env:LOCALAPPDATA\Waddle\run-waddle.cmd"
```

The default install directory is `%LOCALAPPDATA%\Waddle`. Set `$env:WADDLE_HOME` to choose another
location before installing. Start Waddle from Command Prompt with
`"%LOCALAPPDATA%\Waddle\run-waddle.cmd"` or from PowerShell with
`& "$env:LOCALAPPDATA\Waddle\run-waddle.cmd"`. The generated launchers use the same `small` profile
and 320 MB heap defaults as the macOS/Linux launcher.

The scripts install source, not an opaque executable: the repository is available at
<https://github.com/wuzzynizzy/Waddle>. Re-running an installer updates the source in place and
leaves the `data` directory in place. Back up settings before moving or replacing an install.

### Hosted installer URLs

When the intended public deployment is configured, the scripts are also served at
`https://waddle.wisp.uno/install.sh` and `https://waddle.wisp.uno/install.ps1`. The repository
contains those routes, but DNS and deployment for `waddle.wisp.uno` have not been verified from this
checkout. Use the GitHub URLs above unless you have confirmed the domain resolves to a trusted Waddle
server.

## Run from a source checkout

```sh
git clone https://github.com/wuzzynizzy/Waddle.git
cd Waddle
npm start
```

Open <http://localhost:8080>. The default bind address is `127.0.0.1`, so Waddle is local to the
machine. `npm start` does not set the `small` profile automatically; use it on a suitably sized host
or start it with `WADDLE_PROFILE=small` and `NODE_OPTIONS=--max-old-space-size=320`.

To expose a non-container install on your LAN, bind to `0.0.0.0` and set a strong password before
starting. For an internet-facing installation, also put Waddle behind HTTPS. See
[Security](security.md) and [Configuration](configuration.md#environment-variables).

## Docker Compose with a 512 MB memory cap

The provided Compose setup binds Waddle to loopback, requires a password, runs as an unprivileged
user, uses a read-only root filesystem, caps the container at 512 MB RAM, limits Node's heap to 320
MB, and gives temporary files a 32 MB `tmpfs`. Its `small` profile lowers default pool work. The
persistent `waddle-data` volume stores JSON configuration and live proxy/resolver state; raw source
archives and unchecked candidates are not stored on disk. Waddle does not persist request logs or a
page cache. These are resource limits and design targets, not a benchmark or a guarantee that every
workload fits: peak memory depends on traffic and pool activity, and the container can be terminated
if it exceeds its RAM cap. Persistent disk use has not been measured on a target host. Docker volumes
do not have a portable Compose-level hard quota; apply a filesystem/volume quota at the host if you
need a strict 1 GB enforcement.

```sh
git clone https://github.com/wuzzynizzy/Waddle.git
cd Waddle
cp .env.example .env
# Edit .env and replace the placeholder with a unique, long random password.
docker compose up -d --build
```

Open <http://127.0.0.1:8080> on the host. To make it internet-facing, point your domain's DNS at the
host and use a TLS reverse proxy. `Caddyfile.example` is a starting point for Caddy; it uses the
requested hostname `waddle.wisp.uno` and obtains TLS automatically when DNS and ports 80/443 are
correctly configured. Do not remove the password or expose port 8080 directly to the internet.

For a 512 MB RAM / 1 GB storage target, keep `WADDLE_PROFILE=small` (the Docker image's default),
retain the Compose resource caps, and avoid raising `pool.target`, `pool.concurrency`, or `pool.perSource`
beyond what the host can sustain. The settings panel shows the active profile and its ceilings. Measure
RAM and volume growth on the intended workload before treating those budgets as met.

## Settings checkpoint and migration

In the Waddle interface, open **Settings → General → Backup & migration** and choose **Export full
backup**. The versioned JSON includes server settings and sources plus this browser's bookmarks,
saved addresses, history, tabs and appearance preferences. It does not contain session cookies,
request logs, live proxies, DNS cache or the Waddle server's private state. Keep the file private; it
may include your browsing history and custom source list.

Choose **Restore backup** on another Waddle to migrate it. The importer validates the version and
sanitizes imported URLs/settings. The destination's server settings and the current browser's local
library/tabs/preferences are replaced; session cookies and live proxy state are not moved. A local
storage failure or server-side rejection restores the prior local browser data on a best-effort
basis. See [the API description](api.md#server-settings-backup) for server-only backups.

## Useful environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Listening port; default `8080`. |
| `HOST` | Bind address; default `127.0.0.1`. Keep private unless protected by a password and TLS. |
| `WADDLE_PASSWORD` | Require HTTP Basic authentication. Set this before sharing the service. |
| `WADDLE_USER` | Basic-auth username; default `waddle`. |
| `WADDLE_DATA` | Persistent data directory; default `./data` (or `/data` in Docker). |
| `WADDLE_PROFILE` | `small` for a constrained host; standard limits otherwise. |
| `WADDLE_HOME` | Installer destination (`~/.local/share/waddle` on macOS/Linux, `%LOCALAPPDATA%\Waddle` on Windows). |
| `WADDLE_REF` | Git branch to install; defaults to `main`. |

See [configuration.md](configuration.md) for all settings and [security.md](security.md) before exposing Waddle publicly.
