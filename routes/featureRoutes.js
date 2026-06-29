/**
 * featureRoutes.js
 * Ajouter dans server.js / routes/index.js :
 *   const featureRoutes = require('./featureRoutes');
 *   app.use('/', featureRoutes);
 *
 * Dépendances backend à installer :
 *   npm install web-push fluent-ffmpeg @ffmpeg/ffmpeg lrc-parser
 *   npm install nodemailer   (ou utiliser Resend/Sendgrid)
 *
 * Variables .env à ajouter :
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *   VAPID_EMAIL=mailto:admin@moozik.app
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_USER=...
 *   SMTP_PASS=...
 *   FRONTEND_URL=https://moozik.app
 */

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const webpush  = require('web-push');

const {
  Lyrics, Certification, SmartLink, Featuring,
  ScheduledRelease, ArtistFollower, NewsletterCampaign, PushSubscription,
} = require('../models/featureModels');

const { ListenParty } = require('../models/analyticsModels');

// ── Import depuis le projet principal ──────────
// Adapte les chemins selon ta structure MVC
const { requireAuth, requireAdmin, requireArtist, requireAdminOrArtist, optionalAuth, signToken, verifyToken } = require('../middleware/auth');
const { upload, toCloud, IMG_TRANSFORM } = require('../middleware/upload');
const { Song, Artist, User, Notification, Album } = require('../models');

// ── WebPush config ────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:dodisoa.nandrianina@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// Helper: envoyer une webpush à un userId ou broadcast
const sendPush = async (userIds, payload) => {
  const filter = userIds ? { userId: { $in: userIds } } : {};
  const subs   = await PushSubscription.find(filter);
  const results = await Promise.allSettled(subs.map(s =>
    webpush.sendNotification(s.subscription, JSON.stringify(payload)).catch(() => {
      PushSubscription.deleteOne({ _id: s._id }).catch(() => {}); // supprimer les sub expirées
    })
  ));
  return results.filter(r => r.status === 'fulfilled').length;
};

// ════════════════════════════════════════════
// WEBPUSH
// ════════════════════════════════════════════

