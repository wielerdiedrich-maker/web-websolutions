(function () {
  let leads = [];
  let activeId = null;

  const el = (id) => document.getElementById(id);
  const container = el('leads-container');

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

  function aiBadge(aiStatus) {
    if (!aiStatus) return '<span class="mute">—</span>';
    const cls = `badge badge-${aiStatus.toLowerCase()}`;
    const label = aiStatus === 'NEEDS_INFO' ? 'Needs Info' : aiStatus.charAt(0) + aiStatus.slice(1).toLowerCase();
    return `<span class="${cls}">${label}</span>`;
  }

  async function loadLeads() {
    const params = new URLSearchParams();
    const q = el('search-input').value.trim();
    const status = el('filter-status').value;
    const aiStatus = el('filter-ai-status').value;
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (aiStatus) params.set('aiStatus', aiStatus);

    const res = await adminFetch(`/api/leads?${params.toString()}`);
    const data = await res.json();
    leads = data.leads || [];
    renderStats(data.stats || {});
    render();

    // Deep-link support: /admin/leads?id=... (used by owner-notification emails)
    const urlId = new URLSearchParams(window.location.search).get('id');
    if (urlId && leads.some((l) => l.id === urlId)) openDetail(urlId);
  }

  function renderStats(stats) {
    const tiles = [
      { label: 'New', value: stats.new ?? 0 },
      { label: 'Hot Leads', value: stats.hot ?? 0, cls: 'danger' },
      { label: 'Needs Follow-Up', value: stats.needsFollowUp ?? 0, cls: 'accent' },
      { label: 'Appointments', value: stats.appointmentsBooked ?? 0 },
      { label: 'Won', value: stats.won ?? 0, cls: 'success' },
      { label: 'Lost', value: stats.lost ?? 0 },
      { label: 'Conversion', value: stats.conversionRate == null ? '—' : `${stats.conversionRate}%` },
    ];
    el('stats-row').innerHTML = tiles
      .map(
        (t) => `<div class="stat-tile ${t.cls || ''}"><div class="stat-value">${t.value}</div><div class="stat-label">${t.label}</div></div>`
      )
      .join('');
  }

  function render() {
    if (!leads.length) {
      container.innerHTML = '<div class="empty-state">No leads yet. Submissions from the lead form will show up here.</div>';
      return;
    }
    container.innerHTML = `
      <table class="media-table">
        <thead>
          <tr>
            <th>Received</th><th>Name</th><th>Service</th><th>AI</th><th>Status</th><th>Files</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${leads
            .map(
              (l) => `
            <tr data-id="${l.id}" style="cursor:pointer;">
              <td class="mute">${formatDate(l.createdAt)}</td>
              <td>${escapeHtml(l.name)}<div class="mute" style="font-size:11px;">${escapeHtml(l.email)}</div></td>
              <td>${escapeHtml(l.service)}</td>
              <td>${aiBadge(l.aiStatus)}</td>
              <td><span class="badge badge-status">${escapeHtml(l.status)}</span></td>
              <td class="mute">${l.fileCount || 0}</td>
              <td class="actions-cell">
                <a href="mailto:${escapeHtml(l.email)}" class="btn-ghost" onclick="event.stopPropagation()">Email</a>
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
    const res = await adminFetch(`/api/leads/${id}`);
    if (!res.ok) return toast('Failed to load lead.', 'error');
    const lead = await res.json();
    activeId = id;

    el('detail-name').textContent = lead.name;
    el('detail-meta').textContent = `${lead.email} · ${lead.phone || 'no phone'} · ${formatDate(lead.createdAt)}`;
    el('detail-ai-badge').innerHTML = aiBadge(lead.aiStatus);
    el('detail-description').textContent = lead.description;
    el('detail-fields').innerHTML = [
      lead.company ? `Company: ${escapeHtml(lead.company)}` : '',
      `Budget: ${escapeHtml(lead.budget || '—')}`,
      `Timeframe: ${escapeHtml(lead.timeframe || '—')}`,
      `Preferred contact: ${escapeHtml(lead.preferredContact || '—')}`,
      `Preferred appointment time: ${escapeHtml(lead.preferredAppointmentTime || '—')}`,
    ]
      .filter(Boolean)
      .join('<br>');

    const filesWrap = el('detail-files-wrap');
    if (lead.files && lead.files.length) {
      filesWrap.hidden = false;
      el('detail-files').innerHTML = lead.files
        .map(
          (f) =>
            `<a href="${f.url}" target="_blank" rel="noopener" title="${escapeHtml(f.name)}">${
              f.kind === 'image' ? `<img src="${f.thumbUrl}">` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:10px;">FILE</div>'
            }</a>`
        )
        .join('');
    } else {
      filesWrap.hidden = true;
    }

    el('detail-ai-summary').textContent = lead.aiSummary || '(no summary)';
    el('detail-ai-action').textContent = lead.aiRecommendedAction ? `Recommended action: ${lead.aiRecommendedAction}` : '';
    el('detail-ai-missing').textContent = lead.aiMissingInfo && lead.aiMissingInfo.length
      ? `Missing info: ${lead.aiMissingInfo.join(', ')}`
      : '';
    el('detail-ai-engine').textContent = lead.aiEngine ? `Qualified via ${lead.aiEngine}` : '';

    el('detail-status').value = lead.status;
    el('detail-contacted').checked = Boolean(lead.contactedAt);
    el('detail-opted-out').checked = Boolean(lead.optedOut);
    el('detail-notes').value = lead.notes || '';

    el('detail-timeline').innerHTML = (lead.events || [])
      .map(
        (e) =>
          `<li><span>${escapeHtml(e.type.replace(/_/g, ' '))}${e.detail ? ' — ' + escapeHtml(e.detail) : ''}</span><span class="mute">${formatDate(e.created_at)}</span></li>`
      )
      .join('') || '<li class="mute">No activity yet.</li>';

    el('detail-modal').hidden = false;
  }

  el('detail-close-btn').addEventListener('click', () => {
    el('detail-modal').hidden = true;
    // Clear the deep-link id so a reload doesn't keep re-opening it.
    if (window.location.search) window.history.replaceState({}, '', '/admin/leads');
  });

  el('detail-save-btn').addEventListener('click', async () => {
    if (!activeId) return;
    const res = await adminFetch(`/api/leads/${activeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: el('detail-status').value,
        contacted: el('detail-contacted').checked,
        optedOut: el('detail-opted-out').checked,
        notes: el('detail-notes').value,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return toast(data.error || 'Failed to save.', 'error');
    }
    toast('Lead updated.', 'success');
    el('detail-modal').hidden = true;
    loadLeads();
  });

  el('detail-delete-btn').addEventListener('click', async () => {
    if (!activeId) return;
    if (!confirm('Delete this lead permanently?')) return;
    const res = await adminFetch(`/api/leads/${activeId}`, { method: 'DELETE' });
    if (!res.ok) return toast('Failed to delete.', 'error');
    el('detail-modal').hidden = true;
    toast('Lead deleted.', 'success');
    loadLeads();
  });

  el('run-followups-btn').addEventListener('click', async () => {
    const res = await adminFetch('/api/leads/run-followups', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'Failed to run follow-ups.', 'error');
    toast(`Checked ${data.checked}, sent ${data.sent}, skipped ${data.skipped}, failed ${data.failed}.`, 'success');
    loadLeads();
  });

  ['search-input'].forEach((id) => {
    let t;
    el(id).addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(loadLeads, 300);
    });
  });
  ['filter-status', 'filter-ai-status'].forEach((id) => el(id).addEventListener('change', loadLeads));

  (async function init() {
    await checkSession();
    await loadLeads();
  })();
})();
