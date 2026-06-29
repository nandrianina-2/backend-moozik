// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({

  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  role:   { type: String, enum: ['user', 'artist', 'admin'], required: true },

  // Hash SHA-256 du sessionId embarqué dans le JWT
  tokenHash: { type: String, required: true, unique: true, index: true, select: false },

  // ── Appareil ────────────────────────────────────────────────────────────────
  device: {
    browser:      { type: String, default: 'Inconnu' },
    browserVersion:{ type: String, default: '' },
    os:           { type: String, default: 'Inconnu' },
    osVersion:    { type: String, default: '' },
    type:         { type: String, default: 'desktop' }, // mobile | tablet | desktop
    brand:        { type: String, default: '' },        // Samsung, Apple, etc.
    userAgent:    { type: String, default: '', select: false }, // stocké mais non exposé par défaut
  },

  // ── Réseau ──────────────────────────────────────────────────────────────────
  ip:       { type: String, default: '' },
  location: {                             // résolu via ip-api ou similaire si dispo
    country: { type: String, default: '' },
    city:    { type: String, default: '' },
    region:  { type: String, default: '' },
  },

  // ── Activité ────────────────────────────────────────────────────────────────
  connectedAt:    { type: Date, default: Date.now },   // date de connexion
  lastSeenAt:     { type: Date, default: Date.now },   // dernière activité
  disconnectedAt: { type: Date, default: null },        // null = encore active
  requestCount:   { type: Number, default: 1 },        // nb de requêtes dans la session

  // ── Statut ──────────────────────────────────────────────────────────────────
  // 'active'   : session en cours
  // 'expired'  : token JWT expiré naturellement
  // 'revoked'  : révoquée manuellement ou par nouvelle connexion
  // 'logout'   : déconnexion volontaire
  status: {
    type:    String,
    enum:    ['active', 'expired', 'revoked', 'logout'],
    default: 'active',
    index:   true,
  },

  // TTL MongoDB : supprime automatiquement les sessions après expiresAt
  expiresAt: { type: Date, index: { expires: 0 } },

}, { timestamps: true });

sessionSchema.index({ userId: 1, role: 1, status: 1 });
sessionSchema.index({ userId: 1, connectedAt: -1 });

module.exports = mongoose.models.Session || mongoose.model('Session', sessionSchema);