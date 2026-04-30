# devpi-admin

A modern web UI plugin for [devpi-server](https://devpi.net/) - a drop-in replacement for
`devpi-web`. Ships as a Python package that registers itself as a devpi-server plugin via the
standard entry point mechanism, so a single `pip install devpi-admin` is enough.

The UI itself is a bundled single-page application (pure HTML + CSS + vanilla JavaScript, no
build step) served under `/+admin/`. All devpi REST API endpoints remain untouched - the SPA
talks to the standard devpi JSON API directly.

## Features

### Dashboard
- Server info with version of devpi-server and all installed plugins (auto-detected)
- Cache metrics with hit-rate bars (storage, changelog, relpath caches)
- Whoosh search index queue status
- **Replica status** (master only, authenticated users only) - per-replica cards with
  authoritative `applied_serial` vs. master serial. Three states:
  - **in sync** - replica matches master serial
  - **lagging** - replica is behind but advancing
  - **stuck** - replica has been polling the same serial for >=30 s; usually means a
    server-side plugin (`devpi-admin`, `devpi-web`, ...) is missing or out of date on the replica
- **Topbar health indicator** - the `devpi admin` logo is coloured green / orange / red
  on every page, refreshed every 30 s in the background:
  - server reachable, all replicas in sync
  - at least one replica lagging (visible to authenticated master operators)
  - server not responding

### Indexes
- Visual cards color-coded by type: green (stage), amber (volatile stage), blue (mirror)
- Warning tags for ACL edge cases:
  - **`world-writable`** - `acl_upload` contains `:ANONYMOUS:`; supply-chain risk
  - **`no upload`** - `acl_upload` is empty; nobody (not even owner / root) can publish
- Adaptive kebab menu - items hint whether a token will be issued:
  - **`pip.conf`** (public read index, no auth needed) vs. **`pip.conf + token`** (private read)
  - **`.pypirc`** (public upload, no auth needed) vs. **`.pypirc + token`** (private upload).
    Hidden when nobody can upload (`acl_upload` empty).
- **`pip.conf` modal** - issues a short-lived `read`-scope token bound to the index. Returns
  the full `pip.conf` (Copy / Download), a one-off `pip install --index-url ...` command, and
  the raw `user:token` pair for `curl`, `devpi login`, etc. Anonymous-readable indexes show
  a static pip.conf without credentials.
- **`.pypirc` modal** - issues an `upload`-scope token bound to the index. Returns the full
  `.pypirc` (Copy / Download), `TWINE_*` environment variable block, a one-shot
  `twine upload --repository-url ... -u ... -p ... dist/*` command, and the raw `user:token`
  pair. Anonymous-upload indexes (rare; world-writable) show a static `.pypirc` without
  credentials and a security warning.
- Create / edit / delete indexes via modal dialogs
- `bases` editor with drag & drop priority ordering and transitive inheritance display
- `acl_upload` and `acl_read` tag pickers with user selection dropdown
- `volatile`, `mirror_url`, `title` configuration
- **Mirror package allow/deny lists** (`package_allowlist`, `package_denylist`) — see
  *Mirror access control* below

### Read access control (`acl_read`)
- Per-index list of principals allowed to read the index (download packages, browse simple)
- Default `[:ANONYMOUS:]` - public, behaves like devpi-web
- Set to specific users (`alice`, `bob`) to make the index private
- Special principals: `:ANONYMOUS:` (everyone, including unauthenticated) and `:AUTHENTICATED:`
  (any logged-in user)
- Enforced natively by devpi via the `pkg_read` permission on every download path,
  plus a tween that filters out invisible indexes from the root listing (`GET /`)
  and rejects direct access to private indexes with 404

### Mirror access control (allow/deny lists)
- Per-mirror `package_allowlist` and `package_denylist` filter the projects, versions
  and simple-index links served from upstream. Only `type=mirror` indexes carry
  these fields; stage indexes are unaffected
- **Empty allowlist** = pass-through (everything allowed except denylist).
  **Non-empty allowlist** = whitelist mode (only listed entries reach pip)
- **Denylist always wins** — overrides any allowlist match
- Entry formats (one per line in the modal):
  - PEP 508 requirement — `numpy`, `numpy>=2.0`, `urllib3<1.26.5`
  - Glob in name part — `mycompany-*`, `*-internal`, `mycompany-*<2.0`
- **Multi-layer enforcement** so a denylist hit cannot be bypassed:
  - `+simple/<project>/` — denied versions never appear in pip's discovery (devpi-server's
    customizer hooks: `get_projects_filter_iter`, `get_versions_filter_iter`,
    `get_simple_links_filter_iter`)
  - `/<user>/<index>` listing — denied projects vanish from the project list
  - `+f/<hash>/<filename>` direct download — tween returns 404 even for previously
    cached files (defense in depth against shared/bookmarked URLs). The cached file
    stays on disk; removing the deny rule restores access without re-fetching upstream
