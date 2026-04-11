# devpi-admin

A static web frontend for managing [devpi](https://devpi.net/) servers — a full-featured alternative to the
read-only `devpi-web` UI.

Pure HTML + CSS + vanilla JS. No build step, no framework, no backend — just copy the files and serve them
behind the same origin as devpi.

## Features

- **Dashboard** with server info and cache metrics (from `/+status`)
- **Index browser** with visual cards color-coded by type (stage / volatile / mirror)
- **Users** management — create, edit, delete (admin only)
- **Index** management — create / edit / delete, configure `bases` (with drag & drop priority and
  transitive inheritance detection), `volatile`, `acl_upload` (tag picker), `mirror_url`
- **Package browser** with client-side search and pagination for large mirrors (e.g. `root/pypi`'s 780k
  packages — explicit download prompt before fetching the 17 MB index)
- **Package detail** in a PyPI-like layout: sidebar with metadata, version list, install command,
  file downloads; main area renders the README (markdown via `marked.js`)
- **Copy-to-clipboard** `pip install` commands with a toggle for `pip.conf` mode (short form vs. full
  `--index-url` / `--trusted-host`)
- **`pip.conf` generator** — download a ready-to-use config per index
- **Anonymous browsing** — users can explore public indexes without logging in; admin actions appear only
  after authentication
- **Dark / light / auto theme**, mobile menu, ESC + outside-click dismissal of dialogs

## Requirements

- A running devpi server (tested against devpi-server 6.19, devpi-web 5.0)
- A reverse proxy (e.g. nginx) that serves the static files **on the same origin** as the devpi API, so
  the browser can hit the devpi REST endpoints without CORS

## Deployment

1. Copy the contents of this directory to your web server (`index.html`, `css/`, `js/`).
2. Configure nginx to serve the app alongside devpi on the same host, e.g.:

   ```nginx
   server {
       listen 80;
       server_name devpi.example.com;

       # Admin UI
       location /admin/ {
           alias /var/www/devpi-admin/;
           try_files $uri $uri/ /admin/index.html;
       }

       # devpi API + devpi-web
       location / {
           proxy_pass http://127.0.0.1:3141;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```

3. Open `http://devpi.example.com/admin/` in your browser.

The app calls the devpi REST API directly from the browser using relative URLs (`/`, `/+login`,
`/<user>/<index>`, ...), so all requests land on the nginx proxy which forwards them to devpi.

## Authentication

Login uses `POST /+login`. The returned token is stored in `sessionStorage` and sent as a
base64-encoded `X-Devpi-Auth: <user>:<token>` header with subsequent requests. Tokens expire after
10 hours (devpi default).

Unauthenticated visitors can browse the status dashboard, indexes, packages, and READMEs — anything
devpi exposes publicly.

## Project layout

```
devpi-admin/
├── index.html          — single entry point
├── css/style.css       — all styles (light + dark theme via CSS variables)
├── js/
│   ├── api.js          — tiny devpi REST wrapper (login, auth, CRUD)
│   ├── theme.js        — theme toggle (light / dark / auto)
│   ├── marked.min.js   — vendored markdown renderer
│   └── app.js          — routing, views, rendering
└── README.md           — this file
```

Routing is hash-based:

- `#` — Status dashboard (default)
- `#indexes` — all indexes
- `#indexes/<user>` — filtered to one user
- `#packages/<user>/<index>` — packages in an index
- `#package/<user>/<index>/<name>` — package detail (latest version)
- `#package/<user>/<index>/<name>?version=<ver>` — specific version
- `#users` — users admin (requires login)

## License

Internal tool. No license declared.
