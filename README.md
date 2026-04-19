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
- `pip.conf` toggle — switch between short form and full `--index-url` / `--trusted-host`
- `pip.conf` generator — download a ready-to-use config per index
- Create / edit / delete indexes via modal dialogs
- `bases` editor with drag & drop priority ordering and transitive inheritance display
- `acl_upload` tag picker with user selection dropdown
- `volatile`, `mirror_url`, `title` configuration

### Users
- Create, edit (email, password), delete users (admin only)

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
  actions (create/edit/delete) appear only after authentication
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

## How it works

`devpi-admin` registers a `devpi_server` entry point that hooks into
`devpiserver_pyramid_configure` (with `@hookimpl` from pluggy) to:

1. Serve the bundled static assets under `/+admin/` via a Pyramid static view.
2. Add an explicit view at `/+admin/` that returns `index.html`.
3. Register custom API views under `/+admin-api/` for cached-package and per-version queries.
4. Install a tween that redirects HTML browser requests on `/` to `/+admin/` while leaving
   JSON requests intact.

The plugin uses devpi-server internals (`xom.model.getstage`, `stage.list_versions`,
`stage.get_versiondata`, `stage.get_releaselinks`) and direct filesystem access
(`serverdir/+files/`) for the cached-packages API.

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
├── src/
│   └── devpi_admin/
│       ├── __init__.py      — version (from git tag via hatch-vcs)
│       ├── main.py          — Pyramid hooks, tween, API views
│       └── static/
│           ├── index.html   — SPA entry point
│           ├── css/style.css
│           └── js/
│               ├── api.js       — devpi REST wrapper + auth
│               ├── theme.js     — theme toggle (light/dark/auto)
│               ├── marked.min.js  — vendored markdown renderer
│               └── app.js       — routing, views, rendering
└── tests/
    ├── test_cached_versions.py  — filesystem scan (tmpdir)
    ├── test_helpers.py          — filename parsing, normalization
    ├── test_hooks.py            — pluggy hook registration
    ├── test_json_safe.py        — readonly view conversion
    ├── test_package.py          — entry point, static files
    ├── test_tween.py            — redirect behavior
    └── test_wants_html.py       — Accept header heuristic
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
