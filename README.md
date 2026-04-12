# devpi-admin

A modern web UI plugin for [devpi-server](https://devpi.net/) — a drop-in replacement for
`devpi-web`. Ships as a Python package that registers itself as a devpi-server plugin via the
standard entry point mechanism, so a single `pip install devpi-admin` is enough.

The UI itself is a bundled single-page application (pure HTML + CSS + vanilla JavaScript, no
build step) served under `/+admin/`. All devpi REST API endpoints remain untouched — the SPA
talks to the standard devpi JSON API directly.

## Features

- **Dashboard** with server info and cache metrics (`/+status`)
- **Index browser** with visual cards color-coded by type (stage / volatile / mirror)
- **Users** management — create, edit, delete (admin only)
- **Index** management — create / edit / delete, configure `bases` (drag & drop priority,
  transitive inheritance detection), `volatile`, `acl_upload` (tag picker), `mirror_url`
- **Package browser** with client-side search and pagination, including an explicit
  download prompt for huge mirrors (e.g. `root/pypi`'s ~780 k packages / 17 MB index)
- **Package detail** in a PyPI-like layout: sidebar with metadata, version list, install
  command, file downloads; main area renders the README (markdown via `marked.js`)
- **Copy-to-clipboard `pip install`** commands with a `pip.conf` toggle
  (short form vs. full `--index-url` / `--trusted-host`)
- **`pip.conf` generator** — download a ready-to-use config per index
- **Anonymous browsing** — visitors can explore public indexes without logging in; admin
  actions appear only after authentication
- **Dark / light / auto theme**, responsive mobile menu, ESC + outside-click dismissal of
  dialogs

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

You should uninstall `devpi-web` first — `devpi-admin` provides all the web UI you need:

```bash
pip uninstall devpi-web
```

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

`devpi-admin` registers a `devpi_server` entry point that hooks into `devpiserver_pyramid_configure`
to:

1. Serve the bundled static assets under `/+admin/` via a Pyramid static view.
2. Add an explicit view at `/+admin/` that returns `index.html` (so the directory itself
   resolves to the SPA entry point).
3. Install a tween that redirects HTML browser requests on `/` to `/+admin/` while leaving
   JSON requests intact.

No changes are made to the devpi REST API.

## Requirements

- Python 3.9+
- devpi-server 6.0+
- A browser with ES6 support and `Promise`, `fetch`, `sessionStorage`

## Routes (UI)

Routing is hash-based, so any of these URLs can be bookmarked or shared:

- `/+admin/#` — Status dashboard (default)
- `/+admin/#indexes` — all indexes
- `/+admin/#indexes/<user>` — filtered to one user
- `/+admin/#packages/<user>/<index>` — packages in an index
- `/+admin/#package/<user>/<index>/<name>` — package detail (latest version)
- `/+admin/#package/<user>/<index>/<name>?version=<ver>` — specific version
- `/+admin/#users` — users admin (requires login)

## Project layout

```
devpi-admin/
├── pyproject.toml
├── README.md
└── src/
    └── devpi_admin/
        ├── __init__.py
        ├── main.py              — Pyramid hooks & tween
        └── static/
            ├── index.html       — SPA entry
            ├── css/style.css
            └── js/
                ├── api.js       — devpi REST wrapper
                ├── theme.js     — theme toggle (light/dark/auto)
                ├── marked.min.js  — vendored markdown renderer
                └── app.js       — routing, views, rendering
```

## Development

```bash
git clone <repo>
cd devpi-admin
pip install -e .
```

The static files live at `src/devpi_admin/static/` and can be edited in place — changes
show up on the next browser reload, no restart of devpi-server required (static views
read from disk on each request).

Run the unit tests:

```bash
PYTHONWARNINGS="ignore::UserWarning" python -m unittest discover -v tests/
```

(The `PYTHONWARNINGS` shim hides an unrelated deprecation warning emitted by Pyramid 2.1
when it imports `pkg_resources`.)

## Author

Pavel Revak <pavelrevak@gmail.com>

## License

MIT — see [LICENSE](LICENSE).
