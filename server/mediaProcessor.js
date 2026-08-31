const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
// file-type is ESM-only from v17+; load it lazily via dynamic import from
// this CommonJS module (Node supports import() from CJS).
let fileTypeFromFilePromise;
function getFileTypeFromFile() {
  if (!fileTypeFromFilePromise) {
    fileTypeFromFilePromise = import('file-type').then((mod) => mod.fileTypeFromFile);
  }
  return fileTypeFromFilePromise;
}

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const DIRS = {
  originals: path.join(UPLOAD_ROOT, 'originals'),
  optimized: path.join(UPLOAD_ROOT, 'optimized'),
  thumbs: path.join(UPLOAD_ROOT, 'thumbs'),
};

const IMAGE_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const VIDEO_MIME_TO_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_SVG_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300MB

async function ensureDirs() {
  for (const dir of Object.values(DIRS)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

function randomName(ext) {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

class ValidationError extends Error {}

/**
 * Validates the real file contents (magic-byte sniffing, not just the
 * client-supplied extension/mimetype, which is trivially spoofable) and
 * processes it into optimized + thumbnail variants.
 */
async function processUpload(tempFilePath, originalName, declaredMime) {
  await ensureDirs();
  const stat = await fs.stat(tempFilePath);
  const lowerName = originalName.toLowerCase();
  const isSvg = lowerName.endsWith('.svg') && declaredMime === 'image/svg+xml';

  if (isSvg) {
    return processSvg(tempFilePath, stat.size);
  }

  const fileTypeFromFile = await getFileTypeFromFile();
  const sniffed = await fileTypeFromFile(tempFilePath);
  if (!sniffed) {
    throw new ValidationError('Could not verify file contents; upload rejected.');
  }

  if (IMAGE_MIME_TO_EXT[sniffed.mime]) {
    return processRasterImage(tempFilePath, sniffed, stat.size);
  }
  if (VIDEO_MIME_TO_EXT[sniffed.mime]) {
    return processVideo(tempFilePath, sniffed, stat.size);
  }

  throw new ValidationError(
    `Unsupported or spoofed file type detected (${sniffed.mime}). Allowed: JPG, PNG, WEBP, SVG, MP4, WEBM, MOV.`
  );
}

async function processSvg(tempFilePath, sizeBytes) {
  if (sizeBytes > MAX_SVG_BYTES) {
    throw new ValidationError('SVG exceeds the 2MB size limit.');
  }
  const raw = await fs.readFile(tempFilePath, 'utf8');
  // Reject obvious non-SVG / polyglot content before parsing.
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--.*?-->\s*)*<svg[\s>]/is.test(raw)) {
    throw new ValidationError('File does not appear to be a valid SVG.');
  }

  const window = new JSDOM('').window;
  const DOMPurify = createDOMPurify(window);
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick'],
  });

  if (!clean || !/<svg[\s>]/i.test(clean)) {
    throw new ValidationError('SVG failed sanitization.');
  }

  const storedName = randomName('svg');
  const originalPath = path.join(DIRS.originals, storedName);
  await fs.writeFile(originalPath, clean, 'utf8');

  // SVGs are already vector/text; no raster thumbnail is generated, the
  // browser renders it directly. We reuse the same sanitized file.
  return {
    kind: 'image',
    mimeType: 'image/svg+xml',
    sizeBytes: Buffer.byteLength(clean, 'utf8'),
    width: null,
    height: null,
    durationSeconds: null,
    storedName,
    originalRelPath: `uploads/originals/${storedName}`,
    optimizedRelPath: `uploads/originals/${storedName}`,
    thumbRelPath: `uploads/originals/${storedName}`,
  };
}

