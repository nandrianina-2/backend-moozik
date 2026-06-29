/**
 * analyticsRoutes.js
 *
 * Ajouter dans server.js :
 *   const analyticsRoutes = require('./routes/analyticsRoutes');
 *   app.use('/', analyticsRoutes);
 *
 * Dépendances à installer :
 *   npm install geoip-lite ua-parser-js nodemailer
 *
 * Variables .env :
 *   ANTHROPIC_API_KEY=sk-ant-...     (analyse de sentiment IA)
 *   BREVO_USER=...
 *   BREVO_PASS=...
 *   FRONTEND_URL=https://moozik.app
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
// DELETE /stories/:id
const { fromCloud } = require('../middleware/upload');

// Deps optionnelles — ne plantent pas si absentes
let geoip, UAParser;
try { geoip   = require('geoip-lite'); } catch {}
try { UAParser = require('ua-parser-js'); } catch {}

const {
  RetentionEvent, GeoPlay, TrendingScore, DemographicsSnapshot,
  SentimentAnalysis, Story, LoyaltyPoint, WeeklyChart, Challenge,
  FanBadge, ListenParty, WeeklyReport,
} = require('../models/analyticsModels');

const { Song, Artist, User, Comment, History, UserPlay } = require('../models');
const { ArtistFollower } = require('../models/featureModels');
const { requireAuth, requireAdmin, requireArtist, requireAdminOrArtist, optionalAuth } = require('../middleware/auth');
const { upload, toCloud, IMG_TRANSFORM } = require('../middleware/upload');

// ── Helpers ───────────────────────────────────
const getWeek = (d = new Date()) => {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
};

const POINTS_CONFIG = {
  play:      1,
  comment:   5,
  share:     3,
  favorite:  2,
  register: 20,
  referral: 50,
  listen_party: 10,
};

const LOYALTY_LEVELS = [
  { name: 'bronze',   min: 0 },
  { name: 'silver',   min: 100 },
  { name: 'gold',     min: 500 },
  { name: 'platinum', min: 2000 },
];

const getLoyaltyLevel = (points) =>
  [...LOYALTY_LEVELS].reverse().find(l => points >= l.min)?.name || 'bronze';

const addPoints = async (userId, action, meta = '') => {
  if (!userId) return;
  const pts = POINTS_CONFIG[action] || 0;
  if (!pts) return;
  const lp = await LoyaltyPoint.findOneAndUpdate(
    { userId },
    {
      $inc: { points: pts, totalEarned: pts },
      $push: { history: { action, points: pts, meta, date: new Date() } },
    },
    { upsert: true, returnDocument: 'after' }
  );
  const level = getLoyaltyLevel(lp.points);
  if (lp.level !== level) await LoyaltyPoint.findByIdAndUpdate(lp._id, { level });
};

const geoFromIp = (ip) => {
  if (!geoip || !ip) return {};
  const clean = ip.replace('::ffff:', '');
  const geo = geoip.lookup(clean);
  if (!geo) return {};
  return { country: geo.country || 'XX', countryName: geo.country || '', region: geo.region || '', city: geo.city || '', lat: geo.ll?.[0], lng: geo.ll?.[1] };
};

// ════════════════════════════════════════════
// 1. RÉTENTION AUDIO
// ════════════════════════════════════════════

// POST — enregistrer un bucket d'écoute
router.post('/songs/:id/retention', optionalAuth, async (req, res) => {
  try {
    const { bucket, totalTime, completed = false, deviceId = '' } = req.body;
    // bucket = 0-19 (chaque bucket = 5% de la chanson)
    if (bucket < 0 || bucket > 19) return res.json({ ok: false });
    const update = {
      $inc: { [`buckets.${bucket}`]: 1, totalTime: totalTime || 0 },
      $set: { completed: completed || false, dropped: bucket * 5 },
      userId: req.user?.id || null, deviceId,
    };
    await RetentionEvent.findOneAndUpdate(
      { songId: req.params.id, userId: req.user?.id || null, deviceId },
      update,
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — courbe de rétention agrégée pour une chanson
router.get('/songs/:id/retention', requireAdminOrArtist, async (req, res) => {
  try {
    const events = await RetentionEvent.find({ songId: req.params.id });
    if (!events.length) return res.json({ buckets: Array(20).fill(0), completionRate: 0, avgListenPercent: 0 });

    const totals = Array(20).fill(0);
    events.forEach(e => {if (Array.isArray(e.buckets)) {e.buckets.forEach((v, i) => {totals[i] += v || 0;});}});    
    const maxListeners = totals[0] || 1;
    const retentionCurve = totals.map(v => Math.round((v / maxListeners) * 100));
    const completionRate = Math.round((events.filter(e => e.completed).length / events.length) * 100);
    const avgListenPercent = Math.round(totals.reduce((s, v, i) => s + v * (i * 5 + 2.5), 0) / totals.reduce((s, v) => s + v, 1));

    // Trouver les points de chute
    const dropPoints = retentionCurve.reduce((acc, v, i) => {
      if (i > 0 && retentionCurve[i - 1] - v > 10) acc.push({ percent: i * 5, drop: retentionCurve[i - 1] - v });
      return acc;
    }, []);

    res.json({ buckets: retentionCurve, completionRate, avgListenPercent, dropPoints, totalListeners: events.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 2. CARTE DES ÉCOUTES (GÉO)
// ════════════════════════════════════════════

// POST — tracker une écoute géolocalisée (appelé dans PUT /songs/:id/play)
router.post('/songs/:id/geo-play', optionalAuth, async (req, res) => {
  try {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const geo = geoFromIp(ip);
    if (!geo.country) return res.json({ ok: false });
    const song = await Song.findById(req.params.id).select('artisteId');
    await GeoPlay.findOneAndUpdate(
      { songId: req.params.id, country: geo.country },
      { $inc: { count: 1 }, $set: { ...geo, artistId: song?.artisteId } },
      { upsert: true }
    );
    res.json({ ok: true, country: geo.country });
  } catch (e) { res.json({ ok: false }); }
});

// GET — carte d'écoutes d'une musique (ou d'un artiste)
router.get('/analytics/geo', requireAdminOrArtist, async (req, res) => {
  try {
    const filter = {};
    if (req.query.songId) filter.songId = req.query.songId;
    if (req.query.artistId) filter.artistId = req.query.artistId;
    const data = await GeoPlay.aggregate([
      { $match: filter },
      { $group: { _id: '$country', count: { $sum: '$count' }, countryName: { $first: '$countryName' }, lat: { $first: '$lat' }, lng: { $first: '$lng' } } },
      { $sort: { count: -1 } },
      { $project: { country: '$_id', count: 1, countryName: 1, lat: 1, lng: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — carte publique admin
router.get('/admin/analytics/geo', requireAdmin, async (req, res) => {
  try {
    const data = await GeoPlay.aggregate([
      { $group: { _id: '$country', count: { $sum: '$count' }, countryName: { $first: '$countryName' }, lat: { $first: '$lat' }, lng: { $first: '$lng' } } },
      { $sort: { count: -1 } },
      { $project: { country: '$_id', count: 1, countryName: 1, lat: 1, lng: 1, _id: 0 } },
    ]);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 3. TRENDING EN TEMPS RÉEL
// ════════════════════════════════════════════

// GET — top trending
router.get('/trending', async (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const scores = await TrendingScore.find().sort({ score: -1 }).limit(limit)
      .populate('songId', 'titre artiste image plays artisteId');
    res.set('Cache-Control', 'public, max-age=300'); // cache 5 min
    res.json(scores.filter(s => s.songId));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Cron — recalculer le trending toutes les heures
const updateTrending = async () => {
  try {
    const now = new Date();
    const h1  = new Date(now - 3600000);
    const h24 = new Date(now - 86400000);
    const d7  = new Date(now - 7 * 86400000);
    const songs = await Song.find().select('_id plays');

    for (const song of songs) {
      const [plays1h, plays24h, plays7d, reactions, shares] = await Promise.all([
        History.countDocuments({ songId: song._id, playedAt: { $gte: h1 } }),
        History.countDocuments({ songId: song._id, playedAt: { $gte: h24 } }),
        History.countDocuments({ songId: song._id, playedAt: { $gte: d7 } }),
        require('../models').Reaction?.countDocuments({ songId: song._id }) || 0,
        require('../models/featureModels')?.ShareHistory ? 0 : 0,
      ]);
      // Score composite : vélocité (50%) + réactions (30%) + total (20%)
      const velocity = plays1h * 24; // écoutes/heure extrapolées sur 24h
      const score    = velocity * 0.5 + reactions * 0.3 * 10 + plays7d * 0.2;
      await TrendingScore.findOneAndUpdate(
        { songId: song._id },
        { songId: song._id, score, velocity, plays1h, plays24h, plays7d, reactions, updatedAt: now },
        { upsert: true }
      );
    }
    console.log(`✅ Trending mis à jour — ${songs.length} titres`);
  } catch (e) { console.error('Trending update error:', e.message); }
};
// Lancer toutes les heures
setInterval(updateTrending, 3600000);
setTimeout(updateTrending, 5000); // Premier calcul au démarrage

// ════════════════════════════════════════════
// 4. AUDIENCE DEMOGRAPHICS
// ════════════════════════════════════════════

// Middleware à appeler dans PUT /songs/:id/play pour collecter l'user-agent
const trackDemographics = async (artistId, req) => {
  if (!artistId || !UAParser) return;
  const today   = new Date().toISOString().slice(0, 10);
  const ua      = req.headers['user-agent'] || '';
  const parser  = new UAParser(ua);
  const device  = parser.getDevice().type || 'desktop';
  const deviceKey = device === 'mobile' ? 'mobile' : device === 'tablet' ? 'tablet' : 'desktop';
  const hour = new Date().getHours();
  const inc = {
    [`devices.${deviceKey}`]: 1,
    [`hourlyPlays.${hour}`]: 1,
    totalPlays: 1,
  };
  await DemographicsSnapshot.findOneAndUpdate(
    { artistId, period: today },
    { $inc: inc, $setOnInsert: { artistId, period: today } },
    { upsert: true }
  );
};


// GET — demographics d'un artiste
router.get('/artists/:id/demographics', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const snapshots = await DemographicsSnapshot.find({ artistId: req.params.id, period: { $gte: since } });
    if (!snapshots.length) return res.json({ hourly: Array(24).fill(0), devices: {}, totalPlays: 0 });

    // Agréger
    const hourly  = Array(24).fill(0);
    const devices = { mobile: 0, desktop: 0, tablet: 0 };
    let totalPlays = 0;
    snapshots.forEach(s => {
      s.hourlyPlays.forEach((v, i) => { hourly[i] += v; });
      Object.keys(devices).forEach(k => { devices[k] += s.devices?.[k] || 0; });
      totalPlays += s.totalPlays || 0;
    });
    const peakHour = hourly.indexOf(Math.max(...hourly));

    // Écoutes par pays
    const geoData = await GeoPlay.aggregate([
      { $match: { artistId: new require('mongoose').Types.ObjectId(req.params.id) } },
      { $group: { _id: '$country', count: { $sum: '$count' }, countryName: { $first: '$countryName' } } },
      { $sort: { count: -1 } }, { $limit: 10 },
    ]);

    res.json({ hourly, devices, totalPlays, peakHour, topCountries: geoData });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 5. ANALYSE SENTIMENTS (IA)
// ════════════════════════════════════════════

const analyzeCommentSentiment = async (songId) => {
  try {
    const comments = await Comment.find({ songId }).select('texte').limit(100);
    if (!comments.length) return;
    const texts = comments.map(c => c.texte).join('\n');

    let positive = 0, negative = 0, neutral = 0, score = 0;
    let posKeywords = [], negKeywords = [];

    if (process.env.ANTHROPIC_API_KEY) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `Analyse le sentiment de ces commentaires sur une musique. Réponds UNIQUEMENT en JSON strict:
{"positive":X,"negative":Y,"neutral":Z,"score":N,"positiveKeywords":[],"negativeKeywords":[]}
où X/Y/Z sont des pourcentages (total=100), score entre -1 et 1, keywords = 3 mots-clés max.

Commentaires:\n${texts.slice(0, 2000)}`
          }]
        }),
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      positive = parsed.positive || 0; negative = parsed.negative || 0; neutral = parsed.neutral || 0;
      score = parsed.score || 0; posKeywords = parsed.positiveKeywords || []; negKeywords = parsed.negativeKeywords || [];
    } else {
      // Fallback sans IA — analyse lexicale simple
      const posWords = ['super','génial','magnifique','wow','banger','incroyable','j\'adore','love','fire','🔥','❤️','best','amazing'];
      const negWords = ['nul','mauvais','horrible','déteste','bof','pas terrible','déçu','boring'];
      let posCount = 0, negCount = 0;
      comments.forEach(c => {
        const t = c.texte.toLowerCase();
        if (posWords.some(w => t.includes(w))) posCount++;
        else if (negWords.some(w => t.includes(w))) negCount++;
      });
      const total = comments.length;
      positive = Math.round((posCount / total) * 100);
      negative = Math.round((negCount / total) * 100);
      neutral  = 100 - positive - negative;
      score    = (positive - negative) / 100;
    }

    await SentimentAnalysis.findOneAndUpdate(
      { songId },
      { songId, positive, negative, neutral, score, alert: negative > 40,
        lastAnalyzed: new Date(), commentCount: comments.length,
        keywords: { positive: posKeywords, negative: negKeywords } },
      { upsert: true }
    );
  } catch (e) { console.warn('Sentiment analysis error:', e.message); }
};

// GET — sentiment d'une chanson
router.get('/songs/:id/sentiment', requireAdminOrArtist, async (req, res) => {
  try {
    let sentiment = await SentimentAnalysis.findOne({ songId: req.params.id });
    // Re-analyser si pas analysé depuis 24h
    const stale = !sentiment || (Date.now() - new Date(sentiment.lastAnalyzed) > 86400000);
    if (stale) {
      await analyzeCommentSentiment(req.params.id);
      sentiment = await SentimentAnalysis.findOne({ songId: req.params.id });
    }
    res.json(sentiment || { positive: 0, negative: 0, neutral: 100, score: 0, alert: false });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — alertes sentiments négatifs (admin)
router.get('/admin/sentiment/alerts', requireAdmin, async (req, res) => {
  try {
    const alerts = await SentimentAnalysis.find({ alert: true })
      .populate('songId', 'titre artiste image').sort({ negative: -1 }).limit(20);
    res.json(alerts);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 6. STORIES ARTISTE (24h)
// ════════════════════════════════════════════

// POST — créer une story
router.post('/artists/:id/stories', requireAdminOrArtist, upload.single('media'), async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    if (!req.file) return res.status(400).json({ message: 'Fichier requis' });
    const isAudio = req.file.mimetype.includes('audio');
    const isVideo = req.file.mimetype.includes('video');
    const type    = isAudio ? 'audio' : isVideo ? 'video' : 'image';
    const resourceType = (isAudio || isVideo) ? 'video' : 'image';
    const result = await toCloud(req.file.buffer, { folder: 'moozik/stories', resource_type: resourceType });
    const story  = await new Story({
      artistId: req.params.id, type, mediaUrl: result.secure_url, mediaPublicId: result.public_id,
      caption: req.body.caption || '', duration: parseInt(req.body.duration || 30),
      expiresAt: new Date(Date.now() + 86400000), // 24h
    }).save();
    res.json(story);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — stories actives de tous les artistes suivis
router.get('/stories/feed', optionalAuth, async (req, res) => {
  try {
    const now = new Date();
    let artistIds = [];
    if (req.user?.id) {
      const follows = await ArtistFollower.find({ userId: req.user.id }).select('artistId');
      artistIds = follows.map(f => f.artistId);
    }
    // Même sans connexion : afficher les stories des artistes certifiés
    const filter = { active: true, expiresAt: { $gt: now } };
    if (artistIds.length) filter.artistId = { $in: artistIds };
    const stories = await Story.find(filter)
      .populate('artistId', 'nom image certified certLevel')
      .sort({ createdAt: -1 }).limit(30);
    // Grouper par artiste
    const byArtist = {};
    stories.forEach(s => {
      const aid = String(s.artistId._id);
      if (!byArtist[aid]) byArtist[aid] = { artist: s.artistId, stories: [] };
      byArtist[aid].stories.push({ ...s.toObject(), viewed: req.user ? s.viewedBy.some(id => String(id) === String(req.user.id)) : false });
    });
    res.json(Object.values(byArtist));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — stories d'un artiste
router.get('/artists/:id/stories', async (req, res) => {
  try {
    const stories = await Story.find({ artistId: req.params.id, active: true, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    res.json(stories);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE /stories/:id
router.delete('/stories/:id', async (req, res) => {
  try {
    const storyId = req.params.id;

    // 1. Récupérer la story pour avoir le publicId
    const story = await Story.findById(storyId);

    if (!story) {
      return res.status(404).json({ message: 'Story introuvable' });
    }

    // 2. Supprimer le fichier sur Cloudinary via ton helper
    // On précise 'video' si le mimetype stocké n'est pas une image
    const resourceType = story.mimetype && story.mimetype.startsWith('audio') ? 'video' : 'image';
    await fromCloud(story.cloudinaryId, resourceType);

    // 3. Supprimer de la base de données
    await Story.findByIdAndDelete(storyId);
    res.status(200).json({ message: 'Story supprimée' });
    // res.json({ message: 'Story supprimée avec succès' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT — marquer une story comme vue
router.put('/stories/:id/view', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const story  = await Story.findById(req.params.id);
    if (!story) return res.json({ ok: false });
    await Story.findByIdAndUpdate(req.params.id, {
      $inc: { views: 1 },
      ...(userId ? { $addToSet: { viewedBy: userId } } : {}),
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// ════════════════════════════════════════════
// 7. PROGRAMME DE FIDÉLITÉ
// ════════════════════════════════════════════

router.get('/loyalty/me', requireAuth, async (req, res) => {
  try {
    const lp = await LoyaltyPoint.findOne({ userId: req.user.id });
    res.json(lp || { points: 0, totalEarned: 0, level: 'bronze', history: [] });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/loyalty/leaderboard', async (req, res) => {
  try {
    const top = await LoyaltyPoint.find().sort({ points: -1 }).limit(20).populate('userId', 'nom avatar');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(top);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Déclencher des points (appelé par d'autres routes)
router.post('/loyalty/award', requireAuth, async (req, res) => {
  try {
    const { action, meta } = req.body;
    await addPoints(req.user.id, action, meta || '');
    const lp = await LoyaltyPoint.findOne({ userId: req.user.id });
    res.json(lp);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin — voir les points globaux
router.get('/admin/loyalty', requireAdmin, async (req, res) => {
  try {
    const levels = await LoyaltyPoint.aggregate([
      { $group: { _id: '$level', count: { $sum: 1 }, totalPoints: { $sum: '$points' } } }
    ]);
    const total = await LoyaltyPoint.countDocuments();
    res.json({ levels, total });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 8. CLASSEMENTS & CHALLENGES
// ════════════════════════════════════════════

// GET — classement hebdomadaire
router.get('/charts/:type', async (req, res) => {
  try {
    const week  = req.query.week || getWeek();
    const type  = ['songs','artists','new','viral'].includes(req.params.type) ? req.params.type : 'songs';
    let chart   = await WeeklyChart.findOne({ week, type })
      .populate('entries.songId')
      .populate('entries.artistId');
    if (!chart) chart = await generateChart(week, type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(chart);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

const generateChart = async (week, type) => {
  const weekAgo   = new Date(Date.now() - 7 * 86400000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000);
  let entries = [];

  if (type === 'songs' || type === 'viral') {
    const scores = await TrendingScore.find().sort({ score: -1 }).limit(10).populate('songId', 'titre artiste image plays artisteId');
    const prevChart = await WeeklyChart.findOne({ week: getWeek(twoWeeksAgo), type });
    entries = scores.filter(s => s.songId).map((s, i) => {
      const prevRank = prevChart?.entries?.find(e => String(e.songId) === String(s.songId?._id))?.rank;
      return { rank: i + 1, songId: s.songId._id, score: s.score, change: prevRank ? prevRank - (i + 1) : 0, isNewEntry: !prevRank };
    });
  } else if (type === 'new') {
    const songs = await Song.find({ createdAt: { $gte: weekAgo } }).sort({ plays: -1 }).limit(10).select('titre artiste image plays');
    entries = songs.map((s, i) => ({ rank: i + 1, songId: s._id, score: s.plays, isNewEntry: true, change: 0 }));
  } else if (type === 'artists') {
    const artistData = await UserPlay.aggregate([
      { $match: { updatedAt: { $gte: weekAgo } } },
      { $lookup: { from: 'songs', localField: 'songId', foreignField: '_id', as: 'song' } },
      { $unwind: '$song' },
      { $group: { _id: '$song.artisteId', score: { $sum: '$count' } } },
      { $sort: { score: -1 } }, { $limit: 10 },
    ]);
    entries = artistData.filter(a => a._id).map((a, i) => ({ rank: i + 1, artistId: a._id, score: a.score, isNewEntry: false, change: 0 }));
  }

  return WeeklyChart.findOneAndUpdate({ week, type }, { week, type, entries, generatedAt: new Date() }, { upsert: true, returnDocument: 'after' });
};

// Cron — générer les charts chaque lundi
const scheduleCharts = () => {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + (1 + 7 - now.getDay()) % 7 || 7);
  next.setHours(0, 5, 0, 0);
  setTimeout(() => {
    ['songs','artists','new','viral'].forEach(t => generateChart(getWeek(), t));
    setInterval(() => { ['songs','artists','new','viral'].forEach(t => generateChart(getWeek(), t)); }, 7 * 86400000);
  }, next - now);
};
scheduleCharts();

// GET — challenges actifs
router.get('/challenges', async (req, res) => {
  try {
    const now = new Date();
    const challenges = await Challenge.find({ active: true, startsAt: { $lte: now }, endsAt: { $gte: now } })
      .populate('songId', 'titre artiste image');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(challenges);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin — créer un challenge
router.post('/admin/challenges', requireAdmin, async (req, res) => {
  try {
    const { hashtag, title, description, songId, startsAt, endsAt, prize } = req.body;
    if (!hashtag || !title || !startsAt || !endsAt) return res.status(400).json({ message: 'Champs requis manquants' });
    const challenge = await new Challenge({ hashtag, title, description, songId: songId || null, startsAt: new Date(startsAt), endsAt: new Date(endsAt), prize: prize || '', createdBy: req.admin.id }).save();
    res.json(challenge);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — Fan Badge de l'artiste
router.get('/artists/:id/fan-badge', async (req, res) => {
  try {
    const badge = await FanBadge.findOne({ artistId: req.params.id }).populate('userId', 'nom avatar');
    res.json(badge || null);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Cron — attribuer les Fan Badges chaque semaine
const updateFanBadges = async () => {
  try {
    const artists = await Artist.find().select('_id');
    for (const artist of artists) {
      const topFan = await UserPlay.aggregate([
        { $lookup: { from: 'songs', localField: 'songId', foreignField: '_id', as: 'song' } },
        { $unwind: '$song' },
        { $match: { 'song.artisteId': artist._id } },
        { $group: { _id: '$userId', plays: { $sum: '$count' } } },
        { $sort: { plays: -1 } }, { $limit: 1 },
      ]);
      if (topFan.length) {
        await FanBadge.findOneAndUpdate({ artistId: artist._id }, { artistId: artist._id, userId: topFan[0]._id, plays: topFan[0].plays, awardedAt: new Date() }, { upsert: true });
      }
    }
  } catch {}
};
setInterval(updateFanBadges, 7 * 86400000);

// ════════════════════════════════════════════
// 9. ÉCOUTE COLLABORATIVE (LISTEN PARTY)
// ════════════════════════════════════════════

// POST — créer une listen party
router.post('/listen-party', requireAuth, async (req, res) => {
  try {
    const { songId, maxParticipants = 10 } = req.body;
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const party = await new ListenParty({
      code, hostId: req.user.id, songId: songId || null,
      participants: [req.user.id], maxParticipants: Math.min(50, parseInt(maxParticipants)),
      expiresAt: new Date(Date.now() + 4 * 3600000), // expire dans 4h
    }).save();
    await addPoints(req.user.id, 'listen_party', code);
    res.json(party);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET — rejoindre une party par code
router.get('/listen-party/:code', optionalAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase(), active: true })
      .populate('songId', 'titre artiste image src')
      .populate('hostId', 'nom avatar')
      .populate('participants', 'nom avatar');
    if (!party) return res.status(404).json({ message: 'Party introuvable ou expirée' });
    res.json(party);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST — rejoindre
router.post('/listen-party/:code/join', requireAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase(), active: true });
    if (!party) return res.status(404).json({ message: 'Party introuvable' });
    if (party.participants.length >= party.maxParticipants) return res.status(400).json({ message: 'Party complète' });
    await ListenParty.findByIdAndUpdate(party._id, { $addToSet: { participants: req.user.id } });
    res.json({ ok: true, code: party.code });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PUT — sync état de lecture (host seulement)
router.put('/listen-party/:code/sync', requireAuth, async (req, res) => {
  try {
    const { currentTime, isPlaying, songId } = req.body;
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party) return res.status(404).json({ message: 'Introuvable' });
    if (String(party.hostId) !== String(req.user.id)) return res.status(403).json({ message: 'Seul le host peut synchroniser' });
    await ListenParty.findByIdAndUpdate(party._id, { currentTime, isPlaying, ...(songId ? { songId } : {}) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST — envoyer un message dans la party
router.post('/listen-party/:code/message', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'Message vide' });
    const user  = await User.findById(req.user.id).select('nom avatar');
    const party = await ListenParty.findOneAndUpdate(
      { code: req.params.code.toUpperCase(), active: true },
      { $push: { messages: { userId: req.user.id, nom: user?.nom || 'Anonyme', avatar: user?.avatar || '', text: text.trim() } } },
      { returnDocument: 'after' }
    );
    if (!party) return res.status(404).json({ message: 'Party introuvable' });
    const lastMsg = party.messages[party.messages.length - 1];
    res.json(lastMsg);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE — quitter / fermer
router.delete('/listen-party/:code', requireAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party) return res.json({ ok: false });
    if (String(party.hostId) === String(req.user.id)) {
      await ListenParty.findByIdAndUpdate(party._id, { active: false });
    } else {
      await ListenParty.findByIdAndUpdate(party._id, { $pull: { participants: req.user.id } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// 10. RAPPORTS HEBDOMADAIRES ARTISTE
// ════════════════════════════════════════════

const generateWeeklyReports = async () => {
  try {
    const week   = getWeek();
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const artists = await Artist.find().select('_id nom email');
    for (const artist of artists) {
      // Écoutes de la semaine
      const songs  = await Song.find({ artisteId: artist._id }).select('_id plays');
      const songIds = songs.map(s => s._id);
      const plays  = await History.countDocuments({ songId: { $in: songIds }, playedAt: { $gte: weekAgo } });
      // Nouveaux followers
      const newFollowers = await ArtistFollower.countDocuments({ artistId: artist._id, createdAt: { $gte: weekAgo } });
      // Top song
      const topSongData = await History.aggregate([
        { $match: { songId: { $in: songIds }, playedAt: { $gte: weekAgo } } },
        { $group: { _id: '$songId', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 1 },
      ]);
      // Top pays
      const topGeo = await GeoPlay.findOne({ artistId: artist._id }).sort({ count: -1 }).select('countryName country');
      await WeeklyReport.findOneAndUpdate(
        { artistId: artist._id, week },
        { artistId: artist._id, week, plays, newFollowers, topSong: topSongData[0]?._id, topCountry: topGeo?.country || '' },
        { upsert: true }
      );
      // Envoyer l'email si artiste a un email
      if (artist.email && plays > 0) {
        await sendWeeklyEmail(artist, { plays, newFollowers, week, topCountry: topGeo?.countryName || '' });
        await WeeklyReport.findOneAndUpdate({ artistId: artist._id, week }, { emailSent: true, sentAt: new Date() });
      }
    }
    console.log(`✅ Rapports hebdomadaires envoyés — ${artists.length} artistes`);
  } catch (e) { console.error('Weekly reports error:', e.message); }
};

const sendWeeklyEmail = async (artist, data) => {
  try {
    let nodemailer; try { nodemailer = require('nodemailer'); } catch { return; }
    const transporter = nodemailer.createTransport({
      host:   'smtp-relay.brevo.com',
      port:   587,
      secure: false,
      auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_PASS,
      },
    });
    await transporter.sendMail({
      from: `MOOZIK <${process.env.BREVO_USER}>`,
      to: artist.email,
      subject: `📊 Votre rapport de la semaine ${data.week}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#18181b;color:#fff;padding:32px;border-radius:16px">
          <h1 style="color:#ef4444;margin-top:0">MOOZIK — Rapport hebdomadaire</h1>
          <p style="color:#a1a1aa">Bonjour ${artist.nom}, voici vos stats pour la semaine ${data.week} :</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0">
            <div style="background:#27272a;padding:20px;border-radius:12px;text-align:center">
              <div style="font-size:32px;font-weight:900;color:#ef4444">${data.plays.toLocaleString()}</div>
              <div style="color:#71717a;font-size:12px;margin-top:4px">ÉCOUTES</div>
            </div>
            <div style="background:#27272a;padding:20px;border-radius:12px;text-align:center">
              <div style="font-size:32px;font-weight:900;color:#3b82f6">+${data.newFollowers}</div>
              <div style="color:#71717a;font-size:12px;margin-top:4px">NOUVEAUX FANS</div>
            </div>
          </div>
          ${data.topCountry ? `<p style="color:#a1a1aa">🌍 Votre principal marché cette semaine : <strong style="color:#fff">${data.topCountry}</strong></p>` : ''}
          <a href="${process.env.FRONTEND_URL}/artist-dashboard" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px">
            Voir le tableau de bord complet
          </a>
          <p style="color:#52525b;font-size:12px;margin-top:24px">MOOZIK · Se désabonner depuis les paramètres de votre compte</p>
        </div>
      `,
    });
  } catch (e) { console.warn('Email error:', e.message); }
};

// Cron chaque lundi à 8h
const scheduleLundis = () => {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + (1 + 7 - now.getDay()) % 7 || 7);
  next.setHours(8, 0, 0, 0);
  setTimeout(() => { generateWeeklyReports(); setInterval(generateWeeklyReports, 7 * 86400000); }, next - now);
};
scheduleLundis();

// GET — rapport de la semaine pour un artiste
router.get('/artists/:id/weekly-report', requireAdminOrArtist, async (req, res) => {
  try {
    const reports = await WeeklyReport.find({ artistId: req.params.id }).populate('topSong','titre image').sort({ week: -1 }).limit(8);
    res.json(reports);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin — forcer génération des rapports
router.post('/admin/weekly-reports/generate', requireAdmin, async (req, res) => {
  try { await generateWeeklyReports(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

// Exporter trackDemographics pour l'utiliser dans songController
module.exports = router;
module.exports.trackDemographics = trackDemographics;
module.exports.addPoints = addPoints;
module.exports.analyzeCommentSentiment = analyzeCommentSentiment;