/**
 * Fills any element carrying data-slot="<key>" with whatever the admin has
 * assigned to that slot in the media library. Elements with no assignment
 * are left exactly as they are (the hand-built wireframe placeholders),
 * so this is purely additive and never breaks the page if nothing is set.
 */
(function () {
  function applyBackgroundSlot(container, media) {
    const existing = container.querySelector(':scope > .slot-media');
    if (existing) existing.remove();

    let el;
    if (media.kind === 'video') {
      el = document.createElement('video');
      el.src = media.url;
      el.muted = true;
      el.autoplay = true;
      el.loop = true;
      el.playsInline = true;
      if (media.thumbUrl) el.poster = media.thumbUrl;
    } else {
      el = document.createElement('img');
      el.src = media.url;
      el.alt = '';
      el.loading = 'lazy';
    }
    el.className = 'slot-media';
    container.appendChild(el);
  }

  function applyImgSlot(imgEl, media) {
    imgEl.src = media.kind === 'video' ? media.thumbUrl || media.url : media.url;
  }

  fetch('/api/media/public')
    .then((r) => (r.ok ? r.json() : {}))
    .then((slots) => {
      document.querySelectorAll('[data-slot]').forEach((el) => {
        const media = slots[el.dataset.slot];
        if (!media) return;
        if (el.tagName === 'IMG') {
          applyImgSlot(el, media);
        } else {
          applyBackgroundSlot(el, media);
        }
      });
    })
    .catch(() => {
      /* Public site works fine with placeholders if this fails. */
    });
})();