- Use cases:
  - **CVE blocklist** — `urllib3<1.26.5`, `cryptography<41.0.0`
  - **Internal namespace ban** — `mycompany-*` keeps PyPI typosquats from shadowing
    private packages on a public mirror
  - **Whitelist-only mirrors** — paste curated `requirements.txt` style entries
    into `package_allowlist`; everything else is blocked

### Admin tokens (scoped, revocable)
- Opaque `adm_<id>.<secret>` tokens bound to a `(user, index, scope)` triple. Scope is
  `read` (pip install) or `upload` (twine / `devpi upload`). A leaked token is contained
  to **one index** and **one operation class** - no cross-index or upgrade path.
- Tokens are persisted in keyfs as **SHA-256 hashes only** - the plaintext secret is shown
  exactly once at issuance. A keyfs dump (replica disk, backup) does not yield usable
  tokens. Lookup compares hashes via `hmac.compare_digest` (constant-time).
- TTL configurable per-token (60 s up to 1 year), uniquely revocable
- **Tween enforcement matrix**:

  | scope | allowed methods | allowed paths |
  |---|---|---|
  | `read` | GET, HEAD | `/+api`, `/<token.user>/<token.index>/...` |
  | `upload` | GET, HEAD, POST, PUT | `/+api`, `/<token.user>/<token.index>/...` |

  `DELETE` is **never** granted, even with `upload` scope - package removal must use
  password auth. Anything outside the bound index path returns 403, including the SPA,
  `/+admin-api/*` (so a token cannot mint further tokens), `/+login`, `/`, and `/<user>`.
- **Issuance rules**: regular users may issue for themselves; root may issue for *other*
  users (admin delegation) but not for itself. Admin-token-authenticated requests cannot
  issue further tokens. Issuance verifies the target user is in `acl_read` /
  `acl_upload` of the target index.
- **Management rules**: list / revoke is allowed for the token owner or root. Per-index
  token list endpoint shows only the caller's own tokens (root sees all).
- **Auto-cleanup**:
  - User delete -> all tokens for that user removed from keyfs
  - Index delete -> all tokens bound to that index removed (USER subscriber diffs the
    `indexes` dict)
  - Legacy tokens (pre-hash storage, or pre-`index/scope`) wiped at startup
- Audit log: failed lookups (unknown id, secret mismatch, expired, deleted user, legacy
  token) are logged at WARNING/INFO so an operator can spot bruteforce attempts.
- CI/Ansible-friendly: `GET /+admin-api/pip-conf?index=user/index&ttl=3600` returns a
  ready-to-use `pip.conf` (text/plain) in one HTTP call. For upload, use
  `POST /+admin-api/token` with `{"scope": "upload"}`.

### Users
- Create, edit (email, password), delete users (admin only)
- **Tokens manager** (kebab -> Tokens) - per-user list with label, **index, scope**,
  expiry, issuer, IP; revoke individual or "Reset all". Wide modal layout so the table
  doesn't overflow on stage indexes with long names.

### Packages
- Client-side search with PEP 503 name normalization and relevance ranking
  (exact match > prefix match > substring match, then shortest name first) so
  searching `requests` in a 780k-project upstream surfaces `requests` itself, not
  `django-requests-cache` first
- Stage indexes load packages automatically. Mirror indexes (e.g. `root/pypi` ≈ 780k
  upstream projects, ~17 MB) require an explicit "Browse full index" click — no
  auto-fetch
- Package cards with latest version and `pip install` command

### Package detail (PyPI-like layout)
- **Sidebar**: metadata (author, license, Python version, keywords, platform, maintainer,
  extras, project URLs, dependencies), `pip install` command, file downloads with upload dates
