/**
 * radioRoutes.js — Radio par IA MOOZIK (version slim)
 *
 * Toute la logique métier se trouve dans radioController.js.
 * Ce fichier ne fait que brancher les middlewares et les routes.
 *
 * Ajouter dans server.js :
 *   const radioRoutes = require('./routes/radioRoutes');
 *   app.use('/', radioRoutes);
 *
 * Variables .env :
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   FRONTEND_URL=https://moozik.app
 */

'use strict';

const express = require('express');
const router  = express.Router();

const ctrl                      = require('../controllers/radioController');
const { requireAuth, optionalAuth } = require('../middleware/auth');

// ── Config ────────────────────────────────────────────────────────────────────
// Ces routes doivent être déclarées AVANT /:sessionId/* pour éviter les conflits
router.get ('/radio/config/moods',       ctrl.getMoods);
router.get ('/radio/config/suggestions', optionalAuth, ctrl.getSuggestions);

// ── Session lifecycle ─────────────────────────────────────────────────────────
router.post  ('/radio/start',                optionalAuth, ctrl.startSession);
router.get   ('/radio/:sessionId',           optionalAuth, ctrl.getSession);
router.delete('/radio/:sessionId',           optionalAuth, ctrl.stopSession);

// ── Playback ──────────────────────────────────────────────────────────────────
router.get ('/radio/:sessionId/next',    optionalAuth, ctrl.nextSong);
router.post('/radio/:sessionId/skip',    optionalAuth, ctrl.skipSong);
router.post('/radio/:sessionId/like',    optionalAuth, ctrl.likeSong);

module.exports = router;

