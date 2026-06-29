// utils/sessionHelper.js
const Session  = require('../models/Session');
const { signToken, hashToken, parseDevice, getIp, computeExpiresAt } = require('../middleware/auth');

/**
 * Crée une session unique : révoque les précédentes (status=revoked),
 * crée la nouvelle, retourne le JWT signé.
 */
const createUniqueSession = async (payload, req, duration = '30d') => {
  const { token, sessionId } = signToken(payload, duration);
  const now = new Date();

  // ── Marquer toutes les sessions actives précédentes comme révoquées ─────────
  await Session.updateMany(
    { userId: payload.id, role: payload.role, status: 'active' },
    { $set: { status: 'revoked', disconnectedAt: now } }
  );

  // ── Parser le User-Agent pour les infos appareil ───────────────────────────
  const ua     = req.headers['user-agent'] || '';
  const device = parseDevice(ua);
  const ip     = getIp(req);

  // ── Créer la nouvelle session ──────────────────────────────────────────────
  await Session.create({
    userId:      payload.id,
    role:        payload.role,
    tokenHash:   hashToken(sessionId),
    device:      { ...device, userAgent: ua },
    ip,
    connectedAt: now,
    lastSeenAt:  now,
    status:      'active',
    expiresAt:   computeExpiresAt(duration),
  });

  return token;
};

/**
 * Marque une session comme déconnectée proprement (logout).
 */
const closeSession = async (userId, sessionId, reason = 'logout') => {
  await Session.findOneAndUpdate(
    { userId, tokenHash: hashToken(sessionId), status: 'active' },
    { $set: { status: reason, disconnectedAt: new Date() } }
  );
};

module.exports = { createUniqueSession, closeSession };