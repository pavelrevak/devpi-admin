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

    // --- Modal ---

    function openModal(title, bodyFn, buttons) {
        modalTitle.textContent = title;
        clear(modalBody);
        clear(modalFooter);
        modalError.hidden = true;
        bodyFn(modalBody);
        for (var i = 0; i < buttons.length; i++) {
            modalFooter.appendChild(buttons[i]);
        }
        modalOverlay.hidden = false;
    }

    function closeModal() {
        modalOverlay.hidden = true;
    }

    function showModalError(msg) {
        modalError.textContent = msg;
        modalError.hidden = false;
    }

    modalCloseBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', function (e) {
        if (e.target === modalOverlay) closeModal();
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

    function downloadPipConf(indexPath) {
        var content = '[global]\n' +
            'index-url = ' + location.origin + '/' + indexPath + '/+simple/\n' +
            'trusted-host = ' + location.hostname + '\n';
        var blob = new Blob([content], {type: 'text/plain'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'pip.conf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // Global toggle state — persisted
    var _hasConfig = localStorage.getItem('devpi-has-config') !== 'false';

    // Build pip block for package contexts (no toggle, uses header toggle)
    function buildPipBlock(indexPath, pkg) {
        var wrapper = el('div', {className: 'pip-block'});
        var urlSlot = el('div', {className: 'pip-url-slot'});
        wrapper.appendChild(urlSlot);
        function render() {
            clear(urlSlot);
            urlSlot.appendChild(buildPipUrl(indexPath, pkg, _hasConfig));
        }
        wrapper._renderPip = render;
        render();
        return wrapper;
    }

    // Index card pip block: download link (with config) or full command (without)
    function buildIndexPipBlock(indexPath) {
        var wrapper = el('div', {className: 'pip-block'});
        function render() {
            clear(wrapper);
            if (_hasConfig) {
                wrapper.appendChild(el('button', {
                    className: 'pip-conf-link',
                    textContent: 'Download pip.conf',
                    onclick: function () { downloadPipConf(indexPath); },
                }));
            } else {
                wrapper.appendChild(buildPipUrl(indexPath, null, false));
            }
        }
        wrapper._renderPip = render;
        render();
        return wrapper;
    }

    // Header toggle — rendered once, shown/hidden per route
    var _headerToggle = document.getElementById('pip-toggle-header');

    function renderHeaderPipToggle() {
        clear(_headerToggle);
        var btn = el('button', {
            className: 'pip-toggle-btn' + (_hasConfig ? ' pip-toggle-on' : ''),
            textContent: 'pip.conf',
            title: _hasConfig ? 'pip.conf enabled — click to disable' : 'pip.conf disabled — click to enable',
        });
        btn.addEventListener('click', function () {
            _hasConfig = !_hasConfig;
            localStorage.setItem('devpi-has-config', _hasConfig ? 'true' : 'false');
            updateAllPipBlocks();
            renderHeaderPipToggle();
        });
        _headerToggle.appendChild(btn);
    }
    renderHeaderPipToggle();

    function updateAllPipBlocks() {
        var blocks = document.querySelectorAll('.pip-block');
        for (var i = 0; i < blocks.length; i++) {
            if (blocks[i]._renderPip) blocks[i]._renderPip();
        }
    }

    function buildPipUrl(indexPath, pkg, withConfig) {
        var args = '--index-url ' + location.origin + '/' + indexPath + '/+simple/' +
            ' --trusted-host ' + location.hostname;
        var cmd;
        var div = el('div', {className: 'pip-url'});
        div.appendChild(el('span', {className: 'pip-cmd', textContent: 'pip install'}));
        if (withConfig) {
            cmd = 'pip install' + (pkg ? ' ' + pkg : '');
            if (pkg) {
                div.appendChild(document.createTextNode(' '));
                div.appendChild(el('span', {className: 'pip-pkg', textContent: pkg}));
            } else {
                div.appendChild(document.createTextNode(' <package>'));
            }
        } else {
            cmd = 'pip install ' + args + (pkg ? ' ' + pkg : '');
            div.appendChild(document.createTextNode(' ' + args));
            if (pkg) {
                div.appendChild(document.createTextNode(' '));
                div.appendChild(el('span', {className: 'pip-pkg', textContent: pkg}));
            }
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

    function showLoading() {
        clear(content);
        content.appendChild(el('p', {className: 'loading', textContent: 'Loading...'}));
    }

    function showError(err) {
        clear(content);
        var msg = (err && err.message) ? err.message : String(err);
        content.appendChild(el('p', {className: 'error', textContent: msg}));
    }

    function handleApiError(err) {
        if (err && err.status === 401) {
            Api.logout();
            updateAuthUI();
            showError(new Error('Session expired. Please log in again.'));
        } else {
            showError(err);
        }
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
            logoutBtn.appendChild(el('span', {className: 'user-btn-name', textContent: user}));
            logoutBtn.appendChild(el('span', {className: 'user-btn-action', textContent: 'Logout'}));
            loginBtn.hidden = true;
            logoutBtn.hidden = false;
            navUsers.hidden = false;
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
                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Username'}),
                    el('input', {type: 'text', id: 'login-user'}),
                ]));
                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Password'}),
                    el('input', {type: 'password', id: 'login-pass'}),
                ]));
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
            })
            .catch(function (err) {
                showModalError(err.message || 'Login failed');
            });
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

    logoutBtn.addEventListener('click', function () {
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
            if (!Api.getUser()) {
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
            var header = el('div', {className: 'view-header'}, [
                el('h2', {textContent: 'Users'}),
                el('button', {
                    className: 'btn btn-primary',
                    textContent: '+ New User',
                    onclick: function () { showUserModal(null, null); },
                }),
            ]);
            content.appendChild(header);

            var userNames = getAllUserNames(result);
            var table = el('table', {className: 'data-table'});
            var thead = el('thead');
            thead.appendChild(el('tr', null, [
                el('th', {textContent: 'User'}),
                el('th', {textContent: 'Email'}),
                el('th', {textContent: 'Indexes'}),
                el('th', {textContent: 'Actions'}),
            ]));
            table.appendChild(thead);
            var tbody = el('tbody');
            for (var i = 0; i < userNames.length; i++) {
                (function (name) {
                    var info = result[name];
                    var indexes = info.indexes || {};
                    var indexNames = Object.keys(indexes);
                    var indexCell = el('td');
                    var indexList = el('div', {className: 'index-list'});
                    for (var j = 0; j < indexNames.length; j++) {
                        var idx = indexes[indexNames[j]];
                        var tagClass = 'tag';
                        if (idx.type === 'mirror') tagClass += ' tag-mirror';
                        if (idx.volatile) tagClass += ' tag-volatile';
                        indexList.appendChild(
                            el('span', {
                                className: tagClass,
                                textContent: indexNames[j],
                                title: idx.type +
                                    (idx.volatile ? ', volatile' : '') +
                                    (idx.bases ? ', bases: ' + idx.bases.join(', ') : ''),
                            })
                        );
                    }
                    indexCell.appendChild(indexList);
                    var actions = el('td', {className: 'actions'}, [
                        el('button', {
                            className: 'btn btn-small',
                            textContent: 'Edit',
                            onclick: function () { showUserModal(name, info); },
                        }),
                        el('button', {
                            className: 'btn btn-small btn-danger',
                            textContent: 'Delete',
                            onclick: function () { deleteUser(name); },
                        }),
                    ]);
                    var tr = el('tr', null, [
                        el('td', {textContent: name}),
                        el('td', {textContent: info.email || ''}),
                        indexCell,
                        actions,
                    ]);
                    tbody.appendChild(tr);
                })(userNames[i]);
            }
            table.appendChild(tbody);
            content.appendChild(table);
        }).catch(handleApiError);
    }

    function showUserModal(editName, editInfo) {
        var isEdit = !!editName;
        openModal(
            isEdit ? 'Edit User: ' + editName : 'New User',
            function (body) {
                if (!isEdit) {
                    body.appendChild(el('div', {className: 'form-group'}, [
                        el('label', {textContent: 'Username'}),
                        el('input', {type: 'text', id: 'form-username'}),
                    ]));
                }
                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Email'}),
                    el('input', {
                        type: 'email',
                        id: 'form-email',
                        value: (editInfo && editInfo.email) || '',
                    }),
                ]));
                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: isEdit ? 'New Password (leave empty to keep)' : 'Password'}),
                    el('input', {type: 'password', id: 'form-password'}),
                ]));
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
        var password = document.getElementById('form-password').value;

        if (email) data.email = email;
        if (password) data.password = password;
        if (!isEdit && !password) data.password = '';

        var url = '/' + (isEdit ? editName : username);
        var method = isEdit ? Api.patch : Api.put;
        method(url, data)
            .then(function () {
                closeModal();
                loadUsers();
            })
            .catch(function (err) {
                showModalError(err.message || 'Operation failed');
            });
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
            _indexResult = result;
            clear(content);

            content.appendChild(el('div', {id: 'indexes-header'}));
            content.appendChild(el('div', {id: 'indexes-content'}));
            renderIndexCards(result);
        }).catch(handleApiError);
    }

    var _indexResult = null;

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
        headerContainer.appendChild(el('div', {className: 'view-header'}, [
            heading,
            el('button', {
                className: 'btn btn-primary auth-only',
                textContent: '+ New Index',
                onclick: function () {
                    showIndexModal(null, result, _filterUser);
                },
            }),
        ]));

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
                card.appendChild(details);

                card.appendChild(buildIndexPipBlock(idx._full));

                // Kebab menu (top-right)
                var menu = el('div', {className: 'kebab-menu auth-only'});
                var menuBtn = el('button', {
                    className: 'kebab-btn',
                    textContent: '\u22ee',
                    onclick: function (e) {
                        e.stopPropagation();
                        var dropdown = menu.querySelector('.kebab-dropdown');
                        var wasOpen = !dropdown.hidden;
                        closeAllKebabs();
                        dropdown.hidden = wasOpen;
                    },
                });
                var dropdown = el('div', {className: 'kebab-dropdown', hidden: true}, [
                    el('button', {
                        className: 'kebab-item',
                        textContent: 'Edit',
                        onclick: function () { closeAllKebabs(); showIndexModal(idx, result); },
                    }),
                    el('button', {
                        className: 'kebab-item kebab-item-danger',
                        textContent: 'Delete',
                        onclick: function () { closeAllKebabs(); deleteIndex(idx._full); },
                    }),
                ]);
                menu.appendChild(menuBtn);
                menu.appendChild(dropdown);
                cardHead.appendChild(menu);

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
                    var ownerSelect = el('select', {id: 'form-owner'});
                    for (var u = 0; u < userNames.length; u++) {
                        ownerSelect.appendChild(el('option', {
                            value: userNames[u],
                            textContent: userNames[u],
                        }));
                    }
                    ownerSelect.value = preOwner || Api.getUser();
                    body.appendChild(el('div', {className: 'form-group'}, [
                        el('label', {textContent: 'Owner'}),
                        ownerSelect,
                    ]));
                    body.appendChild(el('div', {className: 'form-group'}, [
                        el('label', {textContent: 'Index Name'}),
                        el('input', {type: 'text', id: 'form-index-name'}),
                    ]));
                }

                var typeSelect = el('select', {id: 'form-type'});
                typeSelect.appendChild(el('option', {value: 'stage', textContent: 'stage'}));
                typeSelect.appendChild(el('option', {value: 'mirror', textContent: 'mirror'}));
                if (isEdit) typeSelect.value = editIdx.type || 'stage';

                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Type'}),
                    typeSelect,
                ]));

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

                var aclInitial = isEdit ? (editIdx.acl_upload || []) : [Api.getUser()];
                stageFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'ACL Upload'}),
                    buildTagPicker('form-acl-upload', aclInitial, userNames, [':ANONYMOUS:']),
                ]));

                mirrorFields.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Mirror URL'}),
                    el('input', {
                        type: 'url',
                        id: 'form-mirror-url',
                        value: isEdit && editIdx.mirror_url ? editIdx.mirror_url : 'https://pypi.org/simple/',
                    }),
                ]));

                body.appendChild(stageFields);
                body.appendChild(mirrorFields);

                body.appendChild(el('div', {className: 'form-group'}, [
                    el('label', {textContent: 'Title (optional)'}),
                    el('input', {
                        type: 'text',
                        id: 'form-title',
                        value: isEdit && editIdx.title ? editIdx.title : '',
                    }),
                ]));

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
        }

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
            .catch(function (err) {
                showModalError(err.message || 'Operation failed');
            });
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

    function buildPackageCard(indexPath, pkg, fetchVersion) {
        var card = el('div', {className: 'pkg-card'});
        var cardHead = el('div', {className: 'pkg-card-head'});
        cardHead.appendChild(el('a', {
            href: '#package/' + indexPath + '/' + pkg,
            className: 'pkg-card-name',
            textContent: pkg,
        }));

        var menu = el('div', {className: 'kebab-menu auth-only'});
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
        menu.appendChild(el('div', {className: 'kebab-dropdown', hidden: true}, [
            el('button', {
                className: 'kebab-item kebab-item-danger',
                textContent: 'Delete all versions',
                onclick: function () { closeAllKebabs(); deletePackage(indexPath, pkg); },
            }),
        ]));
        cardHead.appendChild(menu);
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
        content.appendChild(el('h2', {className: 'page-heading'}, [
            el('a', {href: '#indexes', textContent: 'Indexes'}),
            ' / ',
            el('a', {href: '#indexes/' + idxUser, textContent: idxUser}),
            ' / ',
            el('a', {href: '#packages/' + indexPath, textContent: idxName}),
        ]));

        // Check index type first via cached root listing — if unknown, use GET to learn type
        // We need to know if it's mirror BEFORE fetching /<user>/<index> because
        // mirror indexes return 17MB+ JSON. Use the indexes listing instead.
        Api.get('/' + idxUser).then(function (userData) {
            var indexInfo = (userData.result.indexes || {})[idxName];
            if (indexInfo && indexInfo.type === 'mirror') {
                // Show download prompt
                var warn = el('div', {className: 'mirror-warning'});
                warn.appendChild(el('div', {className: 'mirror-warning-title', textContent: 'Large mirror index'}));
                warn.appendChild(el('p', {
                    textContent: 'This is a mirror index that may contain hundreds of thousands of packages. Downloading the full index can take several seconds and use ~17 MB of data.',
                }));
                warn.appendChild(el('button', {
                    className: 'btn btn-primary',
                    textContent: 'Download index',
                    onclick: function () { fetchAndRender(true); },
                }));
                content.appendChild(warn);
            } else {
                fetchAndRender(false);
            }
        }).catch(function () {
            // Fall back to direct fetch if we can't determine type
            fetchAndRender(false);
        });

        function fetchAndRender(isMirror) {
            // Replace with loading
            clear(content);
            content.appendChild(el('h2', {className: 'page-heading'}, [
                el('a', {href: '#indexes', textContent: 'Indexes'}),
                ' / ',
                el('a', {href: '#indexes/' + idxUser, textContent: idxUser}),
                ' / ',
                el('a', {href: '#packages/' + indexPath, textContent: idxName}),
            ]));
            content.appendChild(el('p', {className: 'loading', textContent: 'Loading...'}));

            Api.get('/' + indexPath).then(function (data) {
                renderPackages(indexPath, data.result, isMirror);
            }).catch(handleApiError);
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
            placeholder: isMirror
                ? 'Search ' + formatNum(projects.length) + ' packages...'
                : 'Filter packages...',
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
            if (q) {
                matches = [];
                var qNorm = q.replace(/[-_.]/g, '');
                for (var j = 0; j < projects.length; j++) {
                    var name = projects[j].toLowerCase();
                    if (name.indexOf(q) !== -1 ||
                        name.replace(/[-_.]/g, '').indexOf(qNorm) !== -1) {
                        matches.push(projects[j]);
                        if (matches.length >= PKG_LIMIT) break;
                    }
                }
            } else {
                matches = projects.slice(0, PKG_LIMIT);
            }

            if (matches.length === 0) {
                infoEl.textContent = q ? 'No matching packages.' : '';
            } else if (q) {
                infoEl.textContent = matches.length >= PKG_LIMIT
                    ? 'Showing first ' + PKG_LIMIT + ' matches. Refine search for more.'
                    : 'Found ' + matches.length + ' match' + (matches.length === 1 ? '' : 'es') + '.';
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
            debounceTimer = setTimeout(render, 150);
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
        Api.get('/' + indexPath + '/' + pkg).then(function (data) {
            clear(content);
            var result = data.result;
            var versions = Object.keys(result).sort(compareVersions);
            var currentVer = selectedVersion && result[selectedVersion] ? selectedVersion : versions[0];
            var info = result[currentVer] || {};

            // Breadcrumb
            var parts = indexPath.split('/');
            var idxUser = parts[0], idxName = parts[1];
            content.appendChild(el('h2', {className: 'page-heading'}, [
                el('a', {href: '#indexes', textContent: 'Indexes'}),
                ' / ',
                el('a', {href: '#indexes/' + idxUser, textContent: idxUser}),
                ' / ',
                el('a', {href: '#packages/' + indexPath, textContent: idxName}),
                ' / ',
                el('a', {href: '#package/' + indexPath + '/' + pkg, textContent: pkg}),
                ' ',
                el('span', {className: 'page-heading-version', textContent: 'v' + currentVer}),
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
                infoRows.push(['Platform', info.platform.join(', ')]);
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
                    li.appendChild(el('a', {
                        href: urlEntries[ue][1],
                        textContent: urlEntries[ue][0],
                        target: '_blank',
                        rel: 'noopener',
                        className: 'pkg-sidebar-link',
                    }));
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
            var versHead = el('div', {className: 'pkg-sidebar-versions-head'}, [
                el('span', {className: 'pkg-sidebar-title', textContent: 'Versions'}),
                el('span', {className: 'pkg-sidebar-count', textContent: String(versions.length)}),
            ]);
            versCard.appendChild(versHead);

            var versList = el('div', {className: 'pkg-version-list'});
            for (var v = 0; v < versions.length; v++) {
                (function (ver) {
                    var isCurrent = ver === currentVer;
                    var row = el('div', {className: 'pkg-version-row' + (isCurrent ? ' pkg-version-active' : '')});
                    var link = el('a', {
                        href: '#package/' + indexPath + '/' + pkg + '?version=' + encodeURIComponent(ver),
                        className: 'pkg-version-link',
                        textContent: 'v' + ver,
                    });
                    row.appendChild(link);

                    // Delete button
                    var delBtn = el('button', {
                        className: 'pkg-version-del auth-only',
                        textContent: '\u00d7',
                        title: 'Delete version',
                        onclick: function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            deleteVersion(indexPath, pkg, ver);
                        },
                    });
                    row.appendChild(delBtn);
                    versList.appendChild(row);
                })(versions[v]);
            }
            versCard.appendChild(versList);
            sidebar.appendChild(versCard);

            layout.appendChild(sidebar);

            // === Main content: README ===
            var main = el('main', {className: 'pkg-main'});

            if (info.description) {
                var body = el('div', {className: 'markdown-body'});
                var isMarkdown = (info.description_content_type || '').indexOf('markdown') !== -1;
                if (isMarkdown && window.marked) {
                    body.innerHTML = marked.parse(info.description);
                } else {
                    var pre = document.createElement('pre');
                    pre.textContent = info.description;
                    body.appendChild(pre);
                }
                main.appendChild(body);
            } else {
                main.appendChild(el('p', {
                    className: 'text-muted',
                    textContent: 'No description / README available for this version.',
                }));
            }

            layout.appendChild(main);
            content.appendChild(layout);
        }).catch(handleApiError);
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

    function compareVersions(a, b) {
        // Simple reverse sort — newest first
        var pa = a.split(/[.\-+]/);
        var pb = b.split(/[.\-+]/);
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var na = parseInt(pa[i]) || 0;
            var nb = parseInt(pb[i]) || 0;
            if (na !== nb) return nb - na;
        }
        return 0;
    }

    // ========== STATUS ==========

    function loadStatus() {
        showLoading();
        Promise.all([
            Api.get('/+api'),
            Api.get('/+status'),
        ]).then(function (results) {
            var api = results[0].result;
            var status = results[1].result;
            clear(content);

            content.appendChild(el('h2', {className: 'page-heading'}, ['Status']));

            var grid = el('div', {className: 'status-grid'});

            // Server info card
            var infoCard = el('div', {className: 'status-card'});
            infoCard.appendChild(el('div', {className: 'status-card-title', textContent: 'Server'}));
            var ver = status.versioninfo || {};
            var infoRows = [
                ['devpi-server', ver['devpi-server'] || '?'],
                ['devpi-web', ver['devpi-web'] || '?'],
                ['Role', status.role || '?'],
                ['Host', status.host + ':' + status.port],
                ['Serial', String(status.serial || 0)],
            ];
            if (api.features && api.features.length) {
                infoRows.push(['Features', api.features.join(', ')]);
            }
            for (var i = 0; i < infoRows.length; i++) {
                infoCard.appendChild(el('div', {className: 'status-row'}, [
                    el('span', {className: 'status-label', textContent: infoRows[i][0]}),
                    el('span', {textContent: infoRows[i][1]}),
                ]));
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
                cacheCard.appendChild(el('div', {className: 'status-row'}, [
                    el('span', {className: 'status-label', textContent: 'Hit rate'}),
                    el('span', {className: 'hit-rate-value', textContent: hitRate}),
                ]));
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
                    cacheCard.appendChild(el('div', {className: 'status-row'}, [
                        el('span', {className: 'status-label', textContent: cacheRows[r][0]}),
                        el('span', {textContent: cacheRows[r][1]}),
                    ]));
                }
                grid.appendChild(cacheCard);
            }

            // Whoosh index
            var whooshQueue = metricMap['devpi_web_whoosh_index_queue_size'];
            var whooshErrors = metricMap['devpi_web_whoosh_index_error_queue_size'];
            if (whooshQueue !== undefined) {
                var whooshCard = el('div', {className: 'status-card'});
                whooshCard.appendChild(el('div', {className: 'status-card-title', textContent: 'Search Index'}));
                whooshCard.appendChild(el('div', {className: 'status-row'}, [
                    el('span', {className: 'status-label', textContent: 'Queue'}),
                    el('span', {textContent: String(whooshQueue)}),
                ]));
                whooshCard.appendChild(el('div', {className: 'status-row'}, [
                    el('span', {className: 'status-label', textContent: 'Errors'}),
                    el('span', {textContent: String(whooshErrors || 0)}),
                ]));
                grid.appendChild(whooshCard);
            }

            content.appendChild(grid);
        }).catch(handleApiError);
    }

    function formatNum(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
    }

    // --- Init ---

    Api.restore();
    updateAuthUI();
    updateNav();
    navigate();
})();
