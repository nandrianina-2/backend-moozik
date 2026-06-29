require('dotenv').config();

const express     = require('express');
const multer      = require('multer');
const mongoose    = require('mongoose');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const compression = require('compression');
const { v2: cloudinary } = require('cloudinary');

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB :', err));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ok = ['audio/mpeg','audio/mp3','image/jpeg','image/png','image/webp','image/gif'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Type non supporté'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

const toCloud = (buffer, opts) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(opts, (err, r) => err ? reject(err) : resolve(r)).end(buffer);
  });

const fromCloud = async (publicId, rt = 'image') => {
  if (!publicId) return;
  try { await cloudinary.uploader.destroy(publicId, { resource_type: rt }); }
  catch (e) { console.warn('Cloudinary destroy:', e.message); }
};

const IMG_TRANSFORM = [{ width: 400, height: 400, crop: 'fill', gravity: 'auto', quality: 70, fetch_format: 'auto' }];
const AVT_TRANSFORM = [{ width: 200, height: 200, crop: 'fill', quality: 75, fetch_format: 'auto' }];

// ── SCHEMAS ───────────────────────────────────

const ArtistSchema = new mongoose.Schema({
  nom: { type: String, required: true }, bio: { type: String, default: '' },
  image: { type: String, default: '' }, imagePublicId: { type: String, default: '' },
  email: { type: String, unique: true, sparse: true }, password: String,
  role: { type: String, default: 'artist' }
}, { timestamps: true });
const Artist = mongoose.model('Artist', ArtistSchema);

const AlbumSchema = new mongoose.Schema({
  titre: { type: String, required: true },
  artisteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  artiste: { type: String, default: '' }, annee: { type: String, default: '' },
  image: { type: String, default: '' }, imagePublicId: { type: String, default: '' },
}, { timestamps: true });
const Album = mongoose.model('Album', AlbumSchema);

const ReponseSchema = new mongoose.Schema({
  auteur: String, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  texte: { type: String, required: true }, createdAt: { type: Date, default: Date.now }
});

const CommentSchema = new mongoose.Schema({
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  auteur: String, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  texte: { type: String, required: true }, likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reponses: [ReponseSchema]
}, { timestamps: true });
const Comment = mongoose.model('Comment', CommentSchema);

const ReactionSchema = new mongoose.Schema({
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  userId: { type: String, required: true },
  type: { type: String, enum: ['fire', 'heart', 'star'], required: true }
}, { timestamps: true });
ReactionSchema.index({ songId: 1, userId: 1 }, { unique: true });
const Reaction = mongoose.model('Reaction', ReactionSchema);

const UserPlaySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  count: { type: Number, default: 1 }
}, { timestamps: true });
UserPlaySchema.index({ userId: 1, songId: 1 }, { unique: true });
const UserPlay = mongoose.model('UserPlay', UserPlaySchema);

const UserFavoriteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
}, { timestamps: true });
UserFavoriteSchema.index({ userId: 1, songId: 1 }, { unique: true });
const UserFavorite = mongoose.model('UserFavorite', UserFavoriteSchema);

const HistorySchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  songId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  playedAt: { type: Date, default: Date.now },
}, { timestamps: false });
HistorySchema.index({ userId: 1, playedAt: -1 });
const History = mongoose.model('History', HistorySchema);

const NotificationSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:    { type: String, enum: ['new_song','comment','reaction','new_album'], required: true },
  titre:   { type: String, required: true }, message: { type: String, default: '' },
  songId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Song', default: null },
  albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album', default: null },
  lu:      { type: Boolean, default: false },
}, { timestamps: true });
NotificationSchema.index({ userId: 1, lu: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', NotificationSchema);

const ShareHistorySchema = new mongoose.Schema({
  songId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  sharedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  shareToken:{ type: String, required: true },
  viewCount: { type: Number, default: 0 },
  playCount: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
ShareHistorySchema.index({ shareToken: 1 }, { unique: true });
ShareHistorySchema.index({ sharedBy: 1, createdAt: -1 });
const ShareHistory = mongoose.model('ShareHistory', ShareHistorySchema);

const SongSchema = new mongoose.Schema({
  titre: String, artiste: String,
  artisteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', default: null },
  albumId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Album', default: null },
  image: String, imagePublicId: { type: String, default: '' },
  src: String, audioPublicId: { type: String, default: '' },
  liked: { type: Boolean, default: false }, plays: { type: Number, default: 0 }, ordre: { type: Number, default: 0 }
}, { timestamps: true });
const Song = mongoose.model('Song', SongSchema);

const PlaylistSchema = new mongoose.Schema({
  nom: String, musiques: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }]
}, { timestamps: true });
const Playlist = mongoose.model('Playlist', PlaylistSchema);

const UserPlaylistSchema = new mongoose.Schema({
  nom: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  musiques: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
  isPublic: { type: Boolean, default: false }
}, { timestamps: true });
const UserPlaylist = mongoose.model('UserPlaylist', UserPlaylistSchema);

const AdminSchema = new mongoose.Schema({
  email: { type: String, unique: true }, password: String,
  nom: { type: String, default: '' }, role: { type: String, default: 'admin' },
  isPrimary: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
}, { timestamps: true });
const Admin = mongoose.model('Admin', AdminSchema);

const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true }, password: { type: String, required: true },
  nom: { type: String, default: '' }, avatar: { type: String, default: '' },
  avatarPublicId: { type: String, default: '' }, role: { type: String, default: 'user' }
}, { timestamps: true });
const User = mongoose.model('User', UserSchema);

// ── INDEX ─────────────────────────────────────
Song.collection.createIndex({ ordre: 1, createdAt: -1 }).catch(() => {});
Song.collection.createIndex({ artisteId: 1 }).catch(() => {});
Song.collection.createIndex({ albumId: 1 }).catch(() => {});
Song.collection.createIndex({ plays: -1 }).catch(() => {});
Song.collection.createIndex({ titre: 'text', artiste: 'text' }).catch(() => {});
Comment.collection.createIndex({ songId: 1, createdAt: -1 }).catch(() => {});
Album.collection.createIndex({ artisteId: 1 }).catch(() => {});
UserPlaylist.collection.createIndex({ userId: 1 }).catch(() => {});
Notification.collection.createIndex({ userId: 1, lu: 1 }).catch(() => {});

