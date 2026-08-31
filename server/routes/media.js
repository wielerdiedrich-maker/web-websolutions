const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { requireAuth, requireSameOriginHeader } = require('../auth');
const { processUpload, deleteMediaFiles, ValidationError } = require('../mediaProcessor');

const router = express.Router();

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.mp4', '.webm', '.mov']);

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 300 * 1024 * 1024, // hard ceiling; per-type limits enforced in mediaProcessor
    files: 20,
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new ValidationError(`File type not allowed: ${file.originalname}`));
    }
    cb(null, true);
  },
});

// --- Public, read-only: resolve named "slots" to live media URLs for the
// front-end to hydrate without any code changes. No auth required since
// this only returns what the admin has explicitly published.
router.get('/public', (req, res) => {
  const rows = db
    .prepare(
      `SELECT slot_key, kind, mime_type, optimized_path, thumb_path
       FROM media WHERE slot_key IS NOT NULL`
    )
    .all();
  const bySlot = {};
  for (const row of rows) {
    bySlot[row.slot_key] = {
      kind: row.kind,
      mimeType: row.mime_type,
      url: '/' + row.optimized_path,
      thumbUrl: row.thumb_path ? '/' + row.thumb_path : null,
    };
  }
  res.json(bySlot);
});

router.use(requireAuth);

function serializeMedia(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds,
    folder: row.folder,
    slotKey: row.slot_key,
    url: '/' + row.optimized_path,
    thumbUrl: row.thumb_path ? '/' + row.thumb_path : '/' + row.optimized_path,
    originalUrl: '/' + row.original_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- List / search / filter / sort
router.get('/', (req, res) => {
  const { q, kind, folder, sort = 'newest' } = req.query;
  const clauses = [];
  const params = {};

  if (q) {
    clauses.push('original_name LIKE @q');
    params.q = `%${q}%`;
  }
  if (kind && ['image', 'video'].includes(kind)) {
    clauses.push('kind = @kind');
    params.kind = kind;
  }
  if (folder) {
    clauses.push('folder = @folder');
    params.folder = folder;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy =
    {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      name: 'original_name COLLATE NOCASE ASC',
      size: 'size_bytes DESC',
    }[sort] || 'created_at DESC';

  const rows = db.prepare(`SELECT * FROM media ${where} ORDER BY ${orderBy}`).all(params);
  res.json(rows.map(serializeMedia));
});

router.get('/folders', (_req, res) => {
  const rows = db
    .prepare('SELECT folder, COUNT(*) as count FROM media GROUP BY folder ORDER BY folder')
    .all();
  res.json(rows);
});

// --- Upload (single or multiple)
router.post('/upload', requireSameOriginHeader, upload.array('files', 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'No files received.' });
  }
  const folder = (req.body.folder || 'uncategorized').trim().slice(0, 64) || 'uncategorized';

  const results = [];
  const insertStmt = db.prepare(`
    INSERT INTO media (
      id, original_name, stored_name, kind, mime_type, size_bytes,
      width, height, duration_seconds, folder, original_path, optimized_path, thumb_path
    ) VALUES (@id, @original_name, @stored_name, @kind, @mime_type, @size_bytes,
      @width, @height, @duration_seconds, @folder, @original_path, @optimized_path, @thumb_path)
  `);

  for (const file of files) {
    try {
      const processed = await processUpload(file.path, file.originalname, file.mimetype);
      const id = uuidv4();
      insertStmt.run({
        id,
        original_name: file.originalname.slice(0, 255),
        stored_name: processed.storedName,
        kind: processed.kind,
        mime_type: processed.mimeType,
        size_bytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        duration_seconds: processed.durationSeconds,
        folder,
        original_path: processed.originalRelPath,
        optimized_path: processed.optimizedRelPath,
        thumb_path: processed.thumbRelPath,
      });
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
      results.push({ ok: true, originalName: file.originalname, media: serializeMedia(row) });
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : 'Failed to process file.';
      if (!(err instanceof ValidationError)) console.error('Upload processing error:', err);
      results.push({ ok: false, originalName: file.originalname, error: message });
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }
  }

  const anyOk = results.some((r) => r.ok);
  res.status(anyOk ? 200 : 400).json({ results });
});

// --- Update metadata (rename, folder, slot assignment)
router.patch('/:id', requireSameOriginHeader, (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Media not found.' });

  const { originalName, folder, slotKey } = req.body;
  const updates = {};
  if (typeof originalName === 'string' && originalName.trim()) {
    updates.original_name = originalName.trim().slice(0, 255);
  }
  if (typeof folder === 'string' && folder.trim()) {
    updates.folder = folder.trim().slice(0, 64);
  }
  if (slotKey === null || slotKey === '') {
    updates.slot_key = null;
  } else if (typeof slotKey === 'string' && slotKey.trim()) {
    const cleanSlot = slotKey.trim().slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, '');
    const existing = db
      .prepare('SELECT id FROM media WHERE slot_key = ? AND id != ?')
      .get(cleanSlot, row.id);
    if (existing) {
      return res.status(409).json({ error: `Slot "${cleanSlot}" is already assigned to another item.` });
    }
    updates.slot_key = cleanSlot;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  updates.updated_at = new Date().toISOString();
  const setClause = Object.keys(updates)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  db.prepare(`UPDATE media SET ${setClause} WHERE id = @id`).run({ ...updates, id: row.id });

  const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id);
  res.json(serializeMedia(updated));
});

// --- Replace the underlying file, keeping the same id/slot/folder
router.post(
  '/:id/replace',
  requireSameOriginHeader,
  upload.single('file'),
  async (req, res) => {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Media not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    try {
      const processed = await processUpload(req.file.path, req.file.originalname, req.file.mimetype);
      await deleteMediaFiles(row);
      db.prepare(
        `UPDATE media SET original_name = @original_name, stored_name = @stored_name, kind = @kind,
           mime_type = @mime_type, size_bytes = @size_bytes, width = @width, height = @height,
           duration_seconds = @duration_seconds, original_path = @original_path,
           optimized_path = @optimized_path, thumb_path = @thumb_path, updated_at = @updated_at
         WHERE id = @id`
      ).run({
        id: row.id,
        original_name: req.file.originalname.slice(0, 255),
        stored_name: processed.storedName,
        kind: processed.kind,
        mime_type: processed.mimeType,
        size_bytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        duration_seconds: processed.durationSeconds,
        original_path: processed.originalRelPath,
        optimized_path: processed.optimizedRelPath,
        thumb_path: processed.thumbRelPath,
        updated_at: new Date().toISOString(),
      });
      const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id);
      res.json(serializeMedia(updated));
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : 'Failed to process replacement file.';
      if (!(err instanceof ValidationError)) console.error('Replace processing error:', err);
      res.status(400).json({ error: message });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
);

// --- Delete
router.delete('/:id', requireSameOriginHeader, async (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Media not found.' });
  await deleteMediaFiles(row);
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
