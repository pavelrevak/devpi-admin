(function () {
    'use strict';

    var content = document.getElementById('content');
    var loginBtn = document.getElementById('login-btn');
    var logoutBtn = document.getElementById('logout-btn');
    var navUsers = document.getElementById('nav-users');

    // Modal elements
    var modalOverlay = document.getElementById('modal-overlay');
    var modalTitle = document.getElementById('modal-title');
    var modalBody = document.getElementById('modal-body');
    var modalError = document.getElementById('modal-error');
    var modalFooter = document.getElementById('modal-footer');
    var modalCloseBtn = document.getElementById('modal-close');

    // --- Helpers ---

    var DOM_PROPS = {
        textContent: 1, className: 1, checked: 1, value: 1, hidden: 1,
    };

    function el(tag, attrs, children) {
        var e = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (k === 'onclick') {
                    e.addEventListener('click', attrs[k]);
                } else if (DOM_PROPS[k]) {
                    e[k] = attrs[k];
                } else {
                    e.setAttribute(k, attrs[k]);
                }
            }
        }
        if (children) {
            for (var i = 0; i < children.length; i++) {
                if (typeof children[i] === 'string') {
                    e.appendChild(document.createTextNode(children[i]));
                } else {
                    e.appendChild(children[i]);
                }
            }
        }
        return e;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function formGroup(label, inputEl) {
        return el('div', {className: 'form-group'}, [
            el('label', {textContent: label}),
            inputEl,
        ]);
    }

    function parseLinesField(elementId) {
        // Split textarea content by newlines; trim; drop empty and
        // '#'-prefixed comment lines so admins can paste annotated
        // requirement-style snippets.
        var raw = document.getElementById(elementId);
        if (!raw) return [];
        var lines = raw.value.split(/\r?\n/);
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line && line.charAt(0) !== '#') out.push(line);
        }
        return out;
    }

    function statusRow(label, value) {
        // value may be a string OR a DOM node (e.g. a styled <span> for
        // the replica sync state). textContent on a Node would coerce
        // it to "[object HTMLSpanElement]", so wrap nodes via children.
        var valueEl;
        if (value && typeof value === 'object' && value.nodeType) {
            valueEl = el('span', null, [value]);
        } else {
            valueEl = el('span', {textContent: String(value)});
        }
        return el('div', {className: 'status-row'}, [
            el('span', {className: 'status-label', textContent: label}),
            valueEl,
        ]);
    }

    function buildBreadcrumb(indexPath, extra) {
        var parts = indexPath.split('/');
        var children = [
            el('a', {href: '#indexes', textContent: 'Indexes'}),
            ' / ',
            el('a', {href: '#indexes/' + parts[0], textContent: parts[0]}),
            ' / ',
            el('a', {href: '#packages/' + indexPath, textContent: parts[1]}),
        ];
        if (extra) {
            for (var i = 0; i < extra.length; i++) {
                children.push(extra[i]);
            }
        }
        return el('h2', {className: 'page-heading'}, children);
    }

    // --- Plugin capabilities ---
    //
    // Some UI affordances (Macaroon tokens manager) only make sense when an
    // optional server-side plugin is installed. We learn that from the
    // devpi-server `/+api` (advertised feature flags) and `/+status`
    // (importable Python distribution names) responses.
    //
    // Both are fetched anyway by the status page; loadPluginCaps() falls
    // back to its own fetch when callers (users list, index detail) need
    // the answer before the user has navigated to status.
    var _pluginCaps = null;
    var _pluginCapsPromise = null;

    function _setPluginCaps(api, status) {
        _pluginCaps = {
            features: ((api && api.features) || []).slice(),
            versioninfo: (status && status.versioninfo) || {},
        };
        return _pluginCaps;
    }

    function loadPluginCaps() {
        if (_pluginCaps) return Promise.resolve(_pluginCaps);
        if (_pluginCapsPromise) return _pluginCapsPromise;
        _pluginCapsPromise = Promise.all([
            Api.get('/+api').catch(function () { return {result: {}}; }),
            Api.get('/+status').catch(function () { return {result: {}}; }),
        ]).then(function (results) {
            return _setPluginCaps(results[0].result, results[1].result);
        }).catch(function () {
            return _setPluginCaps({}, {});
        });
        return _pluginCapsPromise;
    }

    function hasDevpiTokens() {
        // Dev override: append `?no-devpi-tokens` (or `&no-devpi-tokens`)
        // to the URL to simulate a server without the plugin without
        // actually uninstalling. Useful for verifying the SPA degrades
        // gracefully (kebab item disappears, type selector hides, etc).
        if (location.search.indexOf('no-devpi-tokens') !== -1) return false;
        if (!_pluginCaps) return false;
        var f = _pluginCaps.features;
        if (f && f.indexOf('tokens') !== -1) return true;
        var v = _pluginCaps.versioninfo;
        return !!(v && Object.prototype.hasOwnProperty.call(v, 'devpi-tokens'));
    }

    function devpiTokensVersion() {
        if (!_pluginCaps || !_pluginCaps.versioninfo) return null;
        return _pluginCaps.versioninfo['devpi-tokens'] || null;
    }

    function buildKebabMenu(items) {
        var menu = el('div', {className: 'kebab-menu'});
        menu.appendChild(el('button', {
            className: 'kebab-btn',
            textContent: '\u22ee',
            onclick: function (e) {
                e.stopPropagation();
                var dd = menu.querySelector('.kebab-dropdown');
                var wasOpen = !dd.hidden;
                closeAllKebabs();
                dd.hidden = wasOpen;
            },
        }));
        var dropdownItems = [];
        for (var i = 0; i < items.length; i++) {
            dropdownItems.push(el('button', {
                className: 'kebab-item' + (items[i].danger ? ' kebab-item-danger' : ''),
                textContent: items[i].label,
                onclick: items[i].onclick,
            }));
        }
        menu.appendChild(el('div', {className: 'kebab-dropdown', hidden: true}, dropdownItems));
        return menu;
    }

    // --- Modal ---

    var modalCard = document.querySelector('#modal-overlay .modal');

    function openModal(title, bodyFn, buttons, opts) {
        modalTitle.textContent = title;
        clear(modalBody);
        clear(modalFooter);
        modalError.hidden = true;
        // Optional wide layout for content that needs more horizontal
        // room (e.g. the user-tokens table, with ~8 columns).
        modalCard.classList.toggle('modal-wide', !!(opts && opts.width === 'wide'));
        bodyFn(modalBody);
        for (var i = 0; i < buttons.length; i++) {
            modalFooter.appendChild(buttons[i]);
        }
        modalOverlay.hidden = false;
    }

    function closeModal() {
        modalOverlay.hidden = true;
        modalCard.classList.remove('modal-wide');
    }

    function showModalError(msgOrErr) {
        var text = (typeof msgOrErr === 'string') ? msgOrErr
            : (msgOrErr && msgOrErr.message) || 'Operation failed';
        modalError.textContent = text;
        modalError.hidden = false;
    }

    modalCloseBtn.addEventListener('click', closeModal);
    // Close on click *outside* the modal — but only if BOTH mousedown
    // and mouseup landed on the overlay. Otherwise a text selection
    // that starts inside the modal and drags out would dismiss it,
    // losing whatever the user was typing.
    var _overlayMousedownOutside = false;
    modalOverlay.addEventListener('mousedown', function (e) {
        _overlayMousedownOutside = (e.target === modalOverlay);
    });
    modalOverlay.addEventListener('mouseup', function (e) {
        var bothOutside = _overlayMousedownOutside
            && e.target === modalOverlay;
        _overlayMousedownOutside = false;
        if (bothOutside) closeModal();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (!modalOverlay.hidden) closeModal();
            closeAllKebabs();
            var hi = document.querySelector('.header-inner');
            if (hi) hi.classList.remove('menu-open');
        }
    });

    // --- Tag picker ---

    function buildTagPicker(id, selected, options, extraOptions, orderable, onChange) {
        var values = selected.slice();
        var container = el('div', {className: 'tag-picker', id: id});
        var dragIdx = null;

        function render() {
            clear(container);
            var tagsRow = el('div', {className: 'tag-picker-tags'});
            for (var i = 0; i < values.length; i++) {
                (function (val, idx) {
                    var removeBtn = el('span', {
                        className: 'tag-remove',
                        textContent: '\u00d7',
                        onclick: function (e) {
                            e.stopPropagation();
                            values.splice(idx, 1);
                            render();
                        },
                    });
                    var tag = el('span', {className: 'tag tag-removable'}, [
                        val, removeBtn,
                    ]);
                    if (orderable) {
                        tag.setAttribute('draggable', 'true');
                        tag.classList.add('tag-draggable');
                        tag.addEventListener('dragstart', function (e) {
                            dragIdx = idx;
                            tag.classList.add('tag-dragging');
                            e.dataTransfer.effectAllowed = 'move';
                        });
                        tag.addEventListener('dragend', function () {
                            dragIdx = null;
                            tag.classList.remove('tag-dragging');
                        });
                        tag.addEventListener('dragover', function (e) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            tag.classList.add('tag-dragover');
                        });
                        tag.addEventListener('dragleave', function () {
                            tag.classList.remove('tag-dragover');
                        });
                        tag.addEventListener('drop', function (e) {
                            e.preventDefault();
                            tag.classList.remove('tag-dragover');
                            if (dragIdx === null || dragIdx === idx) return;
                            var item = values.splice(dragIdx, 1)[0];
                            values.splice(idx, 0, item);
                            dragIdx = null;
                            render();
                        });
                    }
                    tagsRow.appendChild(tag);
                })(values[i], i);
            }
            container.appendChild(tagsRow);

            var available = [];
            var all = (extraOptions || []).concat(options || []);
            for (var j = 0; j < all.length; j++) {
                if (values.indexOf(all[j]) === -1) available.push(all[j]);
            }
            if (available.length > 0) {
                var addSelect = el('select', {className: 'tag-picker-add'});
                addSelect.appendChild(el('option', {value: '', textContent: '+ Add...'}));
                for (var k = 0; k < available.length; k++) {
                    addSelect.appendChild(el('option', {
                        value: available[k],
                        textContent: available[k],
                    }));
                }
                addSelect.addEventListener('change', function () {
                    if (this.value) {
                        values.push(this.value);
                        render();
                    }
                });
                container.appendChild(addSelect);
            }
            if (onChange) onChange(values);
        }
        render();
        return container;
    }

    function getTagPickerValues(id) {
        var container = document.getElementById(id);
        if (!container) return [];
        var tags = container.querySelectorAll('.tag-removable');
        var vals = [];
        for (var i = 0; i < tags.length; i++) {
            vals.push(tags[i].firstChild.textContent);
        }
        return vals;
    }

    // --- Common ---

    function downloadFile(content, filename) {
        var blob = new Blob([content], {type: 'text/plain'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    var TTL_OPTIONS = [
        {value: 3600, label: '1 hour'},
        {value: 86400, label: '1 day'},
        {value: 604800, label: '7 days'},
        {value: 2592000, label: '30 days'},
        {value: 7776000, label: '90 days'},
        {value: 31536000, label: '1 year'},
    ];

    function shellQuote(s) {
        // POSIX-safe single quoting; escapes any embedded single quotes.
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    // Canonical public URL — fetched once, cached for the session. Single
    // source of truth shared with the backend so static pip.conf / .pypirc
    // fallbacks match what _pip_conf_view would emit when behind a proxy
    // with --outside-url set. Falls back to location.origin if the call
    // ever fails (extremely conservative — anonymous endpoint, no auth).
    var _publicUrlCache = null;
    function getPublicUrl() {
        if (_publicUrlCache) return Promise.resolve(_publicUrlCache);
        return Api.get('/+admin-api/public-url')
            .then(function (data) {
                _publicUrlCache = (data && data.url) || location.origin;
                return _publicUrlCache;
            })
            .catch(function () {
                _publicUrlCache = location.origin.replace(/\/+$/, '');
                return _publicUrlCache;
            });
    }

    function hostFromUrl(url) {
        try { return new URL(url).hostname; }
        catch (e) { return location.hostname; }
    }

    function isUploadFrozen(aclUpload) {
        // Empty acl_upload — devpi grants 'upload' to nobody (not even
        // root or the index owner). The index is effectively frozen
        // for new publishes.
        return !aclUpload || aclUpload.length === 0;
    }

    function isPublicAclRead(aclRead) {
        if (!aclRead || !aclRead.length) return true;
        for (var i = 0; i < aclRead.length; i++) {
            if (aclRead[i] === ':ANONYMOUS:') return true;
        }
        return false;
    }

    function isAnonymousAclUpload(aclUpload) {
        // ":ANONYMOUS:" in acl_upload makes the index world-writable —
        // any caller, even unauthenticated, can publish packages.
        // Devpi accepts this configuration; we surface it as a hard
        // warning rather than silently allowing it.
        if (!aclUpload || !aclUpload.length) return false;
        for (var i = 0; i < aclUpload.length; i++) {
            if (aclUpload[i] === ':ANONYMOUS:') return true;
        }
        return false;
    }


    function renderTokensList(username, opts) {
        opts = opts || {};
        var containerId = opts.containerId || 'tokens-list-container';
        var hideOnEmpty = !!opts.hideOnEmpty;
        var container = document.getElementById(containerId);
        if (!container) return Promise.resolve(0);
        return Api.get('/+admin-api/users/' + encodeURIComponent(username) + '/tokens')
            .then(function (data) {
                clear(container);
                var tokens = data.result || [];
                if (!tokens.length) {
                    if (hideOnEmpty) {
                        // Caller orchestrates the empty state across both
                        // sections — don't show our own placeholder.
                        return 0;
                    }
                    container.appendChild(el('div', {
                        className: 'tokens-empty',
                        textContent: 'No active tokens.',
                    }));
                    return 0;
                }
                var table = el('table', {className: 'tokens-table'});
                var thead = el('thead');
                thead.appendChild(el('tr', null, [
                    el('th', {textContent: 'Label'}),
                    el('th', {textContent: 'Index'}),
                    el('th', {textContent: 'Scope'}),
                    el('th', {textContent: 'Expires'}),
                    el('th', {textContent: 'Issuer'}),
                    el('th', {textContent: 'IP'}),
                    el('th', {textContent: 'ID'}),
                    el('th', {}),
                ]));
                table.appendChild(thead);
                var tbody = el('tbody');
                for (var i = 0; i < tokens.length; i++) {
                    tbody.appendChild(buildTokenRow(tokens[i], username));
                }
                table.appendChild(tbody);
                // Wrap so the table can scroll horizontally inside the
                // modal on narrow viewports instead of stretching it.
                var wrap = el('div', {className: 'tokens-table-wrap'});
                wrap.appendChild(table);
                container.appendChild(wrap);
                return tokens.length;
            })
            .catch(function (err) {
                clear(container);
                container.appendChild(el('div', {
                    className: 'error-text',
                    textContent: 'Failed to load tokens: ' + err.message,
                }));
                return 0;
            });
    }

    function buildTokenRow(t, username) {
        var row = el('tr', null, [
            el('td', {textContent: t.label || '(no label)'}),
            el('td', {className: 'mono', textContent: t.index || '—'}),
            el('td', null, [
                el('span', {
                    className: 'token-scope token-scope-' + (t.scope || 'unknown'),
                    textContent: t.scope || '—',
                }),
            ]),
            el('td', {textContent: formatExpiry(t.expires_in)}),
            el('td', {textContent: t.issuer}),
            el('td', {textContent: t.client_ip || '—'}),
            el('td', {className: 'mono', textContent: t.id_short}),
            el('td', null, [
                el('button', {
                    className: 'btn btn-small',
                    textContent: 'Revoke',
                    onclick: function () {
                        if (!confirm('Revoke token "' + (t.label || t.id_short) + '"?')) return;
                        Api.del('/+admin-api/tokens/' + encodeURIComponent(t.id))
                            .then(function () { renderTokensList(username); })
                            .catch(showModalError);
                    },
                }),
            ]),
        ]);
        _markJustIssued(row, t.id);
        return row;
    }

    // --- Macaroon tokens (devpi-tokens plugin) ---
    //
    // Optional second token manager: appears in the user kebab only when
    // `devpi-tokens` is installed on the server. Talks directly to the
    // devpi-tokens HTTP API (`/{user}/+token-create`, `/{user}/+tokens`,
    // `/{user}/+tokens/{id}`) — we do NOT proxy through `/+admin-api/`.
    //
    // Different threat model from admin tokens (raw secret in keyfs, no
    // audit log, derived tokens not listable). The modal shows a
    // persistent security banner so users can make an informed choice.

    // devpi-tokens advertises restrictions over the wire as opaque
    // `name=value` / `name=v1,v2` strings (see
    // devpi_tokens.restrictions.Restriction.dump()). The client side
    // re-parses them so we can render them as columns and validate the
    // existence of expected restrictions.
    var MACAROON_LIST_RESTRICTIONS = {indexes: 1, projects: 1, allowed: 1};
    var MACAROON_INT_RESTRICTIONS = {expires: 1, not_before: 1};

    function parseMacaroonRestrictions(strings) {
        var out = {};
        if (!strings || !strings.length) return out;
        for (var i = 0; i < strings.length; i++) {
            var s = strings[i];
            var eq = s.indexOf('=');
            if (eq <= 0) continue;
            var key = s.substring(0, eq);
            var raw = s.substring(eq + 1);
            if (MACAROON_LIST_RESTRICTIONS[key]) {
                out[key] = raw ? raw.split(',') : [];
            } else if (MACAROON_INT_RESTRICTIONS[key]) {
                var n = parseInt(raw, 10);
                out[key] = isNaN(n) ? null : n;
            } else {
                out[key] = raw;
            }
        }
        return out;
    }

    function formatMacaroonTimestamp(unixTs) {
        if (unixTs === null || unixTs === undefined) return '—';
        var d = new Date(unixTs * 1000);
        if (isNaN(d.getTime())) return String(unixTs);
        // Locale-friendly short form, no seconds.
        var iso = d.toISOString().replace('T', ' ').substring(0, 16);
        return iso + ' UTC';
    }

    function shortMacaroonId(id) {
        if (!id) return '';
        return id.length > 12 ? id.substring(0, 12) : id;
    }

    // Security banner persists per logged-in user — keying by the human
    // reading the screen, not by the user whose tokens they're managing
    // (root managing alice's tokens still wants to see the note once).
    // Stored in localStorage so it survives reloads but stays per-browser
    // (different device = different trust context = banner re-appears).
    function _macaroonBannerKey() {
        return 'devpi-admin.macaroon-banner-dismissed.'
            + (Api.getUser() || '_anon');
    }

    function isMacaroonBannerDismissed() {
        try { return localStorage.getItem(_macaroonBannerKey()) === '1'; }
        catch (e) { return false; }
    }

    function dismissMacaroonBanner() {
        try { localStorage.setItem(_macaroonBannerKey(), '1'); } catch (e) {}
    }

    function buildMacaroonSecurityBanner() {
        if (isMacaroonBannerDismissed()) return null;
        var banner = el('div', {className: 'macaroon-security-banner'});
        banner.appendChild(el('button', {
            type: 'button',
            className: 'macaroon-security-dismiss',
            textContent: '×',
            title: 'Hide and don\'t show again on this device',
            onclick: function () {
                dismissMacaroonBanner();
                if (banner.parentNode) banner.parentNode.removeChild(banner);
            },
        }));
        banner.appendChild(el('strong', {textContent: 'Security note. '}));
        banner.appendChild(document.createTextNode(
            'Devpi tokens (macaroon-based, served by the devpi-tokens '
            + 'plugin) store the raw secret in the server keyfs. Anyone '
            + 'with filesystem access to the devpi data dir (or a leaked '
            + 'backup, or a replica disk dump) can use them. For '
            + 'privileged workflows prefer Admin tokens (hash-only '
            + 'storage, audit log).'
        ));
        return banner;
    }

    function buildMacaroonNote() {
        return el('div', {className: 'macaroon-note'},
            ['ⓘ Derived tokens (`devpi token-derive`) are not '
                + 'listable — this view only shows initial tokens.']);
    }

    // Unified per-user Tokens modal: combines Admin tokens + Devpi tokens
    // (when the plugin is installed) into a single view. Each section
    // hides itself when its list is empty so the modal isn't cluttered
    // with empty placeholders. A single "+ Issue new" button opens the
    // unified Issue modal where the user picks the backend.
    function showTokensModal(username) {
        // Make sure plugin caps are loaded — without this we could miss
        // the Devpi section on a deep-link reload of the User card.
        loadPluginCaps().then(function () {
            _renderUnifiedTokensModal(username);
        });
    }

    function _renderUnifiedTokensModal(username) {
        var hasDevpi = hasDevpiTokens();
        openModal(
            'Tokens for ' + username,
            function (body) {
                if (hasDevpi) {
                    var bn = buildMacaroonSecurityBanner();
                    if (bn) body.appendChild(bn);
                }

                var adminSection = el('div', {
                    id: 'tokens-admin-section',
                    className: 'tokens-section',
                    hidden: true,
                });
                adminSection.appendChild(el('h3', {
                    className: 'tokens-section-heading',
                    textContent: 'Admin tokens',
                }));
                adminSection.appendChild(el('div', {
                    id: 'tokens-list-container',
                }));
                body.appendChild(adminSection);

                if (hasDevpi) {
                    var devpiSection = el('div', {
                        id: 'tokens-devpi-section',
                        className: 'tokens-section',
                        hidden: true,
                    });
                    devpiSection.appendChild(el('h3', {
                        className: 'tokens-section-heading',
                        textContent: 'Devpi tokens',
                    }));
                    devpiSection.appendChild(buildMacaroonNote());
                    devpiSection.appendChild(el('div', {
                        id: 'macaroon-tokens-list-container',
                    }));
                    body.appendChild(devpiSection);
                }

                // Catch-all when both sections turn out empty.
                body.appendChild(el('div', {
                    id: 'tokens-empty-both',
                    className: 'tokens-empty',
                    textContent: 'No tokens.',
                    hidden: true,
                }));

                // Loading indicator until both fetches resolve.
                body.appendChild(el('div', {
                    id: 'tokens-loading',
                    className: 'tokens-empty',
                    textContent: 'Loading…',
                }));
            },
            [
                el('button', {
                    className: 'btn',
                    textContent: '+ Issue new',
                    onclick: function () {
                        showIssueTokenModal(username);
                    },
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Reset all admin',
                    title: 'Revoke every admin token bound to this user. '
                        + 'Devpi tokens are not affected.',
                    onclick: function () {
                        if (!confirm('Revoke ALL admin tokens for '
                                + username + '?')) return;
                        Api.del('/+admin-api/users/'
                                + encodeURIComponent(username) + '/tokens')
                            .then(function () {
                                _populateUnifiedTokens(username, hasDevpi);
                            })
                            .catch(showModalError);
                    },
                }),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ],
            {width: 'wide'});
        _populateUnifiedTokens(username, hasDevpi);
    }

    function _populateUnifiedTokens(username, hasDevpi) {
        var p1 = renderTokensList(username, {hideOnEmpty: true});
        var p2 = hasDevpi
            ? renderMacaroonTokensList(username, {hideOnEmpty: true})
            : Promise.resolve(0);
        Promise.all([p1, p2]).then(function (counts) {
            var loadingEl = document.getElementById('tokens-loading');
            if (loadingEl) loadingEl.hidden = true;
            var adminCount = counts[0] || 0;
            var devpiCount = counts[1] || 0;
            var adminEl = document.getElementById('tokens-admin-section');
            if (adminEl) adminEl.hidden = (adminCount === 0);
            var devpiEl = document.getElementById('tokens-devpi-section');
            if (devpiEl) devpiEl.hidden = (devpiCount === 0);
            var emptyEl = document.getElementById('tokens-empty-both');
            if (emptyEl) emptyEl.hidden = (adminCount + devpiCount > 0);
        });
    }


    function renderMacaroonTokensList(username, opts) {
        opts = opts || {};
        var containerId = opts.containerId || 'macaroon-tokens-list-container';
        var hideOnEmpty = !!opts.hideOnEmpty;
        var container = document.getElementById(containerId);
        if (!container) return Promise.resolve(0);
        return Api.get('/' + encodeURIComponent(username) + '/+tokens')
            .then(function (data) {
                clear(container);
                var tokens = (data && data.result && data.result.tokens) || {};
                var ids = Object.keys(tokens);
                if (!ids.length) {
                    if (hideOnEmpty) return 0;
                    container.appendChild(el('div', {
                        className: 'tokens-empty',
                        textContent: 'No Devpi tokens.',
                    }));
                    return 0;
                }
                var table = el('table', {className: 'tokens-table'});
                var thead = el('thead');
                thead.appendChild(el('tr', null, [
                    el('th', {textContent: 'ID'}),
                    el('th', {textContent: 'Indexes'}),
                    el('th', {textContent: 'Allowed'}),
                    el('th', {textContent: 'Projects'}),
                    el('th', {textContent: 'Expires'}),
                    el('th', {textContent: 'Not before'}),
                    el('th', {}),
                ]));
                table.appendChild(thead);
                var tbody = el('tbody');
                // Stable order: by token id ascending.
                ids.sort();
                for (var i = 0; i < ids.length; i++) {
                    var t = tokens[ids[i]] || {};
                    var parsed = parseMacaroonRestrictions(t.restrictions);
                    tbody.appendChild(buildMacaroonTokenRow(ids[i], parsed, username));
                }
                table.appendChild(tbody);
                table.classList.add('tokens-table-macaroon');
                var wrap = el('div', {className: 'tokens-table-wrap'});
                wrap.appendChild(table);
                container.appendChild(wrap);
                return ids.length;
            })
            .catch(function (err) {
                clear(container);
                container.appendChild(el('div', {
                    className: 'error-text',
                    textContent: 'Failed to load Devpi tokens: ' + err.message,
                }));
                return 0;
            });
    }

    function _macaroonRestrictionCell(values, fallbackText, warn) {
        if (!values || !values.length) {
            var span = el('span', {
                className: warn ? 'macaroon-warn' : 'macaroon-faint',
                textContent: fallbackText,
            });
            return el('td', {className: 'macaroon-cell-wrap'}, [span]);
        }
        // Render each value as a pill so multi-value cells flow to a new
        // line instead of triggering the table's horizontal scrollbar.
        var chips = el('div', {className: 'macaroon-chips'});
        for (var i = 0; i < values.length; i++) {
            chips.appendChild(el('span', {
                className: 'macaroon-chip',
                textContent: values[i],
            }));
        }
        return el('td', {className: 'macaroon-cell-wrap'}, [chips]);
    }

    // Permission catalog — drives the checkbox grid in the Issue modal and
    // gates the anti-footgun warning. Basic block is checked by default;
    // destructive ops are collapsed in an "Advanced" section so a user
    // does not include them without intent.
    var MACAROON_PERMS_BASIC = [
        {key: 'pkg_read', desc: 'pip install / browse'},
        {key: 'upload', desc: 'twine upload (does NOT include delete)'},
        {key: 'toxresult_upload', desc: 'upload tox results'},
    ];
    var MACAROON_PERMS_DESTRUCTIVE = [
        {key: 'del_entry', desc: 'delete individual files'},
        {key: 'del_project', desc: 'delete entire project'},
        {key: 'del_verdata', desc: 'delete versions'},
        {key: 'index_modify', desc: 'change index config (incl. ACLs)'},
        {key: 'index_delete', desc: 'delete the index entirely'},
    ];
    var MACAROON_PERMS_DEFAULT_CHECKED = {pkg_read: 1, upload: 1};

    var MACAROON_EXPIRES_PRESETS = [
        {seconds: 3600, label: '1 hour'},
        {seconds: 86400, label: '1 day'},
        {seconds: 604800, label: '7 days'},
        {seconds: 2592000, label: '30 days'},
        {seconds: 7776000, label: '90 days'},
        {seconds: 31536000, label: '1 year'},
    ];
    var MACAROON_DEFAULT_EXPIRES = 86400;  // 1 day — matches admin tokens
    // pip-conf default; longer TTL or custom date is explicit opt-in.

    var _MACAROON_INDEX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

    function _parseLinesOrCsv(raw) {
        // Accept newline OR comma separated, drop empties and # comments.
        if (!raw) return [];
        var parts = String(raw).split(/[\n,]+/);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var v = parts[i].trim();
            if (v && v.charAt(0) !== '#') out.push(v);
        }
        return out;
    }

    function buildMacaroonTokenRow(tokenId, parsed, username) {
        var indexesCell = _macaroonRestrictionCell(
            parsed.indexes, '⚠ any', true);
        var allowedCell = _macaroonRestrictionCell(
            parsed.allowed, '⚠ all (except user_*)', true);
        var projectsCell = _macaroonRestrictionCell(
            parsed.projects, '—', false);
        var idCell = el('td', {
            className: 'mono',
            textContent: shortMacaroonId(tokenId),
            title: tokenId,
        });
        var actions = el('td', null, [
            el('button', {
                className: 'btn btn-small',
                textContent: 'Revoke',
                onclick: function () {
                    if (!confirm('Revoke Devpi token "'
                            + shortMacaroonId(tokenId) + '"?')) return;
                    Api.del('/' + encodeURIComponent(username)
                            + '/+tokens/' + encodeURIComponent(tokenId))
                        .then(function () {
                            renderMacaroonTokensList(username);
                        })
                        .catch(showModalError);
                },
            }),
        ]);
        return el('tr', null, [
            idCell,
            indexesCell,
            allowedCell,
            projectsCell,
            el('td', {textContent: formatMacaroonTimestamp(parsed.expires)}),
            el('td', {textContent: formatMacaroonTimestamp(parsed.not_before)}),
            actions,
        ]);
    }

    // --- Per-index macaroon listing ---
    //
    // devpi-tokens has no per-index listing endpoint; we fetch the index
    // owner's whole token list (`GET /<owner>/+tokens`) and filter
    // client-side by the `indexes` caveat. Tokens with no `indexes`
    // restriction (super-tokens) implicitly grant access to every index
    // and are always included.

    function _macaroonTokenAppliesTo(parsed, userIdx) {
        if (!parsed.indexes || !parsed.indexes.length) return true;
        return parsed.indexes.indexOf(userIdx) !== -1;
    }

    // Per-index unified Tokens modal — same shape as the per-user version
    // but the listing endpoints filter to tokens bound to this index.
    // Issue button preselects the index so the user can't accidentally
    // create a token for a different one.
    function showIndexTokensModal(idxUser, idxName, aclRead) {
        loadPluginCaps().then(function () {
            _renderUnifiedIndexTokensModal(idxUser, idxName, aclRead);
        });
    }

    function _renderUnifiedIndexTokensModal(idxUser, idxName, aclRead) {
        var userIdx = idxUser + '/' + idxName;
        var hasDevpi = hasDevpiTokens();
        openModal(
            'Tokens for ' + userIdx,
            function (body) {
                if (hasDevpi) {
                    var bn = buildMacaroonSecurityBanner();
                    if (bn) body.appendChild(bn);
                }

                var adminSection = el('div', {
                    id: 'index-tokens-admin-section',
                    className: 'tokens-section',
                    hidden: true,
                });
                adminSection.appendChild(el('h3', {
                    className: 'tokens-section-heading',
                    textContent: 'Admin tokens',
                }));
                adminSection.appendChild(el('div', {
                    id: 'index-admin-tokens-list-container',
                }));
                body.appendChild(adminSection);

                if (hasDevpi) {
                    var devpiSection = el('div', {
                        id: 'index-tokens-devpi-section',
                        className: 'tokens-section',
                        hidden: true,
                    });
                    devpiSection.appendChild(el('h3', {
                        className: 'tokens-section-heading',
                        textContent: 'Devpi tokens',
                    }));
                    devpiSection.appendChild(el('div', {
                        className: 'macaroon-note',
                    }, [
                        'ⓘ Showing tokens issued for ' + idxUser
                            + ' that grant access to this index. '
                            + 'Tokens without an `indexes` restriction '
                            + '(super-tokens) are also included.',
                    ]));
                    devpiSection.appendChild(el('div', {
                        id: 'macaroon-index-tokens-list-container',
                    }));
                    body.appendChild(devpiSection);
                }

                body.appendChild(el('div', {
                    id: 'index-tokens-empty-both',
                    className: 'tokens-empty',
                    textContent: 'No tokens for this index.',
                    hidden: true,
                }));

                body.appendChild(el('div', {
                    id: 'index-tokens-loading',
                    className: 'tokens-empty',
                    textContent: 'Loading…',
                }));
            },
            [
                el('button', {
                    className: 'btn',
                    textContent: '+ Issue new',
                    onclick: function () {
                        // Issue for the index owner; preselect this index
                        // so the form can hint that admin scope=read is
                        // useless on a public index, etc. Done returns
                        // to this per-index modal so the new token is
                        // visible in context.
                        showIssueTokenModal(idxUser, {
                            preselectIndexes: [userIdx],
                            lockIndex: true,
                            returnTo: function () {
                                showIndexTokensModal(
                                    idxUser, idxName, aclRead);
                            },
                        });
                    },
                }),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ],
            {width: 'wide'});
        _populateIndexTokens(idxUser, idxName, hasDevpi);
    }

    function _populateIndexTokens(idxUser, idxName, hasDevpi) {
        var p1 = renderIndexAdminTokensList(idxUser, idxName, {hideOnEmpty: true});
        var p2 = hasDevpi
            ? renderIndexMacaroonTokensList(idxUser, idxName, {hideOnEmpty: true})
            : Promise.resolve(0);
        Promise.all([p1, p2]).then(function (counts) {
            var loadingEl = document.getElementById('index-tokens-loading');
            if (loadingEl) loadingEl.hidden = true;
            var adminCount = counts[0] || 0;
            var devpiCount = counts[1] || 0;
            var adminEl = document.getElementById('index-tokens-admin-section');
            if (adminEl) adminEl.hidden = (adminCount === 0);
            var devpiEl = document.getElementById('index-tokens-devpi-section');
            if (devpiEl) devpiEl.hidden = (devpiCount === 0);
            var emptyEl = document.getElementById('index-tokens-empty-both');
            if (emptyEl) emptyEl.hidden = (adminCount + devpiCount > 0);
        });
    }

    function renderIndexAdminTokensList(idxUser, idxName, opts) {
        opts = opts || {};
        var containerId = opts.containerId || 'index-admin-tokens-list-container';
        var hideOnEmpty = !!opts.hideOnEmpty;
        var container = document.getElementById(containerId);
        if (!container) return Promise.resolve(0);
        var url = '/+admin-api/indexes/' + encodeURIComponent(idxUser)
            + '/' + encodeURIComponent(idxName) + '/tokens';
        return Api.get(url)
            .then(function (data) {
                clear(container);
                var tokens = (data && data.result) || [];
                if (!tokens.length) {
                    if (hideOnEmpty) return 0;
                    container.appendChild(el('div', {
                        className: 'tokens-empty',
                        textContent: 'No admin tokens for this index.',
                    }));
                    return 0;
                }
                var table = el('table', {className: 'tokens-table'});
                var thead = el('thead');
                thead.appendChild(el('tr', null, [
                    el('th', {textContent: 'Label'}),
                    el('th', {textContent: 'Scope'}),
                    el('th', {textContent: 'Expires'}),
                    el('th', {textContent: 'Issuer'}),
                    el('th', {textContent: 'IP'}),
                    el('th', {textContent: 'ID'}),
                    el('th', {}),
                ]));
                table.appendChild(thead);
                var tbody = el('tbody');
                for (var i = 0; i < tokens.length; i++) {
                    tbody.appendChild(_buildIndexAdminTokenRow(
                        tokens[i], idxUser, idxName));
                }
                table.appendChild(tbody);
                var wrap = el('div', {className: 'tokens-table-wrap'});
                wrap.appendChild(table);
                container.appendChild(wrap);
                return tokens.length;
            })
            .catch(function (err) {
                clear(container);
                container.appendChild(el('div', {
                    className: 'error-text',
                    textContent: 'Failed to load admin tokens: ' + err.message,
                }));
                return 0;
            });
    }

    function _buildIndexAdminTokenRow(t, idxUser, idxName) {
        // No "Index" column — the whole table is already index-scoped.
        var row = el('tr', null, [
            el('td', {textContent: t.label || '(no label)'}),
            el('td', null, [
                el('span', {
                    className: 'token-scope token-scope-' + (t.scope || 'unknown'),
                    textContent: t.scope || '—',
                }),
            ]),
            el('td', {textContent: formatExpiry(t.expires_in)}),
            el('td', {textContent: t.issuer}),
            el('td', {textContent: t.client_ip || '—'}),
            el('td', {className: 'mono', textContent: t.id_short}),
            el('td', null, [
                el('button', {
                    className: 'btn btn-small',
                    textContent: 'Revoke',
                    onclick: function () {
                        if (!confirm('Revoke admin token "'
                                + (t.label || t.id_short) + '"?')) return;
                        Api.del('/+admin-api/tokens/' + encodeURIComponent(t.id))
                            .then(function () {
                                renderIndexAdminTokensList(idxUser, idxName);
                            })
                            .catch(showModalError);
                    },
                }),
            ]),
        ]);
        _markJustIssued(row, t.id);
        return row;
    }

    function renderIndexMacaroonTokensList(idxUser, idxName, opts) {
        opts = opts || {};
        var containerId = opts.containerId
            || 'macaroon-index-tokens-list-container';
        var hideOnEmpty = !!opts.hideOnEmpty;
        var userIdx = idxUser + '/' + idxName;
        var container = document.getElementById(containerId);
        if (!container) return Promise.resolve(0);
        return Api.get('/' + encodeURIComponent(idxUser) + '/+tokens')
            .then(function (data) {
                clear(container);
                var tokens = (data && data.result && data.result.tokens) || {};
                var ids = Object.keys(tokens);
                // Filter to tokens that apply to this index.
                var matching = [];
                for (var i = 0; i < ids.length; i++) {
                    var parsed = parseMacaroonRestrictions(
                        (tokens[ids[i]] || {}).restrictions);
                    if (_macaroonTokenAppliesTo(parsed, userIdx)) {
                        matching.push({id: ids[i], parsed: parsed});
                    }
                }
                if (!matching.length) {
                    if (hideOnEmpty) return 0;
                    container.appendChild(el('div', {
                        className: 'tokens-empty',
                        textContent: 'No Devpi tokens for this index.',
                    }));
                    return 0;
                }
                var table = el('table', {
                    className: 'tokens-table tokens-table-macaroon',
                });
                var thead = el('thead');
                thead.appendChild(el('tr', null, [
                    el('th', {textContent: 'ID'}),
                    el('th', {textContent: 'Indexes'}),
                    el('th', {textContent: 'Allowed'}),
                    el('th', {textContent: 'Projects'}),
                    el('th', {textContent: 'Expires'}),
                    el('th', {textContent: 'Not before'}),
                    el('th', {}),
                ]));
                table.appendChild(thead);
                var tbody = el('tbody');
                matching.sort(function (a, b) {
                    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                });
                for (var j = 0; j < matching.length; j++) {
                    tbody.appendChild(_buildMacaroonIndexTokenRow(
                        matching[j].id, matching[j].parsed, idxUser, idxName));
                }
                table.appendChild(tbody);
                var wrap = el('div', {className: 'tokens-table-wrap'});
                wrap.appendChild(table);
                container.appendChild(wrap);
                return matching.length;
            })
            .catch(function (err) {
                clear(container);
                container.appendChild(el('div', {
                    className: 'error-text',
                    textContent: 'Failed to load tokens: ' + err.message,
                }));
                return 0;
            });
    }

    // Same row layout as the per-user listing but the Revoke action
    // refreshes the per-index filtered view, not the user-level one.
    function _buildMacaroonIndexTokenRow(tokenId, parsed, idxUser, idxName) {
        var indexesCell = _macaroonRestrictionCell(
            parsed.indexes, '⚠ any', true);
        var allowedCell = _macaroonRestrictionCell(
            parsed.allowed, '⚠ all (except user_*)', true);
        var projectsCell = _macaroonRestrictionCell(
            parsed.projects, '—', false);
        var idCell = el('td', {
            className: 'mono',
            textContent: shortMacaroonId(tokenId),
            title: tokenId,
        });
        var actions = el('td', null, [
            el('button', {
                className: 'btn btn-small',
                textContent: 'Revoke',
                onclick: function () {
                    if (!confirm('Revoke Devpi token "'
                            + shortMacaroonId(tokenId) + '"?')) return;
                    Api.del('/' + encodeURIComponent(idxUser)
                            + '/+tokens/' + encodeURIComponent(tokenId))
                        .then(function () {
                            renderIndexMacaroonTokensList(idxUser, idxName);
                        })
                        .catch(showModalError);
                },
            }),
        ]);
        return el('tr', null, [
            idCell,
            indexesCell,
            allowedCell,
            projectsCell,
            el('td', {textContent: formatMacaroonTimestamp(parsed.expires)}),
            el('td', {textContent: formatMacaroonTimestamp(parsed.not_before)}),
            actions,
        ]);
    }

    // --- Macaroon issue modal ---

    function _macaroonPermCheckbox(perm, checked) {
        var cb = el('input', {
            type: 'checkbox',
            id: 'macaroon-perm-' + perm.key,
            value: perm.key,
            className: 'macaroon-perm-cb',
        });
        if (checked) cb.checked = true;
        var label = el('label', {
            className: 'macaroon-perm-label',
            for: 'macaroon-perm-' + perm.key,
        }, [
            cb,
            el('span', {className: 'macaroon-perm-name', textContent: perm.key}),
            el('span', {className: 'macaroon-perm-desc', textContent: ' — ' + perm.desc}),
        ]);
        return label;
    }

    // Token types supported by the unified Issue modal. The selector at the
    // top of the modal switches the form between Devpi tokens (multi-index,
    // permission checkboxes) and Admin tokens (single index, scope select).
    // When the caller doesn't pin a type, the modal defaults to whichever
    // backend the user *most recently* issued against — saves picking the
    // same radio every time. Falls back to Devpi (or Admin if the plugin
    // isn't installed) for users with no tokens yet.
    var TOKEN_TYPE_DEVPI = 'devpi';
    var TOKEN_TYPE_ADMIN = 'admin';

    function _detectRecentTokenType(username) {
        // Returns Promise<TOKEN_TYPE_*|null>. ``null`` means the user has
        // no tokens (or detection failed) — caller picks a static default.
        //
        // Admin tokens carry ``issued_at`` (epoch). Macaroon tokens have
        // no first-class issuance timestamp; we use ``not_before`` when
        // present (it tracks the issue moment for the typical "starts
        // now" flow) and fall back to ``expires`` so a freshly-issued
        // long-TTL token still wins over an older short-TTL one.
        var pAdmin = Api.get(
            '/+admin-api/users/' + encodeURIComponent(username) + '/tokens')
            .then(function (data) {
                var tokens = (data && data.result) || [];
                var max = 0;
                for (var i = 0; i < tokens.length; i++) {
                    var t = tokens[i].issued_at || 0;
                    if (t > max) max = t;
                }
                return max || null;
            })
            .catch(function () { return null; });

        var pDevpi = hasDevpiTokens()
            ? Api.get('/' + encodeURIComponent(username) + '/+tokens')
                .then(function (data) {
                    var tokens = (data && data.result
                        && data.result.tokens) || {};
                    var max = 0;
                    for (var id in tokens) {
                        if (!Object.prototype.hasOwnProperty.call(
                                tokens, id)) continue;
                        var parsed = parseMacaroonRestrictions(
                            tokens[id].restrictions);
                        var t = parsed.not_before
                            || parsed.expires || 0;
                        if (t > max) max = t;
                    }
                    return max || null;
                })
                .catch(function () { return null; })
            : Promise.resolve(null);

        return Promise.all([pAdmin, pDevpi]).then(function (results) {
            var adminTs = results[0];
            var devpiTs = results[1];
            if (!adminTs && !devpiTs) return null;
            if (!adminTs) return TOKEN_TYPE_DEVPI;
            if (!devpiTs) return TOKEN_TYPE_ADMIN;
            return adminTs >= devpiTs ? TOKEN_TYPE_ADMIN : TOKEN_TYPE_DEVPI;
        });
    }

    // Public entry point. `options` may include:
    //  • `preselectType` — 'devpi' or 'admin'
    //  • `preselectIndexes` — list of 'user/index' strings
    //  • `lockIndex` — when true, hides the index picker entirely and
    //    binds the form to `preselectIndexes[0]` (used by per-index
    //    Tokens flow where the index is already fixed by the entry).
    //  • `returnTo` — function called when user clicks Done after issue
    //    (defaults to the per-user unified Tokens modal).
    var _issueReturnTo = null;
    var _issueLockedIndex = null;
    function showIssueTokenModal(username, options) {
        options = options || {};
        var presel = (options.preselectIndexes || []).slice();
        var explicitType = options.preselectType || null;
        _issueReturnTo = options.returnTo || function () {
            showTokensModal(username);
        };
        _issueLockedIndex = (options.lockIndex && presel.length)
            ? presel[0] : null;
        // Caller pinned the type → honour it; otherwise detect from the
        // user's existing tokens (most-recently-issued backend wins).
        // Detection failure falls back to Devpi (or Admin if the plugin
        // isn't installed).
        var pType = explicitType
            ? Promise.resolve(explicitType)
            : _detectRecentTokenType(username);
        Promise.all([fetchRoot(), pType]).then(function (results) {
            var rootResult = results[0];
            var preselType = results[1] || TOKEN_TYPE_DEVPI;
            if (preselType === TOKEN_TYPE_DEVPI && !hasDevpiTokens()) {
                preselType = TOKEN_TYPE_ADMIN;
            }
            var indexInfos = getAllIndexes(rootResult);
            var aclByIndex = {};
            // Indexes accessible to the bound user: ones they own, ones
            // listing them in acl_read, ones listing them in acl_upload.
            // Root sees every index (bypasses ACLs everywhere). The
            // unified set powers both the Devpi multi-picker and the
            // Admin single-select; the issuer doesn't need to think
            // about which backend supports what.
            var isRoot = username === 'root';
            var accessible = [];
            for (var i = 0; i < indexInfos.length; i++) {
                var idx = indexInfos[i];
                aclByIndex[idx._full] = idx.acl_read || null;
                if (isRoot
                        || idx._user === username
                        || (idx.acl_read && idx.acl_read.indexOf(username) !== -1)
                        || (idx.acl_upload && idx.acl_upload.indexOf(username) !== -1)) {
                    accessible.push(idx._full);
                }
            }
            // Always include preselect entries — caller knows what they
            // want, even when the bound user has no obvious ACL match.
            for (var p = 0; p < presel.length; p++) {
                if (accessible.indexOf(presel[p]) === -1) {
                    accessible.push(presel[p]);
                }
            }
            _issueContext = {
                accessibleIndexes: accessible.sort(),
                aclByIndex: aclByIndex,
            };
            _renderIssueTokenModal(username, presel, preselType);
        }).catch(function () {
            var fallbackType = explicitType
                || (hasDevpiTokens() ? TOKEN_TYPE_DEVPI : TOKEN_TYPE_ADMIN);
            _issueContext = {
                accessibleIndexes: presel.slice(),
                aclByIndex: {},
            };
            _renderIssueTokenModal(username, presel, fallbackType);
        });
    }

    // Backwards-compat alias — internal callers may still use the old name.
    function showMacaroonIssueModal(username, preselectIndexes) {
        showIssueTokenModal(username, {
            preselectType: TOKEN_TYPE_DEVPI,
            preselectIndexes: preselectIndexes,
        });
    }

    function _applyTokenTypeVisibility(type) {
        // Show form groups whose `data-token-only` matches; hide others.
        // Groups without the attribute are common (always shown).
        var nodes = modalBody.querySelectorAll('[data-token-only]');
        for (var i = 0; i < nodes.length; i++) {
            var only = nodes[i].getAttribute('data-token-only');
            nodes[i].hidden = (only !== type);
        }
    }

    function _renderIssueTokenModal(username, preselect, initialType) {
        var indexOptions = (_issueContext && _issueContext.accessibleIndexes) || [];
        var locked = _issueLockedIndex;
        var title = locked
            ? 'Issue token for ' + locked
            : 'Issue token — ' + username;
        openModal(
            title,
            function (body) {
                // Token type selector — only meaningful when both backends
                // are available. With only Admin tokens (no devpi-tokens
                // plugin) we hide the chooser to keep the form compact.
                var typeSel = el('select', {id: 'token-type-select'});
                typeSel.appendChild(el('option', {
                    value: TOKEN_TYPE_DEVPI,
                    textContent: 'Devpi tokens — multi-index, fine permissions, derivable',
                }));
                typeSel.appendChild(el('option', {
                    value: TOKEN_TYPE_ADMIN,
                    textContent: 'Admin tokens — single index/scope, hash-only storage, audit log',
                }));
                typeSel.value = initialType;
                if (hasDevpiTokens()) {
                    body.appendChild(formGroup('Token type', typeSel));
                }
                // Always present so the collector can read `.value` even
                // when the chooser is hidden.

                // Devpi-only: security banner (optionally dismissed).
                var _bn = buildMacaroonSecurityBanner();
                if (_bn) {
                    _bn.setAttribute('data-token-only', TOKEN_TYPE_DEVPI);
                    body.appendChild(_bn);
                }

                // Indexes accessible to the bound user. Both pickers
                // share the same set; the issuer never has to choose
                // "include indexes from other users" because we already
                // included everything the bound user has ACL access to.
                // When `locked` is set, the index is fixed by the entry
                // point (per-index Tokens kebab) — show it as a static
                // label instead of an interactive picker.
                var adminIdxSel;  // hoisted; needed by scope refresh logic
                if (locked) {
                    var lockedRow = el('div', {className: 'form-group'});
                    lockedRow.appendChild(el('label', {textContent: 'Index'}));
                    lockedRow.appendChild(el('div', {
                        className: 'form-static-value',
                        textContent: locked,
                    }));
                    body.appendChild(lockedRow);
                    // Hidden <select> exposes the same `admin-index-select`
                    // id so the scope-refresh helper can read .value
                    // without branching.
                    adminIdxSel = el('select', {
                        id: 'admin-index-select',
                        hidden: true,
                    });
                    adminIdxSel.appendChild(el('option', {
                        value: locked,
                        textContent: locked,
                    }));
                    body.appendChild(adminIdxSel);
                } else {
                    var devpiIdxGroup = el('div', {className: 'form-group'});
                    devpiIdxGroup.setAttribute('data-token-only', TOKEN_TYPE_DEVPI);
                    devpiIdxGroup.appendChild(el('label', {
                        textContent: 'Indexes (required)',
                    }));
                    devpiIdxGroup.appendChild(buildTagPicker(
                        'macaroon-indexes', preselect || [],
                        indexOptions, [], false, null));
                    devpiIdxGroup.appendChild(el('div', {
                        className: 'form-hint',
                        textContent: 'Cross-index requests will be denied '
                            + 'by the token.',
                    }));
                    body.appendChild(devpiIdxGroup);

                    var adminIdxGroup = el('div', {className: 'form-group'});
                    adminIdxGroup.setAttribute('data-token-only', TOKEN_TYPE_ADMIN);
                    adminIdxGroup.appendChild(el('label', {
                        textContent: 'Index (required)',
                    }));
                    adminIdxSel = el('select', {id: 'admin-index-select'});
                    // Single-select with a real index always selected —
                    // no empty placeholder. Preselect wins; otherwise the
                    // first accessible index is the default.
                    var adminPicked = (preselect && preselect.length)
                        ? preselect[0] : (indexOptions[0] || '');
                    for (var ii = 0; ii < indexOptions.length; ii++) {
                        var optI = el('option', {
                            value: indexOptions[ii],
                            textContent: indexOptions[ii],
                        });
                        if (adminPicked === indexOptions[ii]) optI.selected = true;
                        adminIdxSel.appendChild(optI);
                    }
                    if (!indexOptions.length) {
                        adminIdxSel.appendChild(el('option', {
                            value: '',
                            textContent: '(no accessible indexes)',
                        }));
                    }
                    adminIdxGroup.appendChild(adminIdxSel);
                    body.appendChild(adminIdxGroup);
                }

                // Devpi-only: permissions checkbox grid + advanced section.
                var permsGroup = el('div', {className: 'form-group'});
                permsGroup.setAttribute('data-token-only', TOKEN_TYPE_DEVPI);
                permsGroup.appendChild(el('label', {textContent: 'Permissions'}));
                permsGroup.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'At least one. Token will only allow operations '
                        + 'in this set, intersected with the user\'s ACL.',
                }));
                var basicWrap = el('div', {className: 'macaroon-perms-block'});
                for (var i = 0; i < MACAROON_PERMS_BASIC.length; i++) {
                    var p = MACAROON_PERMS_BASIC[i];
                    basicWrap.appendChild(_macaroonPermCheckbox(
                        p, !!MACAROON_PERMS_DEFAULT_CHECKED[p.key]));
                }
                permsGroup.appendChild(basicWrap);

                var advToggle = el('button', {
                    type: 'button',
                    className: 'macaroon-adv-toggle',
                    textContent: '▸ Advanced (destructive operations)',
                });
                var advWrap = el('div', {
                    className: 'macaroon-perms-block macaroon-perms-advanced',
                    hidden: true,
                });
                advWrap.appendChild(el('div', {
                    className: 'macaroon-warn-text',
                    textContent: '⚠ These permissions allow data destruction '
                        + 'or index reconfiguration. Only enable if the token '
                        + 'is for a service that genuinely needs them.',
                }));
                for (var j = 0; j < MACAROON_PERMS_DESTRUCTIVE.length; j++) {
                    advWrap.appendChild(
                        _macaroonPermCheckbox(MACAROON_PERMS_DESTRUCTIVE[j], false));
                }
                advToggle.addEventListener('click', function () {
                    advWrap.hidden = !advWrap.hidden;
                    advToggle.textContent = (advWrap.hidden ? '▸' : '▾')
                        + ' Advanced (destructive operations)';
                });
                permsGroup.appendChild(advToggle);
                permsGroup.appendChild(advWrap);
                body.appendChild(permsGroup);

                // Admin-only: scope select. Admin tokens have a single
                // operational mode per token — read OR upload (no DELETE).
                // For public indexes (no acl_read restriction), read is
                // disabled because anyone can pip install without auth —
                // a read token would be wasted bytes.
                var scopeGroup = el('div', {className: 'form-group'});
                scopeGroup.setAttribute('data-token-only', TOKEN_TYPE_ADMIN);
                scopeGroup.appendChild(el('label', {textContent: 'Scope'}));
                // Options are (re)built by _refreshAdminScopeOptions
                // based on the picked index — public indexes get only
                // upload, private indexes get both.
                var scopeSel = el('select', {id: 'admin-scope-select'});
                scopeGroup.appendChild(scopeSel);
                var scopeHint = el('div', {
                    id: 'admin-scope-hint',
                    className: 'form-hint',
                });
                scopeGroup.appendChild(scopeHint);

                // Rebuild the scope options whenever the picked index
                // changes. Public indexes don't get the `read` option at
                // all (it would issue a useless token — anyone can pip
                // install without auth). Private indexes get both, with
                // `read` selected by default as the more common case.
                function _refreshAdminScopeOptions() {
                    var sel = document.getElementById('admin-index-select');
                    var picked = sel && sel.value;
                    var aclByIndex = (_issueContext && _issueContext.aclByIndex) || {};
                    var publicIdx = picked && isPublicAclRead(aclByIndex[picked]);
                    var prevValue = scopeSel.value;
                    clear(scopeSel);
                    if (!publicIdx) {
                        scopeSel.appendChild(el('option', {
                            value: 'read',
                            textContent: 'read — pip install / browse (GET, HEAD)',
                        }));
                    }
                    scopeSel.appendChild(el('option', {
                        value: 'upload',
                        textContent: 'upload — twine upload (no DELETE)',
                    }));
                    // Restore prior selection when still valid; otherwise
                    // pick the only option that's left.
                    if (publicIdx) {
                        scopeSel.value = 'upload';
                    } else if (prevValue === 'upload') {
                        scopeSel.value = 'upload';
                    } else {
                        scopeSel.value = 'read';
                    }
                    scopeHint.textContent = publicIdx
                        ? 'Index ' + picked + ' is public — only upload '
                            + 'scope is meaningful (pip install works '
                            + 'without auth on this index).'
                        : '';
                }
                adminIdxSel.addEventListener('change', _refreshAdminScopeOptions);
                // Apply once on initial render so a preselected index
                // (e.g. opened from per-index Tokens kebab) gates scope
                // immediately.
                setTimeout(_refreshAdminScopeOptions, 0);
                body.appendChild(scopeGroup);

                // Devpi-only: project filter.
                var projGroup = el('div', {className: 'form-group'});
                projGroup.setAttribute('data-token-only', TOKEN_TYPE_DEVPI);
                projGroup.appendChild(el('label', {
                    textContent: 'Project filter (optional)',
                }));
                projGroup.appendChild(el('textarea', {
                    id: 'macaroon-projects',
                    rows: 2,
                    placeholder: 'mycompany-*\nnumpy',
                    spellcheck: 'false',
                }));
                projGroup.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'One per line or comma-separated. '
                        + 'Empty = all projects on the bound indexes.',
                }));
                body.appendChild(projGroup);

                // Common: expires picker (presets + custom datetime).
                var expGroup = el('div', {className: 'form-group'});
                expGroup.appendChild(el('label', {textContent: 'Expires'}));
                var expSel = el('select', {id: 'macaroon-expires-select'});
                for (var k = 0; k < MACAROON_EXPIRES_PRESETS.length; k++) {
                    var preset = MACAROON_EXPIRES_PRESETS[k];
                    var optEl = el('option', {
                        value: String(preset.seconds),
                        textContent: preset.label,
                    });
                    if (preset.seconds === MACAROON_DEFAULT_EXPIRES) {
                        optEl.selected = true;
                    }
                    expSel.appendChild(optEl);
                }
                expSel.appendChild(el('option', {
                    value: 'custom',
                    textContent: 'Custom…',
                }));
                expGroup.appendChild(expSel);
                var customWrap = el('div', {
                    id: 'macaroon-exp-custom-wrap',
                    className: 'macaroon-exp-custom-wrap',
                    hidden: true,
                });
                customWrap.appendChild(el('input', {
                    type: 'datetime-local',
                    id: 'macaroon-exp-custom-date',
                }));
                expGroup.appendChild(customWrap);
                expSel.addEventListener('change', function () {
                    customWrap.hidden = (expSel.value !== 'custom');
                    if (customWrap.hidden) {
                        var f = document.getElementById('macaroon-exp-custom-date');
                        if (f) f.value = '';
                    }
                });
                body.appendChild(expGroup);

                // Devpi-only: not-before (delayed activation).
                var nbGroup = el('div', {className: 'form-group'});
                nbGroup.setAttribute('data-token-only', TOKEN_TYPE_DEVPI);
                nbGroup.appendChild(el('label', {
                    textContent: 'Not before (optional)',
                }));
                nbGroup.appendChild(el('input', {
                    type: 'datetime-local',
                    id: 'macaroon-not-before',
                }));
                nbGroup.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'Token is rejected before this time. '
                        + 'Useful for scheduled rollouts.',
                }));
                body.appendChild(nbGroup);

                // Admin-only: free-form label (audit log column).
                var labelGroup = el('div', {className: 'form-group'});
                labelGroup.setAttribute('data-token-only', TOKEN_TYPE_ADMIN);
                labelGroup.appendChild(el('label', {
                    textContent: 'Label (optional)',
                }));
                labelGroup.appendChild(el('input', {
                    type: 'text',
                    id: 'admin-label',
                    maxLength: 200,
                    placeholder: 'e.g. ci-prod, gitea-ci, ansible-deploy',
                }));
                body.appendChild(labelGroup);

                // Issued result container (hidden until success).
                body.appendChild(el('div', {
                    id: 'macaroon-issued-result',
                    hidden: true,
                }));

                // Wire type chooser; apply initial visibility.
                typeSel.addEventListener('change', function () {
                    _applyTokenTypeVisibility(typeSel.value);
                });
                _applyTokenTypeVisibility(typeSel.value);
            },
            [
                el('button', {
                    className: 'btn',
                    textContent: 'Cancel',
                    onclick: function () {
                        if (_issueReturnTo) _issueReturnTo();
                        else closeModal();
                    },
                }),
                el('button', {
                    id: 'macaroon-issue-submit',
                    className: 'btn btn-primary',
                    textContent: 'Issue token',
                    onclick: function () {
                        _submitIssue(username, this);
                    },
                }),
            ],
            {width: 'wide'});
    }

    function _collectIssueForm() {
        var typeEl = document.getElementById('token-type-select');
        var type = (typeEl && typeEl.value) || TOKEN_TYPE_DEVPI;

        // Common: expires (preset TTL or absolute datetime).
        var expSel = document.getElementById('macaroon-expires-select');
        var ttl = null;
        var expiresAbs = null;
        if (expSel && expSel.value === 'custom') {
            var customField = document.getElementById('macaroon-exp-custom-date');
            if (customField && customField.value) {
                var dc = new Date(customField.value);
                if (!isNaN(dc.getTime())) expiresAbs = Math.floor(dc.getTime() / 1000);
            }
        } else if (expSel) {
            ttl = parseInt(expSel.value, 10);
        }

        var form = {type: type, ttl: ttl, expires_abs: expiresAbs};

        if (type === TOKEN_TYPE_DEVPI) {
            // Locked index overrides the picker (pickers are hidden).
            form.indexes = _issueLockedIndex
                ? [_issueLockedIndex]
                : getTagPickerValues('macaroon-indexes');
            form.projects = _parseLinesOrCsv(
                (document.getElementById('macaroon-projects') || {}).value);
            var allowed = [];
            var cbs = document.querySelectorAll('.macaroon-perm-cb');
            for (var i = 0; i < cbs.length; i++) {
                if (cbs[i].checked) allowed.push(cbs[i].value);
            }
            form.allowed = allowed;
            var nbField = document.getElementById('macaroon-not-before');
            form.not_before = null;
            if (nbField && nbField.value) {
                var dn = new Date(nbField.value);
                if (!isNaN(dn.getTime())) form.not_before = Math.floor(dn.getTime() / 1000);
            }
        } else {
            // Admin: single index, single scope, optional label.
            if (_issueLockedIndex) {
                form.indexes = [_issueLockedIndex];
            } else {
                var idxSel = document.getElementById('admin-index-select');
                form.indexes = idxSel && idxSel.value ? [idxSel.value] : [];
            }
            var scopeSel = document.getElementById('admin-scope-select');
            form.scope = (scopeSel && scopeSel.value) || 'read';
            var labelEl = document.getElementById('admin-label');
            form.label = (labelEl && labelEl.value) || '';
            // Admin tokens don't carry a not_before — server uses
            // issued_at as the floor.
            form.not_before = null;
        }
        return form;
    }

    function _validateIssueForm(form) {
        if (!form.indexes.length) {
            return form.type === TOKEN_TYPE_DEVPI
                ? 'Pick at least one index.'
                : 'Pick an index.';
        }
        for (var i = 0; i < form.indexes.length; i++) {
            if (!_MACAROON_INDEX_RE.test(form.indexes[i])) {
                return 'Invalid index format: "' + form.indexes[i]
                    + '". Expected user/index.';
            }
        }
        if (form.type === TOKEN_TYPE_DEVPI) {
            if (!form.allowed.length) {
                return 'Select at least one permission.';
            }
        } else {
            if (form.scope !== 'read' && form.scope !== 'upload') {
                return 'Pick a scope (read or upload).';
            }
            if (form.label && form.label.length > 200) {
                return 'Label must be 200 characters or fewer.';
            }
        }
        if (form.ttl === null && form.expires_abs === null) {
            return 'Pick an expiry preset or enter a custom date.';
        }
        var now = Math.floor(Date.now() / 1000);
        if (form.expires_abs !== null) {
            if (form.expires_abs <= now) {
                return 'Custom expiry date is in the past.';
            }
            if (form.not_before !== null && form.expires_abs <= form.not_before) {
                return 'Custom expiry date must be after the not-before date.';
            }
        } else if (form.not_before !== null) {
            if (form.not_before + form.ttl <= now) {
                return 'Not-before plus expiry preset is already in the past.';
            }
        }
        // Admin tokens have a server-side TTL floor of 60 s and ceiling of
        // 1 year. Pre-flight here so the user gets a clearer error than
        // the raw 400 from the backend.
        if (form.type === TOKEN_TYPE_ADMIN) {
            var effTtl;
            if (form.expires_abs !== null) {
                effTtl = form.expires_abs - now;
            } else {
                effTtl = form.ttl;
            }
            if (effTtl < 60) {
                return 'Admin tokens must live at least 60 seconds.';
            }
            if (effTtl > 31536000) {
                return 'Admin tokens cannot live longer than 1 year.';
            }
        }
        return null;
    }

    function _submitIssue(username, btn) {
        var form = _collectIssueForm();
        var err = _validateIssueForm(form);
        if (err) { showModalError(err); return; }
        var nowSec = Math.floor(Date.now() / 1000);

        var endpoint, body;
        if (form.type === TOKEN_TYPE_DEVPI) {
            var basis = form.not_before !== null ? form.not_before : nowSec;
            var expires = form.expires_abs !== null ? form.expires_abs
                : basis + form.ttl;
            body = {
                indexes: form.indexes,
                allowed: form.allowed,
                expires: expires,
            };
            if (form.projects.length) body.projects = form.projects;
            if (form.not_before !== null) body.not_before = form.not_before;
            endpoint = '/' + encodeURIComponent(username) + '/+token-create';
        } else {
            var ttlSec = form.expires_abs !== null
                ? form.expires_abs - nowSec : form.ttl;
            body = {
                user: username,
                index: form.indexes[0],
                scope: form.scope,
                ttl_seconds: ttlSec,
                label: form.label || '',
            };
            endpoint = '/+admin-api/token';
        }

        _setBtnLoading(btn);
        Api.post(endpoint, body)
            .then(function (data) {
                var token = form.type === TOKEN_TYPE_DEVPI
                    ? (data && data.result && data.result.token)
                    : (data && data.token);
                if (!token) throw new Error('Server returned no token.');
                // Capture an identifier so the next listing render can
                // highlight this row. Devpi returns `devpi-<id>-<rest>`;
                // admin returns the full `adm_<id>.<secret>` token + a
                // top-level `id_short` we currently don't surface — the
                // backend bundles `meta` though, take meta.id_short
                // when present, else parse from token.
                if (form.type === TOKEN_TYPE_DEVPI) {
                    // Macaroon ids are second segment after "devpi-".
                    var raw = token.indexOf('-') !== -1
                        ? token.substring(token.indexOf('-') + 1) : '';
                    // The macaroon serialised form embeds the id base64;
                    // the listing keys by the `username-tokenid` hash, so
                    // we can't trivially pre-compute it here. Skip.
                    _justIssuedTokenId = null;
                } else {
                    // Admin token format is `adm_<id>.<secret>` — strip
                    // the prefix and the secret tail to get the id used
                    // by the listing.
                    if (token.substring(0, 4) === 'adm_') {
                        var rest = token.substring(4);
                        var dot = rest.indexOf('.');
                        _justIssuedTokenId = dot > 0 ? rest.substring(0, dot) : null;
                    } else {
                        _justIssuedTokenId = null;
                    }
                }
                _renderIssued(username, token, form);
            })
            .catch(function (e) {
                showModalError(e.message || 'Failed to issue token.');
                _restoreBtn(btn);
            });
    }

    // --- Macaroon token-issued (read-once) view ---

    function _macaroonHostPath(publicUrl, idx) {
        // publicUrl is "https://devpi.example.com[:port]" (no trailing slash).
        return publicUrl + '/' + idx;
    }

    function _macaroonAuthUrl(publicUrl, idx, username, token) {
        // For pip.conf index-url. URL-encode the token because '+' / '=' /
        // '/' are valid in macaroon base64 alphabet and would corrupt the URL.
        var u = new URL(publicUrl);
        var auth = encodeURIComponent(username) + ':' + encodeURIComponent(token);
        return u.protocol + '//' + auth + '@' + u.host + '/' + idx + '/+simple/';
    }

    function _macaroonPipConfText(publicUrl, indexes, username, token) {
        var lines = ['[global]'];
        var primary = indexes[0];
        lines.push('index-url = ' + _macaroonAuthUrl(publicUrl, primary, username, token));
        for (var i = 1; i < indexes.length; i++) {
            lines.push('extra-index-url = '
                + _macaroonAuthUrl(publicUrl, indexes[i], username, token));
        }
        lines.push('trusted-host = ' + hostFromUrl(publicUrl));
        lines.push('');
        return lines.join('\n');
    }

    function _macaroonPypircText(publicUrl, indexes, username, token) {
        var aliases = [];
        var sections = [];
        for (var i = 0; i < indexes.length; i++) {
            var alias = 'devpi-' + indexes[i].replace(/\//g, '-');
            aliases.push(alias);
            sections.push(
                '[' + alias + ']\n'
                + 'repository = ' + _macaroonHostPath(publicUrl, indexes[i]) + '/\n'
                + 'username = ' + username + '\n'
                + 'password = ' + token);
        }
        return '[distutils]\n'
            + 'index-servers = ' + aliases.join(' ') + '\n\n'
            + sections.join('\n\n') + '\n';
    }

    function _macaroonTwineText(publicUrl, idx, username, token) {
        return 'export TWINE_REPOSITORY_URL="'
                + _macaroonHostPath(publicUrl, idx) + '/"\n'
            + 'export TWINE_USERNAME="' + username + '"\n'
            + 'export TWINE_PASSWORD="' + token + '"\n';
    }

    function _macaroonReadOnceBlock(label, content, filename) {
        var wrap = el('div', {className: 'macaroon-issued-block'});
        wrap.appendChild(el('div', {
            className: 'macaroon-issued-label',
            textContent: label,
        }));
        var actions = el('div', {className: 'pip-conf-actions'});
        var copyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        copyBtn.addEventListener('click', function () {
            copyText(content).then(function () { flashCopied(copyBtn); });
        });
        actions.appendChild(copyBtn);
        if (filename) {
            actions.appendChild(el('button', {
                className: 'btn',
                textContent: 'Download',
                onclick: function () { downloadFile(content, filename); },
            }));
        }
        wrap.appendChild(actions);
        wrap.appendChild(el('pre', {
            className: 'pip-conf-preview',
            textContent: content,
        }));
        return wrap;
    }

    // Map a successful issuance to (canRead, canUpload) booleans driving
    // which configs the result view renders. We follow the user's stated
    // intent rather than what the backend technically allows: an admin
    // upload-scope token can GET, but if you picked upload you wanted
    // upload — surfacing pip.conf would be noise. For Devpi tokens the
    // user picked permissions explicitly, so we mirror that.
    function _issuedCapabilities(form) {
        if (form.type === TOKEN_TYPE_DEVPI) {
            return {
                canRead: form.allowed.indexOf('pkg_read') !== -1,
                canUpload: form.allowed.indexOf('upload') !== -1,
            };
        }
        return {
            canRead: form.scope === 'read',
            canUpload: form.scope === 'upload',
        };
    }

    // Issue context — populated when the modal opens, consulted by the
    // result view so it knows which indexes are public (no pip.conf
    // creds needed) vs. private (auth required).
    var _issueContext = null;

    // Token id of the most recently issued token (admin or devpi). When
    // the listing renders next, the row matching this id gets a brief
    // highlight so the user can spot what they just created.
    var _justIssuedTokenId = null;
    function _markJustIssued(rowEl, tokenId) {
        if (_justIssuedTokenId && tokenId === _justIssuedTokenId) {
            rowEl.classList.add('tokens-row-just-created');
        }
    }

    function _anyIndexPrivate(indexes) {
        if (!_issueContext || !_issueContext.aclByIndex) return true;
        for (var i = 0; i < indexes.length; i++) {
            var acl = _issueContext.aclByIndex[indexes[i]];
            if (!isPublicAclRead(acl)) return true;
        }
        return false;
    }

    function _renderIssued(username, token, form) {
        // Hide all form-group divs and the advanced-perms toggle so only
        // the issued blocks remain. Type chooser too — switching type
        // mid-issued state would be confusing.
        var formGroups = modalBody.querySelectorAll('.form-group');
        for (var g = 0; g < formGroups.length; g++) formGroups[g].hidden = true;
        var advToggle = modalBody.querySelector('.macaroon-adv-toggle');
        if (advToggle) advToggle.hidden = true;
        // Hide any data-token-only nodes that aren't form-groups (e.g.
        // the security banner).
        var only = modalBody.querySelectorAll('[data-token-only]');
        for (var o = 0; o < only.length; o++) only[o].hidden = true;

        clear(modalFooter);
        // Done returns to whatever opened the Issue modal (per-user
        // unified Tokens modal by default; per-index Tokens modal when
        // launched from an index card). The unified listing always
        // shows both Admin and Devpi sections, so the user sees their
        // freshly-issued token in context.
        modalFooter.appendChild(el('button', {
            className: 'btn btn-primary',
            textContent: 'Done',
            onclick: _issueReturnTo || function () {
                showTokensModal(username);
            },
        }));

        var caps = _issuedCapabilities(form);

        getPublicUrl().then(function (publicUrl) {
            var result = document.getElementById('macaroon-issued-result');
            if (!result) return;
            clear(result);
            result.hidden = false;

            result.appendChild(el('div', {
                className: 'macaroon-issued-warning',
                textContent: '⚠ This is the only time the token is shown. '
                    + 'Copy it now — it cannot be recovered, only revoked.',
            }));

            result.appendChild(_macaroonReadOnceBlock(
                'Token (raw)', token, null));

            // pip.conf only matters when at least one bound index actually
            // requires authentication. For all-public indexes anyone could
            // pip install via the bare URL — surfacing pip.conf-with-creds
            // would mislead the user into thinking it's needed.
            if (caps.canRead && _anyIndexPrivate(form.indexes)) {
                var pipConf = _macaroonPipConfText(
                    publicUrl, form.indexes, username, token);
                result.appendChild(_macaroonReadOnceBlock(
                    'pip.conf', pipConf, 'pip.conf'));
            }

            if (caps.canUpload) {
                var pypirc = _macaroonPypircText(
                    publicUrl, form.indexes, username, token);
                result.appendChild(_macaroonReadOnceBlock(
                    '.pypirc', pypirc, '.pypirc'));
                // TWINE env uses the first index (one repo per env).
                var twine = _macaroonTwineText(
                    publicUrl, form.indexes[0], username, token);
                result.appendChild(_macaroonReadOnceBlock(
                    'TWINE_* env', twine, null));
            }

            result.appendChild(_macaroonReadOnceBlock(
                'user : token (for curl -u, devpi login, custom tools)',
                username + ':' + token, null));
        });
    }

    function formatExpiry(seconds) {
        if (seconds <= 0) return 'expired';
        if (seconds < 3600) return Math.round(seconds / 60) + ' min';
        if (seconds < 86400) return Math.round(seconds / 3600) + ' h';
        if (seconds < 30 * 86400) return Math.round(seconds / 86400) + ' d';
        return Math.round(seconds / (30 * 86400)) + ' mo';
    }

    function showPipConfStaticModal(indexPath) {
        // Public index — no auth needed. Show plain pip.conf without
        // generating a token. URL is fetched from the backend so it
        // matches whatever request.application_url would produce there.
        getPublicUrl().then(function (publicUrl) {
            var host = hostFromUrl(publicUrl);
            var content = '[global]\n'
                + 'index-url = ' + publicUrl + '/' + indexPath + '/+simple/\n'
                + 'trusted-host = ' + host + '\n';
            var oneOffCmd = 'pip install --index-url ' + publicUrl + '/'
                + indexPath + '/+simple/ --trusted-host ' + host + ' <package>';
            _renderPipConfStaticModal(indexPath, content, oneOffCmd);
        });
    }

    function _renderPipConfStaticModal(indexPath, content, oneOffCmd) {
        openModal(
            'pip.conf for ' + indexPath,
            function (body) {
                body.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'This index is public — no token needed.',
                }));

                // pip.conf
                body.appendChild(el('label', {
                    className: 'pipconf-section-label',
                    textContent: 'pip.conf',
                }));
                var actions = el('div', {className: 'pip-conf-actions'});
                var copyBtn = el('button', {className: 'btn', textContent: 'Copy'});
                copyBtn.addEventListener('click', function () {
                    copyText(content).then(function () { flashCopied(copyBtn); });
                });
                actions.appendChild(copyBtn);
                actions.appendChild(el('button', {
                    className: 'btn',
                    textContent: 'Download',
                    onclick: function () { downloadFile(content, 'pip.conf'); },
                }));
                body.appendChild(actions);
                body.appendChild(el('pre', {
                    className: 'pip-conf-preview',
                    textContent: content,
                }));

                // One-off install
                body.appendChild(el('label', {
                    className: 'pipconf-section-label',
                    textContent: 'One-off install command',
                }));
                var cmdRow = el('div', {className: 'pip-oneoff-row'});
                var cmdInput = el('input', {
                    type: 'text',
                    className: 'pip-oneoff-input',
                    value: oneOffCmd,
                    readOnly: true,
                    spellcheck: false,
                });
                cmdInput.addEventListener('focus', function () { this.select(); });
                cmdRow.appendChild(cmdInput);
                var cmdCopyBtn = el('button', {className: 'btn', textContent: 'Copy'});
                cmdCopyBtn.addEventListener('click', function () {
                    copyText(oneOffCmd).then(function () { flashCopied(cmdCopyBtn); });
                });
                cmdRow.appendChild(cmdCopyBtn);
                body.appendChild(cmdRow);
            },
            [
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ]);
    }

    function flashCopied(btn) {
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = orig; }, 1200);
    }

    // Replace a button's content with three pulsing dots while a request
    // is in-flight. Disables the button to prevent double-submit. Caller
    // restores via `_restoreBtn` on error; on success the modal re-renders
    // its body so restoration isn't needed.
    function _setBtnLoading(btn) {
        btn._origText = btn.textContent;
        clear(btn);
        for (var i = 0; i < 3; i++) {
            btn.appendChild(el('span', {className: 'btn-loading-dot'}));
        }
        btn.classList.add('btn-loading');
        btn.disabled = true;
    }

    function _restoreBtn(btn) {
        btn.classList.remove('btn-loading');
        clear(btn);
        if (btn._origText) btn.textContent = btn._origText;
        btn.disabled = false;
    }


    // Pip block for package detail: shows clickable "pip install <pkg>" command.
    // Assumes pip.conf has been configured separately via the per-index modal.
    function buildPipBlock(indexPath, pkg) {
        var wrapper = el('div', {className: 'pip-block'});
        wrapper.appendChild(buildPipShortCmd(pkg));
        return wrapper;
    }

    function buildPipShortCmd(pkg) {
        var cmd = 'pip install' + (pkg ? ' ' + pkg : '');
        var div = el('div', {className: 'pip-url'});
        div.appendChild(el('span', {className: 'pip-cmd', textContent: 'pip install'}));
        if (pkg) {
            div.appendChild(document.createTextNode(' '));
            div.appendChild(el('span', {className: 'pip-pkg', textContent: pkg}));
        } else {
            div.appendChild(document.createTextNode(' <package>'));
        }
        var overlay = el('span', {className: 'pip-copied-overlay', textContent: 'Copied!'});
        div.appendChild(overlay);
        div.addEventListener('click', function () {
            var self = this;
            copyText(cmd).then(function () {
                self.classList.add('pip-copied');
                setTimeout(function () { self.classList.remove('pip-copied'); }, 1500);
            });
        });
        return div;
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        // Fallback for HTTP / older browsers
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
    }

    function closeAllKebabs() {
        var all = document.querySelectorAll('.kebab-dropdown');
        for (var i = 0; i < all.length; i++) all[i].hidden = true;
    }

    document.addEventListener('click', closeAllKebabs);

    var _activeTimers = new Set();

    function trackedTimeout(callback, delay) {
        var id = setTimeout(function () {
            _activeTimers.delete(id);
            callback();
        }, delay);
        _activeTimers.add(id);
        return id;
    }

    function clearActiveTimers() {
        _activeTimers.forEach(clearTimeout);
        _activeTimers.clear();
    }

    function showLoading() {
        clearActiveTimers();
        clear(content);
        content.appendChild(el('p', {className: 'loading', textContent: 'Loading...'}));
    }

    function showError(err) {
        clear(content);
        var msg = (err && err.message) ? err.message : String(err);
        content.appendChild(el('p', {className: 'error', textContent: msg}));
    }

    function handleApiError(err) {
        showError(err);
    }

    function updateNav() {
        var hash = (window.location.hash || '#').substring(1);
        var links = document.querySelectorAll('.nav-link');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href').substring(1);
            var active = (hash === href) || (href !== '' && hash.indexOf(href + '/') === 0);
            if (active) {
                links[i].classList.add('active');
            } else {
                links[i].classList.remove('active');
            }
        }
    }

    function fetchRoot() {
        return Api.get('/').then(function (data) {
            return data.result;
        });
    }

    function getAllIndexes(result) {
        var list = [];
        var userNames = Object.keys(result).sort();
        for (var i = 0; i < userNames.length; i++) {
            var userName = userNames[i];
            var indexes = result[userName].indexes || {};
            var indexNames = Object.keys(indexes).sort();
            for (var j = 0; j < indexNames.length; j++) {
                var idx = indexes[indexNames[j]];
                idx._user = userName;
                idx._name = indexNames[j];
                idx._full = userName + '/' + indexNames[j];
                list.push(idx);
            }
        }
        return list;
    }

    function getAllUserNames(result) {
        return Object.keys(result).sort();
    }

    // --- Auth flow ---

    function updateAuthUI() {
        var user = Api.getUser();
        if (user) {
            clear(logoutBtn);
            var nameSpan = el('span', {className: 'user-btn-name', textContent: user});
            nameSpan.title = 'Change password';
            logoutBtn.appendChild(nameSpan);
            logoutBtn.appendChild(el('span', {className: 'user-btn-sep', textContent: '|'}));
            logoutBtn.appendChild(el('span', {className: 'user-btn-action', textContent: 'Logout'}));
            loginBtn.hidden = true;
            logoutBtn.hidden = false;
            logoutBtn.classList.toggle('is-root', user === 'root');
            navUsers.hidden = user !== 'root';
            document.body.classList.add('authenticated');
        } else {
            loginBtn.hidden = false;
            logoutBtn.hidden = true;
            navUsers.hidden = true;
            document.body.classList.remove('authenticated');
        }
    }

    function showLoginModal() {
        openModal(
            'Login',
            function (body) {
                body.appendChild(formGroup('Username', el('input', {type: 'text', id: 'login-user'})));
                body.appendChild(formGroup('Password', el('input', {type: 'password', id: 'login-pass'})));
            },
            [
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Login',
                    onclick: doLogin,
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Cancel',
                    onclick: closeModal,
                }),
            ]
        );
        var userInput = document.getElementById('login-user');
        if (userInput) userInput.focus();
        // Submit on Enter
        var handler = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
        };
        document.getElementById('login-user').addEventListener('keydown', handler);
        document.getElementById('login-pass').addEventListener('keydown', handler);
    }

    function doLogin() {
        modalError.hidden = true;
        var user = document.getElementById('login-user').value;
        var pass = document.getElementById('login-pass').value;
        Api.login(user, pass)
            .then(function () {
                closeModal();
                updateAuthUI();
                navigate();
                // Preserve the current hash through the PRG redirect that
                // form.submit() to /+admin triggers — otherwise the
                // browser lands on /+admin/ with no fragment and the
                // user's original deep link (or the page they were on
                // when the session expired) is lost.
                var currentHash = (window.location.hash || '').replace(/^#/, '');
                _triggerPasswordSave(user, pass, currentHash);
            })
            .catch(showModalError);
    }

    loginBtn.addEventListener('click', showLoginModal);

    // Mobile menu toggle
    var menuToggleBtn = document.getElementById('menu-toggle');
    var headerInner = document.querySelector('.header-inner');
    var mobilePanel = document.getElementById('mobile-menu-panel');
    if (menuToggleBtn && headerInner) {
        menuToggleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            headerInner.classList.toggle('menu-open');
        });
        // Close menu on nav link click
        document.getElementById('main-nav').addEventListener('click', function (e) {
            if (e.target.tagName === 'A') {
                headerInner.classList.remove('menu-open');
            }
        });
        // Close on outside click
        document.addEventListener('click', function (e) {
            if (!headerInner.classList.contains('menu-open')) return;
            if (mobilePanel.contains(e.target)) return;
            if (menuToggleBtn.contains(e.target)) return;
            headerInner.classList.remove('menu-open');
        });
    }

    // Reload current view when clicking an already-active nav link
    document.getElementById('main-nav').addEventListener('click', function (e) {
        if (e.target.tagName === 'A') {
            var href = e.target.getAttribute('href') || '#';
            var current = window.location.hash || '#';
            if (href === current) {
                e.preventDefault();
                navigate();
            }
        }
    });

    logoutBtn.addEventListener('click', function (e) {
        // Clicking the username part opens change-password modal
        if (e.target.classList.contains('user-btn-name')) {
            var user = Api.getUser();
            if (user) {
                fetchRoot().then(function (result) {
                    showUserModal(user, result[user] || {});
                }).catch(function () {
                    showUserModal(user, {});
                });
            }
            return;
        }
        Api.logout();
        updateAuthUI();
        window.location.hash = '#';
        navigate();
    });

    // --- Routing ---

    var _skipHashChange = false;
    window.addEventListener('hashchange', function () {
        if (_skipHashChange) { _skipHashChange = false; return; }
        updateNav();
        navigate();
    });

    function navigate() {
        // Any navigation cancels the periodic /+status refresh. The
        // status loader re-arms the timer if it ends up running again.
        _stopStatusRefresh();
        var hash = (window.location.hash || '#').substring(1);
        var m;
        // Split hash and query
        var qIdx = hash.indexOf('?');
        var path = qIdx === -1 ? hash : hash.substring(0, qIdx);
        var queryStr = qIdx === -1 ? '' : hash.substring(qIdx + 1);
        var query = {};
        if (queryStr) {
            var parts = queryStr.split('&');
            for (var p = 0; p < parts.length; p++) {
                var kv = parts[p].split('=');
                query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
            }
        }
        if ((m = path.match(/^packages\/([^/]+\/[^/]+)$/))) {
            loadPackages(m[1]);
        } else if ((m = path.match(/^package\/([^/]+\/[^/]+)\/(.+)$/))) {
            loadPackageDetail(m[1], m[2], query.version);
        } else if (path === 'users') {
            if (!Api.getUser() || Api.getUser() !== 'root') {
                loadStatus();
                return;
            }
            loadUsers();
        } else if ((m = path.match(/^indexes\/(.+)$/))) {
            _filterUser = m[1];
            loadIndexes();
        } else if (path === 'indexes') {
            _filterUser = null;
            loadIndexes();
        } else {
            loadStatus();
        }
    }

    // ========== USERS ==========

    function loadUsers() {
        showLoading();
        Promise.all([fetchRoot(), loadPluginCaps()]).then(function (parts) {
            var result = parts[0];
            clear(content);
            var headerChildren = [el('h2', {textContent: 'Users'})];
            if (Api.getUser() === 'root') {
                headerChildren.push(el('button', {
                    className: 'btn btn-primary',
                    textContent: '+ New User',
                    onclick: function () { showUserModal(null, null); },
                }));
            }
            var header = el('div', {className: 'view-header'}, headerChildren);
            content.appendChild(header);

            var userNames = getAllUserNames(result);
            var grid = el('div', {className: 'index-grid'});
            for (var i = 0; i < userNames.length; i++) {
                (function (name) {
                    var info = result[name];
                    var indexes = info.indexes || {};
                    var indexNames = Object.keys(indexes).sort();
                    var currentUser = Api.getUser();
                    var canEdit = currentUser === name || currentUser === 'root';

                    var card = el('div', {className: 'index-card user-card' + (name === 'root' ? ' user-root' : '')});

                    // Card head: username + kebab menu
                    var cardHead = el('div', {className: 'index-card-head'});
                    cardHead.appendChild(el('a', {
                        href: '#indexes/' + name,
                        className: 'index-card-name',
                        textContent: name,
                    }));
                    var menuItems = [];
                    if (canEdit) {
                        menuItems.push({label: 'Edit', onclick: function () { closeAllKebabs(); showUserModal(name, info); }});
                        (function (uname) {
                            menuItems.push({
                                label: 'Tokens',
                                onclick: function () {
                                    closeAllKebabs();
                                    showTokensModal(uname);
                                },
                            });
                        })(name);
                    }
                    if (currentUser === 'root' && name !== 'root') {
                        menuItems.push({label: 'Delete', danger: true, onclick: function () { closeAllKebabs(); deleteUser(name); }});
                    }
                    if (menuItems.length) {
                        cardHead.appendChild(buildKebabMenu(menuItems));
                    }
                    card.appendChild(cardHead);

                    // Details
                    var details = el('div', {className: 'index-card-details'});
                    if (info.email) {
                        details.appendChild(el('div', {className: 'index-card-row'}, [
                            el('span', {className: 'index-card-label', textContent: 'Email'}),
                            el('span', {textContent: info.email}),
                        ]));
                    }
                    if (indexNames.length) {
                        var tagsWrap = el('div', {className: 'index-card-row'});
                        tagsWrap.appendChild(el('span', {className: 'index-card-label', textContent: 'Indexes'}));
                        var tagsGroup = el('div', {className: 'user-card-indexes'});
                        for (var j = 0; j < indexNames.length; j++) {
                            var idx = indexes[indexNames[j]];
                            var tagClass = 'tag';
                            if (idx.type === 'mirror') tagClass += ' tag-mirror';
                            else if (idx.volatile) tagClass += ' tag-volatile';
                            tagsGroup.appendChild(el('a', {
                                href: '#packages/' + name + '/' + indexNames[j],
                                className: tagClass,
                                textContent: indexNames[j],
                                title: idx.type + (idx.volatile ? ', volatile' : '') +
                                    (idx.bases && idx.bases.length ? ', bases: ' + idx.bases.join(', ') : ''),
                            }));
                        }
                        tagsWrap.appendChild(tagsGroup);
                        details.appendChild(tagsWrap);
                    }
                    card.appendChild(details);

                    grid.appendChild(card);
                })(userNames[i]);
            }
            content.appendChild(grid);
        }).catch(handleApiError);
    }

    function showUserModal(editName, editInfo) {
        var isEdit = !!editName;
        openModal(
            isEdit ? 'Edit User: ' + editName : 'New User',
            function (body) {
                if (!isEdit) {
                    body.appendChild(formGroup('Username', el('input', {type: 'text', id: 'form-username'})));
                }
                body.appendChild(formGroup('Email', el('input', {
                    type: 'email',
                    id: 'form-email',
                    value: (editInfo && editInfo.email) || '',
                })));
                var isSelf = isEdit && editName === Api.getUser();
                // Hidden username input so browser associates saved password correctly
                if (isSelf) {
                    var hiddenUser = el('input', {type: 'text', id: 'form-hidden-username'});
                    hiddenUser.setAttribute('autocomplete', 'username');
                    hiddenUser.setAttribute('aria-hidden', 'true');
                    hiddenUser.style.display = 'none';
                    hiddenUser.value = editName;
                    body.appendChild(hiddenUser);
                }
                var pwInput;
                if (isSelf) {
                    // Own password: type="password" + autocomplete so browser offers to save
                    pwInput = el('input', {type: 'password', id: 'form-password'});
                    pwInput.setAttribute('autocomplete', 'new-password');
                } else {
                    // Other user: plain text — Safari won't offer to save text fields
                    pwInput = el('input', {type: 'text', id: 'form-password'});
                    pwInput.setAttribute('autocomplete', 'off');
                    pwInput.setAttribute('spellcheck', 'false');
                }
                body.appendChild(formGroup(
                    isEdit ? 'New Password (leave empty to keep)' : 'Password',
                    pwInput
                ));
            },
            [
                el('button', {
                    className: 'btn btn-primary',
                    textContent: isEdit ? 'Save' : 'Create',
                    onclick: function () { submitUserModal(editName); },
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Cancel',
                    onclick: closeModal,
                }),
            ]
        );
        var focus = document.getElementById(isEdit ? 'form-email' : 'form-username');
        if (focus) focus.focus();
    }

    function submitUserModal(editName) {
        var isEdit = !!editName;
        modalError.hidden = true;

        var data = {};
        var username;
        if (!isEdit) {
            username = document.getElementById('form-username').value.trim();
            if (!username) {
                showModalError('Username is required');
                return;
            }
        }
        var email = document.getElementById('form-email').value.trim();
        var passwordEl = document.getElementById('form-password');
        var password = passwordEl ? passwordEl.value : null;

        if (email) data.email = email;
        if (password) data.password = password;
        if (!isEdit && !password) data.password = '';

        var url = '/' + (isEdit ? editName : username);
        var method = isEdit ? Api.patch : Api.put;
        method(url, data)
            .then(function () {
                if (password && isEdit && editName === Api.getUser()) {
                    // Own password — trigger "Save Password" before closing modal
                    closeModal();
                    _triggerPasswordSave(editName, password, 'users');
                } else {
                    // Other user — wipe field value before close so browser has nothing to save
                    if (passwordEl) passwordEl.value = '';
                    closeModal();
                }
                loadUsers();
            })
            .catch(showModalError);
    }

    function _triggerPasswordSave(user, password, hash) {
        var form = document.createElement('form');
        form.method = 'post';
        form.action = '/+admin' + (hash ? '#' + hash : '');  // devpi 302-redirects to /+admin/ — PRG pattern, Ctrl+R won't resubmit
        form.style.cssText = 'display:none';
        var u = document.createElement('input');
        u.type = 'text';
        u.name = 'username';
        u.setAttribute('autocomplete', 'username');
        u.value = user;
        var p = document.createElement('input');
        p.type = 'password';
        p.name = 'password';
        p.setAttribute('autocomplete', 'current-password');
        p.value = password;
        form.appendChild(u);
        form.appendChild(p);
        form.addEventListener('submit', function (e) { e.preventDefault(); });
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    }

    function deleteUser(name) {
        if (!confirm('Delete user "' + name + '"? This will also delete all their indexes.')) {
            return;
        }
        Api.del('/' + name)
            .then(function () { loadUsers(); })
            .catch(handleApiError);
    }

    // ========== INDEXES ==========

    var _filterUser = null; // null = all

    function loadIndexes() {
        showLoading();
        // Load plugin caps in parallel — `renderIndexCards` consults
        // `hasDevpiTokens()` to decide whether to surface the per-index
        // Devpi tokens kebab item. Without this prefetch, navigating
        // directly to /#indexes (no Status / Users visited first) would
        // hide the item even on servers where the plugin is installed.
        Promise.all([fetchRoot(), loadPluginCaps()]).then(function (parts) {
            var result = parts[0];
            clear(content);
            content.appendChild(el('div', {id: 'indexes-header'}));
            content.appendChild(el('div', {id: 'indexes-content'}));
            renderIndexCards(result);
        }).catch(handleApiError);
    }

    function renderIndexCards(result) {
        // Update heading
        var headerContainer = document.getElementById('indexes-header');
        clear(headerContainer);
        var headingChildren = [
            el('a', {href: '#indexes', textContent: 'Indexes'}),
        ];
        if (_filterUser) {
            headingChildren.push(' / ');
            headingChildren.push(el('a', {href: '#indexes/' + _filterUser, textContent: _filterUser}));
        }
        var heading = el('h2', {className: 'page-heading'}, headingChildren);
        var viewHeaderChildren = [heading];
        if (Api.getUser() === 'root') {
            viewHeaderChildren.push(el('button', {
                className: 'btn btn-primary',
                textContent: '+ New Index',
                onclick: function () {
                    showIndexModal(null, result, _filterUser);
                },
            }));
        }
        headerContainer.appendChild(el('div', {className: 'view-header'}, viewHeaderChildren));

        var container = document.getElementById('indexes-content');
        clear(container);

        var indexes = getAllIndexes(result);
        if (_filterUser) {
            indexes = indexes.filter(function (idx) {
                return idx._user === _filterUser;
            });
        }

        if (indexes.length === 0) {
            container.appendChild(el('p', {
                className: 'text-muted',
                textContent: 'No indexes found.',
            }));
            return;
        }

        var grid = el('div', {className: 'index-grid'});
        for (var i = 0; i < indexes.length; i++) {
            (function (idx) {
                var isMirror = idx.type === 'mirror';
                var card = el('div', {
                    className: 'index-card' + (isMirror ? ' index-card-mirror' : (idx.volatile ? ' index-card-volatile' : ' index-card-stage')),
                });

                // Card header: name + type badge
                var cardHead = el('div', {className: 'index-card-head'});
                // Path container groups owner / sep / name so the only
                // wide flex gap in the head is between path, tags, and
                // kebab — the separator hugs both sides like a real
                // filesystem path.
                var pathWrap = el('div', {className: 'index-card-path'});
                pathWrap.appendChild(el('a', {
                    href: '#indexes/' + idx._user,
                    className: 'index-card-owner',
                    textContent: idx._user,
                }));
                pathWrap.appendChild(el('span', {
                    className: 'index-card-sep',
                    textContent: '/',
                }));
                pathWrap.appendChild(el('a', {
                    href: '#packages/' + idx._full,
                    className: 'index-card-name',
                    textContent: idx._name,
                }));
                cardHead.appendChild(pathWrap);
                // Type / state badges. Single-letter labels (M/S/V/W/N)
                // keep multi-badge headers from wrapping in tight grids;
                // `title` exposes the full word on hover for clarity.
                var tagGroup = el('div', {className: 'index-card-tags'});
                tagGroup.appendChild(el('span', {
                    className: 'tag tag-letter'
                        + (isMirror ? ' tag-mirror' : ' tag-stage'),
                    textContent: isMirror ? 'M' : 'S',
                    'data-tooltip': idx.type || 'stage',
                }));
                if (!isMirror && idx.volatile) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-letter tag-volatile',
                        textContent: 'V',
                        'data-tooltip': 'volatile — uploads may overwrite '
                            + 'existing versions',
                    }));
                }
                if (!isMirror && isAnonymousAclUpload(idx.acl_upload)) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-letter tag-world-writable',
                        textContent: 'W',
                        'data-tooltip': 'world-writable — acl_upload '
                            + 'contains :ANONYMOUS:; anyone (including '
                            + 'unauthenticated callers) can publish to '
                            + 'this index.',
                    }));
                } else if (!isMirror && isUploadFrozen(idx.acl_upload)) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-letter tag-no-upload',
                        textContent: 'N',
                        'data-tooltip': 'no upload — acl_upload is empty; '
                            + 'nobody can publish to this index, not even '
                            + 'the owner or root. Add a principal to '
                            + 'acl_upload to enable uploads.',
                    }));
                }
                cardHead.appendChild(tagGroup);
                card.appendChild(cardHead);

                // Details
                var details = el('div', {className: 'index-card-details'});

                if (idx.title) {
                    details.appendChild(el('div', {className: 'index-card-row'}, [
                        el('span', {className: 'index-card-label', textContent: 'Title'}),
                        el('span', {textContent: idx.title}),
                    ]));
                }

                if (!isMirror) {
                    if (idx.bases && idx.bases.length) {
                        details.appendChild(el('div', {className: 'index-card-row'}, [
                            el('span', {className: 'index-card-label', textContent: 'Bases'}),
                            el('span', {textContent: idx.bases.join(', ')}),
                        ]));
                    }
                    if (idx.acl_upload && idx.acl_upload.length) {
                        details.appendChild(el('div', {className: 'index-card-row'}, [
                            el('span', {className: 'index-card-label', textContent: 'Upload'}),
                            el('span', {textContent: idx.acl_upload.join(', ')}),
                        ]));
                    }
                } else {
                    if (idx.mirror_url) {
                        details.appendChild(el('div', {className: 'index-card-row'}, [
                            el('span', {className: 'index-card-label', textContent: 'URL'}),
                            el('span', {className: 'index-card-url', textContent: idx.mirror_url}),
                        ]));
                    }
                }
                if (idx.acl_read && idx.acl_read.length
                        && !(idx.acl_read.length === 1 && idx.acl_read[0] === ':ANONYMOUS:')) {
                    details.appendChild(el('div', {className: 'index-card-row'}, [
                        el('span', {className: 'index-card-label', textContent: 'Read'}),
                        el('span', {textContent: idx.acl_read.join(', ')}),
                    ]));
                }

                card.appendChild(details);

                // Kebab menu items: pip.conf for everyone, upload token
                // pip.conf as a one-click static download — only meaningful
                // for public indexes (no credentials required). Private
                // indexes route through the unified Tokens flow where the
                // user picks scope/TTL and gets a credentialed pip.conf.
                var loggedIn = Api.getUser();
                var menuItems = [];
                if (isPublicAclRead(idx.acl_read)) {
                    (function (path) {
                        menuItems.push({
                            label: 'pip.conf',
                            onclick: function () {
                                closeAllKebabs();
                                showPipConfStaticModal(path);
                            },
                        });
                    })(idx._full);
                }
                // Unified per-index Tokens manager — replaces the old
                // separate "pip.conf + token" / ".pypirc + token" / "Devpi
                // tokens" trio. Issuance is now consistent across user and
                // index contexts.
                if (loggedIn === 'root' || loggedIn === idx._user) {
                    (function (idxRef) {
                        menuItems.push({
                            label: 'Tokens',
                            onclick: function () {
                                closeAllKebabs();
                                showIndexTokensModal(
                                    idxRef._user, idxRef._name,
                                    idxRef.acl_read || null);
                            },
                        });
                    })(idx);
                }
                if (loggedIn === 'root' || loggedIn === idx._user) {
                    (function (idxRef) {
                        menuItems.push({
                            label: 'Edit',
                            onclick: function () { closeAllKebabs(); showIndexModal(idxRef, result); },
                        });
                        menuItems.push({
                            label: 'Delete', danger: true,
                            onclick: function () { closeAllKebabs(); deleteIndex(idxRef._full); },
                        });
                    })(idx);
                }
                // Mirror-only: any authenticated user may trigger an
                // upstream re-fetch (etag-conditional, low cost). Useful
                // when waiting for a freshly-published upstream release
                // that's hidden behind the `mirror_cache_expiry` TTL.
                if (isMirror && loggedIn) {
                    (function (idxRef) {
                        menuItems.push({
                            label: 'Refresh cache',
                            onclick: function () {
                                closeAllKebabs();
                                refreshMirrorCache(
                                    idxRef._user, idxRef._name);
                            },
                        });
                    })(idx);
                }
                if (menuItems.length) {
                    cardHead.appendChild(buildKebabMenu(menuItems));
                }

                grid.appendChild(card);
            })(indexes[i]);
        }
        container.appendChild(grid);
    }

    function updateInheritedDisplay(allIndexes) {
        var container = document.getElementById('inherited-bases');
        if (!container) return;
        clear(container);

        var currentBases = getTagPickerValues('form-bases');
        // Build a temporary index map to compute transitive bases
        var indexMap = {};
        for (var i = 0; i < allIndexes.length; i++) {
            indexMap[allIndexes[i]._full] = allIndexes[i];
        }
        var inherited = {};
        var queue = [];
        for (var d = 0; d < currentBases.length; d++) {
            queue.push(currentBases[d]);
        }
        while (queue.length) {
            var cur = queue.shift();
            if (!indexMap[cur]) continue;
            var curBases = indexMap[cur].bases || [];
            for (var b = 0; b < curBases.length; b++) {
                if (!inherited[curBases[b]]) {
                    inherited[curBases[b]] = true;
                    queue.push(curBases[b]);
                }
            }
        }

        var names = Object.keys(inherited).sort();
        if (names.length === 0) return;

        container.appendChild(el('span', {
            className: 'index-card-label',
            textContent: 'Inherited: ',
        }));
        for (var h = 0; h < names.length; h++) {
            container.appendChild(el('span', {
                className: 'tag tag-inherited',
                textContent: names[h],
            }));
        }
    }

    function showIndexModal(editIdx, rootData, preOwner) {
        var isEdit = !!editIdx;
        var userNames = getAllUserNames(rootData);
        var allIndexes = getAllIndexes(rootData);

        openModal(
            isEdit ? 'Edit Index: ' + editIdx._full : 'New Index',
            function (body) {
                if (!isEdit) {
                    var currentUser = Api.getUser();
                    var owners = currentUser === 'root' ? userNames : [currentUser];
                    var ownerSelect = el('select', {id: 'form-owner'});
                    for (var u = 0; u < owners.length; u++) {
                        ownerSelect.appendChild(el('option', {
                            value: owners[u],
                            textContent: owners[u],
                        }));
                    }
                    ownerSelect.value = preOwner || currentUser;
                    body.appendChild(formGroup('Owner', ownerSelect));
                    body.appendChild(formGroup('Index Name', el('input', {type: 'text', id: 'form-index-name'})));
                }

                var typeSelect = el('select', {id: 'form-type'});
                typeSelect.appendChild(el('option', {value: 'stage', textContent: 'stage'}));
                typeSelect.appendChild(el('option', {value: 'mirror', textContent: 'mirror'}));
                if (isEdit) typeSelect.value = editIdx.type || 'stage';

                body.appendChild(formGroup('Type', typeSelect));

                var stageFields = el('div', {id: 'stage-fields'});
                var mirrorFields = el('div', {id: 'mirror-fields'});

                // Bases picker (orderable)
                var basesInitial = isEdit ? (editIdx.bases || []) : [];
                var availableBases = [];
                for (var b = 0; b < allIndexes.length; b++) {
                    if (isEdit && allIndexes[b]._full === editIdx._full) continue;
                    availableBases.push(allIndexes[b]._full);
                }
                var basesGroup = el('div', {className: 'form-group'});
                basesGroup.appendChild(el('label', {textContent: 'Bases (order = priority)'}));
                var inheritedContainer = el('div', {className: 'inherited-bases', id: 'inherited-bases'});
                var basesPicker = buildTagPicker(
                    'form-bases', basesInitial, availableBases, [], true,
                    function () { updateInheritedDisplay(allIndexes); }
                );
                basesGroup.appendChild(basesPicker);
                basesGroup.appendChild(inheritedContainer);
                stageFields.appendChild(basesGroup);

                var volChecked = isEdit ? editIdx.volatile : true;
                stageFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {className: 'checkbox-label'}, [
                        el('input', {
                            type: 'checkbox',
                            id: 'form-volatile',
                            checked: !!volChecked,
                        }),
                        ' Volatile (allow overwriting same version)',
                    ]),
                ]));

                var aclUploadInitial = isEdit ? (editIdx.acl_upload || []) : [Api.getUser()];
                stageFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'ACL Upload'}),
                    buildTagPicker('form-acl-upload', aclUploadInitial, userNames, [':ANONYMOUS:']),
                ]));

                mirrorFields.appendChild(formGroup('Mirror URL', el('input', {
                    type: 'url',
                    id: 'form-mirror-url',
                    value: isEdit && editIdx.mirror_url ? editIdx.mirror_url : 'https://pypi.org/simple/',
                })));

                // Allow/deny lists. Plain text, one PEP 508 entry per
                // line. Empty allowlist = pass-through; denylist always
                // wins. Lines starting with '#' are dropped client-side
                // so admins can paste comments.
                var allowInitial = (isEdit && Array.isArray(editIdx.package_allowlist))
                    ? editIdx.package_allowlist.join('\n') : '';
                mirrorFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Package Allowlist'}),
                    el('textarea', {
                        id: 'form-package-allowlist',
                        rows: 5,
                        placeholder: 'numpy\nrequests>=2.0\nmycompany-*',
                        value: allowInitial,
                    }),
                    el('div', {
                        className: 'form-hint',
                        textContent: 'One entry per line: PEP 508 (numpy, numpy>=2.0) or name with * wildcard (mycompany-*, *-internal, mycompany-*<2.0). Empty = all packages allowed.',
                    }),
                ]));

                var denyInitial = (isEdit && Array.isArray(editIdx.package_denylist))
                    ? editIdx.package_denylist.join('\n') : '';
                mirrorFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Package Denylist'}),
                    el('textarea', {
                        id: 'form-package-denylist',
                        rows: 5,
                        placeholder: 'urllib3<1.26.5\nmycompany-*\n*-evil',
                        value: denyInitial,
                    }),
                    el('div', {
                        className: 'form-hint',
                        textContent: 'Always blocked. Overrides allowlist. Bare name (mycompany-*) bans the namespace; with specifier (urllib3<1.26.5) bans only matching versions.',
                    }),
                ]));

                body.appendChild(stageFields);
                body.appendChild(mirrorFields);

                var aclReadInitial = isEdit ? (editIdx.acl_read || [':ANONYMOUS:']) : [':ANONYMOUS:'];
                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'ACL Read'}),
                    buildTagPicker(
                        'form-acl-read', aclReadInitial, userNames,
                        [':ANONYMOUS:', ':AUTHENTICATED:']),
                    el('div', {
                        className: 'form-hint',
                        textContent: ':ANONYMOUS: = public, :AUTHENTICATED: = any logged-in user',
                    }),
                ]));

                body.appendChild(formGroup('Title (optional)', el('input', {
                    type: 'text',
                    id: 'form-title',
                    value: isEdit && editIdx.title ? editIdx.title : '',
                })));

                function updateTypeFields() {
                    var isMirror = typeSelect.value === 'mirror';
                    stageFields.hidden = isMirror;
                    mirrorFields.hidden = !isMirror;
                }
                typeSelect.addEventListener('change', updateTypeFields);
                updateTypeFields();
            },
            [
                el('button', {
                    className: 'btn btn-primary',
                    textContent: isEdit ? 'Save' : 'Create',
                    onclick: function () { submitIndexModal(editIdx); },
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Cancel',
                    onclick: closeModal,
                }),
            ]
        );

        if (!isEdit) {
            var nameInput = document.getElementById('form-index-name');
            if (nameInput) nameInput.focus();
        }
    }

    function submitIndexModal(editIdx) {
        var isEdit = !!editIdx;
        modalError.hidden = true;

        var type = document.getElementById('form-type').value;
        var title = document.getElementById('form-title').value.trim();
        var data = {type: type};
        if (title) data.title = title;

        if (type === 'stage') {
            data.bases = getTagPickerValues('form-bases');
            data.volatile = document.getElementById('form-volatile').checked;
            data.acl_upload = getTagPickerValues('form-acl-upload');
        } else {
            data.mirror_url = document.getElementById('form-mirror-url').value.trim();
            data.package_allowlist = parseLinesField('form-package-allowlist');
            data.package_denylist = parseLinesField('form-package-denylist');
        }
        data.acl_read = getTagPickerValues('form-acl-read');

        var url;
        if (isEdit) {
            url = '/' + editIdx._full;
        } else {
            var owner = document.getElementById('form-owner').value;
            var name = document.getElementById('form-index-name').value.trim();
            if (!name) {
                showModalError('Index name is required');
                return;
            }
            url = '/' + owner + '/' + name;
        }

        var method = isEdit ? Api.patch : Api.put;
        method(url, data)
            .then(function () {
                closeModal();
                loadIndexes();
            })
            .catch(showModalError);
    }

    function deleteIndex(fullName) {
        if (!confirm('Delete index "' + fullName + '"? All packages will be lost.')) {
            return;
        }
        Api.del('/' + fullName)
            .then(function () { loadIndexes(); })
            .catch(handleApiError);
    }

    function refreshMirrorCache(user, index) {
        // Non-destructive: just bumps the upstream-fetch clocks. Skip
        // the confirm dialog; show a small result modal so the user
        // knows whether the request reached the primary.
        Api.post(
            '/+admin-api/mirror/'
                + encodeURIComponent(user) + '/'
                + encodeURIComponent(index) + '/refresh-cache',
            {})
            .then(function (data) {
                var r = (data && data.result) || {};
                var count = r.projects_invalidated;
                openModal('Cache refreshed', function (body) {
                    body.appendChild(el('p', {
                        textContent: 'Mirror "' + user + '/' + index
                            + '" cache invalidated. '
                            + count + ' project'
                            + (count === 1 ? '' : 's')
                            + ' will re-check upstream on next access.',
                    }));
                    body.appendChild(el('p', {
                        className: 'note',
                        textContent: 'Note: cache is process-local; '
                            + 'replicas will sync once the primary refetches.',
                    }));
                }, [el('button', {
                    className: 'btn btn-primary',
                    textContent: 'OK',
                    onclick: closeModal,
                })]);
            })
            .catch(function (err) {
                openModal('Cache refresh failed', function (body) {
                    body.appendChild(el('p', {
                        className: 'error',
                        textContent: (err && err.message) || String(err),
                    }));
                }, [el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Close',
                    onclick: closeModal,
                })]);
            });
    }

    // ========== PACKAGES ==========

    var PKG_LIMIT = 100;

    function canDeleteFromIndex(indexPath) {
        var user = Api.getUser();
        if (!user) return false;
        return user === 'root' || user === indexPath.split('/')[0];
    }

    function buildPackageCard(indexPath, pkg, fetchVersion) {
        var card = el('div', {className: 'pkg-card'});
        var cardHead = el('div', {className: 'pkg-card-head'});
        cardHead.appendChild(el('a', {
            href: '#package/' + indexPath + '/' + pkg,
            className: 'pkg-card-name',
            textContent: pkg,
        }));

        if (canDeleteFromIndex(indexPath)) {
            cardHead.appendChild(buildKebabMenu([
                {label: 'Delete all versions', danger: true, onclick: function () { closeAllKebabs(); deletePackage(indexPath, pkg); }},
            ]));
        }
        card.appendChild(cardHead);

        card.appendChild(buildPipBlock(indexPath, pkg));

        if (fetchVersion) {
            var versionEl = el('div', {
                className: 'pkg-card-version',
                textContent: '...',
            });
            card.appendChild(versionEl);
            Api.get('/' + indexPath + '/' + pkg).then(function (pkgData) {
                var vers = Object.keys(pkgData.result).sort(compareVersions);
                versionEl.textContent = vers.length ? 'v' + vers[0] : 'no versions';
            }).catch(function () {
                versionEl.textContent = '';
            });
        }
        return card;
    }

    function loadPackages(indexPath) {
        clear(content);

        var parts = indexPath.split('/');
        var idxUser = parts[0], idxName = parts[1];
        var indexInfo = {};
        content.appendChild(buildBreadcrumb(indexPath));

        // Detect mirror type to decide fetching strategy.
        Api.get('/' + idxUser).then(function (userData) {
            indexInfo = (userData.result.indexes || {})[idxName] || {};
            if (indexInfo.type === 'mirror') {
                fetchMirror();
            } else {
                fetchStage();
            }
        }).catch(function () {
            fetchStage();
        });

        function fetchStage() {
            showHeadingAndLoading(false);
            Api.get('/' + indexPath).then(function (data) {
                var resultIsMirror = !!(data.result && data.result.type === 'mirror');
                renderPackages(indexPath, data.result, resultIsMirror);
            }).catch(handleApiError);
        }

        function fetchMirror() {
            // Mirror indexes can carry hundreds of thousands of upstream
            // projects (root/pypi ≈ 780k → 17 MB). We do not auto-fetch
            // the listing; the user clicks "Browse full index" in the
            // header to opt in. Empty content area shows the prompt.
            showHeadingAndLoading(true);
            var loading = content.querySelector('.loading');
            if (loading) loading.remove();
            content.appendChild(el('p', {
                className: 'text-muted',
                textContent: 'Click "Browse full index" above to load all upstream packages.',
            }));
        }

        function showHeadingAndLoading(isMirror) {
            clear(content);
            var heading = buildBreadcrumb(indexPath);
            var actions = [];
            if (isMirror) {
                actions.push(el('button', {
                    className: 'btn',
                    textContent: 'Browse full index',
                    onclick: function () {
                        showHeadingAndLoading(true);
                        Api.get('/' + indexPath).then(function (data) {
                            renderPackages(indexPath, data.result, true);
                        }).catch(handleApiError);
                    },
                }));
            }
            (function () {
                var aclRead = (indexInfo && indexInfo.acl_read) || [];
                // Quick-action pip.conf only useful for public indexes
                // (no creds required). Private indexes go through Tokens.
                if (isPublicAclRead(aclRead)) {
                    actions.push(el('button', {
                        className: 'btn',
                        textContent: 'pip.conf',
                        onclick: function () {
                            showPipConfStaticModal(indexPath);
                        },
                    }));
                }
            })();
            (function () {
                // Unified Tokens flow — replaces the old "pip.conf + token"
                // and ".pypirc + token" buttons. Owner / root only.
                var loggedIn = Api.getUser();
                var idxUser = indexPath.split('/')[0];
                if (loggedIn === 'root' || loggedIn === idxUser) {
                    var idxName = indexPath.split('/')[1];
                    var aclRead = (indexInfo && indexInfo.acl_read) || null;
                    actions.push(el('button', {
                        className: 'btn auth-only',
                        textContent: 'Tokens',
                        onclick: function () {
                            showIndexTokensModal(idxUser, idxName, aclRead);
                        },
                    }));
                }
            })();
            actions.push(el('button', {
                className: 'btn auth-only',
                textContent: 'Edit',
                onclick: function () {
                    fetchRoot().then(function (result) {
                        var idx = Object.assign(
                            {}, indexInfo,
                            {_user: idxUser, _name: idxName, _full: indexPath});
                        showIndexModal(idx, result);
                    }).catch(handleApiError);
                },
            }));
            actions.push(el('button', {
                className: 'btn btn-danger auth-only',
                textContent: 'Delete',
                onclick: function () { deleteIndex(indexPath); },
            }));
            content.appendChild(el('div', {className: 'view-header'}, [
                heading,
                el('div', {className: 'view-header-actions'}, actions),
            ]));
            content.appendChild(el('p', {className: 'loading', textContent: 'Loading...'}));
        }
    }

    function renderPackages(indexPath, result, isMirror) {
        var projects = result.projects || [];
        var loading = content.querySelector('.loading');
        if (loading) loading.remove();

        if (projects.length === 0) {
            content.appendChild(el('p', {
                className: 'text-muted',
                textContent: 'No packages in this index.',
            }));
            return;
        }

        var searchBar = el('div', {className: 'pkg-search'});
        var searchInput = el('input', {
            type: 'text',
            className: 'pkg-search-input',
            placeholder: 'Filter ' + projects.length + ' packages...',
        });
        searchBar.appendChild(searchInput);
        content.appendChild(searchBar);

        var infoEl = el('div', {className: 'pkg-search-info text-muted'});
        content.appendChild(infoEl);

        var grid = el('div', {className: 'pkg-grid'});
        content.appendChild(grid);

        function render() {
            var q = searchInput.value.trim().toLowerCase();
            clear(grid);

            var matches;
            var totalMatches = 0;
            if (q) {
                // Score each match: 0 = exact, 1 = prefix, 2 = substring.
                // Without scoring an alphabetical "first 100" cuts off
                // common short names — searching "requests" in 780k PyPI
                // would fill the slot with django-requests-* entries
                // before reaching `requests` itself.
                var qNorm = q.replace(/[-_.]/g, '');
                var scored = [];
                for (var j = 0; j < projects.length; j++) {
                    var name = projects[j].toLowerCase();
                    var nameNorm = name.replace(/[-_.]/g, '');
                    var score;
                    if (name === q || nameNorm === qNorm) {
                        score = 0;
                    } else if (name.indexOf(q) === 0 || nameNorm.indexOf(qNorm) === 0) {
                        score = 1;
                    } else if (name.indexOf(q) !== -1 || nameNorm.indexOf(qNorm) !== -1) {
                        score = 2;
                    } else {
                        continue;
                    }
                    scored.push({name: projects[j], score: score, len: name.length});
                }
                totalMatches = scored.length;
                scored.sort(function (a, b) {
                    return a.score - b.score
                        || a.len - b.len
                        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
                });
                matches = scored.slice(0, PKG_LIMIT).map(function (m) { return m.name; });
            } else {
                matches = projects.slice(0, PKG_LIMIT);
            }

            if (matches.length === 0) {
                infoEl.textContent = q ? 'No matching packages.' : '';
            } else if (q) {
                infoEl.textContent = totalMatches > PKG_LIMIT
                    ? 'Showing top ' + PKG_LIMIT + ' of ' + formatNum(totalMatches) + ' matches. Refine search to narrow down.'
                    : 'Found ' + totalMatches + ' match' + (totalMatches === 1 ? '' : 'es') + '.';
            } else {
                infoEl.textContent = projects.length > PKG_LIMIT
                    ? 'Showing first ' + PKG_LIMIT + ' of ' + formatNum(projects.length) + ' packages. Use search to filter.'
                    : 'Showing all ' + projects.length + ' packages.';
            }

            for (var k = 0; k < matches.length; k++) {
                grid.appendChild(buildPackageCard(indexPath, matches[k], !isMirror));
            }
        }

        var debounceTimer;
        searchInput.addEventListener('input', function () {
            clearTimeout(debounceTimer);
            _activeTimers.delete(debounceTimer);
            debounceTimer = trackedTimeout(render, 150);
        });
        searchInput.focus();
        render();
    }

    function deletePackage(indexPath, pkg) {
        if (!confirm('Delete all versions of "' + pkg + '" from ' + indexPath + '?')) {
            return;
        }
        Api.del('/' + indexPath + '/' + pkg)
            .then(function () { loadPackages(indexPath); })
            .catch(handleApiError);
    }

    // ========== PACKAGE DETAIL ==========

    function loadPackageDetail(indexPath, pkg, selectedVersion) {
        showLoading();
        var versionsUrl = '/+admin-api/versions/' + indexPath + '/' + pkg;
        Api.get(versionsUrl).then(function (verData) {
            var versions = (verData.versions || []).sort(compareVersions);
            var currentVer = selectedVersion && versions.indexOf(selectedVersion) !== -1
                ? selectedVersion : versions[0];
            if (!currentVer) {
                clear(content);
                showError(new Error('No versions found'));
                return;
            }
            var detailUrl = '/+admin-api/versiondata/' + indexPath + '/' + pkg + '/' + currentVer;
            return Api.get(detailUrl).then(function (detail) {
                return {versions: versions, currentVer: currentVer,
                    info: detail.result || {}};
            }).catch(function () {
                return {versions: versions, currentVer: currentVer,
                    info: {version: currentVer, name: pkg}};
            });
        }).then(function (ctx) {
            if (!ctx) return;
            var versions = ctx.versions;
            var currentVer = ctx.currentVer;
            var info = ctx.info;
            clear(content);

            // Breadcrumb + delete button
            content.appendChild(el('div', {className: 'view-header'}, [
                buildBreadcrumb(indexPath, [
                    ' / ',
                    el('a', {href: '#package/' + indexPath + '/' + pkg, textContent: pkg}),
                    ' ',
                    el('span', {className: 'page-heading-version', textContent: 'v' + currentVer}),
                ]),
                el('div', {className: 'view-header-actions'}, canDeleteFromIndex(indexPath) ? [
                    el('button', {
                        className: 'btn btn-danger',
                        textContent: 'Delete package',
                        onclick: function () { deletePackage(indexPath, pkg); },
                    }),
                ] : []),
            ]));

            if (versions.length === 0) {
                content.appendChild(el('p', {
                    className: 'text-muted',
                    textContent: 'No versions found.',
                }));
                return;
            }

            var layout = el('div', {className: 'pkg-detail-layout'});

            // === Sidebar ===
            var sidebar = el('aside', {className: 'pkg-sidebar'});

            // Package info
            var infoCard = el('div', {className: 'pkg-sidebar-section'});
            infoCard.appendChild(el('div', {className: 'pkg-sidebar-title', textContent: 'Package info'}));

            if (info.summary) {
                infoCard.appendChild(el('div', {
                    className: 'pkg-sidebar-summary',
                    textContent: info.summary,
                }));
            }

            var infoRows = [];
            if (info.requires_python) infoRows.push(['Python', info.requires_python]);
            var license = info.license_expression || info.license;
            if (license) infoRows.push(['License', license]);
            if (info.author) {
                var author = info.author;
                if (info.author_email) author += ' <' + info.author_email + '>';
                infoRows.push(['Author', author]);
            }
            if (info.maintainer) {
                var maint = info.maintainer;
                if (info.maintainer_email) maint += ' <' + info.maintainer_email + '>';
                infoRows.push(['Maintainer', maint]);
            }
            if (info.home_page) infoRows.push(['Home', info.home_page]);
            if (info.keywords) infoRows.push(['Keywords', info.keywords]);
            if (info.platform && info.platform.length) {
                var plat = Array.isArray(info.platform)
                    ? info.platform.join(', ') : String(info.platform);
                infoRows.push(['Platform', plat]);
            }
            for (var ri = 0; ri < infoRows.length; ri++) {
                infoCard.appendChild(el('div', {className: 'pkg-sidebar-row'}, [
                    el('span', {className: 'pkg-sidebar-label', textContent: infoRows[ri][0]}),
                    el('span', {className: 'pkg-sidebar-value', textContent: infoRows[ri][1]}),
                ]));
            }

            if (info.requires_dist && info.requires_dist.length) {
                infoCard.appendChild(el('div', {className: 'pkg-sidebar-label', textContent: 'Requires'}));
                var reqList = el('ul', {className: 'pkg-sidebar-list'});
                for (var rd = 0; rd < info.requires_dist.length; rd++) {
                    reqList.appendChild(el('li', {textContent: info.requires_dist[rd]}));
                }
                infoCard.appendChild(reqList);
            }

            if (info.provides_extras && info.provides_extras.length) {
                infoCard.appendChild(el('div', {className: 'pkg-sidebar-label', textContent: 'Extras'}));
                var extrasList = el('ul', {className: 'pkg-sidebar-list'});
                for (var ex = 0; ex < info.provides_extras.length; ex++) {
                    extrasList.appendChild(el('li', {textContent: info.provides_extras[ex]}));
                }
                infoCard.appendChild(extrasList);
            }

            // Project URLs (list of "Label, URL" strings, or dict)
            var urls = info.project_urls;
            var urlEntries = [];
            if (Array.isArray(urls)) {
                for (var up = 0; up < urls.length; up++) {
                    var parts2 = urls[up].split(',');
                    if (parts2.length >= 2) {
                        urlEntries.push([parts2[0].trim(), parts2.slice(1).join(',').trim()]);
                    }
                }
            } else if (urls && typeof urls === 'object') {
                for (var uk in urls) {
                    urlEntries.push([uk, urls[uk]]);
                }
            }
            if (urlEntries.length) {
                infoCard.appendChild(el('div', {className: 'pkg-sidebar-label', textContent: 'Links'}));
                var urlList = el('ul', {className: 'pkg-sidebar-list'});
                for (var ue = 0; ue < urlEntries.length; ue++) {
                    var li = el('li');
                    var urlHref = urlEntries[ue][1];
                    if (isSafeUrl(urlHref)) {
                        li.appendChild(el('a', {
                            href: urlHref,
                            textContent: urlEntries[ue][0],
                            target: '_blank',
                            rel: 'noopener',
                            className: 'pkg-sidebar-link',
                        }));
                    } else {
                        li.appendChild(el('span', {textContent: urlEntries[ue][0] + ': ' + urlHref}));
                    }
                    urlList.appendChild(li);
                }
                infoCard.appendChild(urlList);
            }

            // Pip install
            infoCard.appendChild(el('div', {className: 'pkg-sidebar-label', textContent: 'Install'}));
            var pipSpec = selectedVersion ? pkg + '==' + currentVer : pkg;
            infoCard.appendChild(buildPipBlock(indexPath, pipSpec));

            // Files for current version
            var links = info['+links'] || [];
            if (links.length) {
                infoCard.appendChild(el('div', {className: 'pkg-sidebar-label', textContent: 'Files'}));
                var fileList = el('div', {className: 'pkg-sidebar-files'});
                var lastDate = '';
                for (var j = 0; j < links.length; j++) {
                    var link = links[j];
                    var fileName = link.href.split('/').pop();
                    var dateStr = '';
                    if (link.log && link.log.length) {
                        var log = link.log[0];
                        var when = log.when;
                        dateStr = when[0] + '-' + pad(when[1]) + '-' + pad(when[2]) + ' ' +
                            pad(when[3]) + ':' + pad(when[4]);
                        if (log.who) dateStr = log.who + ', ' + dateStr;
                    }
                    if (dateStr && dateStr !== lastDate) {
                        fileList.appendChild(el('div', {
                            className: 'file-date',
                            textContent: dateStr,
                        }));
                        lastDate = dateStr;
                    }
                    fileList.appendChild(el('a', {
                        href: link.href,
                        className: 'file-link',
                        textContent: fileName,
                    }));
                }
                infoCard.appendChild(fileList);
            }

            sidebar.appendChild(infoCard);

            // Versions list
            var versCard = el('div', {className: 'pkg-sidebar-section'});
            versCard.appendChild(el('div', {className: 'pkg-sidebar-versions-head'}, [
                el('span', {className: 'pkg-sidebar-title', textContent: 'Versions'}),
                el('span', {className: 'pkg-sidebar-count', textContent: String(versions.length)}),
            ]));

            var versList = el('div', {className: 'pkg-version-list'});
            for (var v = 0; v < versions.length; v++) {
                var ver = versions[v];
                var rowCls = 'pkg-version-row' + (ver === currentVer ? ' pkg-version-active' : '');
                var row = el('div', {className: rowCls});
                row.appendChild(el('a', {
                    href: '#package/' + indexPath + '/' + pkg + '?version=' + encodeURIComponent(ver),
                    className: 'pkg-version-link',
                    textContent: 'v' + ver,
                }));
                row.appendChild((function (verLocal) {
                    return el('button', {
                        className: 'pkg-version-del auth-only',
                        textContent: '\u00d7',
                        title: 'Delete version',
                        onclick: function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            deleteVersion(indexPath, pkg, verLocal);
                        },
                    });
                })(ver));
                versList.appendChild(row);
            }
            versCard.appendChild(versList);
            sidebar.appendChild(versCard);

            layout.appendChild(sidebar);

            // === Main content: README (loaded async) ===
            var main = el('main', {className: 'pkg-main'});
            var readmeSlot = el('div', {className: 'readme-slot'});
            readmeSlot.appendChild(el('p', {className: 'loading', textContent: 'Loading README...'}));
            main.appendChild(readmeSlot);
            layout.appendChild(main);
            content.appendChild(layout);

            if (info.description) {
                clear(readmeSlot);
                renderReadme(readmeSlot, info.description, info.description_content_type);
            } else {
                fetchUpstreamReadme(indexPath, pkg, currentVer, function (desc, contentType) {
                    clear(readmeSlot);
                    if (desc) {
                        renderReadme(readmeSlot, desc, contentType);
                    } else {
                        readmeSlot.appendChild(el('p', {
                            className: 'text-muted',
                            textContent: 'No description / README available for this version.',
                        }));
                    }
                });
            }
        }).catch(handleApiError);
    }

    function isSafeUrl(url) {
        return /^https?:\/\//i.test(url);
    }

    function sanitizeHtml(html) {
        // Strip dangerous tags and attributes from rendered markdown
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var dangerous = tmp.querySelectorAll('script,iframe,object,embed,form,base,meta,link');
        for (var i = 0; i < dangerous.length; i++) {
            dangerous[i].remove();
        }
        // Remove event handlers and javascript: URLs from all elements
        var all = tmp.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
            var attrs = all[j].attributes;
            for (var k = attrs.length - 1; k >= 0; k--) {
                var name = attrs[k].name.toLowerCase();
                if (name.indexOf('on') === 0) {
                    all[j].removeAttribute(attrs[k].name);
                } else if ((name === 'href' || name === 'action') &&
                        /^\s*(?:javascript|data|vbscript)\s*:/i.test(attrs[k].value)) {
                    // data: in href is the text/html XSS vector; block it on links.
                    all[j].removeAttribute(attrs[k].name);
                } else if (name === 'src' &&
                        /^\s*(?:javascript|vbscript)\s*:/i.test(attrs[k].value)) {
                    // data: kept on src — data:image/... is the common safe case.
                    all[j].removeAttribute(attrs[k].name);
                }
            }
        }
        return tmp.innerHTML;
    }

    function renderReadme(container, description, contentType) {
        var body = el('div', {className: 'markdown-body'});
        var isMarkdown = (contentType || '').indexOf('markdown') !== -1;
        if (isMarkdown && window.marked) {
            body.innerHTML = sanitizeHtml(marked.parse(description));
        } else {
            var pre = document.createElement('pre');
            pre.textContent = description;
            body.appendChild(pre);
        }
        container.appendChild(body);
    }

    function fetchUpstreamReadme(indexPath, pkg, version, callback) {
        // Detect mirror URL from index info
        var parts = indexPath.split('/');
        Api.get('/' + parts[0]).then(function (userData) {
            var indexInfo = (userData.result.indexes || {})[parts[1]];
            if (!indexInfo || indexInfo.type !== 'mirror') {
                callback(null);
                return;
            }
            var mirrorUrl = indexInfo.mirror_url || '';
            // Only support pypi.org for now
            if (mirrorUrl.indexOf('pypi.org') === -1) {
                callback(null);
                return;
            }
            var url = 'https://pypi.org/pypi/' + pkg + '/' + version + '/json';
            fetch(url, {signal: AbortSignal.timeout(5000)}).then(function (res) {
                if (!res.ok) throw new Error('not found');
                return res.json();
            }).then(function (data) {
                var info = data.info || {};
                callback(
                    info.description || null,
                    info.description_content_type || null
                );
            }).catch(function () {
                callback(null);
            });
        }).catch(function () {
            callback(null);
        });
    }

    function deleteVersion(indexPath, pkg, ver) {
        if (!confirm('Delete version ' + ver + ' of "' + pkg + '"?')) {
            return;
        }
        Api.del('/' + indexPath + '/' + pkg + '/' + ver)
            .then(function () {
                // Reload with default version (newest)
                _skipHashChange = true;
                window.location.hash = '#package/' + indexPath + '/' + pkg;
                loadPackageDetail(indexPath, pkg);
            })
            .catch(handleApiError);
    }

    function pad(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    var _preReleaseOrder = {dev: 0, a: 1, alpha: 1, b: 2, beta: 2, rc: 3, c: 3};

    function _parseVersion(v) {
        // Split into numeric release and optional pre-release suffix
        var m = v.match(/^(\d[\d.]*?)(?:(dev|a|alpha|b|beta|rc|c)(\d*))?(?:\+.*)?$/i);
        if (!m) return {parts: [0], pre: [4, 0]}; // unparseable → treat as release
        var parts = m[1].split('.').map(function (s) { return parseInt(s) || 0; });
        var pre;
        if (m[2]) {
            pre = [_preReleaseOrder[m[2].toLowerCase()] || 0, parseInt(m[3]) || 0];
        } else {
            pre = [4, 0]; // final release sorts after all pre-releases
        }
        return {parts: parts, pre: pre};
    }

    function compareVersions(a, b) {
        // Reverse sort — newest first. Handles PEP 440 pre-releases.
        var va = _parseVersion(a);
        var vb = _parseVersion(b);
        var len = Math.max(va.parts.length, vb.parts.length);
        for (var i = 0; i < len; i++) {
            var na = va.parts[i] || 0;
            var nb = vb.parts[i] || 0;
            if (na !== nb) return nb - na;
        }
        // Compare pre-release: [type, number]
        if (va.pre[0] !== vb.pre[0]) return vb.pre[0] - va.pre[0];
        return vb.pre[1] - va.pre[1];
    }

    // ========== STATUS ==========

    var _statusRefreshTimer = null;
    var STATUS_REFRESH_MS = 30000;

    function _stopStatusRefresh() {
        if (_statusRefreshTimer) {
            clearInterval(_statusRefreshTimer);
            _statusRefreshTimer = null;
        }
    }

    function _onStatusView() {
        var h = location.hash || '';
        return !h || h === '#' || h.charAt(1) === '?';
    }

    function loadStatus(silent) {
        if (!silent) showLoading();
        // Replica poll info is auth-gated and only used in the replicas
        // section, which itself is hidden from anonymous visitors. Skip
        // the request entirely when nobody's logged in — avoids a 403
        // in the network tab on every status refresh.
        var replicasRequest = Api.getUser()
            ? Api.get('/+admin-api/replicas').catch(function () {
                return {result: {}};
            })
            : Promise.resolve({result: {}});
        Promise.all([
            Api.get('/+api'),
            Api.get('/+status'),
            replicasRequest,
        ]).then(function (results) {
            // User may have navigated away during the fetch; drop the
            // result rather than overwriting the new view.
            if (!_onStatusView()) {
                _stopStatusRefresh();
                return;
            }
            var api = results[0].result;
            var status = results[1].result;
            var replicaPolls = (results[2] && results[2].result) || {};
            // Reuse this fetch to seed plugin capability cache so other
            // views can synchronously branch on it.
            _setPluginCaps(api, status);
            clear(content);

            content.appendChild(el('h2', {className: 'page-heading'}, ['Status']));
            // Periodic silent refresh so the displayed serials follow
            // reality without manual reload.
            _stopStatusRefresh();
            _statusRefreshTimer = setInterval(function () {
                if (!_onStatusView()) { _stopStatusRefresh(); return; }
                loadStatus(true);
            }, STATUS_REFRESH_MS);

            var grid = el('div', {className: 'status-grid'});

            // Server info card
            var infoCard = el('div', {className: 'status-card'});
            infoCard.appendChild(el('div', {className: 'status-card-title', textContent: 'Server'}));
            var ver = status.versioninfo || {};
            var infoRows = [];
            var verKeys = Object.keys(ver).sort();
            for (var vk = 0; vk < verKeys.length; vk++) {
                infoRows.push([verKeys[vk], ver[verKeys[vk]]]);
            }
            // devpi-server still emits "MASTER" in /+status (as of 6.x)
            // even though upstream is in the middle of renaming to
            // "PRIMARY". Display the new name; internal checks below
            // accept both for forward compatibility.
            var displayedRole = status.role === 'MASTER'
                ? 'PRIMARY' : (status.role || '?');
            infoRows.push(
                ['Role', displayedRole],
                ['Host', status.host + ':' + status.port],
                ['Serial', String(status.serial || 0)]
            );
            if (api.features && api.features.length) {
                infoRows.push(['Features', api.features.join(', ')]);
            }
            if (hasDevpiTokens()) {
                var tokensVer = devpiTokensVersion();
                infoRows.push([
                    'Devpi tokens',
                    'supported' + (tokensVer ? ' (devpi-tokens ' + tokensVer + ')' : ''),
                ]);
            }
            for (var i = 0; i < infoRows.length; i++) {
                infoCard.appendChild(statusRow(infoRows[i][0], infoRows[i][1]));
            }
            grid.appendChild(infoCard);

            // Cache metrics
            var metrics = status.metrics || [];
            var metricMap = {};
            for (var m = 0; m < metrics.length; m++) {
                metricMap[metrics[m][0]] = metrics[m][2];
            }

            var caches = [
                {name: 'Storage Cache', prefix: 'devpi_server_storage_cache'},
                {name: 'Changelog Cache', prefix: 'devpi_server_changelog_cache'},
                {name: 'Relpath Cache', prefix: 'devpi_server_relpath_cache'},
            ];

            for (var c = 0; c < caches.length; c++) {
                var cache = caches[c];
                var lookups = metricMap[cache.prefix + '_lookups'] || 0;
                var hits = metricMap[cache.prefix + '_hits'] || 0;
                var misses = metricMap[cache.prefix + '_misses'] || 0;
                var evictions = metricMap[cache.prefix + '_evictions'] || 0;
                var size = metricMap[cache.prefix + '_size'];
                var items = metricMap[cache.prefix + '_items'];
                var hitRate = lookups > 0 ? ((hits / lookups) * 100).toFixed(1) + '%' : '—';

                var cacheCard = el('div', {className: 'status-card'});
                cacheCard.appendChild(el('div', {className: 'status-card-title', textContent: cache.name}));

                // Hit rate bar
                var barContainer = el('div', {className: 'hit-rate-bar'});
                var barFill = el('div', {className: 'hit-rate-fill'});
                barFill.style.width = lookups > 0 ? ((hits / lookups) * 100) + '%' : '0%';
                barContainer.appendChild(barFill);
                cacheCard.appendChild(statusRow('Hit rate', hitRate));
                cacheCard.appendChild(barContainer);

                var cacheRows = [
                    ['Lookups', formatNum(lookups)],
                    ['Hits', formatNum(hits)],
                    ['Misses', formatNum(misses)],
                    ['Evictions', formatNum(evictions)],
                ];
                if (size !== undefined) cacheRows.push(['Max size', formatNum(size)]);
                if (items !== undefined) cacheRows.push(['Items', formatNum(items)]);
                for (var r = 0; r < cacheRows.length; r++) {
                    cacheCard.appendChild(statusRow(cacheRows[r][0], cacheRows[r][1]));
                }
                grid.appendChild(cacheCard);
            }

            // Whoosh index
            var whooshQueue = metricMap['devpi_web_whoosh_index_queue_size'];
            var whooshErrors = metricMap['devpi_web_whoosh_index_error_queue_size'];
            if (whooshQueue !== undefined) {
                var whooshCard = el('div', {className: 'status-card'});
                whooshCard.appendChild(el('div', {className: 'status-card-title', textContent: 'Search Index'}));
                whooshCard.appendChild(statusRow('Queue', String(whooshQueue)));
                whooshCard.appendChild(statusRow('Errors', String(whooshErrors || 0)));
                grid.appendChild(whooshCard);
            }

            // Replicas — only shown on master, with connected replicas,
            // and only to authenticated users. Replica UUIDs / internal
            // IPs are operational metadata; anonymous visitors don't
            // need network topology info.
            var pollingReplicas = status.polling_replicas || {};
            var replicaUuids = Object.keys(pollingReplicas);
            // Accept both names — server still emits MASTER but upstream
            // is renaming to PRIMARY.
            if ((status.role === 'MASTER' || status.role === 'PRIMARY')
                    && replicaUuids.length > 0
                    && Api.getUser()) {
                var masterSerial = status.serial || 0;
                var now = Date.now() / 1000;
                // Replica is considered offline if it hasn't polled in >90s
                // (normal polling interval is ~37.5s)
                var OFFLINE_THRESHOLD = 90;

                for (var ri = 0; ri < replicaUuids.length; ri++) {
                    var uuid = replicaUuids[ri];
                    var rep = pollingReplicas[uuid];
                    var poll = replicaPolls[uuid];
                    var lastRequest = rep['last-request'] || 0;
                    var age = now - lastRequest;
                    var isOnline = rep['in-request'] || age < OFFLINE_THRESHOLD;
                    // Authoritative replica serial: applied_serial from
                    // our /+admin-api/replicas tween record. Do NOT fall
                    // back to polling_replicas[uuid].serial — that's
                    // master's optimistic post-stream value and falsely
                    // claims "in sync" while the replica is stuck.
                    var hasPollData = poll
                        && typeof poll.applied_serial === 'number';
                    var replicaSerial = hasPollData
                        ? poll.applied_serial : null;
                    var lag = (replicaSerial !== null)
                        ? (masterSerial - replicaSerial) : 0;
                    var label = rep['remote-ip'] || uuid.substring(0, 8);
                    var stuckSec = (poll && poll.stuck_seconds) || 0;
                    var sync = _replicaSyncState(
                        lag, replicaSerial, masterSerial, stuckSec);

                    var repCard = el('div', {className: 'status-card'});
                    var titleRow = el('div', {className: 'status-card-title replica-title'}, [
                        el('span', {textContent: 'Replica: ' + label}),
                        el('span', {
                            className: 'replica-badge ' + (isOnline ? 'replica-online' : 'replica-offline'),
                            textContent: isOnline ? 'online' : 'offline',
                        }),
                    ]);
                    repCard.appendChild(titleRow);
                    repCard.appendChild(statusRow(
                        'Serial',
                        el('span', {
                            className: 'replica-sync replica-sync-' + sync.kind,
                            textContent: sync.label,
                        })));
                    repCard.appendChild(statusRow('Last seen', _formatAge(age)));
                    if (rep['outside-url']) {
                        repCard.appendChild(statusRow('URL', rep['outside-url']));
                    }
                    if (sync.kind === 'stuck' && poll) {
                        repCard.appendChild(el('div', {
                            className: 'replica-stuck-hint',
                            textContent: 'Replica has been polling the '
                                + 'same serial (#' + poll.start_serial
                                + ') for ' + stuckSec + 's — replication '
                                + 'is stuck. Common cause: a server-side '
                                + 'plugin (devpi-admin, devpi-web with '
                                + 'whoosh, devpi-postgresql, …) is missing '
                                + 'or out of date on the replica. Check '
                                + 'replica logs for AssertionError on '
                                + 'import_changes.',
                        }));
                    }
                    grid.appendChild(repCard);
                }
            }

            content.appendChild(grid);
        }).catch(handleApiError);
    }

    function _formatAge(seconds) {
        if (seconds < 5) return 'just now';
        if (seconds < 60) return Math.floor(seconds) + 's ago';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
        return Math.floor(seconds / 3600) + 'h ago';
    }

    var REPLICA_STUCK_THRESHOLD_S = 30;

    function _replicaSyncState(lag, replicaSerial, masterSerial, stuckSeconds) {
        // Authoritative reading from /+admin-api/replicas:
        //   green  — replica == master (in sync)
        //   orange — replica < master, but advancing
        //   red    — replica < master AND has been polling the same
        //            serial for >= REPLICA_STUCK_THRESHOLD_S (stuck)
        //   red    — no poll data (tween hasn't captured this replica)
        //
        // ``replicaSerial = null`` means we have no /+admin-api/replicas
        // record. NEVER fall back to master's optimistic
        // polling_replicas.serial value — that's what was hiding the
        // broken state in the first place.
        if (replicaSerial === null) {
            // Distinct kind so the stuck-hint block (which dereferences
            // poll.start_serial) doesn't fire here.
            return {
                kind: 'no-data',
                label: 'no poll data (login session expired?)',
            };
        }
        if (lag === 0) {
            return {kind: 'in-sync', label: '#' + masterSerial + ' (in sync)'};
        }
        var label = '#' + replicaSerial + ' / #' + masterSerial
            + ' (+' + lag + ')';
        if (stuckSeconds >= REPLICA_STUCK_THRESHOLD_S) {
            return {kind: 'stuck', label: label};
        }
        return {kind: 'lagging', label: label};
    }


    function formatNum(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    // --- Init ---

    window.onSessionExpired = function () {
        updateAuthUI();
        closeModal();
        showError(new Error('Session expired. Please log in again.'));
    };

    Api.restore();
    updateAuthUI();
    updateNav();
    navigate();

    // Lightweight global health poll: independent of which view is
    // shown. Fetches /+status (and /+admin-api/replicas if authenticated)
    // every HEALTH_POLL_MS to colour the topbar logo. The Status page
    // does its own deeper refresh; this one is just for the indicator.
    var HEALTH_POLL_MS = 30000;
    var _logoEl = document.querySelector('.logo');

    function _pollHealth() {
        var replicasReq = Api.getUser()
            ? Api.get('/+admin-api/replicas').catch(function () {
                return {result: {}};
            })
            : Promise.resolve({result: {}});
        Promise.all([
            Api.get('/+status').catch(function () { return null; }),
            replicasReq,
        ]).then(function (results) {
            var statusEnv = results[0];
            var status = statusEnv && statusEnv.result;
            var replicaPolls = (results[1] && results[1].result) || {};
            _setTopbarHealth(status, replicaPolls);
        });
    }

    function _setTopbarHealth(status, replicaPolls) {
        if (!_logoEl) return;
        var kind, tip;
        if (!status) {
            kind = 'red';
            tip = 'devpi server is not responding';
        } else if (Api.getUser()
                && (status.role === 'MASTER' || status.role === 'PRIMARY')) {
            // Authenticated on primary: detect lagging/stuck replicas via
            // applied_serial vs current keyfs serial.
            var pollingReplicas = status.polling_replicas || {};
            var uuids = Object.keys(pollingReplicas);
            var masterSerial = status.serial || 0;
            var lagging = [];
            for (var i = 0; i < uuids.length; i++) {
                var poll = replicaPolls[uuids[i]];
                if (poll && typeof poll.applied_serial === 'number'
                        && poll.applied_serial < masterSerial) {
                    lagging.push(uuids[i]);
                }
            }
            if (lagging.length) {
                kind = 'orange';
                tip = lagging.length + ' replica(s) lagging — '
                    + 'check the Status page';
            } else {
                kind = 'green';
                tip = 'all replicas in sync';
            }
        } else {
            kind = 'green';
            tip = 'devpi server is reachable';
        }
        _logoEl.classList.remove(
            'logo-health-green', 'logo-health-orange', 'logo-health-red');
        _logoEl.classList.add('logo-health-' + kind);
        _logoEl.title = tip;
    }

    _pollHealth();
    setInterval(_pollHealth, HEALTH_POLL_MS);

    var _sessionCheckReady = false;
    setTimeout(function () { _sessionCheckReady = true; }, 2000);

    function checkSession() {
        if (!_sessionCheckReady || !Api.getUser()) return;
        Api.get('/+admin-api/session').catch(function (err) {
            if (err.status === 403 || err.status === 401) {
                Api.logout();
                updateAuthUI();
                showError(new Error('Session expired. Please log in again.'));
            }
        });
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') checkSession();
    });
    window.addEventListener('focus', checkSession);
})();