// ── MIDDLEWARES JWT ───────────────────────────
const requireAdmin = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non autorisé' });
  try { req.admin = jwt.verify(t, process.env.JWT_SECRET); if (req.admin.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' }); next(); }
  catch { res.status(401).json({ message: 'Token invalide' }); }
};
const requireArtist = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non autorisé' });
  try { const d = jwt.verify(t, process.env.JWT_SECRET); if (d.role !== 'artist' && d.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' }); req.user = d; next(); }
  catch { res.status(401).json({ message: 'Token invalide' }); }
};
const requireAdminOrArtist = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non autorisé' });
  try { req.user = jwt.verify(t, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Token invalide' }); }
};
const requireAuth = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non autorisé' });
  try { req.user = jwt.verify(t, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Token invalide' }); }
};

const notifyAllUsers = async (type, titre, message, extra = {}) => {
  try {
    const users = await User.find().select('_id');
    if (!users.length) return;
    await Notification.insertMany(users.map(u => ({ userId: u._id, type, titre, message, ...extra })));
  } catch (e) { console.warn('notifyAllUsers:', e.message); }
};

// ── AUTH ADMIN ───────────────────────────────
app.post('/admin/register', async (req, res) => {
  try {
    const { email, password, secret } = req.body;
    if (secret !== process.env.REGISTER_SECRET) return res.status(403).json({ message: 'Secret invalide' });
    if (await Admin.findOne({ email })) return res.status(400).json({ message: 'Admin déjà existant' });
    const isPrimary = (await Admin.countDocuments()) === 0;
    await new Admin({ email, password: await bcrypt.hash(password, 12), isPrimary }).save();
    res.json({ message: isPrimary ? 'Admin principal créé ✅' : 'Admin créé ✅' });
  } catch (e) { res.status(500).json(e); }
});
app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin || !await bcrypt.compare(password, admin.password)) return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id: admin._id, email: admin.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email: admin.email, role: 'admin' });
  } catch (e) { res.status(500).json(e); }
});
app.get('/admin/verify', requireAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id).select('-password');
    res.json({ valid: true, email: req.admin.email, role: 'admin', nom: admin?.nom || '', isPrimary: admin?.isPrimary || false });
  } catch { res.json({ valid: true, email: req.admin.email, role: 'admin' }); }
});
// Lister tous les admins (admin principal seulement)
app.get('/admin/admins', requireAdmin, async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: `Réservé à l'admin principal` });
    res.json(await Admin.find().select('-password').sort({ createdAt: 1 }));
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Créer un nouvel admin (admin principal seulement)
app.post('/admin/admins', requireAdmin, async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: `Réservé à l'admin principal` });
    const { email, password, nom } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email et mot de passe requis' });
    if (await Admin.findOne({ email })) return res.status(400).json({ message: `Email déjà utilisé` });
    const admin = await new Admin({ email, password: await bcrypt.hash(password, 12), nom: nom || '', createdBy: req.admin.id }).save();
    res.json({ ...admin.toObject(), password: undefined });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Modifier un admin (admin principal seulement)
app.put('/admin/admins/:id', requireAdmin, async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary && String(req.admin.id) !== String(req.params.id)) return res.status(403).json({ message: `Accès refusé` });
    const { nom, email, password } = req.body;
    const update = {};
    if (nom !== undefined) update.nom = nom;
    if (email) update.email = email;
    if (password && password.length >= 6) update.password = await bcrypt.hash(password, 12);
    const updated = await Admin.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    res.json(updated);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Supprimer un admin (admin principal seulement, ne peut pas se supprimer lui-même)
app.delete('/admin/admins/:id', requireAdmin, async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: `Réservé à l'admin principal` });
    if (String(req.params.id) === String(req.admin.id)) return res.status(400).json({ message: `Impossible de se supprimer soi-même` });
    const target = await Admin.findById(req.params.id);
    if (target?.isPrimary) return res.status(400).json({ message: `Impossible de supprimer l'admin principal` });
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ message: 'Admin supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Recherche globale
app.get('/search/global', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.trim().length < 1) return res.json({ songs: [], artists: [], albums: [], playlists: [] });
    const re = new RegExp(q.trim(), 'i');
    const [songs, artists, albums, playlists] = await Promise.all([
      Song.find({ $or: [{ titre: re }, { artiste: re }] }).limit(8).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image'),
      Artist.find({ nom: re }).limit(5).select('-password -imagePublicId -__v'),
      Album.find({ $or: [{ titre: re }, { artiste: re }] }).limit(5).select('-imagePublicId -__v'),
      UserPlaylist.find({ isPublic: true, nom: re }).limit(5).populate('userId','nom').select('-__v'),
    ]);
    res.json({ songs, artists, albums, playlists });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Utilisateurs actifs (dernières 15 minutes via websocket listeners)
