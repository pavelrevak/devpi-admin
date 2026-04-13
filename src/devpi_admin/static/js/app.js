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

    function statusRow(label, value) {
        return el('div', {className: 'status-row'}, [
            el('span', {className: 'status-label', textContent: label}),
            el('span', {textContent: value}),
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

    function showModalError(msgOrErr) {
        var text = (typeof msgOrErr === 'string') ? msgOrErr
            : (msgOrErr && msgOrErr.message) || 'Operation failed';
        modalError.textContent = text;
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

    var _activeTimers = [];

    function registerTimer(id) {
        _activeTimers.push(id);
    }

    function clearActiveTimers() {
        for (var i = 0; i < _activeTimers.length; i++) {
            clearTimeout(_activeTimers[i]);
        }
        _activeTimers = [];
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

                // Kebab menu — only for root or the index owner
                var loggedIn = Api.getUser();
                if (loggedIn === 'root' || loggedIn === idx._user) {
                    cardHead.appendChild(buildKebabMenu([
                        {label: 'Edit', onclick: function () { closeAllKebabs(); showIndexModal(idx, result); }},
                        {label: 'Delete', danger: true, onclick: function () { closeAllKebabs(); deleteIndex(idx._full); }},
                    ]));
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

                body.appendChild(stageFields);
                body.appendChild(mirrorFields);

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

    function buildPackageCard(indexPath, pkg, fetchVersion) {
        var card = el('div', {className: 'pkg-card'});
        var cardHead = el('div', {className: 'pkg-card-head'});
        cardHead.appendChild(el('a', {
            href: '#package/' + indexPath + '/' + pkg,
            className: 'pkg-card-name',
            textContent: pkg,
        }));

        cardHead.appendChild(buildKebabMenu([
            {label: 'Delete all versions', danger: true, onclick: function () { closeAllKebabs(); deletePackage(indexPath, pkg); }},
        ]));
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
                renderPackages(indexPath, data.result, false);
            }).catch(handleApiError);
        }

        function fetchMirror() {
            showHeadingAndLoading(true);
            Api.get('/+admin-api/cached/' + indexPath).then(function (data) {
                var cached = data.result || [];
                var total = data.total || 0;
                var fakeResult = {projects: cached, type: 'mirror', _total: total};
                renderPackages(indexPath, fakeResult, true);
            }).catch(function () {
                // Plugin API not available — show only the download button
                var loading = content.querySelector('.loading');
                if (loading) loading.remove();
                content.appendChild(el('p', {
                    className: 'text-muted',
                    textContent: 'Cached packages API not available. Use the "Download full index" button to browse.',
                }));
            });
        }

        function showHeadingAndLoading(isMirror) {
            clear(content);
            var heading = buildBreadcrumb(indexPath);
            var actions = [];
            if (isMirror) {
                actions.push(el('button', {
                    className: 'btn',
                    textContent: 'Download full index',
                    onclick: function () {
                        showHeadingAndLoading(true);
                        Api.get('/' + indexPath).then(function (data) {
                            renderPackages(indexPath, data.result, true);
                        }).catch(handleApiError);
                    },
                }));
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
        var totalUpstream = result._total || 0;
        var loading = content.querySelector('.loading');
        if (loading) loading.remove();

        // Mirror cached summary
        if (isMirror && totalUpstream) {
            content.appendChild(el('div', {className: 'mirror-info'}, [
                el('span', {textContent: projects.length + ' cached'}),
                ' of ',
                el('span', {textContent: formatNum(totalUpstream) + ' upstream packages'}),
            ]));
        }

        if (projects.length === 0) {
            content.appendChild(el('p', {
                className: 'text-muted',
                textContent: isMirror
                    ? 'No cached packages yet. Packages are cached on first access via pip.'
                    : 'No packages in this index.',
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
            registerTimer(debounceTimer);
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
            var cachedVersions = (verData.cached || []).sort(compareVersions);
            var allVersions = verData.all ? verData.all.sort(compareVersions) : null;
            var versions = cachedVersions;
            var currentVer = selectedVersion && versions.indexOf(selectedVersion) !== -1
                ? selectedVersion : versions[0];
            if (!currentVer && allVersions) {
                currentVer = selectedVersion && allVersions.indexOf(selectedVersion) !== -1
                    ? selectedVersion : allVersions[0];
            }
            if (!currentVer) {
                clear(content);
                showError(new Error('No versions found'));
                return;
            }
            var detailUrl = '/+admin-api/versiondata/' + indexPath + '/' + pkg + '/' + currentVer;
            return Api.get(detailUrl).then(function (detail) {
                return {cachedVersions: cachedVersions, allVersions: allVersions,
                    currentVer: currentVer, info: detail.result || {}};
            }).catch(function () {
                return {cachedVersions: cachedVersions, allVersions: allVersions,
                    currentVer: currentVer, info: {version: currentVer, name: pkg}};
            });
        }).then(function (ctx) {
            if (!ctx) return;
            var cachedVersions = ctx.cachedVersions;
            var allVersions = ctx.allVersions;
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
                el('div', {className: 'view-header-actions'}, [
                    el('button', {
                        className: 'btn btn-danger auth-only',
                        textContent: 'Delete package',
                        onclick: function () { deletePackage(indexPath, pkg); },
                    }),
                ]),
            ]));

            if (cachedVersions.length === 0 && !allVersions) {
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
            var cachedSet = {};
            for (var ci = 0; ci < cachedVersions.length; ci++) {
                cachedSet[cachedVersions[ci]] = true;
            }
            var hasMirrorAll = allVersions !== null && allVersions.length > cachedVersions.length;

            var versHead = el('div', {className: 'pkg-sidebar-versions-head'}, [
                el('span', {className: 'pkg-sidebar-title', textContent: 'Versions'}),
                el('span', {className: 'pkg-sidebar-count',
                    textContent: String(cachedVersions.length) +
                        (hasMirrorAll ? ' / ' + allVersions.length : '')}),
            ]);
            versCard.appendChild(versHead);

            var versList = el('div', {className: 'pkg-version-list'});

            function buildVersionRow(ver, isCached) {
                var isCurrent = ver === currentVer;
                var cls = 'pkg-version-row';
                if (isCurrent) cls += ' pkg-version-active';
                if (!isCached) cls += ' pkg-version-uncached';
                var row = el('div', {className: cls});
                if (isCached) {
                    row.appendChild(el('a', {
                        href: '#package/' + indexPath + '/' + pkg + '?version=' + encodeURIComponent(ver),
                        className: 'pkg-version-link',
                        textContent: 'v' + ver,
                    }));
                    row.appendChild(el('button', {
                        className: 'pkg-version-del auth-only',
                        textContent: '\u00d7',
                        title: 'Delete version',
                        onclick: function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            deleteVersion(indexPath, pkg, ver);
                        },
                    }));
                } else {
                    row.appendChild(el('a', {
                        href: 'https://pypi.org/project/' + pkg + '/' + ver + '/',
                        className: 'pkg-version-link',
                        textContent: 'v' + ver,
                        target: '_blank',
                        rel: 'noopener',
                        title: 'View on PyPI (not cached)',
                    }));
                    row.appendChild(el('span', {
                        className: 'pkg-version-ext',
                        textContent: '\u2197',
                    }));
                }
                return row;
            }

            // Show cached versions
            for (var v = 0; v < cachedVersions.length; v++) {
                versList.appendChild(buildVersionRow(cachedVersions[v], true));
            }

            // "Show all versions" button for mirrors
            if (hasMirrorAll) {
                var allList = el('div', {className: 'pkg-version-hidden', hidden: true});
                var uncachedVersions = [];
                for (var a = 0; a < allVersions.length; a++) {
                    if (!cachedSet[allVersions[a]]) {
                        uncachedVersions.push(allVersions[a]);
                    }
                }
                for (var u = 0; u < uncachedVersions.length; u++) {
                    allList.appendChild(buildVersionRow(uncachedVersions[u], false));
                }
                versList.appendChild(allList);

                var showAllBtn = el('button', {
                    className: 'pkg-version-more',
                    textContent: 'Show all ' + allVersions.length + ' versions',
                    onclick: function () {
                        allList.hidden = false;
                        showAllBtn.hidden = true;
                    },
                });
                versList.appendChild(showAllBtn);
            } else if (!allVersions) {
                // Mirror: all versions not yet loaded
                var loadAllBtn = el('button', {
                    className: 'pkg-version-more',
                    textContent: 'Load all versions...',
                    onclick: function () {
                        loadAllBtn.textContent = 'Loading...';
                        loadAllBtn.disabled = true;
                        Api.get('/+admin-api/versions/' + indexPath + '/' + pkg + '?all=1')
                            .then(function (data) {
                                var all = (data.all || []).sort(compareVersions);
                                loadAllBtn.hidden = true;
                                var uncached = [];
                                for (var i = 0; i < all.length; i++) {
                                    if (!cachedSet[all[i]]) uncached.push(all[i]);
                                }
                                for (var j = 0; j < uncached.length; j++) {
                                    versList.insertBefore(
                                        buildVersionRow(uncached[j], false),
                                        loadAllBtn);
                                }
                                // Update count
                                var countEl = versHead.querySelector('.pkg-sidebar-count');
                                if (countEl) {
                                    countEl.textContent = cachedVersions.length + ' / ' + all.length;
                                }
                            })
                            .catch(function () {
                                loadAllBtn.textContent = 'Failed to load';
                            });
                    },
                });
                versList.appendChild(loadAllBtn);
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
                } else if ((name === 'href' || name === 'src' || name === 'action') &&
                        /^\s*javascript\s*:/i.test(attrs[k].value)) {
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
            fetch(url).then(function (res) {
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

            content.appendChild(grid);
        }).catch(handleApiError);
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
