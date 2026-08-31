(function () {
  let mediaList = [];
  let messagesList = [];
  let viewMode = 'grid';
  let activeMediaId = null;
  let pendingDelete = null; // { type: 'media' | 'message', id }

  const el = (id) => document.getElementById(id);
  const container = el('media-container');
  const messagesContainer = el('messages-container');

  // ---------- Toasts ----------
  function toast(message, type = 'info') {
    const stack = el('toast-stack');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(() => node.remove(), 4500);
  }

  // ---------- Auth ----------
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

  // ---------- Data loading ----------
  async function loadFolders() {
    const res = await adminFetch('/api/media/folders');
    const folders = await res.json();
    const select = el('filter-folder');
    const current = select.value;
    select.innerHTML = '<option value="">All folders</option>' +
      folders.map((f) => `<option value="${escapeHtml(f.folder)}">${escapeHtml(f.folder)} (${f.count})</option>`).join('');
    select.value = current;
  }

  async function loadMedia() {
    const params = new URLSearchParams();
    const q = el('search-input').value.trim();
    const kind = el('filter-kind').value;
    const folder = el('filter-folder').value;
    const sort = el('sort-select').value;
    if (q) params.set('q', q);
    if (kind) params.set('kind', kind);
    if (folder) params.set('folder', folder);
    params.set('sort', sort);

    const res = await adminFetch(`/api/media?${params.toString()}`);
    mediaList = await res.json();
    render();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Rendering ----------
  function render() {
    if (!mediaList.length) {
      container.innerHTML = '<div class="empty-state">No media yet. Drag some files into the upload area above to get started.</div>';
      return;
    }
    container.innerHTML = viewMode === 'grid' ? renderGrid() : renderList();
    bindCardActions();
  }

  function thumbMarkup(m) {
    const img = `<img src="${m.thumbUrl}" alt="">`;
    if (m.kind === 'video') {
      return img + `<div class="play-badge"><svg width="34" height="34" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="11" fill="rgba(15,18,20,0.55)"/><path d="M10 8l6 4-6 4V8z"/></svg></div>`;
    }
    return img;
  }

  function renderGrid() {
    return `<div class="media-grid">${mediaList.map((m) => `
      <div class="media-card" data-id="${m.id}">
        <div class="media-thumb">
          ${thumbMarkup(m)}
          ${m.slotKey ? `<span class="slot-badge">${escapeHtml(m.slotKey)}</span>` : ''}
          <span class="kind-badge">${m.kind}</span>
        </div>
        <div class="media-info">
          <div class="name" title="${escapeHtml(m.originalName)}">${escapeHtml(m.originalName)}</div>
          <div class="media-meta-row"><span>${formatBytes(m.sizeBytes)}</span><span>${m.width ? `${m.width}×${m.height}` : ''}${m.durationSeconds ? ' · ' + formatDuration(m.durationSeconds) : ''}</span></div>
          <div class="media-meta-row"><span>${escapeHtml(m.folder)}</span><span>${formatDate(m.createdAt)}</span></div>
        </div>
        <div class="media-actions">
          <button class="btn-ghost" data-action="copy">Copy URL</button>
          <button class="btn-ghost" data-action="slot">Publish</button>
          <button class="btn-ghost" data-action="edit">Edit</button>
          <button class="btn-ghost" data-action="replace">Replace</button>
          <button class="btn-danger" data-action="delete">Delete</button>
        </div>
      </div>`).join('')}</div>`;
  }

  function renderList() {
    return `<table class="media-table"><thead><tr>
        <th></th><th>Name</th><th>Type</th><th>Size</th><th>Dimensions</th><th>Folder</th><th>Slot</th><th>Uploaded</th><th>Actions</th>
      </tr></thead><tbody>${mediaList.map((m) => `
        <tr data-id="${m.id}">
          <td class="thumb-cell"><img src="${m.thumbUrl}" alt=""></td>
          <td title="${escapeHtml(m.originalName)}">${escapeHtml(m.originalName)}</td>
          <td>${m.kind}</td>
          <td>${formatBytes(m.sizeBytes)}</td>
          <td>${m.width ? `${m.width}×${m.height}` : (m.durationSeconds ? formatDuration(m.durationSeconds) : '—')}</td>
          <td>${escapeHtml(m.folder)}</td>
          <td>${m.slotKey ? `<span class="slot-badge" style="position:static;">${escapeHtml(m.slotKey)}</span>` : '—'}</td>
          <td>${formatDate(m.createdAt)}</td>
          <td class="actions-cell">
            <button class="btn-ghost" data-action="copy">Copy</button>
            <button class="btn-ghost" data-action="slot">Publish</button>
            <button class="btn-ghost" data-action="edit">Edit</button>
            <button class="btn-ghost" data-action="replace">Replace</button>
            <button class="btn-danger" data-action="delete">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }

  function bindCardActions() {
    container.querySelectorAll('[data-action]').forEach((btn) => {
      const id = btn.closest('[data-id]').dataset.id;
      const media = mediaList.find((m) => m.id === id);
      btn.addEventListener('click', () => handleAction(btn.dataset.action, media));
    });
  }

  function handleAction(action, media) {
    activeMediaId = media.id;
    if (action === 'copy') {
      navigator.clipboard.writeText(window.location.origin + media.url)
        .then(() => toast('URL copied to clipboard.', 'success'))
        .catch(() => toast('Could not copy URL.', 'error'));
    } else if (action === 'slot') {
      el('slot-input').value = media.slotKey || '';
      openModal('slot-modal');
    } else if (action === 'edit') {
      el('edit-name-input').value = media.originalName;
      el('edit-folder-input').value = media.folder;
      openModal('edit-modal');
    } else if (action === 'replace') {
      el('replace-input').value = '';
      openModal('replace-modal');
    } else if (action === 'delete') {
      pendingDelete = { type: 'media', id: media.id };
      el('delete-modal-title').textContent = 'Delete this file?';
      el('delete-modal-text').textContent =
        "This will permanently remove the file from storage. If it's currently published to a slot, it will disappear from the live site immediately.";
      openModal('delete-modal');
    }
  }

  function openModal(id) { el(id).hidden = false; }
  function closeModal(id) { el(id).hidden = true; }

  // ---------- Modal wiring ----------
  el('slot-cancel-btn').addEventListener('click', () => closeModal('slot-modal'));
  el('slot-save-btn').addEventListener('click', async () => {
    const slotKey = el('slot-input').value.trim();
    const res = await adminFetch(`/api/media/${activeMediaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey: slotKey || null }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Could not update slot.', 'error');
    toast(slotKey ? `Published to "${slotKey}".` : 'Unpublished from slot.', 'success');
    closeModal('slot-modal');
    loadMedia();
  });

  el('edit-cancel-btn').addEventListener('click', () => closeModal('edit-modal'));
  el('edit-save-btn').addEventListener('click', async () => {
    const originalName = el('edit-name-input').value.trim();
    const folder = el('edit-folder-input').value.trim();
    const res = await adminFetch(`/api/media/${activeMediaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalName, folder }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Could not save changes.', 'error');
    toast('Saved.', 'success');
    closeModal('edit-modal');
    loadFolders();
    loadMedia();
  });

  el('replace-cancel-btn').addEventListener('click', () => closeModal('replace-modal'));
  el('replace-save-btn').addEventListener('click', async () => {
    const file = el('replace-input').files[0];
    if (!file) return toast('Choose a file first.', 'error');
    const formData = new FormData();
    formData.append('file', file);
    el('replace-save-btn').disabled = true;
    try {
      const res = await adminFetch(`/api/media/${activeMediaId}/replace`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Replace failed.');
      toast('File replaced.', 'success');
      closeModal('replace-modal');
      loadMedia();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      el('replace-save-btn').disabled = false;
    }
  });

  el('delete-cancel-btn').addEventListener('click', () => closeModal('delete-modal'));
  el('delete-confirm-btn').addEventListener('click', async () => {
    if (!pendingDelete) return;
    const url = pendingDelete.type === 'message'
      ? `/api/messages/${pendingDelete.id}`
      : `/api/media/${pendingDelete.id}`;
    const res = await adminFetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Could not delete.', 'error');
    toast('Deleted.', 'success');
    closeModal('delete-modal');
    if (pendingDelete.type === 'message') {
      loadMessages();
    } else {
      loadFolders();
      loadMedia();
    }
    pendingDelete = null;
  });

  // ---------- Toolbar ----------
  let searchDebounce;
  el('search-input').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadMedia, 250);
  });
  el('filter-kind').addEventListener('change', loadMedia);
  el('filter-folder').addEventListener('change', loadMedia);
  el('sort-select').addEventListener('change', loadMedia);

  el('view-grid-btn').addEventListener('click', () => {
    viewMode = 'grid';
    el('view-grid-btn').classList.add('active');
    el('view-list-btn').classList.remove('active');
    render();
  });
  el('view-list-btn').addEventListener('click', () => {
    viewMode = 'list';
    el('view-list-btn').classList.add('active');
    el('view-grid-btn').classList.remove('active');
    render();
  });

  // ---------- Upload ----------
  const uploadZone = el('upload-zone');
  const fileInput = el('file-input');

  el('browse-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
    })
  );
  uploadZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length) uploadFiles(files);
  });

  function uploadFiles(fileListLike) {
    const files = Array.from(fileListLike);
    const folder = el('upload-folder').value.trim() || 'uncategorized';
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    formData.append('folder', folder);

    const progressList = el('upload-progress-list');
    const item = document.createElement('div');
    item.className = 'upload-progress-item';
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    item.innerHTML = `
      <div class="name"><span>Uploading ${escapeHtml(label)}…</span><span class="pct">0%</span></div>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <div class="upload-result mute" style="font-size:11.5px;margin-top:6px;"></div>
    `;
    progressList.prepend(item);
    const fill = item.querySelector('.progress-fill');
    const pct = item.querySelector('.pct');
    const resultEl = item.querySelector('.upload-result');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media/upload');
    xhr.setRequestHeader('X-Requested-With', 'DWWebAdmin');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        fill.style.width = percent + '%';
        pct.textContent = percent + '%';
      }
    });
    xhr.addEventListener('load', () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        const okCount = data.results.filter((r) => r.ok).length;
        const failCount = data.results.length - okCount;
        fill.classList.add(failCount ? 'error' : 'success');
        fill.style.width = '100%';
        pct.textContent = '100%';
        resultEl.textContent = failCount
          ? `${okCount} uploaded, ${failCount} failed: ${data.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}`
          : `${okCount} file${okCount === 1 ? '' : 's'} uploaded successfully.`;
        toast(resultEl.textContent, failCount ? 'error' : 'success');
        loadFolders();
        loadMedia();
      } else {
        fill.classList.add('error');
        const message = (data && data.error) || 'Upload failed.';
        resultEl.textContent = message;
        toast(message, 'error');
      }
      setTimeout(() => item.remove(), 6000);
    });
    xhr.addEventListener('error', () => {
      fill.classList.add('error');
      resultEl.textContent = 'Network error during upload.';
      toast('Network error during upload.', 'error');
    });
    xhr.send(formData);
  }

  // ---------- Panel switching ----------
  document.querySelectorAll('.nav-item[data-panel]').forEach((navItem) => {
    navItem.addEventListener('click', () => {
      document.querySelectorAll('.nav-item[data-panel]').forEach((n) => n.classList.remove('active'));
      navItem.classList.add('active');
      const panel = navItem.dataset.panel;
      el('panel-media').classList.toggle('hidden', panel !== 'media');
      el('panel-messages').classList.toggle('hidden', panel !== 'messages');
      if (panel === 'messages') loadMessages();
    });
  });

  // ---------- Messages ----------
  function renderMessages() {
    if (!messagesList.length) {
      messagesContainer.innerHTML = '<div class="empty-state">No messages yet. Submissions from the site\'s contact form will show up here.</div>';
      return;
    }
    messagesContainer.innerHTML = messagesList.map((m) => `
      <div class="media-card" style="flex-direction:column;margin-bottom:14px;${m.isRead ? '' : 'border-color:var(--spark-dim);'}">
        <div class="media-info" style="padding:16px;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap;">
            <div>
              <div class="name" style="font-size:15px;">${escapeHtml(m.name)} ${m.isRead ? '' : '<span class="slot-badge" style="position:static;">NEW</span>'}</div>
              <div class="mute" style="font-size:12px;margin-top:2px;">${escapeHtml(m.email)}${m.businessType ? ' · ' + escapeHtml(m.businessType) : ''}</div>
            </div>
            <div class="mute" style="font-size:11.5px;white-space:nowrap;">${formatDate(m.createdAt)}${m.emailSent ? '' : ' · <span title="No SMTP configured or send failed">email not sent</span>'}</div>
          </div>
          <p style="white-space:pre-wrap;font-size:13.5px;margin:6px 0 4px;">${escapeHtml(m.details)}</p>
          <div class="media-actions" style="padding:0;margin-top:4px;">
            <a class="btn-ghost" href="mailto:${encodeURIComponent(m.email)}" style="text-decoration:none;display:inline-block;">Reply by Email</a>
            <button class="btn-ghost" data-action="toggle-read" data-id="${m.id}">${m.isRead ? 'Mark Unread' : 'Mark Read'}</button>
            <button class="btn-danger" data-action="delete-message" data-id="${m.id}">Delete</button>
          </div>
        </div>
      </div>`).join('');

    messagesContainer.querySelectorAll('[data-action="toggle-read"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const msg = messagesList.find((x) => x.id === btn.dataset.id);
        const res = await adminFetch(`/api/messages/${msg.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isRead: !msg.isRead }),
        });
        if (!res.ok) return toast('Could not update message.', 'error');
        loadMessages();
      });
    });
    messagesContainer.querySelectorAll('[data-action="delete-message"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingDelete = { type: 'message', id: btn.dataset.id };
        el('delete-modal-title').textContent = 'Delete this message?';
        el('delete-modal-text').textContent = 'This will permanently remove the submission. This cannot be undone.';
        openModal('delete-modal');
      });
    });
  }

  function updateMessagesBadge() {
    const unread = messagesList.filter((m) => !m.isRead).length;
    const badge = el('messages-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread;
  }

  async function loadMessages() {
    const res = await adminFetch('/api/messages');
    if (!res.ok) return toast('Could not load messages.', 'error');
    messagesList = await res.json();
    renderMessages();
    updateMessagesBadge();
  }

  // ---------- Init ----------
  checkSession().then(() => {
    loadFolders();
    loadMedia();
    loadMessages();
  });
})();
