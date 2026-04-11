(function () {
    'use strict';

    var STORAGE_KEY = 'devpi-theme';
    var ICONS = {
        light: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
        dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        auto: '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20V2z" fill="currentColor"/>',
    };

    function getPreferred() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function apply(theme) {
        var resolved = theme === 'auto' ? getPreferred() : theme;
        document.documentElement.setAttribute('data-theme', resolved);
        var btn = document.getElementById('theme-toggle');
        if (btn) {
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                ICONS[theme] + '</svg>';
        }
    }

    function current() {
        return localStorage.getItem(STORAGE_KEY) || 'auto';
    }

    // Apply on load
    apply(current());

    // Toggle: light → dark → auto → light
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('#theme-toggle');
        if (!btn) return;
        var order = ['light', 'dark', 'auto'];
        var idx = order.indexOf(current());
        var next = order[(idx + 1) % order.length];
        localStorage.setItem(STORAGE_KEY, next);
        apply(next);
    });

    // React to OS theme change when in auto mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (current() === 'auto') apply('auto');
    });
})();
