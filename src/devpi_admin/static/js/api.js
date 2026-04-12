var Api = (function () {
    'use strict';

    var _user = null;
    var _token = null;

    function authHeader() {
        if (_user && _token) {
            return btoa(_user + ':' + _token);
        }
        return null;
    }

    function request(method, url, data) {
        var opts = {
            method: method,
            headers: {'Accept': 'application/json'},
        };
        var auth = authHeader();
        if (auth) {
            opts.headers['X-Devpi-Auth'] = auth;
        }
        if (data !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(data);
        }
        return fetch(url, opts).then(function (res) {
            if (res.status === 204) return null;
            if (res.status === 401 && _user) {
                logout();
                if (typeof onSessionExpired === 'function') onSessionExpired();
                var err = new Error('Session expired. Please log in again.');
                err.status = 401;
                throw err;
            }
            return res.json().then(function (json) {
                if (!res.ok) {
                    var msg = json.message || json.error || 'Request failed';
                    var err = new Error(msg);
                    err.status = res.status;
                    throw err;
                }
                return json;
            });
        });
    }

    function login(user, password) {
        return request('POST', '/+login', {
            user: user,
            password: password,
        }).then(function (data) {
            _user = user;
            _token = data.result.password;
            sessionStorage.setItem('devpi-user', _user);
            sessionStorage.setItem('devpi-token', _token);
            return _user;
        });
    }

    function restore() {
        var u = sessionStorage.getItem('devpi-user');
        var t = sessionStorage.getItem('devpi-token');
        if (u && t) {
            _user = u;
            _token = t;
            return true;
        }
        return false;
    }

    function logout() {
        _user = null;
        _token = null;
        sessionStorage.removeItem('devpi-user');
        sessionStorage.removeItem('devpi-token');
    }

    function getUser() {
        return _user;
    }

    return {
        login: login,
        restore: restore,
        logout: logout,
        getUser: getUser,
        get: function (url) { return request('GET', url); },
        post: function (url, data) { return request('POST', url, data); },
        put: function (url, data) { return request('PUT', url, data); },
        patch: function (url, data) { return request('PATCH', url, data); },
        del: function (url) { return request('DELETE', url); },
    };
})();
