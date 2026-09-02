const express = require('express');

const { requireAuth, requireSameOriginHeader } = require('../auth');
const { getSettings, updateSettings, integrationsStatus, KEYS } = require('../services/settings');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ settings: getSettings(), integrations: integrationsStatus() });
});

router.put('/', requireSameOriginHeader, (req, res) => {
  const body = req.body || {};
  const partial = {};
  for (const key of KEYS) {
    if (body[key] !== undefined) partial[key] = body[key];
  }
  if (!Object.keys(partial).length) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  if (partial.services && !Array.isArray(partial.services)) {
    return res.status(400).json({ error: 'services must be an array.' });
  }
  const settings = updateSettings(partial);
  res.json({ settings, integrations: integrationsStatus() });
});

module.exports = router;
