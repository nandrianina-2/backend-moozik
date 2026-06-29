const Play = require('../models/Play');
const { Song } = require('../models/');

const currentPeriod = () => new Date().toISOString().slice(0, 7);

/**
 * POST /songs/:id/play
 * Body : { duration: number }  (secondes écoutées — optionnel)
 *
 * Règle : on enregistre l'écoute seulement si duration >= 30s
 * pour éviter les faux comptages (skip rapide).
 */
exports.recordPlay = async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).lean();
    if (!song) return res.status(404).json({ message: 'Chanson introuvable' });

    const duration  = parseInt(req.body.duration || 0);
    const isPremium = req.user?.planName === 'premium' || req.user?.plan === 'premium';
    const period    = currentPeriod();

    // Toujours incrémenter le compteur global (même les skips courts)
    await Song.findByIdAndUpdate(req.params.id, {
        $inc: { plays: 1 },
    });

    // Enregistrer pour royalties seulement si >= 30 secondes et artiste connu
    if (duration >= 30 && song.artisteId) {
      await Play.create({
        songId:    song._id,
        artisteId: song.artisteId,
        userId:    req.user?._id || null,
        isPremium,
        period,
        duration,
        counted:   false,
      });
    }

    res.json({ ok: true, counted: duration >= 30 });
  } catch (e) {
    console.error('recordPlay error:', e);
    res.status(500).json({ message: e.message });
  }
};