app.get('/admin/active-users', requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recentHistory = await History.aggregate([
      { $match: { playedAt: { $gte: since } } },
      { $group: { _id: '$userId' } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { 'user.nom': 1, 'user.email': 1, 'user.avatar': 1, _id: 1 } }
    ]);
    res.json({ count: recentHistory.length, users: recentHistory.map(r => r.user) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
// Musiques sans artiste assigné
app.get('/admin/unassigned-songs', requireAdmin, async (req, res) => {
  try {
    const songs = await Song.find({ $or: [{ artisteId: null }, { artisteId: { $exists: false } }, { artiste: '' }] })
      .select('titre artiste image createdAt').sort({ createdAt: -1 });
    res.json({ count: songs.length, songs });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/admin/profile', requireAdmin, async (req, res) => {
  try { const { nom } = req.body; if (!nom?.trim()) return res.status(400).json({ message: 'Nom requis' }); res.json({ message: 'Profil mis à jour', nom: nom.trim() }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/admin/password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const admin = await Admin.findById(req.admin.id);
    if (!admin || !await bcrypt.compare(currentPassword, admin.password)) return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    admin.password = await bcrypt.hash(newPassword, 12); await admin.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── ADMIN: USERS ─────────────────────────────
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const enriched = await Promise.all(users.map(async (u) => {
      const [totalPlaylists, totalLikes, totalPlays] = await Promise.all([
        UserPlaylist.countDocuments({ userId: u._id }),
        Reaction.countDocuments({ userId: String(u._id), type: 'heart' }),
        UserPlay.aggregate([{ $match: { userId: u._id } }, { $group: { _id: null, total: { $sum: '$count' } } }]).then(r => r[0]?.total || 0)
      ]);
      return { ...u.toObject(), totalPlaylists, totalLikes, totalPlays };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/admin/users/:id/stats', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    const [totalPlaylists, totalComments, playsAgg, topPlaysRaw] = await Promise.all([
      UserPlaylist.countDocuments({ userId: user._id }),
      Comment.countDocuments({ userId: user._id }),
      UserPlay.aggregate([{ $match: { userId: user._id } }, { $group: { _id: null, total: { $sum: '$count' } } }]),
      UserPlay.find({ userId: user._id }).sort({ count: -1 }).limit(10).populate('songId', 'titre artiste image plays')
    ]);
    const reactions = await Reaction.find({ userId: String(user._id), type: 'heart' });
    const likedSongs = await Song.find({ _id: { $in: reactions.map(r => r.songId) } }).select('titre artiste image plays').limit(10);
    res.json({ user, totalPlays: playsAgg[0]?.total || 0, totalPlaylists, totalComments, totalLikes: reactions.length, topSongs: topPlaysRaw.filter(p => p.songId).map(p => ({ ...p.songId.toObject(), userPlays: p.count })), likedSongs });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { nom, email } = req.body; const update = {};
    if (nom) update.nom = nom; if (email) update.email = email;
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await Promise.all([UserPlaylist.deleteMany({ userId: req.params.id }), Comment.deleteMany({ userId: req.params.id }), Reaction.deleteMany({ userId: req.params.id }), UserPlay.deleteMany({ userId: req.params.id }), History.deleteMany({ userId: req.params.id }), Notification.deleteMany({ userId: req.params.id })]);
    res.json({ message: 'Utilisateur supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── AUTH USER ────────────────────────────────
app.post('/users/register', async (req, res) => {
  try {
    const { email, password, nom } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email et mot de passe requis' });
    if (await User.findOne({ email })) return res.status(400).json({ message: 'Email déjà utilisé' });
    const user = await new User({ email, password: await bcrypt.hash(password, 12), nom: nom || email.split('@')[0] }).save();
    const token = jwt.sign({ id: user._id, email: user.email, nom: user.nom, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, nom: user.nom, role: 'user', userId: user._id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id: user._id, email: user.email, nom: user.nom, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, nom: user.nom, role: 'user', userId: user._id, avatar: user.avatar || '' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/users/verify', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.json({ valid: false });
    res.json({ valid: true, ...req.user, avatar: user.avatar || '', nom: user.nom || req.user.nom });
  } catch { res.json({ valid: true, ...req.user }); }
});
app.put('/users/:id', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.id) && req.user.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' });
    const update = {};
    if (req.body.nom) update.nom = req.body.nom;
    if (req.body.email) update.email = req.body.email;
    if (req.file) {
      const old = await User.findById(req.params.id);
      if (old?.avatarPublicId) await fromCloud(old.avatarPublicId);
      const r = await toCloud(req.file.buffer, { folder: 'moozik/avatars', resource_type: 'image', transformation: AVT_TRANSFORM });
      update.avatar = r.secure_url; update.avatarPublicId = r.public_id;
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/users/:id/password', requireAuth, async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.id) && req.user.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const user = await User.findById(req.params.id);
    if (!user || !await bcrypt.compare(currentPassword, user.password)) return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    user.password = await bcrypt.hash(newPassword, 12); await user.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── PROFIL PUBLIC UTILISATEUR ───────────────
app.get('/users/:id/profile', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('nom avatar role createdAt');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/users/:id/playlists', async (req, res) => {
  try {
    const playlists = await UserPlaylist.find({ userId: req.params.id, isPublic: true })
      .populate('musiques', 'titre artiste image src plays')
      .sort({ createdAt: -1 });
    res.json(playlists.map(p => ({ ...p.toObject(), songs: p.musiques })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/users/:id/favorites', async (req, res) => {
  try {
    const favs = await UserFavorite.find({ userId: req.params.id }).select('songId');
    const songs = await Song.find({ _id: { $in: favs.map(f => f.songId) } })
      .select('-audioPublicId -imagePublicId -__v');
    res.json(songs.map(s => ({ ...s.toObject(), liked: true })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── AUTH ARTISTE ─────────────────────────────
app.post('/artists', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { nom, bio, email, password } = req.body;
    if (!nom?.trim()) return res.status(400).json({ message: 'Nom requis' });
    let imageUrl = '', imagePublicId = '';
    if (req.file) {
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      imageUrl = r.secure_url; imagePublicId = r.public_id;
    }
    const artist = await new Artist({
      nom: nom.trim(), bio: bio || '', email: email || undefined,
      password: password ? await bcrypt.hash(password, 12) : null,
      image: imageUrl, imagePublicId
    }).save();
    res.json(artist);
  } catch (e) { res.status(500).json(e); }
});
app.post('/artists/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const artist = await Artist.findOne({ email });
    if (!artist?.password || !await bcrypt.compare(password, artist.password)) return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id: artist._id, email: artist.email, nom: artist.nom, role: 'artist' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email: artist.email, nom: artist.nom, role: 'artist', artisteId: artist._id });
  } catch (e) { res.status(500).json(e); }
});
app.get('/artists/verify', requireArtist, (req, res) => res.json({ valid: true, ...req.user }));
app.get('/artists', async (req, res) => {
  try { res.set('Cache-Control','public, max-age=60'); res.json(await Artist.find().select('-password -imagePublicId -__v').sort({ nom: 1 })); }
  catch (e) { res.status(500).json(e); }
});
app.get('/artists/:id', async (req, res) => {
  try {
    const artist = await Artist.findById(req.params.id).select('-password');
    if (!artist) return res.status(404).json({ message: 'Artiste introuvable' });
    const songs = await Song.find({ artisteId: req.params.id }).sort({ ordre: 1, createdAt: -1 });
    res.set('Cache-Control','public, max-age=30');
    res.json({ artist, songs });
  } catch (e) { res.status(500).json(e); }
});
app.put('/artists/:id', requireAdminOrArtist, upload.single('image'), async (req, res) => {
  try {
    // Seul l'artiste lui-même ou un admin peut modifier
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const update = {};
    if (req.body.nom) update.nom = req.body.nom;
    if (req.body.bio !== undefined) update.bio = req.body.bio;
    if (req.file) {
      const existing = await Artist.findById(req.params.id);
      await fromCloud(existing?.imagePublicId);
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      update.image = r.secure_url; update.imagePublicId = r.public_id;
    }
    res.json(await Artist.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password'));
  } catch (e) { res.status(500).json(e); }
});
app.put('/artists/me', requireArtist, upload.single('image'), async (req, res) => {
  try {
    const update = {};
    if (req.body.nom) update.nom = req.body.nom; if (req.body.bio !== undefined) update.bio = req.body.bio;
    if (req.file) { const old = await Artist.findById(req.user.id); await fromCloud(old?.imagePublicId); const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM }); update.image = r.secure_url; update.imagePublicId = r.public_id; }
    res.json(await Artist.findByIdAndUpdate(req.user.id, update, { returnDocument: 'after' }).select('-password'));
  } catch (e) { res.status(500).json(e); }
});
app.put('/artists/:id/password', requireArtist, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) return res.status(403).json({ message: 'Accès refusé' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const artist = await Artist.findById(req.params.id);
    if (!artist || !artist.password || !await bcrypt.compare(currentPassword, artist.password)) return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    artist.password = await bcrypt.hash(newPassword, 12); await artist.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/artists/:id', requireAdmin, async (req, res) => {
  try { const a = await Artist.findById(req.params.id); await fromCloud(a?.imagePublicId); await Artist.findByIdAndDelete(req.params.id); res.json({ message: 'Artiste supprimé' }); }
  catch (e) { res.status(500).json(e); }
});

// ── ALBUMS ───────────────────────────────────
app.post('/albums', requireAdminOrArtist, upload.single('image'), async (req, res) => {
  try {
    let artisteId = req.user.role === 'artist' ? req.user.id : req.body.artisteId;
    if (!artisteId) return res.status(400).json({ message: 'artisteId requis' });
    let artisteName = req.user.role === 'artist' ? req.user.nom : '';
    if (req.user.role !== 'artist') { const a = await Artist.findById(artisteId); if (a) artisteName = a.nom; }
    let imageUrl = `https://api.dicebear.com/7.x/shapes/svg?seed=album_${Date.now()}`, imagePublicId = '';
    if (req.file) { const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM }); imageUrl = r.secure_url; imagePublicId = r.public_id; }
    const album = await new Album({ titre: req.body.titre, artisteId, artiste: artisteName, annee: req.body.annee || String(new Date().getFullYear()), image: imageUrl, imagePublicId }).save();
    await notifyAllUsers('new_album', `💿 Nouvel album : ${album.titre}`, `${artisteName} vient de sortir un nouvel album`, { albumId: album._id });
    res.json(album);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/albums', async (req, res) => {
  try {
    const f = req.query.artisteId ? { artisteId: req.query.artisteId } : {};
    const albums = await Album.find(f).sort({ annee: -1, createdAt: -1 }).populate('artisteId', 'nom').select('-imagePublicId -__v');
    res.set('Cache-Control','public, max-age=60'); res.json(albums);
  } catch (e) { res.status(500).json(e); }
});
app.get('/albums/:id', async (req, res) => {
  try {
    const album = await Album.findById(req.params.id).populate('artisteId', 'nom image');
    if (!album) return res.status(404).json({ message: 'Introuvable' });
    const songs = await Song.find({ albumId: req.params.id }).sort({ ordre: 1, createdAt: -1 });
    res.set('Cache-Control','public, max-age=30'); res.json({ album, songs });
  } catch (e) { res.status(500).json(e); }
});
app.put('/albums/:id', requireAdminOrArtist, upload.single('image'), async (req, res) => {
  try {
    const album = await Album.findById(req.params.id);
    if (!album) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(album.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    const u = {};
    if (req.body.titre) u.titre = req.body.titre; if (req.body.annee) u.annee = req.body.annee;
    if (req.file) { await fromCloud(album.imagePublicId); const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM }); u.image = r.secure_url; u.imagePublicId = r.public_id; }
    res.json(await Album.findByIdAndUpdate(req.params.id, u, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json(e); }
});
app.delete('/albums/:id', requireAdminOrArtist, async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    await fromCloud(a.imagePublicId); await Song.updateMany({ albumId: req.params.id }, { $unset: { albumId: '' } }); await Album.findByIdAndDelete(req.params.id);
    res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json(e); }
});
app.post('/albums/:id/add/:songId', requireAdminOrArtist, async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    res.json(await Song.findByIdAndUpdate(req.params.songId, { albumId: req.params.id }, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json(e); }
});
app.delete('/albums/:id/remove/:songId', requireAdminOrArtist, async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    await Song.findByIdAndUpdate(req.params.songId, { $unset: { albumId: '' } }); res.json({ message: 'Retiré' });
  } catch (e) { res.status(500).json(e); }
});

// ── COMMENTS ─────────────────────────────────
app.get('/songs/:id/comments', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const [comments, total] = await Promise.all([
      Comment.find({ songId: req.params.id }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).select('-__v'),
      Comment.countDocuments({ songId: req.params.id })
    ]);
    const t = req.headers.authorization?.split(' ')[1];
    let uid = null;
    if (t) { try { uid = jwt.verify(t, process.env.JWT_SECRET).id; } catch {} }
    res.json({ comments: comments.map(c => ({ ...c.toObject(), likedByMe: uid ? c.likedBy.some(id => String(id) === String(uid)) : false })), pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json(e); }
});
app.post('/songs/:id/comments', requireAuth, async (req, res) => {
  try {
    const { texte, auteur } = req.body;
    if (!texte?.trim()) return res.status(400).json({ message: 'Texte requis' });
    const comment = await new Comment({ songId: req.params.id, texte: texte.trim(), auteur: auteur || req.user.nom || req.user.email, userId: req.user.id }).save();
    try {
      const song = await Song.findById(req.params.id).populate('artisteId', 'email nom');
      if (song?.artisteId?.email) {
        const au = await User.findOne({ email: song.artisteId.email });
        if (au && String(au._id) !== String(req.user.id)) await Notification.create({ userId: au._id, type: 'comment', titre: `Nouveau commentaire sur "${song.titre}"`, message: `${req.user.nom || req.user.email} : "${texte.trim().slice(0,60)}"`, songId: req.params.id });
      }
    } catch {}
    res.json(comment);
  } catch (e) { res.status(500).json(e); }
});
app.put('/songs/:sid/comments/:cid/like', requireAuth, async (req, res) => {
  try {
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    const uid = req.user.id; const liked = c.likedBy.some(id => String(id) === String(uid));
    if (liked) { c.likedBy = c.likedBy.filter(id => String(id) !== String(uid)); c.likes = Math.max(0, c.likes - 1); }
    else { c.likedBy.push(uid); c.likes++; }
    await c.save(); res.json({ ...c.toObject(), likedByMe: !liked });
  } catch (e) { res.status(500).json(e); }
});
app.post('/songs/:sid/comments/:cid/reply', requireAuth, async (req, res) => {
  try {
    const { texte, auteur } = req.body;
    if (!texte?.trim()) return res.status(400).json({ message: 'Texte requis' });
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    c.reponses.push({ texte: texte.trim(), auteur: auteur || req.user.nom || req.user.email, userId: req.user.id });
    res.json(await c.save());
  } catch (e) { res.status(500).json(e); }
});
app.delete('/songs/:sid/comments/:cid', requireAuth, async (req, res) => {
  try {
    const c = await Comment.findById(req.params.cid);
    if (!c) return res.status(404).json({ message: 'Introuvable' });
    if (String(c.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' });
    await Comment.findByIdAndDelete(req.params.cid); res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json(e); }
});

// ── REACTIONS ────────────────────────────────
app.get('/songs/:id/reactions', async (req, res) => {
  try {
    const list = await Reaction.find({ songId: req.params.id });
    const counts = { fire: 0, heart: 0, star: 0 };
    list.forEach(r => { if (counts[r.type] !== undefined) counts[r.type]++; });
    const t = req.headers.authorization?.split(' ')[1];
    let userReaction = null;
    if (t) { try { const d = jwt.verify(t, process.env.JWT_SECRET); const m = list.find(r => String(r.userId) === String(d.id)); if (m) userReaction = m.type; } catch {} }
    res.json({ ...counts, userReaction });
  } catch (e) { res.status(500).json(e); }
});
app.post('/songs/:id/reactions', requireAuth, async (req, res) => {
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
    const list = await Reaction.find({ songId: req.params.id });
    const counts = { fire: 0, heart: 0, star: 0 };
    list.forEach(r => { if (counts[r.type] !== undefined) counts[r.type]++; });
    const m = list.find(r => String(r.userId) === String(req.user.id));
    res.json({ ...counts, userReaction: m ? m.type : null });
  } catch (e) { res.status(500).json(e); }
});

// ── SONGS ────────────────────────────────────
app.get('/songs/meta', async (req, res) => {
  try { res.set('Cache-Control','public, max-age=10'); res.json(await Song.find().sort({ ordre:1, createdAt:-1 }).select('_id updatedAt plays liked')); }
  catch (e) { res.status(500).json(e); }
});
app.get('/songs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(50, parseInt(req.query.limit)||30);
    const filter = {};
    if (req.query.q) { const re = new RegExp(req.query.q,'i'); filter.$or = [{ titre: re },{ artiste: re }]; }
    if (req.query.albumId)   filter.albumId   = req.query.albumId;
    if (req.query.artisteId) filter.artisteId = req.query.artisteId;
    const [songs, total] = await Promise.all([
      Song.find(filter).sort({ ordre:1, createdAt:-1 }).skip((page-1)*limit).limit(limit).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image'),
      Song.countDocuments(filter)
    ]);
    // Injecter liked par utilisateur connecté
    let likedSet = new Set();
    const t = req.headers.authorization?.split(' ')[1];
    if (t) {
      try {
        const d = jwt.verify(t, process.env.JWT_SECRET);
        if (d.id) {
          const favs = await UserFavorite.find({ userId: d.id }).select('songId');
          favs.forEach(f => likedSet.add(String(f.songId)));
        }
      } catch {}
    }
    const songsWithLike = songs.map(s => ({ ...s.toObject(), liked: likedSet.has(String(s._id)) }));
    res.set('Cache-Control','no-store');
    res.json({ songs: songsWithLike, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json(e); }
});
app.post('/upload', requireAdminOrArtist, upload.fields([{ name:'audio', maxCount:1 },{ name:'image', maxCount:1 }]), async (req, res) => {
  try {
    const audioBuf = req.files['audio']?.[0]?.buffer;
    const imgBuf   = req.files['image']?.[0]?.buffer;
    const origName = req.files['audio']?.[0]?.originalname || 'track.mp3';
    if (!audioBuf) return res.status(400).json({ message: 'Fichier audio manquant' });
    const isArtist = req.user.role === 'artist';
    const artisteId = isArtist ? req.user.id : (req.body.artisteId || null);
    let artisteName = 'Artiste Local';
    if (isArtist) artisteName = req.user.nom;
    else if (artisteId) { const a = await Artist.findById(artisteId); if (a) artisteName = a.nom; }
    const audioResult = await toCloud(audioBuf, { folder:'moozik/audio', resource_type:'video', format:'mp3' });
    let imageUrl = `https://api.dicebear.com/7.x/shapes/svg?seed=${audioResult.public_id}`, imagePublicId = '';
    if (imgBuf) { const ir = await toCloud(imgBuf, { folder:'moozik/images', resource_type:'image', transformation: IMG_TRANSFORM }); imageUrl = ir.secure_url; imagePublicId = ir.public_id; }
    const count = await Song.countDocuments();
    const newSong = await new Song({ titre: req.body.titre || origName.replace(/\.(mp3|mpeg)$/i,'').replace(/_/g,' '), artiste: artisteName, artisteId: artisteId||null, albumId: req.body.albumId||null, src: audioResult.secure_url, audioPublicId: audioResult.public_id, image: imageUrl, imagePublicId, ordre: count }).save();
    await notifyAllUsers('new_song', `🎵 Nouveau titre : ${newSong.titre}`, `${artisteName} vient d'ajouter une nouvelle musique`, { songId: newSong._id });
    res.json(newSong);
  } catch (e) { console.error('Upload error:', e); res.status(500).json({ message: e.message }); }
});
app.put('/songs/:id/play', async (req, res) => {
  try {
    const song = await Song.findByIdAndUpdate(req.params.id, { $inc: { plays:1 } }, { returnDocument: 'after' });
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const t = req.headers.authorization?.split(' ')[1];
    if (t) {
      try {
        const d = jwt.verify(t, process.env.JWT_SECRET);
        if (d.role === 'user' || d.role === 'artist') {
          await UserPlay.findOneAndUpdate({ userId: d.id, songId: req.params.id }, { $inc: { count:1 } }, { upsert:true, returnDocument: 'after' });
          await History.create({ userId: d.id, songId: req.params.id });
          const cnt = await History.countDocuments({ userId: d.id });
          if (cnt > 500) { const oldest = await History.find({ userId: d.id }).sort({ playedAt:1 }).limit(cnt-500).select('_id'); await History.deleteMany({ _id: { $in: oldest.map(o=>o._id) } }); }
        }
      } catch {}
    }
    // Incrémenter aussi le compteur de partage si shareToken fourni
    const shareToken = req.body?.shareToken || req.query?.shareToken;
    if (shareToken) {
      await ShareHistory.findOneAndUpdate({ shareToken }, { $inc: { playCount: 1 } }).catch(() => {});
    }
    res.json({ plays: song.plays });
  } catch (e) { res.status(500).json(e); }
});
app.delete('/songs/:id', requireAdminOrArtist, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    await fromCloud(song.audioPublicId, 'video'); await fromCloud(song.imagePublicId);
    await Promise.all([Comment.deleteMany({ songId: req.params.id }), Reaction.deleteMany({ songId: req.params.id }), UserPlay.deleteMany({ songId: req.params.id }), History.deleteMany({ songId: req.params.id })]);
    await Song.findByIdAndDelete(req.params.id); res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json(e); }
});
app.put('/songs/:id', requireAdminOrArtist, upload.single('image'), async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    const u = {};
    if (req.body.titre) u.titre = req.body.titre;
    if (req.body.artiste && req.user.role === 'admin') u.artiste = req.body.artiste;
    if (req.body.artisteId && req.user.role === 'admin') u.artisteId = req.body.artisteId;
    if (req.body.albumId !== undefined) u.albumId = req.body.albumId || null;
    if (req.file) { await fromCloud(song.imagePublicId); const r = await toCloud(req.file.buffer, { folder:'moozik/images', resource_type:'image', transformation: IMG_TRANSFORM }); u.image = r.secure_url; u.imagePublicId = r.public_id; }
    res.json(await Song.findByIdAndUpdate(req.params.id, u, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json(e); }
});
// ── FAVORIS PAR UTILISATEUR ──────────────────
app.put('/songs/:id/like', requireAuth, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message:'Introuvable' });
    const userId = req.user.id;
    const existing = await UserFavorite.findOne({ userId, songId: req.params.id });
    if (existing) {
      await UserFavorite.deleteOne({ _id: existing._id });
    } else {
      await new UserFavorite({ userId, songId: req.params.id }).save();
    }
    const liked = !existing;
    res.json({ ...song.toObject(), liked });
  } catch (e) { res.status(500).json(e); }
});
app.get('/songs/favorites', requireAuth, async (req, res) => {
  try {
    const favs = await UserFavorite.find({ userId: req.user.id }).select('songId');
    const songIds = favs.map(f => f.songId);
    const songs = await Song.find({ _id: { $in: songIds } }).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    res.json(songs.map(s => ({ ...s.toObject(), liked: true })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/songs/reorder', requireAdmin, async (req, res) => {
  try { const { orderedIds } = req.body; for (let i=0; i<orderedIds.length; i++) await Song.findByIdAndUpdate(orderedIds[i], { ordre:i }); res.json({ message:'Ordre mis à jour' }); }
  catch (e) { res.status(500).json(e); }
});
app.get('/search', async (req, res) => {
  try { const q = req.query.q; res.json(await Song.find({ $or: [{ titre: { $regex:q, $options:'i' } },{ artiste: { $regex:q, $options:'i' } }] })); }
  catch (e) { res.status(500).json(e); }
});

// ── PARTAGE ──────────────────────────────────
app.post('/songs/:id/share', async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).select('titre artiste image');
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const shareToken = jwt.sign({ songId: song._id, type:'share' }, process.env.JWT_SECRET, { expiresIn:'7d' });
    // Enregistrer dans l'historique de partage
    let sharedBy = null;
    const t = req.headers.authorization?.split(' ')[1];
    if (t) { try { sharedBy = jwt.verify(t, process.env.JWT_SECRET).id; } catch {} }
    await ShareHistory.findOneAndUpdate(
      { shareToken },
      { songId: song._id, sharedBy, shareToken, expiresAt },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ shareToken, song: { titre:song.titre, artiste:song.artiste, image:song.image }, expiresIn:'7 jours' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/share/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, process.env.JWT_SECRET);
    if (decoded.type !== 'share') return res.status(400).json({ message: 'Token invalide' });
    const song = await Song.findById(decoded.songId).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    if (!song) return res.status(404).json({ message: 'Musique introuvable ou supprimée' });
    await ShareHistory.findOneAndUpdate({ shareToken: req.params.token }, { $inc: { viewCount: 1 } });
    res.json({ song, shared:true });
  } catch (e) { if (e.name==='TokenExpiredError') return res.status(410).json({ message:'Lien expiré' }); res.status(400).json({ message:'Lien invalide' }); }
});
app.put('/share/:token/play', async (req, res) => {
  try {
    await ShareHistory.findOneAndUpdate({ shareToken: req.params.token }, { $inc: { playCount: 1 } });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});
// Historique de partages (utilisateur connecté)
app.get('/my-shares', async (req, res) => {
  try {
    const t = req.headers.authorization?.split(' ')[1];
    if (!t) return res.json([]);
    const d = jwt.verify(t, process.env.JWT_SECRET);
    const shares = await ShareHistory.find({ sharedBy: d.id })
      .sort({ createdAt: -1 }).limit(50)
      .populate('songId', 'titre artiste image plays');
    res.json(shares);
  } catch { res.json([]); }
});
// Historique de partages admin
app.get('/admin/shares', requireAdmin, async (req, res) => {
  try {
    const shares = await ShareHistory.find().sort({ createdAt:-1 }).limit(100)
      .populate('songId','titre artiste image')
      .populate('sharedBy','nom email');
    res.json(shares);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── HISTORIQUE ───────────────────────────────
app.get('/history', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(100, parseInt(req.query.limit)||30);
    const [entries, total] = await Promise.all([
      History.find({ userId: req.user.id }).sort({ playedAt:-1 }).skip((page-1)*limit).limit(limit).populate('songId','titre artiste image src plays liked'),
      History.countDocuments({ userId: req.user.id })
    ]);
    res.json({ history: entries.map(e => ({ _id:e._id, playedAt:e.playedAt, song:e.songId })), pagination: { page, limit, total, pages:Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/history/stats', requireAuth, async (req, res) => {
  try {
    const [topSongs, totalEcoutes, joursAgg] = await Promise.all([
      History.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id:'$songId', count:{ $sum:1 }, lastPlayed:{ $max:'$playedAt' } } },
        { $sort: { count:-1 } }, { $limit:10 },
        { $lookup: { from:'songs', localField:'_id', foreignField:'_id', as:'song' } },
        { $unwind:'$song' },
        { $project: { count:1, lastPlayed:1, 'song.titre':1, 'song.artiste':1, 'song.image':1 } }
      ]),
      History.countDocuments({ userId: req.user.id }),
      History.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
        { $group: { _id: { $dateToString: { format:'%Y-%m-%d', date:'$playedAt' } } } },
        { $count:'total' }
      ])
    ]);
    res.json({ topSongs, totalEcoutes, joursActifs: joursAgg[0]?.total||0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/history', requireAuth, async (req, res) => {
  try { await History.deleteMany({ userId: req.user.id }); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// ── RECOMMANDATIONS ──────────────────────────
app.get('/recommendations', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit)||12);
    const topArtists = await History.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
      { $lookup: { from:'songs', localField:'songId', foreignField:'_id', as:'song' } },
      { $unwind:'$song' },
      { $group: { _id:'$song.artisteId', count:{ $sum:1 } } },
      { $sort: { count:-1 } }, { $limit:5 }, { $match: { _id: { $ne:null } } }
    ]);
    const alreadyPlayed = await History.distinct('songId', { userId: req.user.id });
    let reco = [];
    if (topArtists.length > 0) {
      reco = await Song.find({ artisteId: { $in: topArtists.map(a=>a._id) }, _id: { $nin: alreadyPlayed } })
        .sort({ plays:-1 }).limit(limit).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    }
    if (reco.length < limit) {
      const extra = await Song.find({ _id: { $nin: [...alreadyPlayed, ...reco.map(s=>s._id)] } })
        .sort({ plays:-1 }).limit(limit-reco.length).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
      reco = [...reco, ...extra];
    }
    if (reco.length === 0) reco = await Song.find().sort({ plays:-1 }).limit(limit).select('-audioPublicId -imagePublicId -__v').populate('artisteId','nom image');
    res.json({ recommendations: reco, basedOn: topArtists.length > 0 ? 'history' : 'popular', message: topArtists.length > 0 ? `Basé sur vos ${alreadyPlayed.length} écoutes` : 'Populaires du moment' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/songs/:id/similar', async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).select('artisteId albumId artiste');
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const similar = await Song.find({ _id: { $ne: req.params.id }, $or: [{ artisteId: song.artisteId||null },{ albumId: song.albumId||null },{ artiste: song.artiste }] })
      .sort({ plays:-1 }).limit(8).select('titre artiste image src plays liked').populate('artisteId','nom');
    res.set('Cache-Control','public, max-age=120'); res.json(similar);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── NOTIFICATIONS ────────────────────────────
app.get('/notifications/unread-count', requireAuth, async (req, res) => {
  try { res.set('Cache-Control','no-store'); res.json({ count: await Notification.countDocuments({ userId: req.user.id, lu:false }) }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/notifications', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(50, parseInt(req.query.limit)||20);
    const filter = { userId: req.user.id };
    if (req.query.unread === 'true') filter.lu = false;
    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ lu:1, createdAt:-1 }).skip((page-1)*limit).limit(limit).populate('songId','titre image artiste').populate('albumId','titre image'),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: req.user.id, lu:false })
    ]);
    res.json({ notifications, unreadCount, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/notifications/read-all', requireAuth, async (req, res) => {
  try { await Notification.updateMany({ userId: req.user.id, lu:false }, { lu:true }); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/notifications/:id/read', requireAuth, async (req, res) => {
  try { await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { lu:true }); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/notifications/clear', requireAuth, async (req, res) => {
  try { await Notification.deleteMany({ userId: req.user.id, lu:true }); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// ── PLAYLISTS ADMIN ──────────────────────────
app.get('/playlists', async (req, res) => {
  try { res.set('Cache-Control','public, max-age=30'); res.json(await Playlist.find().populate('musiques','titre artiste image src plays liked ordre')); }
  catch (e) { res.status(500).json(e); }
});
app.post('/playlists', requireAdmin, async (req, res) => {
  try { res.json(await new Playlist({ nom: req.body.nom, musiques:[] }).save()); } catch (e) { res.status(500).json(e); }
});
app.delete('/playlists/:id', requireAdmin, async (req, res) => {
  try { await Playlist.findByIdAndDelete(req.params.id); res.json({ message:'Supprimée' }); } catch (e) { res.status(500).json(e); }
});
app.post('/playlists/:pid/add/:sid', requireAdmin, async (req, res) => {
  try { const p = await Playlist.findById(req.params.pid); if (!p) return res.status(404).json({}); p.musiques.addToSet(req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json(e); }
});
app.delete('/playlists/:pid/remove/:sid', requireAdmin, async (req, res) => {
  try { const p = await Playlist.findById(req.params.pid); p.musiques = p.musiques.filter(id => String(id) !== req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json(e); }
});

// ── USER PLAYLISTS ───────────────────────────
app.post('/user-playlists', requireAuth, async (req, res) => {
  try { const { nom, isPublic } = req.body; if (!nom) return res.status(400).json({ message:'Nom requis' }); res.json(await new UserPlaylist({ nom, userId: req.user.id, musiques:[], isPublic: isPublic===true||isPublic==='true' }).save()); }
  catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/user-playlists/mine', requireAuth, async (req, res) => {
  try { res.json(await UserPlaylist.find({ userId: req.user.id }).populate('musiques').sort({ createdAt:-1 })); } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/user-playlists/public', async (req, res) => {
  try { res.json(await UserPlaylist.find({ isPublic:true }).populate('musiques').populate('userId','nom').sort({ createdAt:-1 })); } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/user-playlists/:id', async (req, res) => {
  try {
    const p = await UserPlaylist.findById(req.params.id).populate('musiques');
    if (!p) return res.status(404).json({ message:'Introuvable' });
    if (p.isPublic) return res.json(p);
    const t = req.headers.authorization?.split(' ')[1];
    if (!t) return res.status(403).json({ message:'Playlist privée' });
    try { const d = jwt.verify(t, process.env.JWT_SECRET); if (String(p.userId) !== String(d.id) && d.role !== 'admin') return res.status(403).json({ message:'Accès refusé' }); res.json(p); }
    catch { res.status(403).json({ message:'Token invalide' }); }
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/user-playlists/:id/add/:sid', requireAuth, async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({ message:'Introuvable' }); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ message:'Accès refusé' }); p.musiques.addToSet(req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/user-playlists/:id/remove/:sid', requireAuth, async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({ message:'Introuvable' }); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ message:'Accès refusé' }); p.musiques = p.musiques.filter(id => String(id) !== req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
});
app.put('/user-playlists/:id/visibility', requireAuth, async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({ message:'Introuvable' }); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ message:'Accès refusé' }); p.isPublic = req.body.isPublic; res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
});
app.delete('/user-playlists/:id', requireAuth, async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({ message:'Introuvable' }); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ message:'Accès refusé' }); await UserPlaylist.findByIdAndDelete(req.params.id); res.json({ message:'Supprimée' }); } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── ADMIN: SONGS MANAGEMENT ─────────────────
app.get('/admin/songs', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(50, parseInt(req.query.limit)||20);
    const filter = {};
    if (req.query.q) { const re = new RegExp(req.query.q,'i'); filter.$or = [{ titre: re },{ artiste: re }]; }
    if (req.query.artisteId) filter.artisteId = req.query.artisteId;
    if (req.query.albumId) filter.albumId = req.query.albumId;
    const [songs, total] = await Promise.all([
      Song.find(filter).sort({ plays:-1, createdAt:-1 }).skip((page-1)*limit).limit(limit)
        .select('-audioPublicId -__v').populate('artisteId','nom').populate('albumId','titre'),
      Song.countDocuments(filter)
    ]);
    res.json({ songs, pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/admin/albums', requireAdmin, async (req, res) => {
  try {
    const albums = await Album.find().sort({ createdAt:-1 }).populate('artisteId','nom');
    res.json(albums);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── STATS ADMIN ──────────────────────────────
// Extended stats endpoints
app.get('/admin/stats/plays-history', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 86400000);
    const data = await History.aggregate([
      { $match: { playedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format:'%Y-%m-%d', date:'$playedAt' } }, plays: { $sum:1 } } },
      { $sort: { _id:1 } }, { $project: { date:'$_id', plays:1, _id:0 } }
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/admin/stats/top-songs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit)||10);
    res.json(await Song.find().sort({ plays:-1 }).limit(limit).select('titre artiste plays image'));
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/admin/stats/top-artists', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(10, parseInt(req.query.limit)||6);
    const data = await Song.aggregate([
      { $group: { _id:'$artiste', plays:{ $sum:'$plays' }, artisteId:{ $first:'$artisteId' } } },
      { $sort: { plays:-1 } }, { $limit: limit },
      { $project: { nom:'$_id', plays:1, artisteId:1, _id:0 } }
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/admin/stats/users-growth', requireAdmin, async (req, res) => {
  try {
    const data = await User.aggregate([
      { $group: { _id: { $dateToString: { format:'%Y-%m-%d', date:'$createdAt' } }, users:{ $sum:1 } } },
      { $sort: { _id:1 } }, { $limit:30 }, { $project: { date:'$_id', users:1, _id:0 } }
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7*86400000);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const [totalSongs, totalPlaylists, totalArtists, totalAlbums, totalUsers, totalUserPlaylists, totalComments, totalFavorites, topSongs, playsAgg, newUsersThisWeek, playsToday] = await Promise.all([
      Song.countDocuments(), Playlist.countDocuments(), Artist.countDocuments(), Album.countDocuments(),
      User.countDocuments(), UserPlaylist.countDocuments(), Comment.countDocuments(),
      UserFavorite.countDocuments(),
      Song.find().sort({ plays:-1 }).limit(5).select('titre artiste plays image'),
      Song.aggregate([{ $group: { _id:null, total: { $sum:'$plays' } } }]),
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      History.countDocuments({ playedAt: { $gte: todayStart } })
    ]);
    res.json({ totalSongs, totalPlaylists, totalArtists, totalAlbums, totalUsers, totalUserPlaylists, totalComments, totalLikes: totalFavorites, topSongs, totalPlays: playsAgg[0]?.total||0, newUsersThisWeek, playsToday });
  } catch (e) { res.status(500).json(e); }
});

const PORT = process.env.PORT || 5000;
const server = require('http').createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur sur le port ${PORT}`));

const { WebSocketServer } = require('ws');
 
const wss = new WebSocketServer({ server });
 
// Map token → { ws, nom, avatar, songId, songTitle, artiste, image, lastSeen }
const listeners = new Map();
 
// Nettoie les connexions mortes toutes les 30s
const cleanupInterval = setInterval(() => {
  listeners.forEach((v, k) => {
    if (v.ws.readyState !== 1) listeners.delete(k);
  });
}, 30_000);
 
function broadcast() {
  const users = [...listeners.values()].map(l => ({
    nom:       l.nom,
    avatar:    l.avatar,
    songId:    l.songId,
    songTitle: l.songTitle,
    artiste:   l.artiste,
    image:     l.image,
  }));
  const payload = JSON.stringify({ type: 'listeners', users });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}
 
wss.on('connection', (ws, req) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
 
    if (msg.type === 'join') {
      // Vérification optionnelle du token JWT
      let nom = 'Anonyme', avatar = null;
      try {
        const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
        nom    = decoded.nom    || decoded.email || 'Utilisateur';
        avatar = decoded.avatar || null;
      } catch {
        // Token invalide → on laisse passer en anonyme ou on refuse
        // Pour refuser : ws.close(); return;
      }
 
      listeners.set(msg.token, {
        ws, nom, avatar,
        songId:    msg.songId,
        songTitle: msg.songTitle,
        artiste:   msg.artiste,
        image:     msg.image,
        lastSeen:  Date.now(),
      });
      broadcast();
    }
 
    if (msg.type === 'leave') {
      listeners.delete(msg.token);
      broadcast();
    }
 
    if (msg.type === 'ping') {
      // Maintenir la connexion active
      const entry = listeners.get(msg.token);
      if (entry) entry.lastSeen = Date.now();
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
 
  ws.on('close', () => {
    listeners.forEach((v, k) => { if (v.ws === ws) listeners.delete(k); });
    broadcast();
  });
 
  ws.on('error', () => ws.close());
});

