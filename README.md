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
- `POST /+admin-api/token` issues an opaque `adm_<random>` token bound to a user
- Tokens are stored in keyfs (stateful) and uniquely revocable — TTL configurable per-token
  (60 s up to 1 year)
- **Read-only enforcement**: even though the token carries the user's full identity for ACL
  purposes, a tween blocks any non-`GET`/`HEAD` request on `/+login` or `/<user>` paths,
  preventing escalation into a full devpi session token or password change
- Per-user list, individual revoke, and "Reset all" available in the user card kebab menu
- Auto-cleanup: when a user is deleted, all of their tokens are removed from keyfs
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
- **Dark / light / auto theme** with half-circle icon for auto mode
- **Responsive mobile menu** with hamburger toggle
- **ESC + outside-click** dismissal for modals, dropdown menus, mobile menu
- **Login via modal** — no separate login page

## Plugin API endpoints

In addition to serving the SPA, `devpi-admin` registers custom API endpoints under
`/+admin-api/` for features that the standard devpi REST API doesn't provide efficiently:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/+admin-api/cached/{user}/{index}` | GET | List cached package names for a mirror index (filesystem scan) |
| `/+admin-api/versions/{user}/{index}/{project}` | GET | Version list with cached/uncached distinction |
| `/+admin-api/versions/{user}/{index}/{project}?all=1` | GET | Include all upstream versions (mirrors) |
| `/+admin-api/versiondata/{user}/{index}/{project}/{version}` | GET | Metadata + file links for a single version |
| `/+admin-api/token` | POST | Issue an admin token (`{user, ttl_seconds, label}`) — user can issue for self, root for anyone |
| `/+admin-api/pip-conf?index=u/i&ttl=&user=&label=` | GET | Issue token + return `text/plain` pip.conf with embedded creds |
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
      "https://devpi.example.com/+admin-api/pip-conf?index=company/private&ttl=3600" \
      > ~/.pip/pip.conf
    pip install -r requirements.txt
```

The token issued is read-only (cannot change passwords or be exchanged for a session token)
and expires after `ttl` seconds. The service user must have `pkg_read` (be listed in the
target index's `acl_read`).

## How it works

`devpi-admin` registers a `devpi_server` entry point with several `@hookimpl`s:

- **`devpiserver_get_features`** — advertises the plugin in `/+api`.
- **`devpiserver_indexconfig_defaults`** — registers `acl_read` as an indexconfig field
  with an `ACLList` marker so devpi normalizes its values on every `PUT`/`PATCH`.
- **`devpiserver_stage_get_principals_for_pkg_read`** — feeds `acl_read` into devpi's
  pyramid ACL, which applies the `pkg_read` permission natively on every download path
  (`+f/`, `+e/`, simple page).
- **`devpiserver_get_identity`** — recognizes `adm_<random>` admin tokens by header prefix
  and validates them against the keyfs storage.
- **`devpiserver_pyramid_configure`** — registers the SPA, custom API views, the tween,
  the token keyfs keys, and a USER-key subscriber that cleans up tokens when a user is
  deleted (primary only — replicas are read-only).

The tween does several things:

1. Redirects HTML browser requests on `/` to `/+admin/` while leaving JSON requests intact.
2. Returns `404` for `GET /<user>/<index>[/+simple/]` when the requestor lacks `pkg_read` —
   devpi's own listing endpoints have no permission check, so we add one.
3. Filters the `GET /` JSON response to remove indexes the requestor can't read.
4. Blocks privilege-escalation paths for admin-token requests: any non-`GET`/`HEAD` on
   `/+login` or `/<user>` is rejected with `403`, preventing token-to-session-token
   exchange or password changes from a leaked token.

The plugin uses devpi-server internals (`xom.model.getstage`, `stage.list_versions`,
`stage.get_versiondata`, `stage.get_releaselinks`, `xom.keyfs`) and direct filesystem
access (`serverdir/+files/`) for the cached-packages API.

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
│   ├── tests.yml            — CI on push/PR (Python 3.10 + 3.14)
│   └── publish.yml          — publish to PyPI on release
├── devpi_admin/
│   ├── __init__.py          — version (from git tag via hatch-vcs)
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
    ├── test_cached_versions.py — filesystem scan (tmpdir)
    ├── test_helpers.py         — filename parsing, normalization
    ├── test_hooks.py           — pluggy hook registration
    ├── test_json_safe.py       — readonly view conversion
    ├── test_package.py         — entry point, static files
    ├── test_tokens.py          — admin token format, generation, splitting
    ├── test_tween.py           — redirect behavior
    └── test_wants_html.py      — Accept header heuristic
```

## Development

```bash
git clone <repo>
cd devpi-admin
python -m venv .venv
.venv/bin/pip install -e .
```

The static files live at `src/devpi_admin/static/` and can be edited in place — changes
show up on the next browser reload, no restart of devpi-server required (static views
read from disk on each request). Python changes (`main.py`) require a devpi-server restart.

Run the unit tests:

```bash
PYTHONWARNINGS="ignore::UserWarning" python -m unittest discover -v tests/
```

(The `PYTHONWARNINGS` shim hides an unrelated deprecation warning emitted by Pyramid 2.1
when it imports `pkg_resources`.)

## Releasing

Version is derived from the git tag via `hatch-vcs`. To release:

1. `git tag v0.1.0 && git push --tags`
2. On GitHub: Releases → Draft new release → select tag → Publish
3. The `publish.yml` workflow runs tests, builds wheel+sdist, and uploads to PyPI via trusted
   publishing (no API tokens needed — configure the GitHub environment `pypi` in PyPI settings).

## Author

Pavel Revak <pavelrevak@gmail.com>

## License

MIT — see [LICENSE](LICENSE).
