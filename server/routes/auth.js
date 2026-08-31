const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyCredentials } = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const ok = await verifyCredentials(username, password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed.' });
      req.session.isAdmin = true;
      req.session.username = username;
      res.json({ ok: true });
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server is not configured for admin login yet.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('dw.sid');
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session && req.session.isAdmin),
    username: (req.session && req.session.username) || null,
  });
});

module.exports = router;
