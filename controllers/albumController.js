const { Album, Song, User, Notification } = require('../models');
const { toCloud, fromCloud, IMG_TRANSFORM } = require('../middleware/upload');

exports.create = async (req, res) => {
  try {
    let artisteId   = req.user.role === 'artist' ? req.user.id : req.body.artisteId;
    if (!artisteId) return res.status(400).json({ message: 'artisteId requis' });
    let artisteName = req.user.role === 'artist' ? req.user.nom : '';
    if (req.user.role !== 'artist') { const a = await require('../models').Artist.findById(artisteId); if (a) artisteName = a.nom; }
    let imageUrl = `https://api.dicebear.com/7.x/shapes/svg?seed=album_${Date.now()}`, imagePublicId = '';
    if (req.file) { const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM }); imageUrl = r.secure_url; imagePublicId = r.public_id; }
    const album = await new Album({ titre: req.body.titre, artisteId, artiste: artisteName, annee: req.body.annee || String(new Date().getFullYear()), image: imageUrl, imagePublicId }).save();
    const users = await User.find().select('_id');
    if (users.length) await Notification.insertMany(users.map(u => ({ userId: u._id, type: 'new_album', titre: `💿 Nouvel album : ${album.titre}`, message: `${artisteName} vient de sortir un nouvel album`, albumId: album._id })));
    res.json(album);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.list = async (req, res) => {
  try {
    const f = req.query.artisteId ? { artisteId: req.query.artisteId } : {};
    res.set('Cache-Control','public, max-age=60');
    res.json(await Album.find(f).sort({ annee: -1, createdAt: -1 }).populate('artisteId','nom').select('-imagePublicId -__v'));
  } catch (e) { res.status(500).json(e); }
};

exports.get = async (req, res) => {
  try {
    const album = await Album.findById(req.params.id).populate('artisteId','nom image');
    if (!album) return res.status(404).json({ message: 'Introuvable' });
    const songs = await Song.find({ albumId: req.params.id }).sort({ ordre: 1, createdAt: -1 });
    res.set('Cache-Control','public, max-age=30');
    res.json({ album, songs });
  } catch (e) { res.status(500).json(e); }
};

exports.update = async (req, res) => {
  try {
    const album = await Album.findById(req.params.id);
    if (!album) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(album.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    const u = {};
    if (req.body.titre) u.titre = req.body.titre;
    if (req.body.annee) u.annee = req.body.annee;
    if (req.file) { await fromCloud(album.imagePublicId); const r = await toCloud(req.file.buffer, { folder:'moozik/images', resource_type:'image', transformation: IMG_TRANSFORM }); u.image = r.secure_url; u.imagePublicId = r.public_id; }
    res.json(await Album.findByIdAndUpdate(req.params.id, u, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json(e); }
};

exports.remove = async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    await fromCloud(a.imagePublicId);
    await Song.updateMany({ albumId: req.params.id }, { $unset: { albumId: '' } });
    await Album.findByIdAndDelete(req.params.id);
    res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json(e); }
};

exports.addSong = async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    res.json(await Song.findByIdAndUpdate(req.params.songId, { albumId: req.params.id }, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json(e); }
};

exports.removeSong = async (req, res) => {
  try {
    const a = await Album.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(a.artisteId) !== String(req.user.id)) return res.status(403).json({ message: 'Accès refusé' });
    await Song.findByIdAndUpdate(req.params.songId, { $unset: { albumId: '' } });
    res.json({ message: 'Retiré' });
  } catch (e) { res.status(500).json(e); }
};

