(function () {
  const el = (id) => document.getElementById(id);
  const form = el('settings-form');

  function toast(message, type = 'info') {
    const stack = el('toast-stack');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(() => node.remove(), 4500);
  }

  async function checkSession() {
    const res = await adminFetch('/api/auth/session');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/admin/login.html';
      return;
    }
    el('whoami').textContent = `Signed in as ${data.username}`;
  }

  el('logout-btn').addEventListener('click', async () => {
    await adminFetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/admin/login.html';
  });

  function renderIntegrations(integrations) {
    const items = [
      { key: 'openai', label: 'OpenAI (AI qualification)' },
      { key: 'email', label: 'Email (SMTP)' },
      { key: 'calendly', label: 'Calendly webhook' },
    ];
    el('integrations-status').innerHTML = items
      .map((i) => {
        const ok = integrations[i.key];
        return `<span class="badge ${ok ? 'badge-status' : ''}" style="border:1px solid ${ok ? 'var(--success)' : 'var(--steel-line)'};color:${ok ? 'var(--success)' : 'var(--mute)'};">${i.label}: ${ok ? 'Configured' : 'Not configured'}</span>`;
      })
      .join('');
  }

  async function loadSettings() {
    const res = await adminFetch('/api/settings');
    const data = await res.json();
    renderIntegrations(data.integrations);
    for (const [key, value] of Object.entries(data.settings)) {
      const field = form.elements[key];
      if (!field) continue;
      field.value = key === 'services' ? (value || []).join('\n') : value || '';
    }
  }

  function renderGoogleStatus(status) {
    const textEl = el('google-status-text');
    const connectBtn = el('google-connect-btn');
    const disconnectBtn = el('google-disconnect-btn');

    if (!status.appCredentialsConfigured) {
      textEl.textContent = 'Not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the server environment first (see .env.example).';
      connectBtn.hidden = true;
      disconnectBtn.hidden = true;
    } else if (status.connected) {
      textEl.textContent = `Connected as ${status.accountEmail || 'unknown account'}.`;
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      textEl.textContent = 'Server is configured but not connected to a Google account yet.';
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
    }
  }

  async function loadGoogleStatus() {
    const res = await adminFetch('/api/google/status');
    if (!res.ok) return;
    renderGoogleStatus(await res.json());
  }

  el('google-connect-btn').addEventListener('click', () => {
    window.location.href = '/api/google/connect';
  });

  el('google-disconnect-btn').addEventListener('click', async () => {
    const res = await adminFetch('/api/google/disconnect', { method: 'POST' });
    if (!res.ok) return toast('Failed to disconnect.', 'error');
    toast('Google Calendar disconnected.', 'success');
    loadGoogleStatus();
  });

  function handleGoogleOAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('google')) return;
    if (params.get('google') === 'connected') {
      toast('Google Calendar connected.', 'success');
    } else {
      toast(`Google Calendar connection failed${params.get('reason') ? ': ' + params.get('reason') : ''}.`, 'error');
    }
    window.history.replaceState({}, '', '/admin/lead-settings');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {};
    for (const [key, value] of fd.entries()) {
      payload[key] = key === 'services' ? value.split('\n').map((s) => s.trim()).filter(Boolean) : value;
    }
    const res = await adminFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || 'Failed to save settings.', 'error');
      return;
    }
    renderIntegrations(data.integrations);
    el('save-status').textContent = `Saved at ${new Date().toLocaleTimeString()}`;
    toast('Settings saved.', 'success');
  });

  (async function init() {
    await checkSession();
    handleGoogleOAuthRedirect();
    await loadSettings();
    await loadGoogleStatus();
  })();
})();
