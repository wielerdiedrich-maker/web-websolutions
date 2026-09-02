/**
 * DW Lead Machine — embeddable lead capture widget.
 *
 * Drop this on any client site:
 *   <div id="dw-lead-machine"
 *        data-endpoint="/api/leads"
 *        data-business="DW Laser"
 *        data-services="Custom Engraved Tumblers,Signage & Plaques,Corporate / Bulk Orders,Other"
 *        data-heading="Ready to Get Started?"
 *        data-subheading="Tell us a little about your project and we'll help you with the next step."
 *   ></div>
 *   <script src="/js/lead-form.js" defer></script>
 *
 * Deliberately dependency-free and namespaced (dwlm- prefix) so it can be
 * dropped into a different client's site without colliding with their CSS.
 * data-endpoint defaults to "/api/leads" (same-origin); point it at a full
 * URL to submit to a different DW Lead Machine instance.
 */
(function () {
  const STYLE = `
  .dwlm-widget{ --dwlm-accent:#F2A93B; --dwlm-ink:#14171A; --dwlm-mute:#6b7280; --dwlm-line:#e2e2df; --dwlm-bg:#fff;
    max-width:640px; margin:0 auto; background:var(--dwlm-bg); border:1px solid var(--dwlm-line); border-radius:12px;
    padding:28px; font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif; color:var(--dwlm-ink); box-sizing:border-box; }
  .dwlm-widget *{ box-sizing:border-box; }
  .dwlm-heading{ font-size:1.6rem; font-weight:800; margin:0 0 6px; letter-spacing:-0.01em; }
  .dwlm-sub{ color:var(--dwlm-mute); font-size:0.95rem; margin:0 0 22px; line-height:1.5; }
  .dwlm-row{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px; }
  .dwlm-field{ margin-bottom:14px; }
  .dwlm-field label{ display:block; font-size:0.78rem; font-weight:600; margin-bottom:6px; color:var(--dwlm-ink); }
  .dwlm-field .dwlm-optional{ color:var(--dwlm-mute); font-weight:400; }
  .dwlm-widget input, .dwlm-widget select, .dwlm-widget textarea{
    width:100%; padding:11px 13px; border:1px solid var(--dwlm-line); border-radius:7px; font-size:0.92rem;
    font-family:inherit; background:#fff; color:var(--dwlm-ink); }
  .dwlm-widget input:focus, .dwlm-widget select:focus, .dwlm-widget textarea:focus{
    outline:none; border-color:var(--dwlm-accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--dwlm-accent) 20%, transparent); }
  .dwlm-widget textarea{ resize:vertical; min-height:90px; }
  .dwlm-file-zone{ border:1.5px dashed var(--dwlm-line); border-radius:8px; padding:16px; text-align:center; cursor:pointer; transition:border-color .15s; }
  .dwlm-file-zone:hover, .dwlm-file-zone.dragover{ border-color:var(--dwlm-accent); }
  .dwlm-file-zone p{ margin:0; font-size:0.85rem; color:var(--dwlm-mute); }
  .dwlm-file-list{ margin-top:10px; font-size:0.8rem; color:var(--dwlm-mute); text-align:left; }
  .dwlm-file-list div{ padding:3px 0; }
  .dwlm-submit{ width:100%; padding:14px; background:var(--dwlm-accent); color:#14171A; border:none; border-radius:7px;
    font-weight:700; font-size:0.95rem; cursor:pointer; transition:transform .15s,opacity .15s; margin-top:6px; }
  .dwlm-submit:hover{ transform:translateY(-1px); }
  .dwlm-submit:disabled{ opacity:0.6; cursor:not-allowed; transform:none; }
  .dwlm-status{ margin-top:14px; font-size:0.88rem; text-align:center; }
  .dwlm-status.ok{ color:#1a7f4e; }
  .dwlm-status.err{ color:#c0392b; }
  @media (max-width:520px){ .dwlm-row{ grid-template-columns:1fr; } .dwlm-widget{ padding:20px; } }
  `;

  function injectStyleOnce() {
    if (document.getElementById('dwlm-style')) return;
    const style = document.createElement('style');
    style.id = 'dwlm-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function buildForm(container) {
    const endpoint = container.dataset.endpoint || '/api/leads';
    const business = container.dataset.business || 'us';
    const heading = container.dataset.heading || 'Ready to Get Started?';
    const subheading =
      container.dataset.subheading || `Tell us a little about your project and we'll help you with the next step.`;
    const services = (container.dataset.services || 'General Inquiry')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    container.classList.add('dwlm-widget');
    container.innerHTML = `
      <h2 class="dwlm-heading">${heading}</h2>
      <p class="dwlm-sub">${subheading}</p>
      <form novalidate>
        <div class="dwlm-row">
          <div class="dwlm-field"><label for="dwlm-name">Name</label><input id="dwlm-name" name="name" required></div>
          <div class="dwlm-field"><label for="dwlm-phone">Phone</label><input id="dwlm-phone" name="phone" type="tel"></div>
        </div>
        <div class="dwlm-row">
          <div class="dwlm-field"><label for="dwlm-email">Email</label><input id="dwlm-email" name="email" type="email" required></div>
          <div class="dwlm-field"><label for="dwlm-company">Company <span class="dwlm-optional">(optional)</span></label><input id="dwlm-company" name="company"></div>
        </div>
        <div class="dwlm-field">
          <label for="dwlm-service">Service needed</label>
          <select id="dwlm-service" name="service" required>
            ${services.map((s) => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="dwlm-field">
          <label for="dwlm-description">Tell us about your project</label>
          <textarea id="dwlm-description" name="description" required placeholder="Quantity, size, artwork, deadline — whatever helps ${business} understand the job."></textarea>
        </div>
        <div class="dwlm-row">
          <div class="dwlm-field"><label for="dwlm-budget">Estimated budget <span class="dwlm-optional">(optional)</span></label><input id="dwlm-budget" name="budget" placeholder="e.g. $200–$500"></div>
          <div class="dwlm-field">
            <label for="dwlm-timeframe">Desired timeframe</label>
            <select id="dwlm-timeframe" name="timeframe">
              <option value="">Select one</option>
              <option>ASAP</option><option>Within 1 week</option><option>Within 1 month</option><option>Flexible</option>
            </select>
          </div>
        </div>
        <div class="dwlm-row">
          <div class="dwlm-field">
            <label for="dwlm-contact">Preferred contact method</label>
            <select id="dwlm-contact" name="preferred-contact">
              <option value="">Select one</option>
              <option>Email</option><option>Phone</option><option>Text</option>
            </select>
          </div>
          <div class="dwlm-field"><label for="dwlm-appt">Preferred appointment time <span class="dwlm-optional">(optional)</span></label><input id="dwlm-appt" name="preferred-appointment-time" placeholder="e.g. weekday afternoons"></div>
        </div>
        <div class="dwlm-field">
          <label>Photos or files <span class="dwlm-optional">(optional)</span></label>
          <div class="dwlm-file-zone" id="dwlm-file-zone">
            <p>Click to add photos/artwork, or drag files here</p>
            <input type="file" id="dwlm-files" name="files" multiple accept="image/*,.pdf" hidden>
          </div>
          <div class="dwlm-file-list" id="dwlm-file-list"></div>
        </div>
        <button type="submit" class="dwlm-submit">Send My Request</button>
        <p class="dwlm-status" id="dwlm-status" hidden></p>
      </form>
    `;

    const form = container.querySelector('form');
    const fileInput = container.querySelector('#dwlm-files');
    const fileZone = container.querySelector('#dwlm-file-zone');
    const fileList = container.querySelector('#dwlm-file-list');
    const status = container.querySelector('#dwlm-status');
    const submitBtn = container.querySelector('.dwlm-submit');

    fileZone.addEventListener('click', () => fileInput.click());
    ['dragover', 'dragleave', 'drop'].forEach((evt) =>
      fileZone.addEventListener(evt, (e) => {
        e.preventDefault();
        fileZone.classList.toggle('dragover', evt === 'dragover');
        if (evt === 'drop' && e.dataTransfer.files.length) {
          fileInput.files = e.dataTransfer.files;
          renderFileList();
        }
      })
    );
    fileInput.addEventListener('change', renderFileList);
    function renderFileList() {
      const files = Array.from(fileInput.files || []);
      fileList.innerHTML = files.map((f) => `<div>📎 ${f.name}</div>`).join('');
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      status.hidden = true;

      const fd = new FormData(form);
      try {
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

        status.textContent = `✓ Thanks — we've received your request and will follow up shortly.`;
        status.className = 'dwlm-status ok';
        status.hidden = false;
        form.reset();
        fileList.innerHTML = '';
      } catch (err) {
        status.textContent = `✕ ${err.message}`;
        status.className = 'dwlm-status err';
        status.hidden = false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send My Request';
      }
    });
  }

  function init() {
    injectStyleOnce();
    document.querySelectorAll('[id="dw-lead-machine"], [data-dwlm-widget]').forEach(buildForm);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
