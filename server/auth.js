const bcrypt = require('bcryptjs');

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(bufA, bufB);
}

async function verifyCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USERNAME || '';
  const expectedHash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!expectedUser || !expectedHash) {
    throw new Error(
      'ADMIN_USERNAME and ADMIN_PASSWORD_HASH must be set in the environment. See .env.example.'
    );
  }
  const userOk = timingSafeStringEqual(username || '', expectedUser);
  const passOk = await bcrypt.compare(password || '', expectedHash);
  return userOk && passOk;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  return res.redirect('/admin/login.html');
}

// Lightweight CSRF-style mitigation for the same-origin admin SPA:
// state-changing requests must carry this header, which a cross-site
// form post or <img>/<script> tag cannot set.
function requireSameOriginHeader(req, res, next) {
  if (req.get('X-Requested-With') !== 'DWWebAdmin') {
    return res.status(403).json({ error: 'Bad request origin.' });
  }
  next();
}

module.exports = { verifyCredentials, requireAuth, requireSameOriginHeader };
