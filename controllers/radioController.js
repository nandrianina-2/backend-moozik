/**
 * radioController.js — Contrôleur Radio IA MOOZIK
 *
 * Toute la logique métier extraite de radioRoutes.js.
 * Les routes restent fines ; ce fichier est testable indépendamment.
 *
 * Usage dans radioRoutes.js :
 *   const ctrl = require('./controllers/radioController');
 *   router.post('/radio/start',              optionalAuth, ctrl.startSession);
 *   router.get ('/radio/:sessionId/next',    optionalAuth, ctrl.nextSong);
 *   router.post('/radio/:sessionId/skip',    optionalAuth, ctrl.skipSong);
 *   router.post('/radio/:sessionId/like',    optionalAuth, ctrl.likeSong);
 *   router.get ('/radio/:sessionId',         optionalAuth, ctrl.getSession);
 *   router.delete('/radio/:sessionId',       optionalAuth, ctrl.stopSession);
 *   router.get ('/radio/config/moods',       ctrl.getMoods);
 *   router.get ('/radio/config/suggestions', optionalAuth, ctrl.getSuggestions);
 */

'use strict';

const mongoose = require('mongoose');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const { Song, History } = require('../models');

// ════════════════════════════════════════════
// MODÈLE SESSION RADIO (déclaré ici, partagé via module)
// ════════════════════════════════════════════

const RadioSessionSchema = new mongoose.Schema(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sessionId:   { type: String, required: true, unique: true },
    mood:        { type: String, default: 'chill' },
    name:        { type: String, default: 'Ma radio IA' },
    seedSong:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song', default: null },
    seedMoods:   [{ type: String }],
    playedIds:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
    queue:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
    djEnabled:   { type: Boolean, default: true },
    active:      { type: Boolean, default: true },
    songsPlayed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

RadioSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // TTL 24 h

// Évite "Cannot overwrite model once compiled" en dev (hot-reload)
const RadioSession =
  mongoose.models.RadioSession ||
  mongoose.model('RadioSession', RadioSessionSchema);

module.exports.RadioSession = RadioSession;

// ════════════════════════════════════════════
// CONSTANTES & HELPERS PRIVÉS
// ════════════════════════════════════════════

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL   = 'claude-haiku-4-5-20251001';

/** Appel Claude Haiku (rapide, économique). Retourne null si indisponible. */
const claudeHaiku = async (prompt, systemPrompt = '', maxTokens = 400) => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      HAIKU_MODEL,
        max_tokens: maxTokens,
        system:     systemPrompt ||
          'Tu es MOOZIK Radio, un DJ IA francophone. Réponds en JSON strict uniquement, sans backticks ni preamble.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return text.replace(/```json|```/g, '').trim();
  } catch (e) {
    console.warn('[radioController] Claude API error:', e.message);
    return null;
  }
};

/** Génère un identifiant de session lisible (8 chars). */
const genSessionId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(
    { length: 8 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
};

/**
 * Calcule un score de compatibilité entre deux titres.
 * @param {Object} songA
 * @param {Object} songB
 * @returns {number}
 */
const compatibilityScore = (songA, songB) => {
  if (!songA || !songB) return 0;
  let score = 0;

  // Même artiste → forte affinité
  if (String(songA.artisteId) === String(songB.artisteId)) score += 40;

  // Moods communs
  const moodsA = songA.moods || [];
  const moodsB = songB.moods || [];
  score += moodsA.filter(m => moodsB.includes(m)).length * 20;

  // Même album
  if (songA.albumId && String(songA.albumId) === String(songB.albumId)) score += 15;

  // Popularité similaire (ratio)
  const playsA = songA.plays || 0;
  const playsB = songB.plays || 0;
  if (playsA > 0 && playsB > 0) {
    const ratio = Math.min(playsA, playsB) / Math.max(playsA, playsB);
    score += Math.round(ratio * 10);
  }

  return score;
};

/**
 * Sélectionne les N titres les plus compatibles avec seedSong,
 * en excluant les IDs déjà joués, avec un zeste d'aléatoire.
 */
const selectCompatibleSongs = (seedSong, allSongs, excludeIds, count = 8) => {
  const exclude    = new Set(excludeIds.map(String));
  const candidates = allSongs.filter(
    s => !exclude.has(String(s._id)) && String(s._id) !== String(seedSong._id)
  );

  const scored = candidates
    .map(s => ({ song: s, score: compatibilityScore(seedSong, s) }))
    .sort((a, b) => b.score - a.score);

  // Pool : top 2× count + shuffle partiel (diversité)
  const topN = Math.max(count * 2, 10);
  const pool = scored.slice(0, topN).map(s => s.song);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count);
};

