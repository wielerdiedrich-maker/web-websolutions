const express = require('express');
const crypto = require('crypto');

const { requireAuth, requireSameOriginHeader } = require('../auth');
const googleCalendar = require('../services/googleCalendar');

const router = express.Router();

router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json(googleCalendar.connectionStatus());
});

router.get('/connect', (req, res) => {
  const status = googleCalendar.connectionStatus();
  if (!status.appCredentialsConfigured) {
    return res
      .status(400)
      .send('Google Calendar is not configured on the server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). See .env.example.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;
  res.redirect(googleCalendar.getAuthUrl(state));
});

router.get('/oauth/callback', async (req, res) => {
  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;

  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`/admin/lead-settings?google=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect('/admin/lead-settings?google=error&reason=invalid_state');
  }

  try {
    await googleCalendar.handleOAuthCallback(String(code));
    res.redirect('/admin/lead-settings?google=connected');
  } catch (err) {
    console.error('[googleAuth] OAuth callback failed:', err.message);
    res.redirect(`/admin/lead-settings?google=error&reason=${encodeURIComponent(err.message)}`);
  }
});

router.post('/disconnect', requireSameOriginHeader, (req, res) => {
  googleCalendar.disconnect();
  res.json({ ok: true });
});

module.exports = router;
