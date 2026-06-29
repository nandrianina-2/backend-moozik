// middleware/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Middleware d'authentification Moozik
// v2 : Session Unique — chaque token JWT embarque un sessionId qui est vérifié
//      en base. Une nouvelle connexion invalide toutes les sessions précédentes.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const SECRET = () => process.env.JWT_SECRET;

// ── Utilitaire : hash du sessionToken pour comparer avec la base ──────────────
const hashToken = (raw) =>
  crypto.createHash('sha256').update(raw).digest('hex');

// ── Parse le User-Agent en infos lisibles ─────────────────────────────────────
const parseDevice = (ua = '') => {
  const lower = ua.toLowerCase();

  // Type d'appareil
  let type = 'desktop';
  if (/mobile|android|iphone|ipod/.test(lower))  type = 'mobile';
  else if (/ipad|tablet/.test(lower))             type = 'tablet';

  // Navigateur (ordre important : Edge avant Chrome, OPR avant Chrome)
  let browser = 'Inconnu';
  if      (/edg\//.test(lower))     browser = 'Edge';
  else if (/opr\/|opera/.test(lower)) browser = 'Opera';
  else if (/firefox/.test(lower))   browser = 'Firefox';
  else if (/safari/.test(lower) && !/chrome/.test(lower)) browser = 'Safari';
  else if (/chrome/.test(lower))    browser = 'Chrome';
  else if (/msie|trident/.test(lower)) browser = 'Internet Explorer';

  // Système d'exploitation
  let os = 'Inconnu';
  if      (/windows nt 10/.test(lower)) os = 'Windows 10/11';
  else if (/windows nt 6\.3/.test(lower)) os = 'Windows 8.1';
  else if (/windows/.test(lower))       os = 'Windows';
  else if (/mac os x/.test(lower))      os = 'macOS';
  else if (/iphone os/.test(lower))     os = 'iOS';
  else if (/ipad/.test(lower))          os = 'iPadOS';
  else if (/android/.test(lower))       os = 'Android';
  else if (/linux/.test(lower))         os = 'Linux';

  return { type, browser, os };
};

// ── Récupère l'IP réelle (proxies inclus) ────────────────────────────────────
const getIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  '';

// ── Vérifie le token JWT ET la session en base ────────────────────────────────
const verifySession = async (token, req, requiredRole = null) => {
  // 1. Vérification JWT classique
  const decoded = jwt.verify(token, SECRET());

  // 2. Si le token ne contient pas de sessionId → ancien token sans session,
  //    on refuse pour forcer une reconnexion
  if (!decoded.sessionId) {
    const err = new Error('Session invalide, reconnectez-vous');
    err.code  = 'SESSION_INVALID';
    throw err;
  }

  // 3. Vérification de la session en base
  const Session = require('../models/Session');
  const session = await Session.findOne({
    tokenHash: hashToken(decoded.sessionId),
    userId:    decoded.id,
    status:    'active',
  }).select('+tokenHash');

  if (!session) {
    const err = new Error('Session expirée ou révoquée');
    err.code  = 'SESSION_EXPIRED';
    throw err;
  }

  // 4. Mise à jour silencieuse de lastSeenAt + requestCount
  //    (toutes les 5 min max pour éviter des écritures trop fréquentes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  if (session.lastSeenAt < fiveMinAgo) {
    await Session.updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: new Date() }, $inc: { requestCount: 1 } }
    );
  }

  // 5. Vérification du rôle si exigé
  if (requiredRole) {
    const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!roles.includes(decoded.role)) {
      const err = new Error('Accès refusé');
      err.code  = 'FORBIDDEN';
      throw err;
    }
  }

  return decoded;
};

// ── Helper : extraire le token de l'en-tête Authorization ────────────────────
const extractToken = (req) => req.headers.authorization?.split(' ')[1] ?? null;

// ── Factory : créer un middleware avec vérification de session + rôle ────────
const makeGuard = (roles = null) => async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ message: 'Non autorisé' });

  try {
    const decoded = await verifySession(token, req, roles);
    req.user  = decoded;
    req.admin = decoded; // alias pour la compatibilité avec les anciens contrôleurs
    next();
  } catch (err) {
    // Codes d'erreur spécifiques pour que le frontend puisse réagir
    if (err.code === 'SESSION_EXPIRED') {
      return res.status(401).json({ message: 'SESSION_EXPIRED', detail: 'Votre session a été révoquée (nouvelle connexion détectée).' });
    }
    if (err.code === 'SESSION_INVALID') {
      return res.status(401).json({ message: 'SESSION_INVALID', detail: 'Reconnectez-vous.' });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ message: 'Accès refusé' });
    }
    return res.status(401).json({ message: 'Token invalide' });
  }
};

// ── Middlewares exportés ──────────────────────────────────────────────────────

/** Tout utilisateur authentifié (user, artist, admin) */
const requireAuth = makeGuard();

/** Admin seulement */
const requireAdmin = makeGuard('admin');

/** Artiste ou admin */
const requireArtist = makeGuard(['artist', 'admin']);

/** Artiste ou admin (alias pour compatibilité) */
const requireAdminOrArtist = makeGuard(['artist', 'admin', 'user']);

/** Passe même sans token (ne bloque pas) */
const optionalAuth = async (req, res, next) => {
  const token = extractToken(req);
  if (token) {
    try { req.user = await verifySession(token, req); } catch {}
  }
  next();
};

// ── Helpers pour les contrôleurs ─────────────────────────────────────────────

/** Signe un JWT avec un sessionId aléatoire embarqué */
const signToken = (payload, expiresIn = '30d') => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  return {
    token:     jwt.sign({ ...payload, sessionId }, SECRET(), { expiresIn }),
    sessionId, // à persister en base (hashé)
  };
};

/** Vérifie un token sans contrôle de session (ex : reset-password) */
const verifyToken = (token) => jwt.verify(token, SECRET());

/** Calcule la date d'expiration à partir d'une durée string ex: '30d', '7d' */
const computeExpiresAt = (duration = '30d') => {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [, n, unit] = match;
  const ms = { d: 86400000, h: 3600000, m: 60000 }[unit];
  return new Date(Date.now() + parseInt(n) * ms);
};

module.exports = {
  requireAuth,
  requireAdmin,
  requireArtist,
  requireAdminOrArtist,
  optionalAuth,
  signToken,
  verifyToken,
  hashToken,
  parseDevice,
  getIp,
  computeExpiresAt,
};