- **Version list**: every known version of the package, newest first, each linking to
  its own detail view
- **README**: rendered markdown (via `marked.js`); fetched from PyPI.org for mirror packages
  where devpi doesn't cache the description

### General
- **Anonymous browsing** - visitors can explore public indexes without logging in; admin
  actions (create/edit/delete) appear only after authentication. Private indexes
  (`acl_read` without `:ANONYMOUS:`) are hidden from anonymous root listing.
- **Hardened SPA delivery** - strict `Content-Security-Policy` (no inline scripts,
  `connect-src` limited to same-origin + `pypi.org`, `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Markdown READMEs
  are sanitised before rendering (script/iframe/event handlers stripped, dangerous
  URL schemes blocked).
- **Dark / light / auto theme** with half-circle icon for auto mode
- **Responsive mobile menu** with hamburger toggle
- **ESC + outside-click** dismissal for modals, dropdown menus, mobile menu
- **Login via modal** - no separate login page

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

You should uninstall `devpi-web` - `devpi-admin` replaces it entirely:

```bash
pip uninstall devpi-web
```

Both plugins can technically coexist but it is not recommended. `devpi-admin` intercepts `/`
for HTML requests while `devpi-web` would still serve its own HTML on other routes like
`/<user>/<index>/<package>`, leading to a confusing mixed experience.

### Replicas: install on every node

`devpi-admin` registers custom keyfs keys (`+admin/tokens/...`,
`+admin/user-tokens/...`, `+admin/index-tokens/...`). Master writes to these on every
token issue / revoke. **Replicas without `devpi-admin` installed cannot apply those
changelog entries** - `import_changes` fails with `AssertionError` on the missing
keyfs key, the replica rolls back to the prior serial, and replication stalls.

The dashboard's stuck-replica detection is designed exactly for this: a `stuck`
state on a replica card almost always means a plugin (typically `devpi-admin` itself,
also `devpi-web`, `devpi-postgresql`) is missing or out of date on the replica. Recovery
is straightforward:

```bash
# on the replica
~/.venv/bin/pip install --upgrade devpi-admin   # match master version
systemctl restart devpi
```

Replication resumes from the failed serial automatically - no manual keyfs surgery.

**Upgrade order:** replicas first, then master. If you upgrade master first and that
release introduces a new keyfs key, replicas would crash on the very next poll.

See `INSTALL.md` section 11 for full step-by-step replica setup and dashboard interpretation.

### Recommended for production: `--restrict-modify root`

devpi-server starts in an **open** mode by default - anyone (including unauthenticated
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

devpi CLI tools and other JSON clients are unaffected - they send `Accept: application/json`
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
the LB may hit a replica that doesn't know the token yet - and get `401`.

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
includes a `replication` block (`synced`, `waited`, `timed_out`, `replicas`, ...) so the
client can decide whether to retry.

The token issued is `read`-scoped - usable only for `GET`/`HEAD` on `/+api` and the
bound `/<user>/<index>/...`. It cannot upload, modify indexes, change passwords,
exchange itself for a session token, or issue another token. It expires after `ttl`
seconds. The service user must have `pkg_read` on the target index. Root may issue
for *other* users (admin delegation) but never for itself.

For uploads, `POST /+admin-api/token` with `{"scope": "upload"}` returns a token that
adds POST/PUT to the bound index - usable from `twine` or `devpi upload`:

```yaml
# CI publish step
- name: Publish wheel
  run: |
    AUTH=$(printf '%s:%s' "$DEVPI_USER" "$DEVPI_PASSWORD" | base64)
    TOKEN=$(curl -sf -H "X-Devpi-Auth: $AUTH" -H 'Content-Type: application/json' \
      -d '{"index":"company/release","scope":"upload","ttl_seconds":900}' \
      "https://devpi.example.com/+admin-api/token" | jq -r .token)
    twine upload --repository-url https://devpi.example.com/company/release/ \
      -u "$DEVPI_USER" -p "$TOKEN" dist/*
```

Upload tokens still cannot DELETE - package removal must use password auth.

### Trusted proxy for client IP logging

The `client_ip` field on issued tokens (visible in the token list) is taken from
`request.client_addr` by default. When devpi-server runs behind a reverse proxy, set
`DEVPI_ADMIN_TRUSTED_PROXIES` to a comma-separated list of CIDRs whose `X-Forwarded-For`
header should be honoured:

```
DEVPI_ADMIN_TRUSTED_PROXIES=10.0.0.0/8,127.0.0.1
```

Without this variable, `X-Forwarded-For` is ignored - preventing clients from forging
their logged IP.

## How it works

`devpi-admin` registers a `devpi_server` entry point with several `@hookimpl`s:

- **`devpiserver_get_features`** - advertises the plugin in `/+api`.
- **`devpiserver_indexconfig_defaults`** - registers `acl_read` as an indexconfig field
  with an `ACLList` marker so devpi normalizes its values on every `PUT`/`PATCH`.
- **`devpiserver_stage_get_principals_for_pkg_read`** - feeds `acl_read` into devpi's
  pyramid ACL, which applies the `pkg_read` permission natively on every download path
  (`+f/`, `+e/`, simple page).
- **`devpiserver_get_identity`** - recognizes `adm_<id>.<secret>` admin tokens, validates
  them against keyfs (constant-time hash compare), sets `adm.is_admin_token` in the
  request environ for downstream tween checks.
- **`devpiserver_pyramid_configure`** - registers the SPA, custom API views, the tween,
  the token keyfs keys, and a USER-key subscriber that cleans up tokens on user delete
  AND on per-user-index removal (diffs old vs. new `indexes` dict via `tx.get_value_at`).
  Primary only - replicas are read-only.

The tween does several things on every request:

1. **Captures replica poll info.** Matches `GET /+changelog/{N}-?` and records
   `start_serial` + `last_seen` keyed by the `X-DEVPI-REPLICA-UUID` header. This is the
   data source for `/+admin-api/replicas` and the dashboard's stuck-replica detection.
2. **Validates admin tokens** by direct `tokens.lookup()` (not via pyramid identity, which
   would pin a stale identity through `/+login`'s mid-request header swap). On valid
   token, sets `adm.token_meta` in the request environ for the identity hook to reuse.
3. **Enforces token scope and index binding**:
   - `read` scope -> only GET/HEAD allowed
   - `upload` scope -> adds POST/PUT (DELETE is *never* granted)
   - URL must be `/+api` or under `/<token.user>/<token.index>/...`. Anything else
     (other indexes, SPA, `/+admin-api/*`, `/+login`, root listing, `/<user>`) returns 403.
4. **Redirects** HTML browser requests on `/` to `/+admin/` while leaving JSON requests intact.
5. **Returns 404** for `GET /<user>/<index>/...` (index, simple, project, version, file)
   when the requestor lacks `pkg_read` - devpi's own listing endpoints have no
   permission check, so we add one.
6. **Returns 403/404** for `GET /<user>` when the requestor is neither the user
   themselves nor `root` - devpi otherwise leaks the full list of that user's
   private indexes.
7. **Filters the `GET /` JSON response** to remove indexes the requestor can't read,
   and adds `Cache-Control: private, no-store` so a shared cache cannot serve one
   user's filtered view to another.

The SPA HTML (`/+admin/`) is served with security headers - strict
`Content-Security-Policy` (no inline scripts, restricted `connect-src` to
`'self'` + `https://pypi.org` for the README fallback, `frame-ancestors 'none'`),
plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

The plugin uses devpi-server internals: `xom.model.getstage`, `stage.list_versions`,
`stage.get_versiondata`, `stage.get_releaselinks`, `xom.keyfs`.

The mirror access control (`package_allowlist` / `package_denylist`) is implemented
on top of devpi-server's stage customizer hooks (`get_projects_filter_iter`,
`get_versions_filter_iter`, `get_simple_links_filter_iter`). devpi-server rejects
duplicate customizer registrations for a given `index_type`, so instead of providing
our own class we monkey-patch our methods onto the upstream `MirrorCustomizer`
(an empty pass-through class designed exactly for this kind of extension). The
patch runs once at module import. The tween additionally enforces denylist on
direct `+f/` downloads to neutralise previously-cached or shared file URLs.

## Requirements

- Python 3.9+
- **devpi-server 6.19 <= version < 7.0** - we rely on `tx.get_value_at`, the
  `X-DEVPI-REPLICA-UUID` header and the `polling_replicas` dict shape introduced in
  6.19; the upper bound is held until 7.x compatibility is verified.
- A browser with ES6 support (`Promise`, `fetch`, `sessionStorage`)

## Routes (UI)

Routing is hash-based, so any of these URLs can be bookmarked or shared:

| Hash | View |
|------|------|
| `#` | Status dashboard (default) |
| `#indexes` | All indexes |
| `#indexes/<user>` | Indexes filtered by user |
| `#packages/<user>/<index>` | Packages in an index |
| `#package/<user>/<index>/<name>` | Package detail (latest version) |
| `#package/<user>/<index>/<name>?version=<ver>` | Specific version |
| `#users` | User management (requires login) |

## API

In addition to serving the SPA, `devpi-admin` exposes its own JSON API under
`/+admin-api/`. Authentication uses the standard devpi-server header
`X-Devpi-Auth: base64(user:token)`. Responses are `application/json` unless noted
(`/+admin-api/pip-conf` returns `text/plain`).

### Session and discovery

#### `GET /+admin-api/session`
Cheap auth check; the frontend pings this on tab focus to detect expired sessions.
- **Auth:** required
- **200:** `{"valid": true, "user": "alice"}`
- **403:** not authenticated

#### `GET /+admin-api/public-url`
Canonical "outside" URL of this deployment, derived from
`request.application_url` (respects `--outside-url` and `X-Forwarded-*` headers).
The SPA uses this for static `pip.conf` / `.pypirc` previews so they match what the
backend would emit when behind a reverse proxy.
- **Auth:** none (URL is not a secret; even anonymous viewers of public indexes need it)
- **200:** `{"url": "https://devpi.example.com"}`

### Project metadata

#### `GET /+admin-api/versions/{user}/{index}/{project}`
All known versions of a project, newest first. Backed by `stage.list_versions()` so
the result is consistent across primary and replicas (PROJSIMPLELINKS in keyfs is
replicated via the changelog).
- **Auth:** `pkg_read` on the index
- **200:** `{"versions": ["1.0", "0.9", "0.8"]}`

#### `GET /+admin-api/versiondata/{user}/{index}/{project}/{version}`
Metadata + file links for a single version (PEP 426 / PEP 621 fields plus `+links`
with `href`, `basename`, `hash_spec`, upload `log`).
- **Auth:** `pkg_read` on the index
- **200:** `{"result": {...}}`
- **404:** version doesn't exist

### Tokens

Tokens are opaque `adm_<id>.<secret>` strings bound to a `(user, index, scope)` triple.
Only the SHA-256 of the secret is persisted in keyfs.

#### `POST /+admin-api/token`
Issue a new token.
- **Auth:** required (regular user for self; root may issue for *other* users; admin-token
  requests cannot issue further tokens)
- **Body (JSON):**
  ```json
  {
    "user": "alice",                  // optional, default = authenticated; root may set freely (not "root")
    "index": "alice/dev",             // required
    "scope": "read" | "upload",       // required
    "ttl_seconds": 3600,              // optional; 60 <= ttl <= 1 year, default 1h
    "label": "ci-build",              // optional, <= 200 chars
    "wait_replicas": 10               // optional; block up to N seconds for replicas to catch up
  }
  ```
- **200:** `{token, user, index, scope, issued_at, expires_at, label, replication?}` -
  `token` is the plaintext, returned **once**.
- **403:** target user lacks scope perm on index, root issuing for itself, admin-token call, etc.
- **404:** index doesn't exist

#### `GET /+admin-api/pip-conf?index=u/i&user=&ttl=&label=&wait_replicas=`
Issue a `read` token + return a ready-to-use pip.conf in one call (CI/Ansible-friendly).
- **Auth:** required (same rules as `POST /token`)
- **200:** `text/plain`
  ```ini
  [global]
  index-url = https://alice:adm_xxx.yyy@devpi.example.com/alice/dev/+simple/
  trusted-host = devpi.example.com
  ```

#### `GET /+admin-api/users/{user}/tokens`
List active tokens for a user.
- **Auth:** the user themselves, or root
- **200:** `{"result": [{id, id_short, user, index, scope, issuer, issued_at, expires_at, expires_in, label, client_ip}, ...], "count": N}`

#### `DELETE /+admin-api/users/{user}/tokens`
Revoke ALL tokens for a user.
- **Auth:** the user themselves, or root
- **200:** `{"revoked": N, "user": "alice"}`

#### `GET /+admin-api/indexes/{user}/{index}/tokens`
List tokens bound to an index. Non-root callers see only tokens they own; root sees
every token for the index. Returns 404 (not 403) when the caller has no `pkg_read` so
private index existence is not leaked.
- **Auth:** `pkg_read` on the index (404 otherwise)
- **200:** `{"result": [...], "count": N}` - same record shape as `/users/{user}/tokens`

#### `DELETE /+admin-api/tokens/{token_id}`
Revoke a single token.
- **Auth:** owner of the token, or root
- **200:** `{"revoked": true, "id": "abc..."}`
- **404:** token id not found

### Replication observability (master only)

#### `GET /+admin-api/replicas`
Last-known poll info per replica, captured from each `GET /+changelog/{N}-` request via
a tween. The `applied_serial` field is the highest serial the replica has actually
applied (`start_serial - 1` from its most recent poll). Compare against `/+status`
`serial` for true lag.

Why this isn't `polling_replicas` from `/+status`: devpi-server overwrites
`xom.polling_replicas[uuid].serial` during streaming and gives a misleading "caught up"
reading once the response generator drains. Capturing `start_serial` at the request
boundary is the only stable signal master alone can produce.

- **Auth:** required
- **200:**
  ```json
  {
    "result": {
      "<replica-uuid>": {
        "start_serial": 103,
        "applied_serial": 102,
        "last_seen": 1712345678.9,
        "age_seconds": 3,
        "stuck_seconds": 47,
        "remote_ip": "10.0.0.5",
        "outside_url": "https://replica.example.com"
      }
    }
  }
  ```
- Entries auto-expire after 10 min of silence. Dict size capped at 256 entries
  (least-recently-seen evicted first) so an attacker spamming UUIDs cannot exhaust master memory.

## Project layout

```
devpi-admin/
├── pyproject.toml
├── README.md
├── LICENSE
├── .github/workflows/
│   ├── tests.yml            - CI on push/PR (Python 3.10 - 3.14)
│   └── publish.yml          - publish to PyPI on release
├── dev/                     - untracked dev-only prototypes (e.g. demo-graph.html)
├── devpi_admin/
│   ├── __init__.py          - version (from git tag via setuptools-scm)
│   ├── main.py              - Pyramid hooks, tween, API views
│   ├── tokens.py            - admin token gen / lookup / revoke / list (keyfs storage)
│   ├── customizer.py        - mirror package allow/deny filter (patches MirrorCustomizer)
│   └── static/
│       ├── index.html       - SPA entry point
│       ├── css/style.css
│       └── js/
│           ├── api.js       - devpi REST wrapper + auth
│           ├── theme.js     - theme toggle (light/dark/auto)
│           ├── marked.min.js  - vendored markdown renderer
│           └── app.js       - routing, views, rendering
└── tests/
    ├── test_acl_read.py        - acl_read hooks, tween guards (scope/index), token issuance
    │                             rules, _check_index_perm, USER-changed handler, replica poll
    │                             tween + endpoint, public-url
    ├── test_filter.py          - package allow/deny customizer + tween +f/ block
    ├── test_hooks.py           - pluggy hook registration
    ├── test_json_safe.py       - readonly view conversion
    ├── test_package.py         - entry point, static files
    ├── test_pipconf.py         - pip.conf credential helpers
    ├── test_tokens.py          - token format, issue/lookup/revoke, reset_for_index,
    │                             list_for_index, end-to-end cleanup chain
    ├── test_tween.py           - redirect behavior
    ├── test_view_helpers.py    - _get_stage_or_404, _check_read_access, CSP headers
    └── test_wants_html.py      - Accept header heuristic
```

## Development

```bash
git clone <repo>
cd devpi-admin
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

The `dev` extra pulls in `pytest`. A bare `pip install -e .` works too - the test suite
is also runnable with the stdlib `unittest` runner.

The static files live at `devpi_admin/static/` and can be edited in place - changes show
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
2. On GitHub: Releases -> Draft new release -> select tag -> Publish
3. The `publish.yml` workflow runs tests, builds wheel+sdist, and uploads to PyPI via trusted
   publishing (no API tokens needed - configure the GitHub environment `pypi` in PyPI settings).

## Author

Pavel Revak <pavelrevak@gmail.com>

## License

MIT - see [LICENSE](LICENSE).
