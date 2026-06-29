/**
 * timestampCommentRoutes.js
 * Commentaires audio avec timestamp (position précise dans la chanson)
 *
 * Ajouter dans server.js :
 *   const tsComments = require('./routes/timestampCommentRoutes');
 *   app.use('/', tsComments);
 */
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { User }                      = require('../models');

// ════════════════════════════════════════════
// MODÈLE
// ════════════════════════════════════════════
const TimestampCommentSchema = new mongoose.Schema({
  songId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song',  required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  timestamp: { type: Number, required: true },   // secondes (ex: 47.3)
  text:      { type: String, required: true, maxlength: 280 },
  // Réactions au commentaire
  likes:     { type: Number, default: 0 },
  likedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Réponses inline
  replies: [{
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    nom:       String,
    avatar:    String,
    text:      { type: String, maxlength: 280 },
    createdAt: { type: Date, default: Date.now },
  }],
  // Emoji réaction rapide
  emoji:     { type: String, default: '' }, // ex: "🔥", "❤️", "😮"
  // Signalement
  reported:  { type: Boolean, default: false },
  hidden:    { type: Boolean, default: false },
}, { timestamps: true });

TimestampCommentSchema.index({ songId: 1, timestamp: 1 });
TimestampCommentSchema.index({ songId: 1, createdAt: -1 });
TimestampCommentSchema.index({ userId: 1 });

// Éviter double-enregistrement si modèle déjà défini
const TimestampComment = mongoose.models.TimestampComment
  || mongoose.model('TimestampComment', TimestampCommentSchema);

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════

// ── GET /songs/:id/ts-comments — Tous les commentaires d'une chanson ──
router.get('/songs/:id/ts-comments', optionalAuth, async (req, res) => {
  try {
    const comments = await TimestampComment.find({
      songId: req.params.id,
      hidden: false,
    })
      .populate('userId', 'nom avatar')
      .populate('replies.userId', 'nom avatar')
      .sort({ timestamp: 1 })
      .lean();

    // Injecter liked par l'utilisateur connecté
    const userId = req.user?.id;
    const result = comments.map(c => ({
      ...c,
      liked: userId ? c.likedBy.some(id => String(id) === String(userId)) : false,
      likedBy: undefined, // ne pas exposer la liste
    }));

    // Grouper par window de 2s pour éviter le clustering visuel
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── POST /songs/:id/ts-comments — Ajouter un commentaire ──
router.post('/songs/:id/ts-comments', requireAuth, async (req, res) => {
  try {
    const { timestamp, text, emoji } = req.body;
    if (!text?.trim())           return res.status(400).json({ message: 'Commentaire vide' });
    if (typeof timestamp !== 'number' || timestamp < 0)
      return res.status(400).json({ message: 'Timestamp invalide' });
    if (text.length > 280)       return res.status(400).json({ message: 'Max 280 caractères' });

    const user    = await User.findById(req.user.id).select('nom avatar');
    const comment = await new TimestampComment({
      songId:    req.params.id,
      userId:    req.user.id,
      timestamp: Math.round(timestamp * 10) / 10, // arrondi à 0.1s
      text:      text.trim(),
      emoji:     emoji || '',
    }).save();

    // Populer avant de retourner
    const populated = await TimestampComment.findById(comment._id)
      .populate('userId', 'nom avatar').lean();

    res.json({ ...populated, liked: false, likedBy: undefined });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── PUT /songs/:songId/ts-comments/:commentId/like — Like/Unlike ──
router.put('/songs/:songId/ts-comments/:commentId/like', requireAuth, async (req, res) => {
  try {
    const comment  = await TimestampComment.findOne({
      _id: req.params.commentId, songId: req.params.songId
    });
    if (!comment) return res.status(404).json({ message: 'Commentaire introuvable' });

    const uid = req.user.id;
    const idx = comment.likedBy.findIndex(id => String(id) === String(uid));
    if (idx === -1) {
      comment.likedBy.push(uid);
      comment.likes = Math.max(0, comment.likes + 1);
    } else {
      comment.likedBy.splice(idx, 1);
      comment.likes = Math.max(0, comment.likes - 1);
    }
    await comment.save();
    res.json({ likes: comment.likes, liked: idx === -1 });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── POST /songs/:songId/ts-comments/:commentId/reply — Répondre ──
router.post('/songs/:songId/ts-comments/:commentId/reply', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'Réponse vide' });
    const user = await User.findById(req.user.id).select('nom avatar');
    const comment = await TimestampComment.findOneAndUpdate(
      { _id: req.params.commentId, songId: req.params.songId },
      { $push: { replies: { userId: req.user.id, nom: user?.nom || 'Utilisateur', avatar: user?.avatar || '', text: text.trim() } } },
      { returnDocument: 'after' }
    ).populate('userId', 'nom avatar');
    if (!comment) return res.status(404).json({ message: 'Commentaire introuvable' });
    res.json(comment.replies[comment.replies.length - 1]);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── DELETE /songs/:songId/ts-comments/:commentId — Supprimer ──
router.delete('/songs/:songId/ts-comments/:commentId', requireAuth, async (req, res) => {
  try {
    const role   = req.user.role;
    const comment = await TimestampComment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Introuvable' });
    // Seul l'auteur ou l'admin peut supprimer
    if (role !== 'admin' && String(comment.userId) !== String(req.user.id))
      return res.status(403).json({ message: 'Accès refusé' });
    await TimestampComment.findByIdAndDelete(req.params.commentId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── POST /songs/:songId/ts-comments/:commentId/report — Signaler ──
router.post('/songs/:songId/ts-comments/:commentId/report', requireAuth, async (req, res) => {
  try {
    await TimestampComment.findByIdAndUpdate(req.params.commentId, { reported: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── GET /admin/ts-comments/reported — Commentaires signalés (admin) ──
router.get('/admin/ts-comments/reported', async (req, res) => {
  try {
    const reported = await TimestampComment.find({ reported: true })
      .populate('userId', 'nom email')
      .populate('songId', 'titre artiste')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(reported);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── PUT /admin/ts-comments/:id/hide — Masquer (admin) ──
router.put('/admin/ts-comments/:id/hide', async (req, res) => {
  try {
    await TimestampComment.findByIdAndUpdate(req.params.id, { hidden: true, reported: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── GET /songs/:id/ts-comments/stats — Stats commentaires (artiste/admin) ──
router.get('/songs/:id/ts-comments/stats', async (req, res) => {
  try {
    const stats = await TimestampComment.aggregate([
      { $match: { songId: new mongoose.Types.ObjectId(req.params.id), hidden: false } },
      {
        $group: {
          _id: null,
          total:       { $sum: 1 },
          totalLikes:  { $sum: '$likes' },
          avgTimestamp:{ $avg: '$timestamp' },
          // Regrouper par tranches de 5s pour la heatmap
          timestamps:  { $push: '$timestamp' },
        }
      }
    ]);

    if (!stats.length) return res.json({ total: 0, totalLikes: 0, heatmap: [] });

    const { total, totalLikes, avgTimestamp, timestamps } = stats[0];

    // Construire une heatmap par tranches de 5s
    const buckets = {};
    timestamps.forEach(t => {
      const bucket = Math.floor(t / 5) * 5;
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    });
    const heatmap = Object.entries(buckets)
      .map(([t, count]) => ({ time: parseInt(t), count }))
      .sort((a, b) => a.time - b.time);

    res.json({ total, totalLikes, avgTimestamp: Math.round(avgTimestamp), heatmap });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

module.exports = router;

