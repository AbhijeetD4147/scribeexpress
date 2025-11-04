const express = require('express');
const router = express.Router();
const {
  fetchIoToken,
  fetchAuthToken,
  ensureIoToken,
  ensureAuthToken,
  getTokenStatus,
} = require('../utils/tokenManager');

// Force refresh IO token
router.get('/io', async (req, res) => {
  try {
    const token = await fetchIoToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force login and cache
router.post('/login', async (req, res) => {
  try {
    const token = await fetchAuthToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ensure tokens
router.get('/ensure', async (req, res) => {
  try {
    const io = await ensureIoToken();
    const auth = await ensureAuthToken().catch(() => null); // optional
    res.json({ ioToken: Boolean(io), authToken: Boolean(auth) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status
router.get('/status', (req, res) => {
  res.json(getTokenStatus());
});

module.exports = router;