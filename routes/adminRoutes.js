const express = require('express');
const router  = express.Router();

const {
  login,
  register,
  getTeam,
  updateAdmin,
  deleteAdmin,
  revokeSession,
  getUsers,
  updateUserRole,
} = require('../controllers/adminTeamController');

// const { broadcastNewsletter } = require('../controllers/adminController');

// requirePrimary n'existe pas dans auth.js — la vérification isPrimary est dans le contrôleur
const { requireAdmin } = require('../middleware/auth');

// ── AUTH (publiques) ──────────────────────────────────────────────────────────
router.post('/login',    login);
router.post('/register', register);

// ── TEAM ──────────────────────────────────────────────────────────────────────
router.get   ('/team',            requireAdmin, getTeam);
router.put   ('/team/:id',        requireAdmin, updateAdmin);
router.delete('/team/:id',        requireAdmin, deleteAdmin);
router.post  ('/team/:id/revoke', requireAdmin, revokeSession);
// router.post('/broadcast', requireAdmin, broadcastNewsletter);

// ── USERS ─────────────────────────────────────────────────────────────────────
router.get('/users',          requireAdmin, getUsers);
router.put('/users/:id/role', requireAdmin, updateUserRole);

module.exports = router;

