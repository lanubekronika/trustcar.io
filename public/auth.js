(function() {
    if (window.__trustcarAuthInit) return;
    window.__trustcarAuthInit = true;

    const AUTH_KEY = 'trustcar-auth';
    const USERNAME = 'admin';
    const PASSWORD = 'trustcarkronic';

    const ensureStyles = () => {
        if (document.getElementById('auth-overlay-style')) return;
        const style = document.createElement('style');
        style.id = 'auth-overlay-style';
        style.textContent = `
            .auth-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.6); display: none; align-items: center; justify-content: center; padding: 1.5rem; z-index: 9999; }
            .auth-card { background: #ffffff; padding: 2rem; border-radius: 12px; width: 100%; max-width: 420px; box-shadow: 0 12px 32px rgba(2,6,23,0.25); border: 1px solid #e2e8f0; font-family: 'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
            .auth-card h2 { margin: 0 0 0.5rem; color: #0b1724; font-size: 1.5rem; }
            .auth-card p { margin: 0 0 1.25rem; color: #475569; font-size: 0.95rem; }
            .auth-input { width: 100%; padding: 0.85rem 1rem; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 1rem; margin-bottom: 0.9rem; background: #f8fafc; }
            .auth-button { width: 100%; padding: 0.9rem 1rem; border-radius: 10px; border: none; background: linear-gradient(135deg, #0553F0 0%, #0441c7 100%); color: white; font-weight: 700; font-size: 1rem; cursor: pointer; box-shadow: 0 8px 20px rgba(5,83,240,0.25); }
            .auth-button:hover { box-shadow: 0 10px 28px rgba(5,83,240,0.35); transform: translateY(-1px); }
            .auth-note { margin-top: 1rem; color: #94a3b8; font-size: 0.85rem; text-align: center; }
            .auth-error { color: #dc2626; font-weight: 700; font-size: 0.9rem; margin-bottom: 0.75rem; display: none; }
            body.auth-locked { overflow: hidden; }
        `;
        document.head.appendChild(style);
    };

    const buildOverlay = () => {
        let overlay = document.getElementById('authOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'authOverlay';
        overlay.className = 'auth-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'authTitle');

        overlay.innerHTML = `
            <form id="authForm" class="auth-card">
                <h2 id="authTitle">Admin Access</h2>
                <p>Enter credentials to view this page. For demo use only.</p>
                <div id="authError" class="auth-error" role="alert">Invalid credentials. Access denied.</div>
                <label for="username" style="display:block;font-weight:700;color:#0b1724;margin-bottom:0.25rem;">Username</label>
                <input id="username" name="username" class="auth-input" type="text" autocomplete="username" required>
                <label for="password" style="display:block;font-weight:700;color:#0b1724;margin-bottom:0.25rem;">Password</label>
                <input id="password" name="password" class="auth-input" type="password" autocomplete="current-password" required>
                <button type="submit" class="auth-button">Unlock</button>
                <div class="auth-note">Credentials: admin / trustcarkronic</div>
            </form>
        `;

        document.body.appendChild(overlay);
        return overlay;
    };

    const enableApp = (overlay) => {
        overlay.style.display = 'none';
        document.body.classList.remove('auth-locked');
    };

    const lockApp = (overlay) => {
        overlay.style.display = 'flex';
        document.body.classList.add('auth-locked');
    };

    const init = () => {
        ensureStyles();
        const overlay = buildOverlay();
        const authForm = overlay.querySelector('#authForm');
        const authError = overlay.querySelector('#authError');

        if (localStorage.getItem(AUTH_KEY) === 'granted') {
            enableApp(overlay);
        } else {
            lockApp(overlay);
        }

        authForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const username = overlay.querySelector('#username').value.trim();
            const password = overlay.querySelector('#password').value;
            if (username === USERNAME && password === PASSWORD) {
                localStorage.setItem(AUTH_KEY, 'granted');
                authError.style.display = 'none';
                enableApp(overlay);
            } else {
                authError.style.display = 'block';
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