// Clé publique VAPID pour le frontend
router.get('/push/vapid-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// S'abonner aux push notifications
router.post('/push/subscribe', optionalAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ message: 'Subscription invalide' });
    const userId = req.user?.id || null;
    await PushSubscription.findOneAndUpdate(
      { 'subscription.endpoint': subscription.endpoint },
      { subscription, userId, userAgent: req.headers['user-agent'] || '' },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Se désabonner
router.post('/push/unsubscribe', async (req, res) => {
  try {
    await PushSubscription.deleteOne({ 'subscription.endpoint': req.body.endpoint });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin: envoyer une push broadcast
router.post('/admin/push/broadcast', requireAdmin, async (req, res) => {
  try {
    const { title, body, url, icon } = req.body;
    if (!title) return res.status(400).json({ message: 'Titre requis' });
    const count = await sendPush(null, { title, body: body || '', url: url || '/', icon: icon || '/icon-192.png' });
    res.json({ sent: count });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// LYRICS (Paroles synchronisées)
// ════════════════════════════════════════════

// GET paroles d'une chanson
router.get('/songs/:id/lyrics', async (req, res) => {
  try {
    const lyrics = await Lyrics.findOne({ songId: req.params.id });
    if (!lyrics) return res.status(404).json({ message: 'Paroles introuvables' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(lyrics);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST / PUT — uploader un fichier .lrc ou des lignes JSON
router.put('/songs/:id/lyrics', requireAdminOrArtist, (req, res, next) => {
  // Si multipart (fichier lrc), utiliser multer
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    upload.single('lrc')(req, res, next);
  } else {
    next(); // JSON normal
  }
}, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Musique introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id))
      return res.status(403).json({ message: 'Accès refusé' });

    let lines = [];

    if (req.file) {
      const lrcText = req.file.buffer.toString('utf-8');
      lines = parseLRC(lrcText);
    } else if (req.body.lines) {
      lines = typeof req.body.lines === 'string'
        ? JSON.parse(req.body.lines)
        : req.body.lines;
    }

    if (!lines.length) return res.status(400).json({ message: 'Aucune ligne de paroles trouvée' });

    const lyrics = await Lyrics.findOneAndUpdate(
      { songId: req.params.id },
      { songId: req.params.id, lines, source: req.file ? 'lrc' : 'manual', uploadedBy: req.user.id },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(lyrics);
  } catch (e) {
    console.error('Lyrics PUT error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// DELETE paroles
router.delete('/songs/:id/lyrics', requireAdminOrArtist, async (req, res) => {
  try {
    await Lyrics.deleteOne({ songId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Parser LRC local (pas de dépendance)
function parseLRC(text) {
  const lines = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const min  = parseInt(match[1]);
    const sec  = parseInt(match[2]);
    const ms   = parseInt(match[3].padEnd(3, '0'));
    const time = min * 60 + sec + ms / 1000;
    const text_line = match[4].trim();
    if (text_line) lines.push({ time, text: text_line });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// ════════════════════════════════════════════
// CERTIFICATION ARTISTE
// ════════════════════════════════════════════

// Demander une certification (artiste)
router.post('/artists/:id/certification', requireArtist, async (req, res) => {
    console.log('role:', req.user?.role);
    console.log('user.id:', req.user?.id);
    console.log('user._id:', req.user?._id);
    console.log('params.id:', req.params.id);
  try {
    if (req.user.role === 'artist' && String(req.user.id || req.user._id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const existing = await Certification.findOne({ artistId: req.params.id });
    if (existing && existing.status === 'pending') return res.status(400).json({ message: 'Demande déjà en attente' });
    if (existing && existing.status === 'approved') return res.status(400).json({ message: 'Déjà certifié' });
    const cert = await Certification.findOneAndUpdate(
      { artistId: req.params.id },
      { artistId: req.params.id, status: 'pending', requestedAt: new Date(), note: req.body?.note || '' },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(cert);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET statut certification d'un artiste
router.get('/artists/:id/certification', async (req, res) => {
  try {
    const cert = await Certification.findOne({ artistId: req.params.id });
    res.json(cert || { status: 'none' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin: lister les demandes en attente
router.get('/admin/certifications', requireAdmin, async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const certs = await Certification.find(filter)
      .populate('artistId', 'nom image email bio')
      .sort({ createdAt: -1 });
    res.json(certs);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin: approuver / refuser
router.put('/admin/certifications/:id', requireAdmin, async (req, res) => {
  try {
    const { status, level, note } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ message: 'Status invalide' });
    const cert = await Certification.findByIdAndUpdate(req.params.id, {
      status, level: level || 'blue', note: note || '', reviewedAt: new Date(), reviewedBy: req.admin.id,
    }, { returnDocument: 'after' }).populate('artistId', 'nom');
    if (!cert) return res.status(404).json({ message: 'Introuvable' });
    // Mettre à jour le champ certified sur l'artiste
    if (status === 'approved') {
      await Artist.findByIdAndUpdate(cert.artistId._id, { certified: true, certLevel: level || 'blue' });
    }
    // Notifier l'artiste via push si possible
    const artistUser = await User.findOne({ email: (await Artist.findById(cert.artistId._id))?.email });
    if (artistUser) {
      await sendPush([artistUser._id], {
        title: status === 'approved' ? '✅ Certification approuvée !' : '❌ Certification refusée',
        body: status === 'approved' ? `Votre badge ${level || 'bleu'} est actif.` : (note || 'Voir les détails dans l\'app.'),
        url: '/account',
      });
    }
    res.json(cert);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// SMART LINKS
// ════════════════════════════════════════════

// GET page artiste par slug
router.get('/a/:slug', async (req, res) => {
  try {
    const sl = await SmartLink.findOneAndUpdate(
      { slug: req.params.slug.toLowerCase() },
      { $inc: { views: 1 } }, { returnDocument: 'after' }
    ).populate('artistId', 'nom image bio certified certLevel');
    if (!sl) return res.status(404).json({ message: 'Lien introuvable' });
    // Récupérer les musiques récentes de l'artiste
    const songs  = await Song.find({ artisteId: sl.artistId._id }).sort({ createdAt: -1 }).limit(6).select('titre artiste image plays src');
    const albums = await Album.find({ artisteId: sl.artistId._id }).sort({ annee: -1 }).limit(4).select('titre annee image');
    res.json({ artist: sl.artistId, slug: sl.slug, socialLinks: sl.socialLinks, customBio: sl.customBio, songs, albums, views: sl.views });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste: créer/mettre à jour son smart link
router.put('/artists/:id/smart-link', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const { slug, socialLinks, customBio } = req.body;
    if (!slug?.trim()) return res.status(400).json({ message: 'Slug requis' });
    const clean = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    // Vérifier unicité
    const existing = await SmartLink.findOne({ slug: clean, artistId: { $ne: req.params.id } });
    if (existing) return res.status(409).json({ message: 'Ce slug est déjà pris' });
    const sl = await SmartLink.findOneAndUpdate(
      { artistId: req.params.id },
      { artistId: req.params.id, slug: clean, socialLinks: socialLinks || {}, customBio: customBio || '' },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(sl);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET smart link d'un artiste (pour son dashboard)
router.get('/artists/:id/smart-link', requireAdminOrArtist, async (req, res) => {
  try {
    const sl = await SmartLink.findOne({ artistId: req.params.id });
    res.json(sl || null);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Tracker un clic depuis le smart link
router.post('/a/:slug/click', async (req, res) => {
  try {
    await SmartLink.findOneAndUpdate({ slug: req.params.slug }, { $inc: { clicks: 1 } });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ════════════════════════════════════════════
// FEATURINGS OFFICIELS
// ════════════════════════════════════════════

// Ajouter un featuring à une chanson
router.post('/songs/:id/featurings', requireAdminOrArtist, async (req, res) => {
  try {
    const { featArtistId, role } = req.body;
    if (!featArtistId) return res.status(400).json({ message: 'featArtistId requis' });
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Musique introuvable' });
    const feat = await new Featuring({
      songId: req.params.id,
      mainArtistId: song.artisteId,
      featArtistId,
      role: role || 'feat',
      status: 'confirmed',
      confirmedAt: new Date(),
    }).save();
    res.json(await feat.populate(['mainArtistId','featArtistId'], 'nom image'));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET featurings d'une chanson
router.get('/songs/:id/featurings', async (req, res) => {
  try {
    const feats = await Featuring.find({ songId: req.params.id, status: 'confirmed' })
      .populate('mainArtistId featArtistId', 'nom image certified certLevel');
    res.json(feats);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE featuring
router.delete('/featurings/:id', requireAdminOrArtist, async (req, res) => {
  try {
    await Featuring.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET tous les featurings d'un artiste
router.get('/artists/:id/featurings', async (req, res) => {
  try {
    const feats = await Featuring.find({
      $or: [{ mainArtistId: req.params.id }, { featArtistId: req.params.id }],
      status: 'confirmed',
    }).populate('songId','titre image artiste plays')
      .populate('mainArtistId featArtistId','nom image certified certLevel');
    res.json(feats);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// PROGRAMMATION DE SORTIES
// ════════════════════════════════════════════

// Programmer une sortie
router.post('/songs/:id/schedule', requireAdminOrArtist, async (req, res) => {
  try {
    const { releaseAt, teaser } = req.body;
    if (!releaseAt) return res.status(400).json({ message: 'Date requise' });
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    const release = await ScheduledRelease.findOneAndUpdate(
      { songId: req.params.id },
      { songId: req.params.id, artistId: song.artisteId, releaseAt: new Date(releaseAt), teaser: teaser || '', isPublished: false, notified: false },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(release);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET planning d'un artiste
router.get('/artists/:id/schedule', requireAdminOrArtist, async (req, res) => {
  try {
    const releases = await ScheduledRelease.find({ artistId: req.params.id, isPublished: false })
      .populate('songId','titre image artiste').sort({ releaseAt: 1 });
    res.json(releases);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Annuler une programmation
router.delete('/songs/:id/schedule', requireAdminOrArtist, async (req, res) => {
  try {
    await ScheduledRelease.deleteOne({ songId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Cron : publier les sorties programmées (appeler toutes les minutes depuis un setInterval)
const publishScheduled = async () => {
  try {
    const now = new Date();
    const due = await ScheduledRelease.find({ releaseAt: { $lte: now }, isPublished: false })
      .populate('songId artistId');
    for (const r of due) {
      await ScheduledRelease.findByIdAndUpdate(r._id, { isPublished: true });
      // Notifier les abonnés
      if (!r.notified) {
        const followers = await ArtistFollower.find({ artistId: r.artistId?._id, notifyNewSong: true }).select('userId');
        const userIds   = followers.map(f => f.userId);
        if (userIds.length) {
          await sendPush(userIds, {
            title: `🎵 Nouveau titre : ${r.songId?.titre}`,
            body:  `${r.songId?.artiste} vient de sortir un nouveau titre !`,
            url:   '/',
            icon:  r.songId?.image || '/icon-192.png',
          });
        }
        await ScheduledRelease.findByIdAndUpdate(r._id, { notified: true });
      }
    }
  } catch {}
};
// Lancer le cron toutes les 60 secondes
setInterval(publishScheduled, 60_000);

// ════════════════════════════════════════════
// ABONNÉS ARTISTE + NEWSLETTER
// ════════════════════════════════════════════

// Suivre un artiste
router.post('/artists/:id/follow', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('email');
    const existing = await ArtistFollower.findOne({ artistId: req.params.id, userId: req.user.id });
    if (existing) {
      await ArtistFollower.deleteOne({ _id: existing._id });
      return res.json({ following: false });
    }
    await new ArtistFollower({ artistId: req.params.id, userId: req.user.id, email: user?.email || '' }).save();
    res.json({ following: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Vérifier si on suit un artiste
router.get('/artists/:id/follow', optionalAuth, async (req, res) => {
  try {
    const count     = await ArtistFollower.countDocuments({ artistId: req.params.id });
    let following   = false;
    if (req.user?.id) following = !!(await ArtistFollower.findOne({ artistId: req.params.id, userId: req.user.id }));
    res.json({ count, following });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste: lister ses abonnés
router.get('/artists/:id/followers', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const followers = await ArtistFollower.find({ artistId: req.params.id })
      .populate('userId','nom email avatar').sort({ createdAt: -1 });
    res.json({ count: followers.length, followers });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste: envoyer une newsletter
router.post('/artists/:id/newsletter', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const { subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ message: 'Sujet et message requis' });
    const artist    = await Artist.findById(req.params.id).select('nom');
    const followers = await ArtistFollower.find({ artistId: req.params.id }).select('userId email');
    const userIds   = followers.map(f => f.userId).filter(Boolean);
    // 1. Push notification
    const pushCount = await sendPush(userIds, { title: `📧 ${artist.nom} : ${subject}`, body: message.slice(0, 120), url: `/artist/${req.params.id}` });
    // 2. In-app notifications
    if (userIds.length) {
      await Notification.insertMany(userIds.map(uid => ({
        userId: uid, type: 'new_song',
        titre: `📧 ${artist.nom} : ${subject}`,
        message: message.slice(0, 200),
      })));
    }
    // 3. Enregistrer la campagne
    const campaign = await new NewsletterCampaign({
      artistId: req.params.id, subject, message,
      sentTo: followers.length, sentAt: new Date(), status: 'sent',
    }).save();
    res.json({ sent: followers.length, pushSent: pushCount, campaign });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste: historique des campagnes
router.get('/artists/:id/newsletter/history', requireAdminOrArtist, async (req, res) => {
  try {
    const campaigns = await NewsletterCampaign.find({ artistId: req.params.id }).sort({ createdAt: -1 }).limit(20);
    res.json(campaigns);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// MULTI-LANGUE (i18n config endpoint)
// ════════════════════════════════════════════
router.get('/config/languages', (_req, res) => {
  res.json({
    available: [
      { code: 'fr', label: 'Français',  flag: '🇫🇷' },
      { code: 'en', label: 'English',   flag: '🇬🇧' },
      { code: 'sw', label: 'Swahili',   flag: '🇹🇿' },
      { code: 'ln', label: 'Lingala',   flag: '🇨🇩' },
      { code: 'mg', label: 'Malagasy',  flag: '🇲🇬' },
    ],
    currencies: [
      { code: 'EUR', symbol: '€',    label: 'Euro' },
      { code: 'USD', symbol: '$',    label: 'Dollar US' },
      { code: 'XAF', symbol: 'FCFA', label: 'Franc CFA' },
      { code: 'CDF', symbol: 'FC',   label: 'Franc Congolais' },
      { code: 'MGA', symbol: 'Ar',   label: 'Ariary Malgache' },
      { code: 'TZS', symbol: 'TSh',  label: 'Shilling Tanzanien' },
    ],
  });
});

// ════════════════════════════════════════════
// LISTEN PARTY (Écoute collaborative)
// ════════════════════════════════════════════

// POST /listen-party — Créer une party
router.post('/listen-party', requireAuth, async (req, res) => {
  try {
    const { name, code, songId } = req.body;
    if (!name?.trim() || !code?.trim()) return res.status(400).json({ message: 'Nom et code requis' });

    // Vérifier unicité du code
    const existing = await ListenParty.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(409).json({ message: 'Ce code est déjà utilisé' });

    const party = await new ListenParty({
      name: name.trim(),
      code: code.toUpperCase(),
      hostId: req.user.id,
      songId: songId || null,
      isPlaying: false,
      participants: [req.user.id],
      messages: [],
      active: true,
      expiresAt: new Date(Date.now() + 4 * 3600000),
    }).save();

    // Récupérer la party avec les données populées
    const populated = await ListenParty.findById(party._id)
      .populate('hostId', 'nom')
      .populate('songId');
    res.json(populated);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /listen-party — Lister les parties publiques actives
router.get('/listen-party', optionalAuth, async (req, res) => {
  try {
    const parties = await ListenParty.find({ active: true, expiresAt: { $gt: new Date() } })
      .populate('hostId', 'nom')
      .populate('songId', 'titre artiste image')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(parties);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /listen-party/:code — Récupérer une party par code
router.get('/listen-party/:code', optionalAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() })
      .populate('hostId', 'nom')
      .populate('participants', 'nom')
      .populate('songId');
    if (!party || !party.active) return res.status(404).json({ message: 'Party introuvable' });
    res.json(party);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /listen-party/:code/join — Rejoindre une party
router.post('/listen-party/:code/join', requireAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party || !party.active) return res.status(404).json({ message: 'Party introuvable' });

    // Ajouter l'utilisateur aux participants
    if (!party.participants.includes(req.user.id)) {
      party.participants.push(req.user.id);
      await party.save();
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /listen-party/:code/message — Envoyer un message
router.post('/listen-party/:code/message', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: 'Message vide' });

    const user = await User.findById(req.user.id).select('nom');
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party) return res.status(404).json({ message: 'Party introuvable' });

    party.messages.push({
      nom: user.nom || 'Utilisateur',
      userId: req.user.id,
      text: text.trim().slice(0, 500),
      time: new Date(),
    });

    // Garder seulement les 100 derniers messages
    if (party.messages.length > 100) {
      party.messages = party.messages.slice(-100);
    }

    await party.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// PUT /listen-party/:code/song — Changer la chanson en cours
router.put('/listen-party/:code/song', requireAuth, async (req, res) => {
  try {
    const { songId, isPlaying } = req.body;
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party) return res.status(404).json({ message: 'Party introuvable' });

    // Vérifier que c'est l'hôte qui change la chanson
    if (String(party.hostId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Seul l\'hôte peut changer la chanson' });
    }

    party.songId = songId || null;
    party.isPlaying = isPlaying ?? false;
    await party.save();

    const updated = await ListenParty.findById(party._id).populate('songId');
    res.json(updated);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE /listen-party/:code — Quitter / supprimer une party
router.delete('/listen-party/:code', requireAuth, async (req, res) => {
  try {
    const party = await ListenParty.findOne({ code: req.params.code.toUpperCase() });
    if (!party) return res.status(404).json({ message: 'Party introuvable' });

    // Si c'est l'hôte, supprimer la party
    if (String(party.hostId) === String(req.user.id)) {
      await ListenParty.deleteOne({ code: req.params.code.toUpperCase() });
    } else {
      // Sinon, juste retirer le participant
      party.participants = party.participants.filter(p => String(p) !== String(req.user.id));
      await party.save();
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ════════════════════════════════════════════
// API PUBLIQUE (documentation + tokens)
// ════════════════════════════════════════════
router.get('/api/docs', (_req, res) => {
  res.json({
    version: '1.0',
    baseUrl: process.env.FRONTEND_URL || 'https://moozik.app',
    endpoints: [
      { method: 'GET',  path: '/songs',         auth: false, desc: 'Liste des musiques' },
      { method: 'GET',  path: '/artists',        auth: false, desc: 'Liste des artistes' },
      { method: 'GET',  path: '/albums',         auth: false, desc: 'Liste des albums' },
      { method: 'GET',  path: '/a/:slug',        auth: false, desc: 'Smart link artiste' },
      { method: 'GET',  path: '/songs/:id/lyrics', auth: false, desc: 'Paroles' },
      { method: 'GET',  path: '/songs/:id/featurings', auth: false, desc: 'Featurings' },
      { method: 'POST', path: '/artists/:id/follow', auth: 'Bearer', desc: 'Suivre un artiste' },
      { method: 'GET',  path: '/recommendations', auth: 'Bearer', desc: 'Recommandations personnalisées' },
    ],
    rateLimit: '100 req/min',
    contact:   'api@moozik.app',
  });
});

module.exports = router;