// ════════════════════════════════════════════
// CHAMP DE SÉLECTION RÉUTILISABLE
// ════════════════════════════════════════════

const SONG_FIELDS = 'titre artiste artisteId albumId image src plays moods genre createdAt';

// ════════════════════════════════════════════
// CONTRÔLEURS EXPORTÉS
// ════════════════════════════════════════════

/**
 * POST /radio/start
 * Démarre une nouvelle session radio IA.
 */
exports.startSession = async (req, res) => {
  try {
    const { mood, seedSongId, djEnabled = true } = req.body;

    const allSongs = await Song.find().select(SONG_FIELDS).lean();
    if (!allSongs.length)
      return res.status(404).json({ message: 'Aucune musique disponible' });

    // ── Titre de départ ──────────────────────────────────────
    let seedSong = seedSongId
      ? allSongs.find(s => String(s._id) === String(seedSongId))
      : null;

    if (!seedSong) {
      const pool =
        mood && mood !== 'surprise'
          ? (allSongs.filter(s => s.moods?.includes(mood)) || allSongs)
          : allSongs;
      const src = pool.length > 0 ? pool : allSongs;
      seedSong  = src[Math.floor(Math.random() * src.length)];
    }

    // ── File initiale ────────────────────────────────────────
    const queue     = selectCompatibleSongs(seedSong, allSongs, [seedSong._id], 8);
    const sessionId = genSessionId();
    const seedMoods = seedSong.moods?.length
      ? seedSong.moods
      : mood ? [mood] : ['chill'];

    // ── Nom de la radio + intro DJ (optionnel) ───────────────
    let radioName = `Radio ${seedSong.artiste || 'IA'}`;
    let djIntro   = null;

    if (djEnabled && process.env.ANTHROPIC_API_KEY) {
      const nameRaw = await claudeHaiku(
        `Crée un nom court et accrocheur (max 4 mots) pour une radio musicale qui commence par "${seedSong.titre}" de ${seedSong.artiste}. Moods : ${seedMoods.join(', ')}. Réponds UNIQUEMENT avec le nom, sans guillemets.`,
        "Tu es un expert en nommage de radios musicales. Réponds avec juste le nom, rien d'autre."
      );
      if (nameRaw && nameRaw.length < 60) radioName = nameRaw;

      const introRaw = await claudeHaiku(
        `Tu es le DJ IA de MOOZIK Radio. Lance la session radio "${radioName}" qui commence par "${seedSong.titre}" de ${seedSong.artiste}. Ambiance : ${seedMoods.join(', ')}. Fais une courte phrase d'introduction énergique (max 20 mots), style radio FM. Réponds avec juste la phrase, sans guillemets.`,
        'Tu es un DJ radio francophone dynamique et enthousiaste. Sois concis et punchy.'
      );
      djIntro = introRaw
        || `Bienvenue sur ${radioName} ! On démarre avec ${seedSong.titre} — profitez du voyage musical 🎵`;
    }

    // ── Persistance ──────────────────────────────────────────
    await new RadioSession({
      userId:    req.user?.id || null,
      sessionId,
      mood:      mood || 'mixed',
      name:      radioName,
      seedSong:  seedSong._id,
      seedMoods,
      queue:     queue.map(s => s._id),
      djEnabled: !!djEnabled,
    }).save();

    return res.status(201).json({
      sessionId,
      name:     radioName,
      seedSong: { ...seedSong, _id: String(seedSong._id) },
      queue:    queue.map(s => ({ ...s, _id: String(s._id) })),
      djIntro,
      mood:     mood || 'mixed',
      seedMoods,
    });
  } catch (e) {
    console.error('[radioController] startSession error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /radio/:sessionId/next
 * Retourne le titre suivant + éventuel commentaire DJ.
 */
exports.nextSong = async (req, res) => {
  try {
    const session = await RadioSession.findOne({ sessionId: req.params.sessionId })
      .populate('seedSong', 'titre artiste moods')
      .populate('queue',    'titre artiste image src plays moods artisteId albumId')
      .populate('playedIds', '_id');

    if (!session || !session.active)
      return res.status(404).json({ message: 'Session radio introuvable ou expirée' });

    let nextSong = session.queue[0];

    const playedObjectIds = session.playedIds.map(p => p._id);
    const allSongs = await Song.find({ _id: { $nin: playedObjectIds } })
      .select('titre artiste artisteId albumId image src plays moods genre')
      .lean();

    // ── Recharger la file si nécessaire ──────────────────────
    if (!nextSong || session.queue.length <= 2) {
      const lastPlayedId = playedObjectIds[playedObjectIds.length - 1];
      let seedForQueue   = session.seedSong;

      if (!seedForQueue?.moods && lastPlayedId) {
        seedForQueue = await Song.findById(lastPlayedId)
          .select('titre artiste artisteId albumId moods plays')
          .lean();
      }

      if (seedForQueue && allSongs.length > 0) {
        const newQueue = selectCompatibleSongs(seedForQueue, allSongs, playedObjectIds, 8);
        session.queue  = [
          ...(nextSong ? [nextSong] : []),
          ...newQueue.map(s => s._id),
        ];
        nextSong = session.queue[0];
      }
    }

    if (!nextSong)
      return res.status(204).json({ message: 'Plus de titres disponibles' });

    // ── Résoudre l'objet complet ──────────────────────────────
    const nextSongObj =
      typeof nextSong === 'object' && nextSong.titre
        ? (nextSong.toObject?.() || nextSong)
        : await Song.findById(nextSong).lean();

    if (!nextSongObj)
      return res.status(204).json({ message: 'Titre introuvable' });

    // ── Mise à jour session (retirer de la file, marquer joué) ─
    await RadioSession.findByIdAndUpdate(session._id, {
      $pull:      { queue: nextSongObj._id },
      $addToSet:  { playedIds: nextSongObj._id },
      $inc:       { songsPlayed: 1 },
    });

    // ── Commentaire DJ (tous les 3 titres) ───────────────────
    let djComment = null;
    if (session.djEnabled && process.env.ANTHROPIC_API_KEY && session.songsPlayed % 3 === 0) {
      const prevId  = playedObjectIds[playedObjectIds.length - 1];
      const prevObj = prevId
        ? await Song.findById(prevId).select('titre artiste').lean()
        : null;

      djComment = await claudeHaiku(
        `Tu es le DJ IA de MOOZIK Radio "${session.name}". On vient d'écouter "${prevObj?.titre || 'le titre précédent'}" et maintenant on enchaîne avec "${nextSongObj.titre}" de ${nextSongObj.artiste}. Fais une phrase de transition énergique style DJ radio (max 15 mots). Réponds avec juste la phrase.`,
        'Tu es un DJ radio francophone. Sois court, dynamique, enthousiaste.'
      );
    }

    return res.json({
      song:        { ...nextSongObj, _id: String(nextSongObj._id) },
      djComment:   djComment || null,
      queueSize:   Math.max(0, session.queue.length - 1),
      songsPlayed: session.songsPlayed + 1,
    });
  } catch (e) {
    console.error('[radioController] nextSong error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /radio/:sessionId/skip
 * Skip le titre en cours (feedback négatif → ne plus le proposer).
 */
exports.skipSong = async (req, res) => {
  try {
    const { songId } = req.body;
    if (!songId)
      return res.status(400).json({ message: 'songId requis' });

    await RadioSession.findOneAndUpdate(
      { sessionId: req.params.sessionId },
      { $addToSet: { playedIds: songId } }
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('[radioController] skipSong error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /radio/:sessionId/like
 * Like → réoriente la queue autour du titre aimé.
 */
exports.likeSong = async (req, res) => {
  try {
    const { songId } = req.body;
    if (!songId)
      return res.status(400).json({ message: 'songId requis' });

    const session = await RadioSession.findOne({ sessionId: req.params.sessionId });
    if (!session) return res.json({ ok: false, message: 'Session introuvable' });

    const likedSong = await Song.findById(songId).lean();
    if (likedSong) {
      const allSongs = await Song.find({ _id: { $nin: session.playedIds } })
        .select('titre artiste artisteId albumId image src plays moods')
        .lean();

      const newQueue     = selectCompatibleSongs(likedSong, allSongs, session.playedIds, 6);
      const currentQueue = session.queue.slice(0, 2); // garder les 2 prochains
      const updatedQueue = [...currentQueue, ...newQueue.map(s => s._id)];

      await RadioSession.findByIdAndUpdate(session._id, {
        queue:     updatedQueue,
        seedSong:  likedSong._id,
        seedMoods: likedSong.moods?.length ? likedSong.moods : session.seedMoods,
      });
    }

    return res.json({ ok: true, message: 'Playlist ajustée selon vos goûts 🎯' });
  } catch (e) {
    console.error('[radioController] likeSong error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /radio/:sessionId
 * Retourne les infos complètes d'une session.
 */
exports.getSession = async (req, res) => {
  try {
    const session = await RadioSession.findOne({ sessionId: req.params.sessionId })
      .populate('seedSong', 'titre artiste image')
      .populate('queue',    'titre artiste image plays moods')
      .lean();

    if (!session)
      return res.status(404).json({ message: 'Session introuvable' });

    return res.json(session);
  } catch (e) {
    console.error('[radioController] getSession error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * DELETE /radio/:sessionId
 * Arrête (désactive) la session radio.
 */
exports.stopSession = async (req, res) => {
  try {
    await RadioSession.findOneAndUpdate(
      { sessionId: req.params.sessionId },
      { active: false }
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('[radioController] stopSession error:', e);
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /radio/config/moods
 * Liste des ambiances disponibles.
 */
exports.getMoods = (_req, res) => {
  res.json([
    { id: 'chill',     label: 'Chill',     icon: '🌊', desc: 'Sons doux, ambiance relaxante'         },
    { id: 'energie',   label: 'Énergie',   icon: '⚡', desc: 'Titres dynamiques, rythme soutenu'    },
    { id: 'focus',     label: 'Focus',     icon: '🎯', desc: 'Musique de concentration'              },
    { id: 'fete',      label: 'Fête',      icon: '🎉', desc: 'Ambiance festive, afrobeats, dancehall' },
    { id: 'nostalgie', label: 'Nostalgie', icon: '🌅', desc: 'Classiques et ambiance vintage'        },
    { id: 'romance',   label: 'Romance',   icon: '💕', desc: 'Sons doux et romantiques'              },
    { id: 'gospel',    label: 'Gospel',    icon: '✝️', desc: 'Musique spirituelle et gospel'          },
    { id: 'surprise',  label: 'Surprise',  icon: '🎲', desc: "L'IA choisit pour vous"               },
  ]);
};

/**
 * GET /radio/config/suggestions
 * Titres suggérés pour démarrer une session (top, récents, personnalisés).
 */
exports.getSuggestions = async (req, res) => {
  try {
    const [topSongs, recent] = await Promise.all([
      Song.find().sort({ plays: -1 }).limit(5).select('titre artiste image plays moods').lean(),
      Song.find().sort({ createdAt: -1 }).limit(5).select('titre artiste image plays moods').lean(),
    ]);

    let forYou = [];
    if (req.user?.id) {
      const userHistory = await History
        .find({ userId: req.user.id })
        .sort({ playedAt: -1 })
        .limit(20)
        .populate('songId', 'artisteId moods');

      const artistIds = [
        ...new Set(
          userHistory.map(h => String(h.songId?.artisteId)).filter(Boolean)
        ),
      ];

      if (artistIds.length > 0) {
        forYou = await Song
          .find({ artisteId: { $in: artistIds.slice(0, 3) } })
          .limit(5)
          .select('titre artiste image plays moods')
          .lean();
      }
    }

    return res.json({ topSongs, recent, forYou });
  } catch (e) {
    console.error('[radioController] getSuggestions error:', e);
    return res.status(500).json({ message: e.message });
  }
};

