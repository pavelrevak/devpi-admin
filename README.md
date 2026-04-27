# devpi-admin

A modern web UI plugin for [devpi-server](https://devpi.net/) — a drop-in replacement for
`devpi-web`. Ships as a Python package that registers itself as a devpi-server plugin via the
standard entry point mechanism, so a single `pip install devpi-admin` is enough.

The UI itself is a bundled single-page application (pure HTML + CSS + vanilla JavaScript, no
build step) served under `/+admin/`. All devpi REST API endpoints remain untouched — the SPA
talks to the standard devpi JSON API directly.

## Features

### Dashboard
- Server info with version of devpi-server and all installed plugins (auto-detected)
- Cache metrics with hit-rate bars (storage, changelog, relpath caches)
- Whoosh search index queue status
- **Replica status** (master only) — per-replica cards with online/offline badge, serial lag,
  and last-seen timestamp; visible only when replicas are connected

### Indexes
- Visual cards color-coded by type: green (stage), amber (volatile stage), blue (mirror)
- `pip install` command with copy-to-clipboard (click to copy, green flash feedback)
- **`pip.conf` modal** — issues a short-lived read-only token and returns three forms:
  the full `pip.conf` file (Copy / Download), a one-off `pip install --index-url ...` command,
  and the raw `user:token` pair for `curl -u`, `devpi login`, and custom tooling.
  Public indexes (`acl_read = [:ANONYMOUS:]`) skip token issuance — they show a static
  pip.conf without credentials.
- Create / edit / delete indexes via modal dialogs
- `bases` editor with drag & drop priority ordering and transitive inheritance display
- `acl_upload` and `acl_read` tag pickers with user selection dropdown
- `volatile`, `mirror_url`, `title` configuration

### Read access control (`acl_read`)
- Per-index list of principals allowed to read the index (download packages, browse simple)
- Default `[:ANONYMOUS:]` — public, behaves like devpi-web
- Set to specific users (`alice`, `bob`) to make the index private
- Special principals: `:ANONYMOUS:` (everyone, including unauthenticated) and `:AUTHENTICATED:`
  (any logged-in user)
- Enforced natively by devpi via the `pkg_read` permission on every download path,
  plus a tween that filters out invisible indexes from the root listing (`GET /`)
  and rejects direct access to private indexes with 404

### Admin tokens (read-only, revocable)
- `POST /+admin-api/token` issues an opaque `adm_<id>.<secret>` token bound to a user
- Tokens are persisted in keyfs as **SHA-256 hashes only** — the plaintext secret is shown
  exactly once at issuance. A keyfs dump (replica disk, backup) does not yield usable
  tokens. Lookup compares hashes via `hmac.compare_digest` (constant-time).
- TTL configurable per-token (60 s up to 1 year), uniquely revocable
- **Read-only, narrow scope**: a tween restricts admin-token requests to `GET`/`HEAD`
  on `/+api` and `/<user>/<index>/...` paths only. Everything else returns 403:
  uploads, `PATCH`/`DELETE` on indexes/users, `POST /+login`, the SPA itself,
  the entire `/+admin-api/*` (so a token cannot mint another token), the root
  listing `/`, and per-user listing `/<user>`.
- **Issuance rules**: only regular users may issue tokens, and only for themselves.
  Root cannot issue tokens at all (a leaked root token would have full server
  privileges). A request authenticated via an admin token cannot issue further
  tokens — no chained renewal past the original TTL.
- **Management rules**: list / revoke is allowed for the token owner or root.
- Per-user list, individual revoke, and "Reset all" available in the user card kebab menu
- Auto-cleanup: when a user is deleted, all of their tokens are removed from keyfs
- Audit log: failed lookups (unknown id, secret mismatch, expired, deleted user)
  are logged at WARNING/INFO so an operator can spot bruteforce attempts.
- CI/Ansible-friendly: `GET /+admin-api/pip-conf?index=user/index&ttl=3600` returns a
  ready-to-use `pip.conf` (text/plain) in one HTTP call

### Users
- Create, edit (email, password), delete users (admin only)
- **Tokens manager** — per-user list with label, expiry, issuer, IP; revoke individual or all

### Packages
- Client-side search with PEP 503 name normalization
- Mirror indexes: shows only cached packages (filesystem scan, no 17 MB index download);
  "Download full index" button available for complete browse
- Package cards with latest version and `pip install` command

### Package detail (PyPI-like layout)
- **Sidebar**: metadata (author, license, Python version, keywords, platform, maintainer,
  extras, project URLs, dependencies), `pip install` command, file downloads with upload dates
- **Version list**: cached versions shown normally, uncached versions link to pypi.org (↗);
  "Load all versions" button for mirrors
- **README**: rendered markdown (via `marked.js`); fetched from PyPI.org for mirror packages
  where devpi doesn't cache the description

### General
- **Anonymous browsing** — visitors can explore public indexes without logging in; admin
  actions (create/edit/delete) appear only after authentication. Private indexes
  (`acl_read` without `:ANONYMOUS:`) are hidden from anonymous root listing.
- **Hardened SPA delivery** — strict `Content-Security-Policy` (no inline scripts,
  `connect-src` limited to same-origin + `pypi.org`, `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Markdown READMEs
  are sanitised before rendering (script/iframe/event handlers stripped, dangerous
  URL schemes blocked).
- **Dark / light / auto theme** with half-circle icon for auto mode
- **Responsive mobile menu** with hamburger toggle
- **ESC + outside-click** dismissal for modals, dropdown menus, mobile menu
- **Login via modal** — no separate login page

## Plugin API endpoints

In addition to serving the SPA, `devpi-admin` registers custom API endpoints under
`/+admin-api/` for features that the standard devpi REST API doesn't provide efficiently:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/+admin-api/session` | GET | Cheap auth check — frontend pings on tab focus |
| `/+admin-api/cached/{user}/{index}` | GET | List cached package names for a mirror index (filesystem scan, serial-cached) |
| `/+admin-api/versions/{user}/{index}/{project}` | GET | Version list with cached/uncached distinction |
| `/+admin-api/versions/{user}/{index}/{project}?all=1` | GET | Include all upstream versions (mirrors) |
| `/+admin-api/versiondata/{user}/{index}/{project}/{version}` | GET | Metadata + file links for a single version |
| `/+admin-api/token` | POST | Issue an admin token (`{user, ttl_seconds, label, wait_replicas}`) — user can issue for self, root for anyone |
| `/+admin-api/pip-conf?index=u/i&ttl=&user=&label=&wait_replicas=` | GET | Issue token + return `text/plain` pip.conf with embedded creds |
| `/+admin-api/users/{user}/tokens` | GET | List active tokens for a user |
| `/+admin-api/users/{user}/tokens` | DELETE | Revoke ALL tokens for a user |
| `/+admin-api/tokens/{token_id}` | DELETE | Revoke a single token |

## Installation

```bash
pip install devpi-admin
```

This pulls in `devpi-server` as a dependency. If you are using devpi in a dedicated venv
(recommended), install the plugin into the same venv:

```bash
/var/lib/pypi/venv/bin/pip install devpi-admin
systemctl --user restart devpi      # or however you run devpi-server
```

You should uninstall `devpi-web` — `devpi-admin` replaces it entirely:

```bash
pip uninstall devpi-web
```

Both plugins can technically coexist but it is not recommended. `devpi-admin` intercepts `/`
for HTML requests while `devpi-web` would still serve its own HTML on other routes like
`/<user>/<index>/<package>`, leading to a confusing mixed experience.

### Recommended for production: `--restrict-modify root`

devpi-server starts in an **open** mode by default — anyone (including unauthenticated
clients) can `PUT /<newuser>` to create an account, and any logged-in user can
`PUT /<user>/<index>` to spin up indexes under their own account. The devpi-admin UI
hides those buttons from non-root users, but a direct API call (`curl`, `devpi user -c`)
will still succeed.

Pass `--restrict-modify root` to `devpi-server` to lock structural operations
(create/modify/delete of users and indexes) down to `root` only. Per-index
`acl_upload`/`acl_read` are unaffected, so day-to-day uploads and downloads keep working
under the existing per-index permissions.

```ini
ExecStart=/opt/pypi/venv/bin/devpi-server \
    --serverdir /var/lib/pypi/data \
    --restrict-modify root \
    ...
```

See `INSTALL.md` for a full systemd unit example.

## Usage

After restart, open:

```
http://<your-devpi-host>:3141/
```

Browser visits to `/` are redirected to `/+admin/`, which serves the SPA. Direct links like
`http://<host>:3141/+admin/#packages/ci/testing` work and can be bookmarked.

devpi CLI tools and other JSON clients are unaffected — they send `Accept: application/json`
and bypass the redirect.

## CI/Ansible: short-lived pip.conf via the API

For automation that needs to install from a private index, store the service user's password
as a secret and let the pipeline mint a fresh short-lived `pip.conf` per run:

```yaml
# Gitea Actions example
- name: Install dependencies
  env:
    DEVPI_USER: ${{ secrets.DEVPI_USER }}        # e.g. "gitea-ci"
    DEVPI_PASSWORD: ${{ secrets.DEVPI_PASSWORD }}
  run: |
    mkdir -p ~/.pip
    AUTH=$(printf '%s:%s' "$DEVPI_USER" "$DEVPI_PASSWORD" | base64)
    curl -sf -H "X-Devpi-Auth: $AUTH" \
      "https://devpi.example.com/+admin-api/pip-conf?index=company/private&ttl=3600&wait_replicas=10" \
      > ~/.pip/pip.conf
    pip install -r requirements.txt
```

### Replication race: `wait_replicas`

When devpi runs as primary + replicas behind a load balancer, a freshly issued token
exists on the primary instantly but takes one polling cycle (~37 s by default) to reach
replicas. An Ansible-style playbook that issues a token and immediately uses it through
the LB may hit a replica that doesn't know the token yet — and get `401`.

Both `POST /+admin-api/token` and `GET /+admin-api/pip-conf` accept a `wait_replicas`
parameter. The primary blocks until every currently-polling replica has caught up to
the commit serial, bounded by 30 s. Stale replicas (silent for >2 min) are skipped so an
offline replica never blocks the caller.

```bash
# Wait up to 10 s for replicas; default cap is 30 s if you pass `true`/`1`.
curl -sf -H "X-Devpi-Auth: $AUTH" \
  "https://devpi.example.com/+admin-api/pip-conf?index=company/private&ttl=3600&wait_replicas=10" \
  > ~/.pip/pip.conf
```

For `POST /+admin-api/token`, send `{"wait_replicas": 10}` in the JSON body. The response
includes a `replication` block (`synced`, `waited`, `timed_out`, `replicas`, …) so the
client can decide whether to retry.

The token issued is strictly read-only — usable only for `GET`/`HEAD` on `/+api` and
`/<user>/<index>/...` (index data and package archives). It cannot upload packages,
change passwords, exchange itself for a session token, modify indexes, or issue another
token. It expires after `ttl` seconds. The service user must have `pkg_read` (be listed
in the target index's `acl_read`) and **must not be `root`** — root accounts cannot
issue tokens at all.

### Trusted proxy for client IP logging

The `client_ip` field on issued tokens (visible in the token list) is taken from
`request.client_addr` by default. When devpi-server runs behind a reverse proxy, set
`DEVPI_ADMIN_TRUSTED_PROXIES` to a comma-separated list of CIDRs whose `X-Forwarded-For`
header should be honoured:

```
DEVPI_ADMIN_TRUSTED_PROXIES=10.0.0.0/8,127.0.0.1
```

Without this variable, `X-Forwarded-For` is ignored — preventing clients from forging
their logged IP.

## How it works

`devpi-admin` registers a `devpi_server` entry point with several `@hookimpl`s:

- **`devpiserver_get_features`** — advertises the plugin in `/+api`.
- **`devpiserver_indexconfig_defaults`** — registers `acl_read` as an indexconfig field
  with an `ACLList` marker so devpi normalizes its values on every `PUT`/`PATCH`.
- **`devpiserver_stage_get_principals_for_pkg_read`** — feeds `acl_read` into devpi's
  pyramid ACL, which applies the `pkg_read` permission natively on every download path
  (`+f/`, `+e/`, simple page).
- **`devpiserver_get_identity`** — recognizes `adm_<id>.<secret>` admin tokens, validates
  them against keyfs (constant-time hash compare), sets `adm.is_admin_token` in the
  request environ for downstream tween checks.
- **`devpiserver_pyramid_configure`** — registers the SPA, custom API views, the tween,
  the token keyfs keys, and a USER-key subscriber that cleans up tokens when a user is
  deleted (primary only — replicas are read-only).

The tween does several things:

1. Redirects HTML browser requests on `/` to `/+admin/` while leaving JSON requests intact.
2. Restricts admin-token requests to read-only access on index/archive paths only.
   Anything outside `GET /+api` or `GET /<user>/<index>/...` returns `403` — including
   the SPA, `/+admin-api/*`, `/+login`, `/`, `/<user>`, and any non-`GET`/`HEAD` method
   anywhere. A leaked token cannot upload, mint another token, change passwords, or
   exchange itself for a session token.
3. Returns `404` for `GET /<user>/<index>/...` (index, simple, project, version, file)
   when the requestor lacks `pkg_read` — devpi's own listing endpoints have no
   permission check, so we add one.
4. Returns `403`/`404` for `GET /<user>` when the requestor is neither the user
   themselves nor `root` — devpi otherwise leaks the full list of that user's
   private indexes.
5. Filters the `GET /` JSON response to remove indexes the requestor can't read,
   and adds `Cache-Control: private, no-store` so a shared cache cannot serve one
   user's filtered view to another.

The SPA HTML (`/+admin/`) is served with security headers — strict
`Content-Security-Policy` (no inline scripts, restricted `connect-src` to
`'self'` + `https://pypi.org` for the README fallback, `frame-ancestors 'none'`),
plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

The plugin uses devpi-server internals (`xom.model.getstage`, `stage.list_versions`,
`stage.get_versiondata`, `stage.get_releaselinks`, `xom.keyfs`) and direct filesystem
access (`serverdir/+files/`) for the cached-packages API. The filesystem scan is
memoised per `(user, index)` and invalidated via `xom.keyfs.get_current_serial()`,
so repeated requests don't re-walk the directory unless a file was added or removed.

## Requirements

- Python 3.9+
- devpi-server 6.0+
- A browser with ES6 support (`Promise`, `fetch`, `sessionStorage`)

## Routes (UI)

Routing is hash-based, so any of these URLs can be bookmarked or shared:

| Hash | View |
|------|------|
| `#` | Status dashboard (default) |
| `#indexes` | All indexes |
| `#indexes/<user>` | Indexes filtered by user |
| `#packages/<user>/<index>` | Packages in an index |
| `#package/<user>/<index>/<name>` | Package detail (latest cached version) |
| `#package/<user>/<index>/<name>?version=<ver>` | Specific version |
| `#users` | User management (requires login) |

## Project layout

```
devpi-admin/
├── pyproject.toml
├── README.md
├── LICENSE
├── .github/workflows/
│   ├── tests.yml            — CI on push/PR (Python 3.10 – 3.14)
│   └── publish.yml          — publish to PyPI on release
├── dev/                     — untracked dev-only prototypes (e.g. demo-graph.html)
├── devpi_admin/
│   ├── __init__.py          — version (from git tag via setuptools-scm)
│   ├── main.py              — Pyramid hooks, tween, API views
│   ├── tokens.py            — admin token gen / lookup / revoke / list (keyfs storage)
│   └── static/
│       ├── index.html       — SPA entry point
│       ├── css/style.css
│       └── js/
│           ├── api.js       — devpi REST wrapper + auth
│           ├── theme.js     — theme toggle (light/dark/auto)
│           ├── marked.min.js  — vendored markdown renderer
│           └── app.js       — routing, views, rendering
└── tests/
    ├── test_acl_read.py        — acl_read hooks, tween guards, header parsing
    ├── test_cached_versions.py — filesystem scan + cache invalidation
    ├── test_helpers.py         — filename parsing, normalization
    ├── test_hooks.py           — pluggy hook registration
    ├── test_json_safe.py       — readonly view conversion
    ├── test_package.py         — entry point, static files
    ├── test_pipconf.py         — pip.conf credential helpers
    ├── test_tokens.py          — admin token format, generation, splitting
    ├── test_tween.py           — redirect behavior
    ├── test_view_helpers.py    — _get_stage_or_404, _check_read_access, CSP headers
    └── test_wants_html.py      — Accept header heuristic
```

## Development

```bash
git clone <repo>
cd devpi-admin
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

The `dev` extra pulls in `pytest`. A bare `pip install -e .` works too — the test suite
is also runnable with the stdlib `unittest` runner.

The static files live at `devpi_admin/static/` and can be edited in place — changes show
up on the next browser reload, no restart of devpi-server required (static views read
from disk on each request). Python changes (`main.py`, `tokens.py`) require a
devpi-server restart.

Run the unit tests:

```bash
# pytest (recommended for local development)
pytest tests/ -q

# unittest (matches the CI invocation)
PYTHONWARNINGS="ignore::UserWarning" python -m unittest discover -v tests/
```

(The `PYTHONWARNINGS` shim hides an unrelated deprecation warning emitted by Pyramid 2.1
when it imports `pkg_resources`.)

## Releasing

Version is derived from the git tag via `setuptools-scm`. To release:

1. `git tag v0.1.0 && git push --tags`
2. On GitHub: Releases → Draft new release → select tag → Publish
3. The `publish.yml` workflow runs tests, builds wheel+sdist, and uploads to PyPI via trusted
   publishing (no API tokens needed — configure the GitHub environment `pypi` in PyPI settings).

## Author

Pavel Revak <pavelrevak@gmail.com>

## License

MIT — see [LICENSE](LICENSE).
