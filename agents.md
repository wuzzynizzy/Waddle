# Agent guidance for Waddle

## Project at a glance

Waddle is a self-hosted Node.js browser shell that sends visited pages through tested proxies only.
It has no runtime npm dependencies or build step and requires Node.js 20 or newer. The startup path
is intentionally simple: installers and the source-checkout launchers start Waddle and open the
browser. Keep Docker/Compose out of the supported quick-start path unless explicitly requested.

## Repository map

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP server, API routes, static files, access checks and startup. |
| `lib/` | Proxy pool, routing, DNS, configuration, page rewriting, cookies and network safeguards. |
| `public/index.html`, `public/app.css`, `public/app.js` | Main shell, start page, settings, library and browser interactions. |
| `public/local.js` | Browser-local bookmarks, saved pages, history and appearance preferences. |
| `public/client.js`, `public/sw.js` | Proxy-page request rewriting and the service-worker leak guard. |
| `docs/` | User, API, architecture, security and testing documentation, plus reference screenshots. |
| `test/` | Node test suites and the optional real-browser E2E suite. |
| `install.sh`, `install.ps1`, `start-waddle.sh`, `start-waddle.cmd` | Install and launch entry points. |

## Invariants to preserve

- A visited website must never be contacted directly. Do not add a direct fallback or weaken private,
  loopback, link-local or reserved-address checks.
- Treat proxy lists, resolver lists, imported files and proxied page content as untrusted input.
  Preserve validation, limits, authentication checks and the rule that Waddle's APIs are not available
  to cross-site pages.
- Waddle listens on localhost by default. Document password and HTTPS requirements before suggesting
  that users expose it to other machines or the internet.
- Keep the start screen intentionally minimal: one centered address/search entry point and a single
  Source on GitHub link. No mascot, visible wordmark, secondary links, promotional panels or product
  tour; do not add backup or export controls without an explicit request.
- Keep controls keyboard-accessible, labeled and usable at phone widths. Preserve the current
  one-command install and source-launch workflows.
- Do not commit generated runtime state, browser-test output or preview data. `data/` is ignored for
  this reason; keep screenshots there unless a documentation screenshot is deliberately updated.

## Making changes

- Keep the existing no-build, dependency-light setup. Add a runtime dependency only when it is needed
  and document the reason.
- For user-visible changes, update the README and the relevant guides in `docs/` together. For
  settings/UI work, keep `README.md`, `docs/configuration.md`, `docs/testing.md` and the relevant
  screenshots aligned; update `docs/installing.md` when setup or persistence changes. Keep test counts
  in `README.md` and `docs/testing.md` synchronized.
- `/robots.txt` is served directly by `server.js` and disallows all crawlers; do not add a duplicate
  static file. Keep that behavior covered by the server integration test and documented in Security.
- Prefer focused changes and tests that cover observable behavior. For UI work, use the browser E2E
  suite and check accessibility, reduced motion and narrow viewports.
- Use a feature branch and pull request for changes intended for `main`; do not push directly to
  `main`.

## Verification commands

```sh
npm test
npm run format:check
git diff --check
node --check public/app.js
node --check test/browser/e2e.mjs
sh -n install.sh start-waddle.sh
```

The browser suite is optional and needs a Chrome/Chromium installation plus `puppeteer-core`:

```sh
npm install --no-save puppeteer-core
CHROME=/path/to/chrome npm run test:browser
```

See [the testing guide](docs/testing.md) for a self-contained Chromium option, environment
variables, screenshot capture and the test coverage map.