async function processRasterImage(tempFilePath, sniffed, sizeBytes) {
  if (sizeBytes > MAX_IMAGE_BYTES) {
    throw new ValidationError('Image exceeds the 20MB size limit.');
  }
  const ext = IMAGE_MIME_TO_EXT[sniffed.mime];
  const base = crypto.randomBytes(16).toString('hex');
  const storedName = `${base}.${ext}`;

  const originalPath = path.join(DIRS.originals, storedName);
  await fs.copyFile(tempFilePath, originalPath);

  const image = sharp(tempFilePath, { failOn: 'error' }).rotate(); // auto-orient, strips EXIF orientation issues
  const metadata = await image.metadata();

  const maxDim = 2560;
  const optimizedName = `${base}.${ext === 'png' ? 'png' : ext}`;
  const optimizedPath = path.join(DIRS.optimized, optimizedName);

  let pipeline = sharp(tempFilePath, { failOn: 'error' }).rotate().resize({
    width: maxDim,
    height: maxDim,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (ext === 'jpg') {
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  } else if (ext === 'png') {
    pipeline = pipeline.png({ quality: 82, compressionLevel: 9 });
  } else if (ext === 'webp') {
    pipeline = pipeline.webp({ quality: 82 });
  }
  await pipeline.toFile(optimizedPath);

  const thumbName = `${base}_thumb.jpg`;
  const thumbPath = path.join(DIRS.thumbs, thumbName);
  await sharp(tempFilePath, { failOn: 'error' })
    .rotate()
    .resize({ width: 480, height: 480, fit: 'cover' })
    .jpeg({ quality: 75 })
    .toFile(thumbPath);

  const optimizedStat = await fs.stat(optimizedPath);

  return {
    kind: 'image',
    mimeType: sniffed.mime,
    sizeBytes: optimizedStat.size,
    width: metadata.width || null,
    height: metadata.height || null,
    durationSeconds: null,
    storedName,
    originalRelPath: `uploads/originals/${storedName}`,
    optimizedRelPath: `uploads/optimized/${optimizedName}`,
    thumbRelPath: `uploads/thumbs/${thumbName}`,
  };
}

function ffprobeAsync(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

async function processVideo(tempFilePath, sniffed, sizeBytes) {
  if (sizeBytes > MAX_VIDEO_BYTES) {
    throw new ValidationError('Video exceeds the 300MB size limit.');
  }
  const ext = VIDEO_MIME_TO_EXT[sniffed.mime];
  const base = crypto.randomBytes(16).toString('hex');
  const storedName = `${base}.${ext}`;
  const originalPath = path.join(DIRS.originals, storedName);
  await fs.copyFile(tempFilePath, originalPath);

  let probe;
  try {
    probe = await ffprobeAsync(originalPath);
  } catch (err) {
    await fs.unlink(originalPath).catch(() => {});
    throw new ValidationError('Video file is corrupt or unreadable.');
  }

  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const width = videoStream ? videoStream.width : null;
  const height = videoStream ? videoStream.height : null;
  const duration = probe.format && probe.format.duration ? Number(probe.format.duration) : null;

  const thumbName = `${base}_thumb.jpg`;
  const thumbPath = path.join(DIRS.thumbs, thumbName);
  const captureAt = duration && duration > 2 ? 1 : 0;

  await new Promise((resolve, reject) => {
    ffmpeg(originalPath)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({
        timestamps: [captureAt],
        filename: thumbName,
        folder: DIRS.thumbs,
        size: '480x?',
      });
  }).catch(async () => {
    // Non-fatal: keep the video, just skip the thumbnail.
  });

  const thumbExists = await fs
    .access(thumbPath)
    .then(() => true)
    .catch(() => false);

  return {
    kind: 'video',
    mimeType: sniffed.mime,
    sizeBytes,
    width,
    height,
    durationSeconds: duration,
    storedName,
    originalRelPath: `uploads/originals/${storedName}`,
    optimizedRelPath: `uploads/originals/${storedName}`,
    thumbRelPath: thumbExists ? `uploads/thumbs/${thumbName}` : null,
  };
}

async function deleteMediaFiles(media) {
  const rels = new Set(
    [media.original_path, media.optimized_path, media.thumb_path].filter(Boolean)
  );
  for (const rel of rels) {
    const abs = path.join(__dirname, '..', rel);
    await fs.unlink(abs).catch(() => {});
  }
}

module.exports = {
  processUpload,
  deleteMediaFiles,
  ValidationError,
  ensureDirs,
  DIRS,
};
