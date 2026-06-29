const { Song, UserFavorite, UserPlay, History, Notification, ShareHistory, User } = require('../models');
const { toCloud, fromCloud, IMG_TRANSFORM }  = require('../middleware/upload');
const { signToken, verifyToken } = require('../middleware/auth');

// Polyfill fetch pour Node < 18
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ── GET /songs ────────────────────────────────
exports.listSongs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 30);
    const filter = {};
    if (req.query.q)        { const re = new RegExp(req.query.q, 'i'); filter.$or = [{ titre: re }, { artiste: re }]; }
    if (req.query.albumId)   filter.albumId   = req.query.albumId;
    if (req.query.artisteId) filter.artisteId = req.query.artisteId;

    const [songs, total] = await Promise.all([
      Song.find(filter).sort({ ordre: 1, createdAt: -1 })
        .skip((page - 1) * limit).limit(limit)
        .select('-audioPublicId -imagePublicId -__v')
        .populate('artisteId', 'nom image'),
      Song.countDocuments(filter),
    ]);

    // Injecter liked par utilisateur connecté
    let likedSet = new Set();
    const t = req.headers.authorization?.split(' ')[1];
    if (t) {
      try {
        const d = verifyToken(t);
        if (d?.id) {
          const favs = await UserFavorite.find({ userId: d.id }).select('songId');
          favs.forEach(f => likedSet.add(String(f.songId)));
        }
      } catch {}
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      songs: songs.map(s => ({ ...s.toObject(), liked: likedSet.has(String(s._id)) })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /songs/favorites ──────────────────────
exports.getFavorites = async (req, res) => {
  try {
    const favs = await UserFavorite.find({ userId: req.user.id }).select('songId');
    const songs = await Song.find({ _id: { $in: favs.map(f => f.songId) } })
      .select('-audioPublicId -imagePublicId -__v')
      .populate('artisteId', 'nom image');
    res.json(songs.map(s => ({ ...s.toObject(), liked: true })));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /songs/meta ───────────────────────────
exports.getMeta = async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=10');
    res.json(await Song.find().sort({ ordre: 1, createdAt: -1 }).select('_id updatedAt plays liked'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── PUT /songs/:id/like ───────────────────────
exports.toggleLike = async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const existing = await UserFavorite.findOne({ userId: req.user.id, songId: req.params.id });
    if (existing) await UserFavorite.deleteOne({ _id: existing._id });
    else await new UserFavorite({ userId: req.user.id, songId: req.params.id }).save();
    res.json({ ...song.toObject(), liked: !existing });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── PUT /songs/:id/play ───────────────────────
exports.registerPlay = async (req, res) => {
  try {
    // 1. Fetch song — ne pas incrémenter ici : playController.recordPlay
    //    s'en charge déjà via $inc: { plays: 1 }. Double appel = double comptage.
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });

    // 2. Decode token (used by multiple branches below)
    const t = req.headers.authorization?.split(' ')[1];
    let d = null;
    if (t) {
      try { d = verifyToken(t); } catch {}
    }

    // 3. User history tracking
    if (d?.role === 'user' || d?.role === 'artist') {
      await UserPlay.findOneAndUpdate(
        { userId: d.id, songId: req.params.id },
        { $inc: { count: 1 } },
        { upsert: true }
      );
      await History.create({ userId: d.id, songId: req.params.id });
      const cnt = await History.countDocuments({ userId: d.id });
      if (cnt > 500) {
        const oldest = await History.find({ userId: d.id })
          .sort({ playedAt: 1 })
          .limit(cnt - 500)
          .select('_id');
        await History.deleteMany({ _id: { $in: oldest.map(o => o._id) } });
      }
    }

    // 4. Share token tracking
    const shareToken = req.body?.shareToken || req.query?.shareToken;
    if (shareToken) {
      await ShareHistory.findOneAndUpdate(
        { shareToken },
        { $inc: { playCount: 1 } }
      ).catch(() => {});
    }

    // 5. Fire-and-forget side effects (after main work is done)
    const { trackDemographics, addPoints } = require('../routes/analyticsRoutes');

    if (song.artisteId) {
      trackDemographics(song.artisteId, req).catch(() => {});
    }

    fetch(`${process.env.BASE_URL || 'http://localhost:5000'}/songs/${req.params.id}/geo-play`, {
      method: 'POST',
      headers: req.headers,
    }).catch(() => {});

    if (d?.role === 'user') {
      addPoints(d.id, 'play', String(req.params.id)).catch(() => {});
    }

    res.json({ plays: song.plays });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── POST /upload ──────────────────────────────
exports.upload = async (req, res) => {
  try {
    const { Artist } = require('../models');
    const audioBuf = req.files['audio']?.[0]?.buffer;
    const imgBuf   = req.files['image']?.[0]?.buffer;
    const origName = req.files['audio']?.[0]?.originalname || 'track.mp3';
    const srcUrl   = req.body.src?.trim();

    if (!audioBuf && !srcUrl)
      return res.status(400).json({ message: 'Fichier audio manquant' });

    const isArtist  = req.user.role === 'artist';
    const artisteId = isArtist ? req.user.id : (req.body.artisteId || null);
    let artisteName = 'Artiste Local';
    if (isArtist) artisteName = req.user.nom;
    else if (artisteId) {
      const a = await Artist.findById(artisteId);
      if (a) artisteName = a.nom;
    } else if (req.body.artiste) {
      artisteName = req.body.artiste;
    }

    // Audio : upload Cloudinary ou URL directe
    let audioResult = { secure_url: '', public_id: '' };
    if (audioBuf) {
      audioResult = await toCloud(audioBuf, {
        folder: 'moozik/audio', resource_type: 'video', format: 'mp3'
      });
    } else {
      audioResult.secure_url = srcUrl;
      audioResult.public_id  = '';
    }

    // Image : upload Cloudinary ou avatar généré
    let imageUrl      = `https://api.dicebear.com/7.x/shapes/svg?seed=${Date.now()}`;
    let imagePublicId = '';
    if (imgBuf) {
      const ir  = await toCloud(imgBuf, {
        folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM
      });
      imageUrl      = ir.secure_url;
      imagePublicId = ir.public_id;
    }

    const count   = await Song.countDocuments();
    const newSong = await new Song({
      titre:         req.body.titre || origName.replace(/\.(mp3|mpeg)$/i, '').replace(/_/g, ' '),
      artiste:       artisteName,
      artisteId:     artisteId || null,
      albumId:       req.body.albumId || null,
      src:           audioResult.secure_url,
      audioPublicId: audioResult.public_id,
      image:         imageUrl,
      imagePublicId,
      ordre:         count,
      annee:         req.body.annee ? Number(req.body.annee) : null,
      genre:         req.body.genre || null,
      moods:         req.body.moods ? JSON.parse(req.body.moods) : [],
    }).save();

    // Notifier tous les utilisateurs
    const users = await User.find().select('_id');
    if (users.length) {
      await Notification.insertMany(users.map(u => ({
        userId:  u._id,
        type:    'new_song',
        titre:   `🎵 Nouveau titre : ${newSong.titre}`,
        message: `${artisteName} vient d'ajouter une nouvelle musique`,
        songId:  newSong._id,
      })));
    }

    res.json(newSong);
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ message: e.message });
  }
};

// ── PUT /songs/:id ────────────────────────────
exports.updateSong = async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id))
      return res.status(403).json({ message: 'Accès refusé' });

    const u = {};
    if (req.body.titre)   u.titre = req.body.titre;
    if (req.body.artiste  && req.user.role === 'admin') u.artiste  = req.body.artiste;
    if (req.body.artisteId !== undefined && req.user.role === 'admin') u.artisteId = req.body.artisteId || null;
    if (req.body.albumId  !== undefined) u.albumId = req.body.albumId || null;
    if (req.body.genre)   u.genre = req.body.genre;
    if (req.body.annee)   u.annee = req.body.annee;
    // Handle moods — sent as JSON string from FormData
    if (req.body.moods) {
      try {
        u.moods = typeof req.body.moods === 'string' ? JSON.parse(req.body.moods) : req.body.moods;
      } catch {
        u.moods = [];
      }
    }
    if (req.file) {
      await fromCloud(song.imagePublicId);
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      u.image = r.secure_url; u.imagePublicId = r.public_id;
    }
    res.json(await Song.findByIdAndUpdate(req.params.id, u, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── DELETE /songs/:id ─────────────────────────
exports.deleteSong = async (req, res) => {
  try {
    const { Comment, Reaction, UserPlay, History } = require('../models');
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id))
      return res.status(403).json({ message: 'Accès refusé' });
    await fromCloud(song.audioPublicId, 'video');
    await fromCloud(song.imagePublicId);
    await Promise.all([
      Comment.deleteMany({ songId: req.params.id }),
      Reaction.deleteMany({ songId: req.params.id }),
      UserPlay.deleteMany({ songId: req.params.id }),
      History.deleteMany({ songId: req.params.id }),
    ]);
    await Song.findByIdAndDelete(req.params.id);
    res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── PUT /songs/reorder ────────────────────────
exports.reorder = async (req, res) => {
  try {
    const { orderedIds } = req.body;
    await Promise.all(orderedIds.map((id, i) => Song.findByIdAndUpdate(id, { ordre: i })));
    res.json({ message: 'Ordre mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── POST /songs/:id/share ─────────────────────
exports.createShare = async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).select('titre artiste image');
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const expiresAt   = new Date(Date.now() + 7 * 86400000);
    const shareToken  = signToken({ songId: song._id, type: 'share' }, '7d');
    let sharedBy = null;
    const t = req.headers.authorization?.split(' ')[1];
    if (t) { try { sharedBy = verifyToken(t).id; } catch {} }
    await ShareHistory.findOneAndUpdate({ shareToken }, { songId: song._id, sharedBy, shareToken, expiresAt }, { upsert: true });
    res.json({ shareToken, song: { titre: song.titre, artiste: song.artiste, image: song.image }, expiresIn: '7 jours' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /share/:token ─────────────────────────
exports.resolveShare = async (req, res) => {
  try {
    const decoded = verifyToken(req.params.token);
    if (decoded.type !== 'share') return res.status(400).json({ message: 'Token invalide' });
    const song = await Song.findById(decoded.songId)
      .select('-audioPublicId -imagePublicId -__v')
      .populate('artisteId', 'nom image');
    if (!song) return res.status(404).json({ message: 'Musique introuvable' });
    await ShareHistory.findOneAndUpdate({ shareToken: req.params.token }, { $inc: { viewCount: 1 } });
    res.json({ song, shared: true });
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(410).json({ message: 'Lien expiré' });
    res.status(400).json({ message: 'Lien invalide' });
  }
};

// ── PUT /share/:token/play ────────────────────
exports.trackSharePlay = async (req, res) => {
  try {
    await ShareHistory.findOneAndUpdate({ shareToken: req.params.token }, { $inc: { playCount: 1 } });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
};

// ── GET /my-shares ────────────────────────────
exports.myShares = async (req, res) => {
  try {
    const shares = await ShareHistory.find({ sharedBy: req.user.id })
      .sort({ createdAt: -1 }).limit(50)
      .populate('songId', 'titre artiste image plays');
    res.json(shares);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /songs/:id/similar ────────────────────
exports.similar = async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).select('artisteId albumId artiste');
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const similar = await Song.find({
      _id: { $ne: req.params.id },
      $or: [{ artisteId: song.artisteId || null }, { albumId: song.albumId || null }, { artiste: song.artiste }],
    }).sort({ plays: -1 }).limit(8).select('titre artiste image src plays liked').populate('artisteId', 'nom');
    res.set('Cache-Control', 'public, max-age=120');
    res.json(similar);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /search (legacy) ──────────────────────
exports.search = async (req, res) => {
  try {
    const q = req.query.q;
    res.json(await Song.find({ $or: [{ titre: { $regex: q, $options: 'i' } }, { artiste: { $regex: q, $options: 'i' } }] }));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── GET /search/global ────────────────────────
exports.globalSearch = async (req, res) => {
  try {
    const q = req.query.q;
    if (!q?.trim()) return res.json({ songs: [], artists: [], albums: [], playlists: [] });
    const re = new RegExp(q.trim(), 'i');
    const { Artist, Album, UserPlaylist } = require('../models');
    const [songs, artists, albums, playlists] = await Promise.all([
      Song.find({ $or: [{ titre: re }, { artiste: re }] }).limit(8).select('-audioPublicId -imagePublicId -__v').populate('artisteId', 'nom image'),
      Artist.find({ nom: re }).limit(5).select('-password -imagePublicId -__v'),
      Album.find({ $or: [{ titre: re }, { artiste: re }] }).limit(5).select('-imagePublicId -__v'),
      UserPlaylist.find({ isPublic: true, nom: re }).limit(5).populate('userId', 'nom').select('-__v'),
    ]);
    res.json({ songs, artists, albums, playlists });
  } catch (e) { res.status(500).json({ message: e.message }); }
};