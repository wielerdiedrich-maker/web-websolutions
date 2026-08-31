require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const SqliteSessionStore = require('./sqliteSessionStore');
const { requireAuth } = require('./auth');
const { ValidationError, ensureDirs } = require('./mediaProcessor');
const authRoutes = require('./routes/auth');
const mediaRoutes = require('./routes/media');
const contactRoutes = require('./routes/contact');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set. See .env.example.');
  process.exit(1);
}

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // the site's inline <style>/<script> predate this backend; CSP can be tightened later
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new SqliteSessionStore(),
    name: 'dw.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api', contactRoutes);

// Publicly served, generated media (images/videos). Random filenames only;
// no directory listing, no script execution of any kind.
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    index: false,
    dotfiles: 'deny',
    setHeaders(res) {
      res.set('X-Content-Type-Options', 'nosniff');
    },
  })
);

// --- Admin UI: served from outside /public and gated explicitly per-route
// so a static-file mount can never accidentally expose the dashboard.
const adminUiDir = path.join(__dirname, 'admin-ui');
app.use('/admin/assets', express.static(path.join(adminUiDir, 'assets')));
app.get(['/admin/login', '/admin/login.html'], (req, res) => {
  res.sendFile(path.join(adminUiDir, 'login.html'));
});
app.get(['/admin', '/admin/', '/admin/index.html'], requireAuth, (req, res) => {
  res.sendFile(path.join(adminUiDir, 'index.html'));
});

// --- Public marketing site
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// --- Error handling for uploads (multer + our own ValidationError)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : `Upload error: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

ensureDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`DW Web Solutions server running on http://localhost:${PORT}`);
  });
});
