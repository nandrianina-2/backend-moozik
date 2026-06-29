// controllers/sessionController.js
// ─────────────────────────────────────────────────────────────────────────────
// Gestion des sessions actives : liste, révocation, déconnexion
// ─────────────────────────────────────────────────────────────────────────────
const Session = require('../models/Session');
const { hashToken } = require('../middleware/auth');

// ── GET /sessions ─────────────────────────────────────────────────────────────
// Retourne { active, history, stats } — format attendu par le frontend
exports.listSessions = async (req, res) => {
  try {
    // 1. Identifier la session courante via son hash
    const currentHash = hashToken(req.user.sessionId);
    const currentSession = await Session.findOne({
      userId:    req.user.id,
      tokenHash: currentHash,
    }).select('_id');
    const currentId = currentSession?._id?.toString();

    // 2. Récupérer toutes les sessions de cet utilisateur
    const HISTORY_STATUSES = ['revoked', 'logout', 'expired'];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const allSessions = await Session.find({ userId: req.user.id })
      .select('-tokenHash')
      .sort({ lastSeenAt: -1 });

    // 3. Sérialiser avec isCurrent
    const serialize = (s) => ({
      ...s.toObject(),
      isCurrent: s._id.toString() === currentId,
    });

    // 4. Séparer actives / historique
    const active  = allSessions
      .filter(s => s.status === 'active')
      .map(serialize);

    const history = allSessions
      .filter(s => HISTORY_STATUSES.includes(s.status) && s.connectedAt >= thirtyDaysAgo)
      .map(serialize);

    // 5. Stats
    const stats = {
      totalActive:  active.length,
      totalHistory: history.length,
    };

    res.json({ active, history, stats });
  } catch (e) {
    console.error('[listSessions]', e);
    res.status(500).json({ message: e.message });
  }
};

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────
// Révoque une session spécifique (ne peut pas révoquer une session d'un autre user)
exports.revokeSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session introuvable' });

    // Sécurité : un user ne peut révoquer que ses propres sessions
    if (String(session.userId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Accès refusé' });
    }

    await Session.updateOne(
      { _id: req.params.id },
      { $set: { status: 'revoked', disconnectedAt: new Date() } }
    );
    res.json({ message: 'Session révoquée' });
  } catch (e) {
    console.error('[revokeSession]', e);
    res.status(500).json({ message: e.message });
  }
};

// ── DELETE /sessions ──────────────────────────────────────────────────────────
// Révoque TOUTES les sessions sauf la courante (déconnexion partout ailleurs)
exports.revokeAllOther = async (req, res) => {
  try {
    const currentHash = hashToken(req.user.sessionId);

    // Trouver la session courante pour l'exclure
    const current = await Session.findOne({
      userId:    req.user.id,
      tokenHash: currentHash,
    }).select('_id');

    const filter = { userId: req.user.id, role: req.user.role };
    if (current) filter._id = { $ne: current._id };

    const { modifiedCount } = await Session.updateMany(
      filter,
      { $set: { status: 'revoked', disconnectedAt: new Date() } }
    );
    res.json({ message: `${modifiedCount} session(s) révoquée(s)` });
  } catch (e) {
    console.error('[revokeAllOther]', e);
    res.status(500).json({ message: e.message });
  }
};

// ── POST /sessions/logout ─────────────────────────────────────────────────────
// Déconnexion propre : supprime la session courante
exports.logout = async (req, res) => {
  try {
    if (req.user?.sessionId) {
      await Session.deleteOne({
        userId:    req.user.id,
        tokenHash: hashToken(req.user.sessionId),
      });
    }
    res.json({ message: 'Déconnecté' });
  } catch (e) {
    console.error('[logout]', e);
    res.status(500).json({ message: e.message });
  }
};

// ── DELETE /sessions/history ──────────────────────────────────────────────────
// Supprime définitivement l'historique (sessions non-actives) de l'utilisateur
exports.clearHistory = async (req, res) => {
  try {
    const { deletedCount } = await Session.deleteMany({
      userId: req.user.id,
      status: { $in: ['revoked', 'logout', 'expired'] },
    });
    res.json({ message: `${deletedCount} session(s) supprimée(s) de l'historique` });
  } catch (e) {
    console.error('[clearHistory]', e);
    res.status(500).json({ message: e.message });
  }
};

// ── Admin : GET /admin/sessions/:userId ───────────────────────────────────────
// Permet à un admin de voir et révoquer les sessions d'un utilisateur
exports.adminListUserSessions = async (req, res) => {
  try {
    const sessions = await Session.find({ userId: req.params.userId })
      .select('-tokenHash')
      .sort({ lastSeenAt: -1 });
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.adminRevokeUserSessions = async (req, res) => {
  try {
    const { deletedCount } = await Session.deleteMany({ userId: req.params.userId });
    res.json({ message: `${deletedCount} session(s) supprimée(s)` });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};