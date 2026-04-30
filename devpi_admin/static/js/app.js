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

    var _pipConfLastTokenId = null;
    var _pipConfLastTokenKept = false;
    var _uploadLastTokenId = null;
    var _uploadLastTokenKept = false;

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

    function canIssueUploadToken(loggedIn, aclUpload) {
        var u = aclUpload || [];
        // Frozen index: no Allow ACEs in __acl__ → backend would reject
        // any token we issue. Don't offer the menu item at all.
        if (isUploadFrozen(u)) return false;
        // Anonymous-upload index lets anyone publish — no auth, no
        // token. The .pypirc modal still has something useful to show
        // (repository URL), so allow even unauthenticated visitors.
        if (u.indexOf(':ANONYMOUS:') >= 0) return true;
        if (!loggedIn) return false;
        if (loggedIn === 'root') return true;
        if (u.indexOf(':AUTHENTICATED:') >= 0) return true;
        return u.indexOf(loggedIn) >= 0;
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

    function showPipConfModal(indexPath, aclRead) {
        _pipConfLastTokenId = null;
        _pipConfLastTokenKept = false;
        var currentUser = Api.getUser();
        var isPublic = isPublicAclRead(aclRead);
        // No need to issue a token for indexes anyone can read,
        // or when the visitor isn't authenticated.
        if (isPublic || !currentUser) {
            return showPipConfStaticModal(indexPath);
        }

        var isRoot = currentUser === 'root';
        var candidateUsers = [];
        if (isRoot) {
            // Root cannot issue tokens for itself (backend rejects with
            // 403). Offer only other principals from acl_read.
            for (var i = 0; i < (aclRead || []).length; i++) {
                var u = aclRead[i];
                if (!u || u.indexOf(':') === 0 || u === 'root') continue;
                if (candidateUsers.indexOf(u) < 0) candidateUsers.push(u);
            }
            // ACL might list only special principals (e.g. :AUTHENTICATED:)
            // — fall back to the index owner so root can still issue.
            if (!candidateUsers.length) {
                var owner = indexPath.split('/')[0];
                if (owner && owner !== 'root') candidateUsers.push(owner);
            }
            if (!candidateUsers.length) return;
        } else {
            candidateUsers.push(currentUser);
        }

        openModal(
            'pip.conf for ' + indexPath,
            function (body) {
                body.appendChild(formGroup('User', (function () {
                    var sel = el('select', {id: 'pipconf-user'});
                    for (var i = 0; i < candidateUsers.length; i++) {
                        sel.appendChild(el('option', {
                            value: candidateUsers[i],
                            textContent: candidateUsers[i],
                        }));
                    }
                    sel.disabled = candidateUsers.length === 1;
                    return sel;
                })()));

                body.appendChild(formGroup('Token TTL', (function () {
                    var sel = el('select', {id: 'pipconf-ttl'});
                    for (var i = 0; i < TTL_OPTIONS.length; i++) {
                        var opt = TTL_OPTIONS[i];
                        var optEl = el('option', {
                            value: String(opt.value),
                            textContent: opt.label,
                        });
                        if (opt.value === 86400) optEl.selected = true;
                        sel.appendChild(optEl);
                    }
                    return sel;
                })()));

                body.appendChild(formGroup('Label (optional)', el('input', {
                    type: 'text',
                    id: 'pipconf-label',
                    value: 'pip-conf ' + indexPath,
                    maxLength: 200,
                })));

                body.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'Token is read-only — it cannot change passwords or be exchanged for a session token. The pip.conf will contain credentials in the URL; treat it as a secret.',
                }));

                body.appendChild(el('div', {
                    id: 'pipconf-result',
                    className: 'pip-conf-result',
                    hidden: true,
                }));
            },
            [
                el('span', {
                    id: 'pipconf-notice',
                    className: 'pipconf-notice',
                    hidden: true,
                }),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Generate',
                    id: 'pipconf-generate',
                    onclick: function () { generatePipConf(indexPath); },
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ]);
    }

    function generatePipConf(indexPath) {
        var user = document.getElementById('pipconf-user').value;
        var ttl = parseInt(document.getElementById('pipconf-ttl').value, 10);
        var label = document.getElementById('pipconf-label').value;
        var btn = document.getElementById('pipconf-generate');
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Generating…';

        // Revoke previously-generated token from this same modal session
        // unless the user committed to it (Copy or Download). Prevents
        // piles of unused tokens while not killing one already in clipboard.
        var prevId = _pipConfLastTokenId;
        var prevKept = _pipConfLastTokenKept;
        var didRevoke = false;
        _pipConfLastTokenId = null;
        _pipConfLastTokenKept = false;
        var revokePromise;
        if (prevId && !prevKept) {
            didRevoke = true;
            revokePromise = Api.del('/+admin-api/tokens/' + encodeURIComponent(prevId))
                .catch(function () {});
        } else {
            revokePromise = Promise.resolve();
        }

        var url = '/+admin-api/pip-conf?index=' + encodeURIComponent(indexPath)
            + '&user=' + encodeURIComponent(user)
            + '&ttl=' + ttl
            + '&label=' + encodeURIComponent(label);

        revokePromise.then(function () {
            // Need raw text/plain response, so use fetch directly instead of Api.get
            return fetch(url, {
                method: 'GET',
                headers: {
                    'X-Devpi-Auth': btoa(Api.getUser() + ':' + Api.getToken()),
                    'Accept': 'text/plain',
                },
            });
        }).then(function (res) {
            if (!res.ok) {
                return res.json().then(function (j) {
                    throw new Error(j.error || ('Status ' + res.status));
                });
            }
            return res.text();
        }).then(function (content) {
            var token = extractTokenSecret(content);
            // Token format is `adm_<id>.<secret>`; the revoke endpoint
            // expects just <id>, so strip the prefix and the secret tail.
            _pipConfLastTokenId = null;
            if (token) {
                var rest = token.substring(4);  // strip "adm_"
                var dot = rest.indexOf('.');
                _pipConfLastTokenId = dot > 0 ? rest.substring(0, dot) : null;
            }
            renderPipConfResult(content, indexPath, didRevoke);
            btn.textContent = 'Regenerate';
        }).catch(function (err) {
            // Route through the same auto-fading slot as the "Previous
            // token was revoked." notice so successive clicks don't pile
            // up modal-level errors.
            var msg = (err && err.message) || 'Operation failed';
            showPipConfNotice(msg, 'error');
            btn.textContent = orig;
        }).finally(function () {
            btn.disabled = false;
        });
    }

    function showUserTokensModal(username) {
        openModal(
            'Tokens for ' + username,
            function (body) {
                body.appendChild(el('div', {
                    id: 'tokens-list-container',
                    textContent: 'Loading…',
                }));
            },
            [
                el('button', {
                    className: 'btn',
                    textContent: 'Reset all',
                    onclick: function () {
                        if (!confirm('Revoke ALL tokens for ' + username + '?')) return;
                        Api.del('/+admin-api/users/' + encodeURIComponent(username) + '/tokens')
                            .then(function () { renderTokensList(username); })
                            .catch(showModalError);
                    },
                }),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ],
            // Tokens table has many columns — request the wide layout
            // so it doesn't overflow the default 520px modal.
            {width: 'wide'});
        renderTokensList(username);
    }

    function renderTokensList(username) {
        var container = document.getElementById('tokens-list-container');
        if (!container) return;
        Api.get('/+admin-api/users/' + encodeURIComponent(username) + '/tokens')
            .then(function (data) {
                clear(container);
                var tokens = data.result || [];
                if (!tokens.length) {
                    container.appendChild(el('div', {
                        className: 'tokens-empty',
                        textContent: 'No active tokens.',
                    }));
                    return;
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
            })
            .catch(function (err) {
                clear(container);
                container.appendChild(el('div', {
                    className: 'error-text',
                    textContent: 'Failed to load tokens: ' + err.message,
                }));
            });
    }

    function buildTokenRow(t, username) {
        return el('tr', null, [
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

    function showPipConfNotice(text, kind) {
        // Single notice slot in the pip.conf modal footer. Both info
        // ("Previous token was revoked.") and error ("root may not issue
        // tokens for itself") land here; the latest message replaces
        // any prior one and auto-fades after a few seconds.
        var notice = document.getElementById('pipconf-notice');
        if (!notice) return;
        notice.textContent = text;
        notice.classList.remove('pipconf-notice-fade');
        notice.classList.toggle('pipconf-notice-error', kind === 'error');
        notice.hidden = false;
        clearTimeout(notice._fadeTimer);
        clearTimeout(notice._hideTimer);
        // Errors stick around longer than info messages so the user has
        // time to read the failure reason.
        var holdMs = kind === 'error' ? 6000 : 3000;
        notice._fadeTimer = setTimeout(function () {
            notice.classList.add('pipconf-notice-fade');
        }, holdMs);
        notice._hideTimer = setTimeout(function () {
            notice.hidden = true;
            notice.textContent = '';
            notice.classList.remove('pipconf-notice-fade');
            notice.classList.remove('pipconf-notice-error');
        }, holdMs + 700);
    }

    function showRevokedNotice() {
        showPipConfNotice('Previous token was revoked.', 'info');
    }

    function clearPipConfNotice() {
        // Drop any pending notice immediately — used after a successful
        // generate so a stale error from the previous attempt doesn't
        // linger over fresh credentials.
        var notice = document.getElementById('pipconf-notice');
        if (!notice) return;
        clearTimeout(notice._fadeTimer);
        clearTimeout(notice._hideTimer);
        notice.hidden = true;
        notice.textContent = '';
        notice.classList.remove('pipconf-notice-fade');
        notice.classList.remove('pipconf-notice-error');
    }

    function renderPipConfResult(content, indexPath, didRevoke) {
        var result = document.getElementById('pipconf-result');
        clear(result);
        result.hidden = false;

        // Wipe any prior error/info notice first; the revoke message
        // (if any) is re-shown immediately below so it survives.
        clearPipConfNotice();
        if (didRevoke) {
            showRevokedNotice();
        }

        // Block 1: pip.conf file
        result.appendChild(el('label', {
            className: 'pipconf-section-label',
            textContent: 'pip.conf',
        }));
        var actions = el('div', {className: 'pip-conf-actions'});
        var copyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        copyBtn.addEventListener('click', function () {
            copyText(content).then(function () {
                _pipConfLastTokenKept = true;
                flashCopied(copyBtn);
            });
        });
        actions.appendChild(copyBtn);
        actions.appendChild(el('button', {
            className: 'btn',
            textContent: 'Download',
            onclick: function () {
                _pipConfLastTokenKept = true;
                downloadFile(content, 'pip.conf');
            },
        }));
        result.appendChild(actions);
        result.appendChild(el('pre', {
            className: 'pip-conf-preview',
            textContent: content,
        }));

        // Block 2: one-off install command (most ready-to-use)
        var indexUrl = extractIndexUrl(content);
        if (indexUrl) {
            // Derive trusted-host from the backend-provided URL so it
            // matches index-url even if the deployment lives behind a
            // proxy with a different hostname than the browser's tab.
            var oneOffCmd = 'pip install --index-url ' + indexUrl
                + ' --trusted-host ' + hostFromUrl(indexUrl) + ' <package>';
            result.appendChild(el('label', {
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
                copyText(oneOffCmd).then(function () {
                    _pipConfLastTokenKept = true;
                    flashCopied(cmdCopyBtn);
                });
            });
            cmdRow.appendChild(cmdCopyBtn);
            result.appendChild(cmdRow);
            result.appendChild(el('div', {
                className: 'form-hint',
                textContent: 'Replace <package> with the package name.',
            }));
        }

        // Block 3: raw user:token credential pair (most generic)
        var creds = extractCreds(content);
        if (creds) {
            result.appendChild(el('label', {
                className: 'pipconf-section-label',
                textContent: 'User : token (for curl -u, devpi login, custom tools)',
            }));
            var tokRow = el('div', {className: 'pip-oneoff-row'});
            var tokInput = el('input', {
                type: 'text',
                className: 'pip-oneoff-input',
                value: creds,
                readOnly: true,
                spellcheck: false,
            });
            tokInput.addEventListener('focus', function () { this.select(); });
            tokRow.appendChild(tokInput);
            var tokCopyBtn = el('button', {className: 'btn', textContent: 'Copy'});
            tokCopyBtn.addEventListener('click', function () {
                copyText(creds).then(function () {
                    _pipConfLastTokenKept = true;
                    flashCopied(tokCopyBtn);
                });
            });
            tokRow.appendChild(tokCopyBtn);
            result.appendChild(tokRow);
        }
    }

    // --- .pypirc modal (upload-scope token for twine / devpi upload) ---

    function showPypircStaticModal(indexPath) {
        // Anonymous-upload index: no credentials needed. Twine still
        // wants a [section] in .pypirc, so we emit one without password.
        // URL fetched from backend so it matches whatever a tokened
        // .pypirc would produce on the same deployment.
        getPublicUrl().then(function (publicUrl) {
            var repoUrl = publicUrl + '/' + indexPath + '/';
            var content = '[distutils]\n'
                + 'index-servers = devpi\n\n'
                + '[devpi]\n'
                + 'repository = ' + repoUrl + '\n';
            var oneOffCmd = 'twine upload --repository-url ' + repoUrl + ' dist/*';
            _renderPypircStaticModal(indexPath, content, oneOffCmd);
        });
    }

    function _renderPypircStaticModal(indexPath, content, oneOffCmd) {
        openModal(
            '.pypirc for ' + indexPath,
            function (body) {
                body.appendChild(el('div', {
                    className: 'form-hint form-hint-warn',
                    textContent: 'This index allows anonymous upload — '
                        + 'no token is needed. Make sure this is what you '
                        + 'want; world-writable indexes are a supply-chain '
                        + 'attack vector.',
                }));

                body.appendChild(el('label', {
                    className: 'pipconf-section-label',
                    textContent: '.pypirc (twine)',
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
                    onclick: function () { downloadFile(content, '.pypirc'); },
                }));
                body.appendChild(actions);
                body.appendChild(el('pre', {
                    className: 'pip-conf-preview',
                    textContent: content,
                }));

                body.appendChild(el('label', {
                    className: 'pipconf-section-label',
                    textContent: 'One-shot twine command',
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


    function showUploadTokenModal(indexPath, aclUpload) {
        _uploadLastTokenId = null;
        _uploadLastTokenKept = false;
        // World-writable index: anonymous upload — render a static
        // .pypirc with no credentials (mirror of pip.conf public flow).
        if (isAnonymousAclUpload(aclUpload)) {
            return showPypircStaticModal(indexPath);
        }
        var currentUser = Api.getUser();
        if (!currentUser) return;
        var isRoot = currentUser === 'root';

        var candidateUsers = [];
        if (isRoot) {
            // Root may issue for any non-root principal in acl_upload.
            for (var i = 0; i < (aclUpload || []).length; i++) {
                var u = aclUpload[i];
                if (!u || u.indexOf(':') === 0 || u === 'root') continue;
                if (candidateUsers.indexOf(u) < 0) candidateUsers.push(u);
            }
            // If acl_upload contains only special principals (e.g. just
            // :AUTHENTICATED:), fall back to the index owner so root can
            // still hand out a token without editing the ACL first.
            if (!candidateUsers.length) {
                var owner = indexPath.split('/')[0];
                if (owner && owner !== 'root') candidateUsers.push(owner);
            }
        } else {
            candidateUsers.push(currentUser);
        }
        if (!candidateUsers.length) return;

        openModal(
            '.pypirc for ' + indexPath,
            function (body) {
                body.appendChild(formGroup('User', (function () {
                    var sel = el('select', {id: 'upload-token-user'});
                    for (var i = 0; i < candidateUsers.length; i++) {
                        sel.appendChild(el('option', {
                            value: candidateUsers[i],
                            textContent: candidateUsers[i],
                        }));
                    }
                    sel.disabled = candidateUsers.length === 1;
                    return sel;
                })()));

                body.appendChild(formGroup('Token TTL', (function () {
                    var sel = el('select', {id: 'upload-token-ttl'});
                    for (var i = 0; i < TTL_OPTIONS.length; i++) {
                        var opt = TTL_OPTIONS[i];
                        var optEl = el('option', {
                            value: String(opt.value),
                            textContent: opt.label,
                        });
                        if (opt.value === 86400) optEl.selected = true;
                        sel.appendChild(optEl);
                    }
                    return sel;
                })()));

                body.appendChild(formGroup('Label (optional)', el('input', {
                    type: 'text',
                    id: 'upload-token-label',
                    value: 'twine ' + indexPath,
                    maxLength: 200,
                })));

                body.appendChild(el('div', {
                    className: 'form-hint',
                    textContent: 'Upload token acts as a temporary password '
                        + 'for twine / devpi upload. It cannot delete '
                        + 'packages, change passwords, or issue further '
                        + 'tokens — but treat it like a password anyway.',
                }));

                body.appendChild(el('div', {
                    id: 'upload-token-result',
                    className: 'pip-conf-result',
                    hidden: true,
                }));
            },
            [
                // Reuse the pip-conf flash slot id — only one modal is
                // open at a time, and the helpers (showPipConfNotice /
                // clearPipConfNotice) work uniformly for both.
                el('span', {
                    id: 'pipconf-notice',
                    className: 'pipconf-notice',
                    hidden: true,
                }),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Generate',
                    id: 'upload-token-generate',
                    onclick: function () { generateUploadToken(indexPath); },
                }),
                el('button', {
                    className: 'btn',
                    textContent: 'Close',
                    onclick: closeModal,
                }),
            ]);
    }

    function generateUploadToken(indexPath) {
        var user = document.getElementById('upload-token-user').value;
        var ttl = parseInt(document.getElementById('upload-token-ttl').value, 10);
        var label = document.getElementById('upload-token-label').value;
        var btn = document.getElementById('upload-token-generate');
        btn.disabled = true;
        var orig = btn.textContent;
        btn.textContent = 'Generating…';

        // Same revoke-on-regen policy as pip.conf: drop the previous
        // token unless the user already copied/downloaded it.
        var prevId = _uploadLastTokenId;
        var prevKept = _uploadLastTokenKept;
        var didRevoke = false;
        _uploadLastTokenId = null;
        _uploadLastTokenKept = false;
        var revokePromise;
        if (prevId && !prevKept) {
            didRevoke = true;
            revokePromise = Api.del('/+admin-api/tokens/'
                + encodeURIComponent(prevId)).catch(function () {});
        } else {
            revokePromise = Promise.resolve();
        }

        revokePromise.then(function () {
            return Promise.all([
                Api.post('/+admin-api/token', {
                    user: user,
                    index: indexPath,
                    scope: 'upload',
                    ttl_seconds: ttl,
                    label: label,
                    wait_replicas: true,
                }),
                getPublicUrl(),
            ]);
        }).then(function (results) {
            var data = results[0];
            var publicUrl = results[1];
            var token = data.token || '';
            if (token.indexOf('adm_') === 0) {
                var rest = token.substring(4);
                var dot = rest.indexOf('.');
                _uploadLastTokenId = dot > 0 ? rest.substring(0, dot) : null;
            }
            renderUploadTokenResult(data, indexPath, didRevoke, publicUrl);
            btn.textContent = 'Regenerate';
        }).catch(function (err) {
            var msg = (err && err.message) || 'Operation failed';
            showPipConfNotice(msg, 'error');
            btn.textContent = orig;
        }).finally(function () {
            btn.disabled = false;
        });
    }

    function renderUploadTokenResult(data, indexPath, didRevoke, publicUrl) {
        var result = document.getElementById('upload-token-result');
        clear(result);
        result.hidden = false;
        clearPipConfNotice();
        if (didRevoke) showRevokedNotice();

        var user = data.user;
        var token = data.token;
        var base = publicUrl || location.origin.replace(/\/+$/, '');
        var repoUrl = base + '/' + indexPath + '/';

        // Block 1: .pypirc — config file consumed by twine
        var pypircContent = '[distutils]\n'
            + 'index-servers = devpi\n\n'
            + '[devpi]\n'
            + 'repository = ' + repoUrl + '\n'
            + 'username = ' + user + '\n'
            + 'password = ' + token + '\n';
        result.appendChild(el('label', {
            className: 'pipconf-section-label',
            textContent: '.pypirc (twine)',
        }));
        var actions = el('div', {className: 'pip-conf-actions'});
        var copyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        copyBtn.addEventListener('click', function () {
            copyText(pypircContent).then(function () {
                _uploadLastTokenKept = true;
                flashCopied(copyBtn);
            });
        });
        actions.appendChild(copyBtn);
        actions.appendChild(el('button', {
            className: 'btn',
            textContent: 'Download',
            onclick: function () {
                _uploadLastTokenKept = true;
                downloadFile(pypircContent, '.pypirc');
            },
        }));
        result.appendChild(actions);
        result.appendChild(el('pre', {
            className: 'pip-conf-preview',
            textContent: pypircContent,
        }));

        // Block 2: TWINE_* environment variables — for CI runners
        var envBlock = 'export TWINE_REPOSITORY_URL=' + repoUrl + '\n'
            + 'export TWINE_USERNAME=' + user + '\n'
            + 'export TWINE_PASSWORD=' + shellQuote(token);
        result.appendChild(el('label', {
            className: 'pipconf-section-label',
            textContent: 'Environment variables (twine)',
        }));
        var envActions = el('div', {className: 'pip-conf-actions'});
        var envCopyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        envCopyBtn.addEventListener('click', function () {
            copyText(envBlock).then(function () {
                _uploadLastTokenKept = true;
                flashCopied(envCopyBtn);
            });
        });
        envActions.appendChild(envCopyBtn);
        result.appendChild(envActions);
        result.appendChild(el('pre', {
            className: 'pip-conf-preview',
            textContent: envBlock,
        }));

        // Block 3: one-shot twine upload command
        var twineCmd = 'twine upload --repository-url ' + repoUrl
            + ' -u ' + user + ' -p ' + shellQuote(token) + ' dist/*';
        result.appendChild(el('label', {
            className: 'pipconf-section-label',
            textContent: 'One-shot twine command',
        }));
        var cmdRow = el('div', {className: 'pip-oneoff-row'});
        var cmdInput = el('input', {
            type: 'text',
            className: 'pip-oneoff-input',
            value: twineCmd,
            readOnly: true,
            spellcheck: false,
        });
        cmdInput.addEventListener('focus', function () { this.select(); });
        cmdRow.appendChild(cmdInput);
        var cmdCopyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        cmdCopyBtn.addEventListener('click', function () {
            copyText(twineCmd).then(function () {
                _uploadLastTokenKept = true;
                flashCopied(cmdCopyBtn);
            });
        });
        cmdRow.appendChild(cmdCopyBtn);
        result.appendChild(cmdRow);

        // Block 4: raw user:token credential pair (for curl, devpi login)
        var creds = user + ':' + token;
        result.appendChild(el('label', {
            className: 'pipconf-section-label',
            textContent: 'User : token (for curl -u, devpi login, custom tools)',
        }));
        var tokRow = el('div', {className: 'pip-oneoff-row'});
        var tokInput = el('input', {
            type: 'text',
            className: 'pip-oneoff-input',
            value: creds,
            readOnly: true,
            spellcheck: false,
        });
        tokInput.addEventListener('focus', function () { this.select(); });
        tokRow.appendChild(tokInput);
        var tokCopyBtn = el('button', {className: 'btn', textContent: 'Copy'});
        tokCopyBtn.addEventListener('click', function () {
            copyText(creds).then(function () {
                _uploadLastTokenKept = true;
                flashCopied(tokCopyBtn);
            });
        });
        tokRow.appendChild(tokCopyBtn);
        result.appendChild(tokRow);
    }

    function flashCopied(btn) {
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = orig; }, 1200);
    }

    function extractIndexUrl(pipConfContent) {
        var m = pipConfContent.match(/^index-url\s*=\s*(\S+)/m);
        return m ? m[1] : null;
    }

    function extractTokenSecret(pipConfContent) {
        var m = pipConfContent.match(/^index-url\s*=\s*https?:\/\/[^:]+:([^@]+)@/m);
        if (!m) return null;
        try {
            return decodeURIComponent(m[1]);
        } catch (e) {
            return m[1];
        }
    }

    function extractCreds(pipConfContent) {
        // Returns "user:token" extracted (URL-decoded) from the index-url.
        var m = pipConfContent.match(/^index-url\s*=\s*https?:\/\/([^:]+):([^@]+)@/m);
        if (!m) return null;
        try {
            return decodeURIComponent(m[1]) + ':' + decodeURIComponent(m[2]);
        } catch (e) {
            return m[1] + ':' + m[2];
        }
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
                _triggerPasswordSave(user, pass);
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
        fetchRoot().then(function (result) {
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
                                    showUserTokensModal(uname);
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
        fetchRoot().then(function (result) {
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
                cardHead.appendChild(el('a', {
                    href: '#indexes/' + idx._user,
                    className: 'index-card-owner',
                    textContent: idx._user,
                }));
                cardHead.appendChild(el('span', {
                    className: 'index-card-sep',
                    textContent: '/',
                }));
                cardHead.appendChild(el('a', {
                    href: '#packages/' + idx._full,
                    className: 'index-card-name',
                    textContent: idx._name,
                }));
                var tagGroup = el('div', {className: 'index-card-tags'});
                tagGroup.appendChild(el('span', {
                    className: 'tag' + (isMirror ? ' tag-mirror' : ' tag-stage'),
                    textContent: idx.type || 'stage',
                }));
                if (!isMirror && idx.volatile) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-volatile',
                        textContent: 'volatile',
                    }));
                }
                if (!isMirror && isAnonymousAclUpload(idx.acl_upload)) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-world-writable',
                        textContent: 'world-writable',
                        title: 'acl_upload contains :ANONYMOUS: — anyone, '
                            + 'including unauthenticated callers, can '
                            + 'publish packages to this index.',
                    }));
                } else if (!isMirror && isUploadFrozen(idx.acl_upload)) {
                    tagGroup.appendChild(el('span', {
                        className: 'tag tag-no-upload',
                        textContent: 'no upload',
                        title: 'acl_upload is empty — nobody can publish '
                            + 'to this index, not even the owner or root. '
                            + 'Add a principal to acl_upload to enable '
                            + 'uploads.',
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
                // for principals with acl_upload (stage indexes only),
                // edit/delete for owners.
                var loggedIn = Api.getUser();
                var menuItems = [];
                (function (path, aclRead) {
                    var needsToken = !isPublicAclRead(aclRead);
                    menuItems.push({
                        label: 'pip.conf' + (needsToken ? ' + token' : ''),
                        onclick: function () {
                            closeAllKebabs();
                            showPipConfModal(path, aclRead);
                        },
                    });
                })(idx._full, idx.acl_read);
                if (!isMirror && canIssueUploadToken(loggedIn, idx.acl_upload)) {
                    (function (path, aclUpload) {
                        var needsToken = !isAnonymousAclUpload(aclUpload);
                        menuItems.push({
                            label: '.pypirc' + (needsToken ? ' + token' : ''),
                            onclick: function () {
                                closeAllKebabs();
                                showUploadTokenModal(path, aclUpload);
                            },
                        });
                    })(idx._full, idx.acl_upload);
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
                var needsToken = !isPublicAclRead(aclRead);
                actions.push(el('button', {
                    className: 'btn',
                    textContent: 'pip.conf' + (needsToken ? ' + token' : ''),
                    onclick: function () {
                        showPipConfModal(indexPath, aclRead);
                    },
                }));
            })();
            if (!isMirror && canIssueUploadToken(
                    Api.getUser(),
                    (indexInfo && indexInfo.acl_upload) || [])) {
                (function () {
                    var aclUpload = (indexInfo && indexInfo.acl_upload) || [];
                    var needsToken = !isAnonymousAclUpload(aclUpload);
                    actions.push(el('button', {
                        className: 'btn',
                        textContent: '.pypirc' + (needsToken ? ' + token' : ''),
                        onclick: function () {
                            showUploadTokenModal(indexPath, aclUpload);
                        },
                    }));
                })();
            }
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
            infoRows.push(
                ['Role', status.role || '?'],
                ['Host', status.host + ':' + status.port],
                ['Serial', String(status.serial || 0)]
            );
            if (api.features && api.features.length) {
                infoRows.push(['Features', api.features.join(', ')]);
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
            if (status.role === 'MASTER' && replicaUuids.length > 0
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
        } else if (Api.getUser() && status.role === 'MASTER') {
            // Authenticated on master: detect lagging/stuck replicas via
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
