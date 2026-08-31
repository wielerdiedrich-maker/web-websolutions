(function () {
  let messages = [];
  let activeId = null;

  const el = (id) => document.getElementById(id);
  const container = el('messages-container');

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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  async function loadMessages() {
    const res = await adminFetch('/api/contact');
    const data = await res.json();
    messages = data.messages || [];
    const unread = messages.filter((m) => !m.read_at).length;
    el('unread-badge').textContent = unread ? String(unread) : '';
    render();
  }

  function render() {
    if (!messages.length) {
      container.innerHTML = '<div class="empty-state">No work orders submitted yet.</div>';
      return;
    }
    container.innerHTML = `
      <table class="media-table">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Email</th>
            <th>Business Type</th>
            <th>Submitted</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${messages
            .map(
              (m) => `
            <tr data-id="${m.id}" style="cursor:pointer;${m.read_at ? '' : 'font-weight:600;'}">
              <td>${m.read_at ? '' : '<span class="ticket-num">NEW</span>'}</td>
              <td>${escapeHtml(m.name)}</td>
              <td>${escapeHtml(m.email)}</td>
              <td>${escapeHtml(m.business_type)}</td>
              <td class="mute">${formatDate(m.created_at)}</td>
              <td class="actions-cell">
                <a href="mailto:${escapeHtml(m.email)}" class="btn-ghost" onclick="event.stopPropagation()">Reply</a>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    container.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.dataset.id));
    });
  }

  async function openDetail(id) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    activeId = id;
    el('detail-name').textContent = msg.name;
    el('detail-meta').innerHTML = `<span class="mute">${escapeHtml(msg.email)} · ${escapeHtml(msg.business_type)} · ${formatDate(msg.created_at)}</span>`;
    el('detail-body').textContent = msg.details;
    el('detail-modal').hidden = false;

    if (!msg.read_at) {
      await adminFetch(`/api/contact/${id}/read`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      });
      msg.read_at = new Date().toISOString();
      render();
    }
  }

  el('detail-close-btn').addEventListener('click', () => {
    el('detail-modal').hidden = true;
  });

  el('detail-delete-btn').addEventListener('click', async () => {
    if (!activeId) return;
    if (!confirm('Delete this message permanently?')) return;
    const res = await adminFetch(`/api/contact/${activeId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Failed to delete.', 'error');
      return;
    }
    el('detail-modal').hidden = true;
    toast('Message deleted.', 'success');
    loadMessages();
  });

  (async function init() {
    await checkSession();
    await loadMessages();
  })();
})();
