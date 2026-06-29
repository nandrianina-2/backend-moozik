const mongoose = require('mongoose');
const {
  Song, Artist, Album, User, Playlist, UserPlaylist,
  Comment, Reaction, UserPlay, UserFavorite, History,
  Notification, ShareHistory,
} = require('../models');
// Vérification explicite — crash immédiat au démarrage plutôt qu'au runtime
if (!Reaction) throw new Error('[adminController] Reaction est undefined — vérifiez l\'export dans ../models');

const { toCloud, fromCloud, IMG_TRANSFORM } = require('../middleware/upload');
const { sendMail } = require('../utils/mailer');

// ══════════════════════════════════════════════
// ADMIN STATS
// ══════════════════════════════════════════════
exports.getStats = async (req, res) => {
  try {
    const weekAgo    = new Date(Date.now() - 7 * 86400000);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const [
      totalSongs, totalPlaylists, totalArtists, totalAlbums,
      totalUsers, totalUserPlaylists, totalComments, totalFavorites,
      topSongs, playsAgg, newUsersThisWeek, playsToday,
    ] = await Promise.all([
      Song.countDocuments(), Playlist.countDocuments(), Artist.countDocuments(), Album.countDocuments(),
      User.countDocuments(), UserPlaylist.countDocuments(), Comment.countDocuments(),
      UserFavorite.countDocuments(),
      Song.find().sort({ plays: -1 }).limit(5).select('titre artiste plays image'),
      Song.aggregate([{ $group: { _id: null, total: { $sum: '$plays' } } }]),
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      History.countDocuments({ playedAt: { $gte: todayStart } }),
    ]);

    res.json({
      totalSongs, totalPlaylists, totalArtists, totalAlbums,
      totalUsers, totalUserPlaylists, totalComments,
      totalLikes: totalFavorites, topSongs,
      totalPlays: playsAgg[0]?.total || 0,
      newUsersThisWeek, playsToday,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getPlaysHistory = async (req, res) => {
  try {
    const days  = req.query.period === '90d' ? 90 : req.query.period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 86400000);
    const data  = await History.aggregate([
      { $match: { playedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$playedAt' } }, plays: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { date: '$_id', plays: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getTopSongs = async (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    res.json(await Song.find().sort({ plays: -1 }).limit(limit).select('titre artiste plays image'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getTopArtists = async (req, res) => {
  try {
    const limit = Math.min(10, parseInt(req.query.limit) || 6);
    const data  = await Song.aggregate([
      { $group: { _id: '$artiste', plays: { $sum: '$plays' }, artisteId: { $first: '$artisteId' } } },
      { $sort: { plays: -1 } }, { $limit: limit },
      { $project: { nom: '$_id', plays: 1, artisteId: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getUsersGrowth = async (req, res) => {
  try {
    const data = await User.aggregate([
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, users: { $sum: 1 } } },
      { $sort: { _id: 1 } }, { $limit: 30 },
      { $project: { date: '$_id', users: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getActiveUsers = async (req, res) => {
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recent = await History.aggregate([
      { $match: { playedAt: { $gte: since } } },
      { $group: { _id: '$userId' } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { 'user.nom': 1, 'user.email': 1, 'user.avatar': 1, _id: 1 } },
    ]);
    res.json({ count: recent.length, users: recent.map(r => r.user) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getUnassignedSongs = async (req, res) => {
  try {
    const songs = await Song.find({
      $or: [{ artisteId: null }, { artisteId: { $exists: false } }, { artiste: '' }],
    }).select('titre artiste image createdAt').sort({ createdAt: -1 });
    res.json({ count: songs.length, songs });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Admin: users ──────────────────────────────
exports.listUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const enriched = await Promise.all(users.map(async u => {
      const [totalPlaylists, totalLikes, totalPlays] = await Promise.all([
        UserPlaylist.countDocuments({ userId: u._id }),
        Reaction.countDocuments({ userId: String(u._id), type: 'heart' }),
        UserPlay.aggregate([{ $match: { userId: u._id } }, { $group: { _id: null, total: { $sum: '$count' } } }]).then(r => r[0]?.total || 0),
      ]);
      return { ...u.toObject(), totalPlaylists, totalLikes, totalPlays };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getUserStats = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    const [totalPlaylists, totalComments, playsAgg, topPlaysRaw] = await Promise.all([
      UserPlaylist.countDocuments({ userId: user._id }),
      Comment.countDocuments({ userId: user._id }),
      UserPlay.aggregate([{ $match: { userId: user._id } }, { $group: { _id: null, total: { $sum: '$count' } } }]),
      UserPlay.find({ userId: user._id }).sort({ count: -1 }).limit(10).populate('songId', 'titre artiste image plays'),
    ]);
    const reactions  = await Reaction.find({ userId: String(user._id), type: 'heart' });
    const likedSongs = await Song.find({ _id: { $in: reactions.map(r => r.songId) } }).select('titre artiste image plays').limit(10);
    res.json({
      user, totalPlays: playsAgg[0]?.total || 0, totalPlaylists, totalComments, totalLikes: reactions.length,
      topSongs: topPlaysRaw.filter(p => p.songId).map(p => ({ ...p.songId.toObject(), userPlays: p.count })),
      likedSongs,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.updateUserAdmin = async (req, res) => {
  try {
    const { nom, email } = req.body;
    const update = {};
    if (nom) update.nom = nom;
    if (email) update.email = email;
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.deleteUser = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await Promise.all([
      UserPlaylist.deleteMany({ userId: req.params.id }),
      Comment.deleteMany({ userId: req.params.id }),
      Reaction.deleteMany({ userId: req.params.id }),
      UserPlay.deleteMany({ userId: req.params.id }),
      History.deleteMany({ userId: req.params.id }),
      Notification.deleteMany({ userId: req.params.id }),
    ]);
    res.json({ message: 'Utilisateur supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Admin songs/albums list
exports.listAdminSongs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const filter = {};
    if (req.query.q)        { const re = new RegExp(req.query.q, 'i'); filter.$or = [{ titre: re }, { artiste: re }]; }
    if (req.query.artisteId) filter.artisteId = req.query.artisteId;
    if (req.query.albumId)   filter.albumId   = req.query.albumId;
    const [songs, total] = await Promise.all([
      Song.find(filter).sort({ plays: -1, createdAt: -1 }).skip((page-1)*limit).limit(limit)
        .select('-audioPublicId -__v').populate('artisteId','nom').populate('albumId','titre'),
      Song.countDocuments(filter),
    ]);
    res.json({ songs, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.listAdminAlbums = async (req, res) => {
  try {
    res.json(await Album.find().sort({ createdAt: -1 }).populate('artisteId','nom'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getAdminShares = async (req, res) => {
  try {
    const shares = await ShareHistory.find().sort({ createdAt: -1 }).limit(100)
      .populate('songId', 'titre artiste image')
      .populate('sharedBy', 'nom email');
    res.json(shares);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ══════════════════════════════════════════════
// SOCIAL — Comments, Reactions, History, Notifs
// ══════════════════════════════════════════════
exports.getComments = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const [comments, total] = await Promise.all([
      Comment.find({ songId: req.params.id }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).select('-__v'),
      Comment.countDocuments({ songId: req.params.id }),
    ]);
    const { verifyToken } = require('../middleware/auth');
    const t   = req.headers.authorization?.split(' ')[1];
    let uid = null;
    if (t) { try { uid = verifyToken(t).id; } catch {} }
    res.json({
      comments: comments.map(c => ({ ...c.toObject(), likedByMe: uid ? c.likedBy.some(id => String(id) === String(uid)) : false })),
      pagination: { page, limit, total, pages: Math.ceil(total/limit) },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.addComment = async (req, res) => {

  // Après avoir sauvegardé le commentaire :
  const { addPoints, analyzeCommentSentiment } = require('../routes/analyticsRoutes');
  addPoints(req.user.id, 'comment', String(req.params.id)).catch(() => {});
  // Re-analyser le sentiment toutes les 10 commentaires
  Comment.countDocuments({ songId: req.params.id }).then(count => {
    if (count % 10 === 0) analyzeCommentSentiment(req.params.id).catch(() => {});
  });
  try {
    const { texte, auteur } = req.body;
    if (!texte?.trim()) return res.status(400).json({ message: 'Texte requis' });
    const comment = await new Comment({
      songId: req.params.id, texte: texte.trim(),
      auteur: auteur || req.user.nom || req.user.email, userId: req.user.id,
    }).save();
    // Notifier l'artiste
    try {
      const song = await Song.findById(req.params.id).populate('artisteId','email');
      if (song?.artisteId?.email) {
        const au = await User.findOne({ email: song.artisteId.email });
        if (au && String(au._id) !== String(req.user.id))
          await Notification.create({ userId: au._id, type: 'comment', titre: `Nouveau commentaire sur "${song.titre}"`, message: `${req.user.nom||req.user.email} : "${texte.trim().slice(0,60)}"`, songId: req.params.id });
      }
    } catch {}
    res.json(comment);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.likeComment = async (req, res) => {
  try {
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    const uid    = req.user.id;
    const liked  = c.likedBy.some(id => String(id) === String(uid));
    if (liked) { c.likedBy = c.likedBy.filter(id => String(id) !== String(uid)); c.likes = Math.max(0, c.likes - 1); }
    else { c.likedBy.push(uid); c.likes++; }
    await c.save();
    res.json({ ...c.toObject(), likedByMe: !liked });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.replyComment = async (req, res) => {
  try {
    const { texte, auteur } = req.body;
    if (!texte?.trim()) return res.status(400).json({ message: 'Texte requis' });
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    c.reponses.push({ texte: texte.trim(), auteur: auteur || req.user.nom || req.user.email, userId: req.user.id });
    res.json(await c.save());
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.deleteComment = async (req, res) => {
  try {
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    if (String(c.userId) !== String(req.user.id) && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Accès refusé' });
    await Comment.findByIdAndDelete(req.params.cid);
    res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getReactions = async (req, res) => {
  try {
    const list = await Reaction.find({ songId: req.params.id });
    const counts = { fire: 0, heart: 0, star: 0 };
    list.forEach(r => { if (counts[r.type] !== undefined) counts[r.type]++; });
    const { verifyToken } = require('../middleware/auth');
    const t = req.headers.authorization?.split(' ')[1];
    let userReaction = null;
    if (t) { try { const d = verifyToken(t); const m = list.find(r => String(r.userId) === String(d.id)); if (m) userReaction = m.type; } catch {} }
    res.json({ ...counts, userReaction });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.addReaction = async (req, res) => {
  try {
    const { type } = req.body;
    if (!['fire','heart','star'].includes(type)) return res.status(400).json({ message: 'Type invalide' });
    const ex = await Reaction.findOne({ songId: req.params.id, userId: req.user.id });
    if (ex) { if (ex.type === type) await Reaction.deleteOne({ _id: ex._id }); else { ex.type = type; await ex.save(); } }
    else await new Reaction({ songId: req.params.id, userId: req.user.id, type }).save();
    if (type === 'heart' && !ex) {
      try {
        const song = await Song.findById(req.params.id).populate('artisteId','email');
        if (song?.artisteId?.email) { const au = await User.findOne({ email: song.artisteId.email }); if (au && String(au._id) !== String(req.user.id)) await Notification.create({ userId: au._id, type: 'reaction', titre: `❤️ ${req.user.nom||req.user.email} adore "${song.titre}"`, message: '', songId: req.params.id }); }
      } catch {}
    }
    const list   = await Reaction.find({ songId: req.params.id });
    const counts = { fire: 0, heart: 0, star: 0 };
    list.forEach(r => { if (counts[r.type] !== undefined) counts[r.type]++; });
    const m = list.find(r => String(r.userId) === String(req.user.id));
    res.json({ ...counts, userReaction: m ? m.type : null });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const [entries, total] = await Promise.all([
      History.find({ userId: req.user.id }).sort({ playedAt: -1 }).skip((page-1)*limit).limit(limit).populate('songId','titre artiste image src plays liked'),
      History.countDocuments({ userId: req.user.id }),
    ]);
    res.json({ history: entries.map(e => ({ _id: e._id, playedAt: e.playedAt, song: e.songId })), pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getHistoryStats = async (req, res) => {
  try {
    const [topSongs, totalEcoutes, joursAgg] = await Promise.all([
      History.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id: '$songId', count: { $sum: 1 }, lastPlayed: { $max: '$playedAt' } } },
        { $sort: { count: -1 } }, { $limit: 10 },
        { $lookup: { from: 'songs', localField: '_id', foreignField: '_id', as: 'song' } },
        { $unwind: '$song' },
        { $project: { count: 1, lastPlayed: 1, 'song.titre': 1, 'song.artiste': 1, 'song.image': 1 } },
      ]),
      History.countDocuments({ userId: req.user.id }),
      History.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$playedAt' } } } },
        { $count: 'total' },
      ]),
    ]);
    res.json({ topSongs, totalEcoutes, joursActifs: joursAgg[0]?.total || 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.clearHistory = async (req, res) => {
  try { await History.deleteMany({ userId: req.user.id }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getRecommendations = async (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit) || 12);
    const topArtists = await History.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
      { $lookup: { from: 'songs', localField: 'songId', foreignField: '_id', as: 'song' } },
      { $unwind: '$song' },
      { $group: { _id: '$song.artisteId', count: { $sum: 1 } } },
      { $sort: { count: -1 } }, { $limit: 5 }, { $match: { _id: { $ne: null } } },
    ]);
    const alreadyPlayed = await History.distinct('songId', { userId: req.user.id });
    let reco = [];
    if (topArtists.length > 0) {
      reco = await Song.find({ artisteId: { $in: topArtists.map(a => a._id) }, _id: { $nin: alreadyPlayed } })
        .sort({ plays: -1 }).limit(limit).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    }
    if (reco.length < limit) {
      const extra = await Song.find({ _id: { $nin: [...alreadyPlayed, ...reco.map(s => s._id)] } })
        .sort({ plays: -1 }).limit(limit - reco.length).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
      reco = [...reco, ...extra];
    }
    if (reco.length === 0) reco = await Song.find().sort({ plays: -1 }).limit(limit).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    res.json({ recommendations: reco, basedOn: topArtists.length > 0 ? 'history' : 'popular', message: topArtists.length > 0 ? `Basé sur vos ${alreadyPlayed.length} écoutes` : 'Populaires du moment' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getNotifications = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const filter = { userId: req.user.id };
    if (req.query.unread === 'true') filter.lu = false;
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ lu: 1, createdAt: -1 }).skip((page-1)*limit).limit(limit)
        .populate('songId','titre image artiste').populate('albumId','titre image'),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: req.user.id, lu: false }),
    ]);
    res.json({ notifications, unreadCount, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getUnreadCount = async (req, res) => {
  try {
    res.set('Cache-Control','no-store');
    res.json({ count: await Notification.countDocuments({ userId: req.user.id, lu: false }) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.markAllRead = async (req, res) => {
  try { await Notification.updateMany({ userId: req.user.id, lu: false }, { lu: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

exports.markOneRead = async (req, res) => {
  try { await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { lu: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

exports.clearNotifications = async (req, res) => {
  try { await Notification.deleteMany({ userId: req.user.id, lu: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

// ══════════════════════════════════════════════
// NEWSLETTER BROADCAST
// ══════════════════════════════════════════════

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Envoi séquentiel par petits paquets, avec pause entre chaque paquet.
// Évite que Gmail bride/bloque temporairement le compte en cas d'envoi massif simultané.
const BATCH_SIZE  = 5;    // emails envoyés en parallèle par paquet
const BATCH_DELAY = 2000; // pause (ms) entre deux paquets

exports.broadcastNewsletter = async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject?.trim() || !message?.trim())
      return res.status(400).json({ message: 'Sujet et message requis' });

    const users  = await User.find({}, 'email').lean();
    const emails = users.map(u => u.email).filter(Boolean);

    const htmlContent = `<p>${message.trim().replace(/\n/g, '<br>')}</p>`;
    let sent = 0, failed = 0;

    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(email =>
          sendMail({
            to:      email,
            subject: subject.trim(),
            html:    htmlContent,
          })
        )
      );
      results.forEach(r => { r.status === 'fulfilled' ? sent++ : failed++; });

      // Pause entre paquets, sauf après le dernier
      if (i + BATCH_SIZE < emails.length) await sleep(BATCH_DELAY);
    }

    res.json({ sent, failed, total: emails.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.banUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    
    const newBanned = !(user.banned ?? false);
    
    await User.findByIdAndUpdate(req.params.id, { $set: { banned: newBanned } });
    
    res.json({ 
      banned: newBanned, 
      message: newBanned ? 'Utilisateur banni' : 'Ban levé' 
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};