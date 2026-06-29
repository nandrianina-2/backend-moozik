const jwt = require('jsonwebtoken');
const { Playlist, UserPlaylist } = require('../models');

// ── Admin playlists ───────────────────────────
exports.list = async (req, res) => {
  try {
    res.set('Cache-Control','public, max-age=30');
    res.json(await Playlist.find().populate('musiques','titre artiste image src plays liked ordre'));
  } catch (e) { res.status(500).json(e); }
};
exports.create = async (req, res) => {
  try { res.json(await new Playlist({ nom: req.body.nom, musiques: [] }).save()); } catch (e) { res.status(500).json(e); }
};
exports.remove = async (req, res) => {
  try { await Playlist.findByIdAndDelete(req.params.id); res.json({ message: 'Supprimée' }); } catch (e) { res.status(500).json(e); }
};
exports.addSong = async (req, res) => {
  try { const p = await Playlist.findById(req.params.pid); if (!p) return res.status(404).json({}); p.musiques.addToSet(req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json(e); }
};
exports.removeSong = async (req, res) => {
  try { const p = await Playlist.findById(req.params.pid); p.musiques = p.musiques.filter(id => String(id) !== req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json(e); }
};

// ── User playlists ────────────────────────────
exports.createUser = async (req, res) => {
  try {
    const { nom, isPublic } = req.body;
    if (!nom) return res.status(400).json({ message: 'Nom requis' });
    res.json(await new UserPlaylist({ nom, userId: req.user.id, musiques: [], isPublic: isPublic === true || isPublic === 'true' }).save());
  } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.listMine = async (req, res) => {
  try { res.json(await UserPlaylist.find({ userId: req.user.id }).populate('musiques').sort({ createdAt: -1 })); } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.listPublic = async (req, res) => {
  try { res.json(await UserPlaylist.find({ isPublic: true }).populate('musiques').populate('userId','nom').sort({ createdAt: -1 })); } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.getOne = async (req, res) => {
  try {
    const p = await UserPlaylist.findById(req.params.id).populate('musiques');
    if (!p) return res.status(404).json({ message: 'Introuvable' });
    if (p.isPublic) return res.json(p);
    const t = req.headers.authorization?.split(' ')[1];
    if (!t) return res.status(403).json({ message: 'Playlist privée' });
    try { const d = jwt.verify(t, process.env.JWT_SECRET); if (String(p.userId) !== String(d.id) && d.role !== 'admin') return res.status(403).json({ message: 'Accès refusé' }); res.json(p); }
    catch { res.status(403).json({ message: 'Token invalide' }); }
  } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.addSongUser = async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({}); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({}); p.musiques.addToSet(req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.removeSongUser = async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({}); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({}); p.musiques = p.musiques.filter(id => String(id) !== req.params.sid); res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.toggleVisibility = async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({}); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({}); p.isPublic = req.body.isPublic; res.json(await p.save()); } catch (e) { res.status(500).json({ message: e.message }); }
};
exports.removeUser = async (req, res) => {
  try { const p = await UserPlaylist.findById(req.params.id); if (!p) return res.status(404).json({}); if (String(p.userId) !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({}); await UserPlaylist.findByIdAndDelete(req.params.id); res.json({ message: 'Supprimée' }); } catch (e) { res.status(500).json({ message: e.message }); }
};

