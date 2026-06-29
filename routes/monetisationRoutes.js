/**
 * monetisationRoutes.js  â€” VERSION CORRIGÃ‰E
 *
 * Corrections apportÃ©es :
 *  1. GET /admin/events      â€” .lean() au lieu de .toObject(), try/catch par event
 *  2. GET /admin/royalties   â€” try/catch renforcÃ© + log d'erreur explicite
 *  3. calculateRoyalties     â€” supprimÃ©e de ce fichier (conflit avec royaltiesCron)
 *  4. cron.schedule          â€” supprimÃ© de ce fichier (gÃ©rÃ© dans royaltiesCron)
 *  5. Require corrigÃ©        â€” models importÃ©s proprement sans chemin relatif cassÃ©
 *
 * Ajouter dans server.js :
 *   const monetisationRoutes = require('./routes/monetisationRoutes');
 *   app.use('/', monetisationRoutes);
 *
 * âš ï¸  Supprimer GET /admin/royalties de royaltiesController.js pour Ã©viter le conflit.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const {
  Plan, Subscription, Purchase, SongPrice, Tip,
  Royalty, AudioAd, AdImpression, Event, Ticket,
  ArtistPayout, MonetisationConfig,
} = require('../models/monetisationModels');

const { Song, User, Artist } = require('../models');
const {
  requireAuth, requireAdmin, requireArtist,
  requireAdminOrArtist, optionalAuth,
} = require('../middleware/auth');
const { upload } = require('../middleware/upload');

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PLATFORM_PERCENT = parseInt(process.env.STRIPE_PLATFORM_PERCENT || '20');
const ROYALTY_PREMIUM  = parseFloat(process.env.ROYALTY_RATE_PREMIUM  || '0.004');
const ROYALTY_FREE     = parseFloat(process.env.ROYALTY_RATE_FREE     || '0.001');

const toEuros       = (cents)  => ((cents || 0) / 100).toFixed(2);
const toCents       = (euros)  => Math.round(parseFloat(euros || 0) * 100);
const currentPeriod = ()       => new Date().toISOString().slice(0, 7);

const isPremium = async (userId) => {
  const sub = await Subscription.findOne({ userId, status: 'active', planName: 'premium' });
  return !!sub;
};

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// 1. ABONNEMENTS FREEMIUM / PREMIUM
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

router.get('/plans', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await Plan.find({ active: true }).sort({ price: 1 }));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/subscriptions/me', requireAuth, async (req, res) => {
  try {
    const sub = await Subscription.findOne({
      userId: req.user.id,
      status: { $in: ['active', 'trialing'] },
    }).populate('planId');
    res.json(sub || { planName: 'free', status: 'active' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/subscriptions/checkout', requireAuth, async (req, res) => {
  try {
    const { planId, provider = 'stripe' } = req.body;
    if (!planId) return res.status(400).json({ message: 'planId requis' });

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan introuvable' });
    if (!plan.price) return res.status(400).json({ message: 'Plan gratuit â€” pas de paiement requis' });

    const user = await User.findById(req.user.id);

    if (provider === 'stripe') {
      let customerId = (await Subscription.findOne({
        userId: req.user.id,
        stripeCustomerId: { $ne: '' },
      }))?.stripeCustomerId;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name:  user.nom || user.email,
        });
        customerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: `${process.env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${process.env.FRONTEND_URL}/subscription/cancel`,
        metadata: { userId: String(req.user.id), planId: String(plan._id) },
      });
      return res.json({ url: session.url, sessionId: session.id, provider: 'stripe' });
    }

    if (provider === 'paydunya') {
      const pd = await paydunyaInvoice({
        amount:      plan.price / 100,
        description: `Abonnement MOOZIK Premium â€” ${plan.interval}`,
        returnUrl:   `${process.env.FRONTEND_URL}/subscription/success`,
        cancelUrl:   `${process.env.FRONTEND_URL}/subscription/cancel`,
        meta: { userId: String(req.user.id), planId: String(plan._id), type: 'subscription' },
      });
      return res.json({ url: pd.url, token: pd.token, provider: 'paydunya' });
    }

    res.status(400).json({ message: 'Provider non supportÃ©' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/subscriptions/cancel', requireAuth, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ userId: req.user.id, status: 'active' });
    if (!sub) return res.status(404).json({ message: 'Aucun abonnement actif' });
    if (sub.stripeSubscriptionId) {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
    }
    sub.cancelAtPeriodEnd = true;
    sub.cancelledAt = new Date();
    await sub.save();
    res.json({ message: 'Annulation programmÃ©e en fin de pÃ©riode', sub });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/admin/plans', requireAdmin, async (req, res) => {
  try {
    const plan = await new Plan(req.body).save();
    res.json(plan);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put('/admin/plans/:id', requireAdmin, async (req, res) => {
  try {
    res.json(await Plan.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/admin/subscriptions', requireAdmin, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 20;
    const filter = req.query.status ? { status: req.query.status } : {};
    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .populate('userId', 'nom email')
        .populate('planId')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Subscription.countDocuments(filter),
    ]);
    res.json({ subs, total, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// 2. VENTE DE MUSIQUES (MP3 Download)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

router.put('/songs/:id/price', requireAdminOrArtist, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ message: 'Introuvable' });
    if (req.user.role === 'artist' && String(song.artisteId) !== String(req.user.id))
      return res.status(403).json({ message: 'AccÃ¨s refusÃ©' });

    const { price, currency = 'EUR', forSale = true, freePreviewSeconds = 30 } = req.body;
    if (forSale && (!price || price < 0.5))
      return res.status(400).json({ message: 'Prix minimum 0,50 â‚¬' });

    const sp = await SongPrice.findOneAndUpdate(
      { songId: req.params.id },
      { songId: req.params.id, artistId: song.artisteId, price: toCents(price), currency, forSale, freePreviewSeconds },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(sp);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/songs/:id/price', optionalAuth, async (req, res) => {
  try {
    const sp = await SongPrice.findOne({ songId: req.params.id });
    if (!sp || !sp.forSale) return res.json({ forSale: false });
    let owned = false;
    if (req.user?.id) {
      owned = !!(await Purchase.findOne({
        userId: req.user.id,
        songId: req.params.id,
        status: 'completed',
      }));
    }
    res.json({ ...sp.toObject(), owned });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/songs/:id/purchase', requireAuth, async (req, res) => {
  try {
    const sp = await SongPrice.findOne({ songId: req.params.id, forSale: true });
    if (!sp) return res.status(404).json({ message: 'Musique non disponible Ã  la vente' });

    const existing = await Purchase.findOne({
      userId: req.user.id,
      songId: req.params.id,
      status: 'completed',
    });
    if (existing) return res.status(400).json({ message: 'DÃ©jÃ  achetÃ©', downloadUrl: existing.downloadUrl });

    const song = await Song.findById(req.params.id);
    const user = await User.findById(req.user.id);
    const { provider = 'stripe' } = req.body;

    const purchase = await new Purchase({
      userId: req.user.id, songId: req.params.id, artistId: sp.artistId,
      price: sp.price, currency: sp.currency, provider, status: 'pending',
    }).save();

    if (provider === 'stripe') {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: sp.currency.toLowerCase(),
            product_data: { name: song.titre, images: [song.image].filter(Boolean) },
            unit_amount: sp.price,
          },
          quantity: 1,
        }],
        success_url: `${process.env.FRONTEND_URL}/purchase/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${process.env.FRONTEND_URL}`,
        metadata: { purchaseId: String(purchase._id), type: 'song_purchase' },
      });
      await Purchase.findByIdAndUpdate(purchase._id, {
        stripePaymentIntentId: session.payment_intent || session.id,
      });
      return res.json({ url: session.url, purchaseId: purchase._id, provider: 'stripe' });
    }

    if (provider === 'paydunya') {
      const pd = await paydunyaInvoice({
        amount:      sp.price / 100,
        description: `Achat MP3 : ${song.titre}`,
        returnUrl:   `${process.env.FRONTEND_URL}/purchase/success`,
        cancelUrl:   `${process.env.FRONTEND_URL}`,
        meta: { purchaseId: String(purchase._id), type: 'song_purchase' },
      });
      await Purchase.findByIdAndUpdate(purchase._id, { paydunyaToken: pd.token });
      return res.json({ url: pd.url, purchaseId: purchase._id, provider: 'paydunya' });
    }

    res.status(400).json({ message: 'Provider non supportÃ©' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/songs/:id/download', requireAuth, async (req, res) => {
  try {
    const premium  = await isPremium(req.user.id);
    const purchase = premium
      ? null
      : await Purchase.findOne({ userId: req.user.id, songId: req.params.id, status: 'completed' });
    if (!premium && !purchase) return res.status(403).json({ message: 'Achat requis' });

    const song = await Song.findById(req.params.id);
    if (!song?.src) return res.status(404).json({ message: 'Fichier introuvable' });

    const { cloudinary } = require('../middleware/upload');
    const expires    = Math.floor(Date.now() / 1000) + 3600;
    const signedUrl  = cloudinary.url(song.audioPublicId, {
      resource_type: 'video', type: 'authenticated',
      expires_at: expires, sign_url: true, attachment: true,
    });
    if (purchase) await Purchase.findByIdAndUpdate(purchase._id, { downloadedAt: new Date() });
    res.json({ url: signedUrl || song.src, expires });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/purchases/me', requireAuth, async (req, res) => {
  try {
    const purchases = await Purchase.find({ userId: req.user.id, status: 'completed' })
      .populate('songId', 'titre artiste image')
      .sort({ createdAt: -1 });
    res.json(purchases);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/admin/purchases', requireAdmin, async (req, res) => {
  try {
    const purchases = await Purchase.find()
      .populate('userId', 'nom email')
      .populate('songId', 'titre')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(purchases);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// 3. DONS & POURBOIRES (TIPPING)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

router.post('/artists/:id/tip', requireAuth, async (req, res) => {
  try {
    const {
      amount, currency = 'EUR', message = '',
      provider = 'stripe', anonymous = false, phoneNumber,
    } = req.body;
    if (!amount || amount < 0.5) return res.status(400).json({ message: 'Montant minimum 0,50 â‚¬' });

    const artist = await Artist.findById(req.params.id);
    if (!artist) return res.status(404).json({ message: 'Artiste introuvable' });

    const tip = await new Tip({
      fromUserId: req.user.id, toArtistId: req.params.id,
      amount: toCents(amount), currency, message, provider, anonymous, phoneNumber,
      status: 'pending',
    }).save();

    if (provider === 'stripe') {
      const payout = await ArtistPayout.findOne({ artisteId: req.params.id });
      const paymentIntent = await stripe.paymentIntents.create({
        amount:               toCents(amount),
        currency:             currency.toLowerCase(),
        payment_method_types: ['card'],
        description:          `Pourboire pour ${artist.nom}${message ? ` : "${message}"` : ''}`,
        metadata:             { tipId: String(tip._id), type: 'tip' },
        ...(payout?.stripeAccountId ? {
          transfer_data: {
            destination: payout.stripeAccountId,
            amount: Math.round(toCents(amount) * (1 - PLATFORM_PERCENT / 100)),
          },
        } : {}),
      });
      await Tip.findByIdAndUpdate(tip._id, { stripePaymentIntentId: paymentIntent.id });
      return res.json({ clientSecret: paymentIntent.client_secret, tipId: tip._id, provider: 'stripe' });
    }

    if (provider === 'paydunya') {
      const pd = await paydunyaInvoice({
        amount,
        description: `Soutenir ${artist.nom}`,
        returnUrl:   `${process.env.FRONTEND_URL}/tip/success`,
        cancelUrl:   `${process.env.FRONTEND_URL}/artist/${req.params.id}`,
        meta: { tipId: String(tip._id), type: 'tip' },
      });
      await Tip.findByIdAndUpdate(tip._id, { paydunyaToken: pd.token });
      return res.json({ url: pd.url, tipId: tip._id, provider: 'paydunya' });
    }

    if (['orange_money', 'airtel_money'].includes(provider)) {
      await Tip.findByIdAndUpdate(tip._id, { phoneNumber, status: 'pending' });
      return res.json({
        tipId: tip._id, provider,
        message: `Paiement Mobile Money en attente de confirmation (${phoneNumber})`,
        instructions: provider === 'orange_money'
          ? `Composez *144*4*1*${amount}*${artist.nom}# sur votre tÃ©lÃ©phone Orange`
          : `Confirmez le paiement de ${amount} ${currency} sur votre app Airtel Money`,
      });
    }

    res.status(400).json({ message: 'Provider non supportÃ©' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put('/tips/:id/confirm', requireAdmin, async (req, res) => {
  try {
    const tip = await Tip.findByIdAndUpdate(
      req.params.id,
      { status: 'completed' },
      { returnDocument: 'after' }
    );
    if (!tip) return res.status(404).json({ message: 'Introuvable' });
    await addToRoyalty(tip.toArtistId, null, 'tips', tip.amount, currentPeriod());
    res.json(tip);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/artists/:id/tips', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'AccÃ¨s refusÃ©' });

    const tips  = await Tip.find({ toArtistId: req.params.id, status: 'completed' })
      .populate('fromUserId', 'nom avatar')
      .sort({ createdAt: -1 })
      .limit(50);
    const total = tips.reduce((s, t) => s + t.amount, 0);
    res.json({
      tips: tips.map(t => ({ ...t.toObject(), fromUser: t.anonymous ? null : t.fromUserId })),
      total,
      totalEuros: toEuros(total),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET â€” dashboard royalties artiste
router.get('/artists/:id/royalties', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'AccÃ¨s refusÃ©' });

    const royalties = await Royalty.find({ artisteId: req.params.id })
      .sort({ period: -1 })
      .limit(12);
    const payout    = await ArtistPayout.findOne({ artisteId: req.params.id });
    const totalTips = (await Tip.find({ toArtistId: req.params.id, status: 'completed' }))
      .reduce((s, t) => s + t.amount, 0);

    res.json({ royalties, payout: payout || {}, totalTipsEuros: toEuros(totalTips) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste â€” configurer son compte de paiement
router.put('/artists/:id/payout', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'AccÃ¨s refusÃ©' });

    const { paypalEmail, mobileMoneyPhone, mobileMoneyProvider } = req.body;
    const payout = await ArtistPayout.findOneAndUpdate(
      { artisteId: req.params.id },
      {
        artisteId: req.params.id,
        paypalEmail:           paypalEmail           || '',
        mobileMoneyPhone:      mobileMoneyPhone      || '',
        mobileMoneyProvider:   mobileMoneyProvider   || 'none',
      },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(payout);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Artiste â€” onboarding Stripe Connect
router.post('/artists/:id/stripe-connect', requireAdminOrArtist, async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'AccÃ¨s refusÃ©' });

    const artist = await Artist.findById(req.params.id);
    let payout   = await ArtistPayout.findOne({ artisteId: req.params.id });

    if (!payout?.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: artist.email,
        capabilities: { transfers: { requested: true } },
      });
      payout = await ArtistPayout.findOneAndUpdate(
        { artisteId: req.params.id },
        { artisteId: req.params.id, stripeAccountId: account.id },
        { upsert: true, returnDocument: 'after' }
      );
    }

    const link = await stripe.accountLinks.create({
      account:     payout.stripeAccountId,
      refresh_url: `${process.env.FRONTEND_URL}/artist-dashboard`,
      return_url:  `${process.env.FRONTEND_URL}/artist-dashboard?stripe=success`,
      type:        'account_onboarding',
    });
    res.json({ url: link.url, accountId: payout.stripeAccountId });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Admin â€” dÃ©clencher le virement mensuel
router.post('/admin/royalties/payout', requireAdmin, async (req, res) => {
  try {
    const { period = currentPeriod() } = req.body;
    const pending = await Royalty.find({ period, status: 'pending', revenue: { $gt: 0 } })
      .populate('artisteId', 'nom email');

    let paid = 0;
    for (const r of pending) {
      const payout = await ArtistPayout.findOne({ artisteId: r.artisteId._id });
      if (payout?.stripeAccountId) {
        try {
          const transfer = await stripe.transfers.create({
            amount:      r.revenue,
            currency:    'eur',
            destination: payout.stripeAccountId,
            description: `Royalties MOOZIK ${period} â€” ${r.artisteId.nom}`,
          });
          await Royalty.findByIdAndUpdate(r._id, {
            status: 'paid', paidAt: new Date(), stripeTransferId: transfer.id,
          });
          await ArtistPayout.findByIdAndUpdate(payout._id, {
            $inc: { pendingBalance: -r.revenue, totalPaid: r.revenue },
          });
          paid++;
        } catch (err) {
          console.warn(`Virement Ã©chouÃ© pour ${r.artisteId.nom}:`, err.message);
        }
      } else {
        await Royalty.findByIdAndUpdate(r._id, { status: 'processing' });
      }
    }
    res.json({ message: `Virements traitÃ©s: ${paid}/${pending.length}`, period });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/admin/royalties', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || currentPeriod();

    const royalties = await Royalty.aggregate([
      { $match: { period } },
      { $sort: { revenue: -1 } },
      {
        $lookup: {
          from:         'artists',
          localField:   'artisteId',
          foreignField: '_id',
          as:           'artisteId',
        },
      },
      {
        $addFields: {
          artisteId: { $arrayElemAt: ['$artisteId', 0] },
        },
      },
      {
        $project: {
          period: 1, plays: 1, revenue: 1, status: 1, sources: 1, currency: 1,
          'artisteId._id': 1,
          'artisteId.nom': 1,
          'artisteId.image': 1,
        },
      },
    ]);

    const total = royalties.reduce((s, r) => s + (r.revenue || 0), 0);
    res.json({ royalties, totalEuros: toEuros(total), period });
  } catch (e) {
    console.error('GET /admin/royalties error:', e);
    res.status(500).json({ message: e.message });
  }
});


router.get('/ads/next', optionalAuth, async (req, res) => {
  try {
    if (req.user?.id) {
      const premium = await isPremium(req.user.id);
      if (premium) return res.json(null);
    }
    const now = new Date();
    const ads = await AudioAd.find({
      active: true,
      $and: [
        { $or: [{ budget: 0 }, { $expr: { $lt: ['$spent', '$budget'] } }] },
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null },   { endsAt:   { $gte: now } }] },
      ],
    });
    if (!ads.length) return res.json(null);
    const ad = ads[Math.floor(Math.random() * ads.length)];
    res.json({
      _id: ad._id, audioUrl: ad.audioUrl, imageUrl: ad.imageUrl,
      title: ad.title, advertiser: ad.advertiser,
      duration: ad.duration, clickUrl: ad.clickUrl,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/ads/:id/impression', optionalAuth, async (req, res) => {
  try {
    const { clicked = false, skipped = false, listenedFull = false, deviceId = '' } = req.body;
    const ad = await AudioAd.findById(req.params.id);
    if (!ad) return res.json({ ok: false });

    const impression = await new AdImpression({
      adId: req.params.id, userId: req.user?.id || null,
      deviceId, clicked, skipped, listenedFull,
    }).save();

    const inc = { impressions: 1 };
    if (clicked)      inc.clicks = 1;
    if (listenedFull) inc.spent  = ad.cpm / 10;
    await AudioAd.findByIdAndUpdate(req.params.id, { $inc: inc });

    res.json({ ok: true, impressionId: impression._id });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/admin/ads', requireAdmin, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Fichier audio requis' });
    const { title, advertiser, budget, cpm, duration, clickUrl } = req.body;
    const { toCloud } = require('../middleware/upload');
    const result = await toCloud(req.file.buffer, {
      folder: 'moozik/ads', resource_type: 'video', format: 'mp3',
    });
    const ad = await new AudioAd({
      title, advertiser,
      audioUrl: result.secure_url, audioPublicId: result.public_id,
      budget: toCents(budget || 0), cpm: toCents(cpm || 2),
      duration: parseInt(duration || 30), clickUrl: clickUrl || '',
      createdBy: req.admin.id, active: true,
    }).save();
    res.json(ad);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/admin/ads', requireAdmin, async (req, res) => {
  try {
    const ads = await AudioAd.find().sort({ createdAt: -1 });
    res.json(ads.map(a => ({
      ...a.toObject(),
      ctr:         a.impressions > 0 ? ((a.clicks / a.impressions) * 100).toFixed(2) + '%' : '0%',
      budgetEuros: toEuros(a.budget),
      spentEuros:  toEuros(a.spent),
    })));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put('/admin/ads/:id', requireAdmin, async (req, res) => {
  try {
    res.json(await AudioAd.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' }));
  } catch (e) { res.status(500).json({ message: e.message }); }
});


router.post('/events', requireAdminOrArtist, upload.single('image'), async (req, res) => {
  try {
    const {
      title, description, venue, city, country, date,
      ticketPrice, ticketCurrency = 'EUR', ticketCapacity = 0,
    } = req.body;
    if (!title || !venue || !date || !ticketPrice)
      return res.status(400).json({ message: 'Champs requis manquants' });

    const artistId = req.user.role === 'artist' ? req.user.id : req.body.artistId;
    let imageUrl = '', imagePublicId = '';

    if (req.file) {
      const { toCloud, IMG_TRANSFORM } = require('../middleware/upload');
      const r = await toCloud(req.file.buffer, {
        folder: 'moozik/events', resource_type: 'image', transformation: IMG_TRANSFORM,
      });
      imageUrl = r.secure_url;
      imagePublicId = r.public_id;
    }

    const event = await new Event({
      artistId, title, description, venue, city, country,
      date: new Date(date), image: imageUrl, imagePublicId,
      ticketPrice: toCents(ticketPrice),
      ticketCurrency,
      ticketCapacity: parseInt(ticketCapacity),
    }).save();
    res.json(event);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/events', async (req, res) => {
  try {
    const filter = { status: 'upcoming', date: { $gte: new Date() } };
    if (req.query.artistId) filter.artistId = req.query.artistId;
    const events = await Event.find(filter)
      .populate('artistId', 'nom image certified certLevel')
      .sort({ date: 1 })
      .limit(20);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(events);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/events/:id', optionalAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate('artistId', 'nom image certified certLevel bio');
    if (!event) return res.status(404).json({ message: 'Introuvable' });
    let ownedTicket = null;
    if (req.user?.id) {
      ownedTicket = await Ticket.findOne({
        eventId: req.params.id, userId: req.user.id, status: 'confirmed',
      });
    }
    res.json({
      event,
      ownedTicket,
      available: event.ticketCapacity === 0 || event.ticketsSold < event.ticketCapacity,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.delete('/events/:id', requireAdminOrArtist, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event introuvable' });
    res.json({ message: 'Event supprimÃ© avec succÃ¨s' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/events/:id/tickets', requireAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Introuvable' });
    if (!event.ticketOnSale) return res.status(400).json({ message: 'Billetterie fermÃ©e' });
    if (event.ticketCapacity > 0 && event.ticketsSold >= event.ticketCapacity)
      return res.status(400).json({ message: 'Complet' });

    const existing = await Ticket.findOne({
      eventId: req.params.id, userId: req.user.id, status: 'confirmed',
    });
    if (existing) return res.status(400).json({ message: 'Billet dÃ©jÃ  achetÃ©', ticket: existing });

    const { quantity = 1, provider = 'stripe' } = req.body;
    const total  = event.ticketPrice * parseInt(quantity);
    const qrCode = crypto.randomBytes(32).toString('hex');

    const ticket = await new Ticket({
      eventId:   req.params.id,
      userId:    req.user.id,
      quantity:  parseInt(quantity),
      totalPaid: total,
      currency:  event.ticketCurrency,
      provider,  qrCode,
      status:    'pending',
    }).save();

    if (provider === 'stripe') {
      const user    = await User.findById(req.user.id);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency:     event.ticketCurrency.toLowerCase(),
            product_data: {
              name:   `ðŸŽ« ${event.title} â€” ${event.venue}`,
              images: [event.image].filter(Boolean),
            },
            unit_amount: event.ticketPrice,
          },
          quantity: parseInt(quantity),
        }],
        success_url:    `${process.env.FRONTEND_URL}/events/${req.params.id}/ticket?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:     `${process.env.FRONTEND_URL}/events/${req.params.id}`,
        customer_email: user.email,
        metadata:       { ticketId: String(ticket._id), type: 'ticket' },
      });
      await Ticket.findByIdAndUpdate(ticket._id, { stripePaymentIntentId: session.id });
      return res.json({ url: session.url, ticketId: ticket._id, provider: 'stripe' });
    }

    if (provider === 'paydunya') {
      const pd = await paydunyaInvoice({
        amount:      total / 100,
        description: `Billet : ${event.title}`,
        returnUrl:   `${process.env.FRONTEND_URL}/events/${req.params.id}/ticket`,
        cancelUrl:   `${process.env.FRONTEND_URL}/events/${req.params.id}`,
        meta:        { ticketId: String(ticket._id), type: 'ticket' },
      });
      await Ticket.findByIdAndUpdate(ticket._id, { paydunyaToken: pd.token });
      return res.json({ url: pd.url, ticketId: ticket._id, provider: 'paydunya' });
    }

    res.status(400).json({ message: 'Provider non supportÃ©' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/tickets/me', requireAuth, async (req, res) => {
  try {
    const tickets = await Ticket.find({ userId: req.user.id, status: 'confirmed' })
      .populate('eventId')
      .sort({ createdAt: -1 });
    res.json(tickets);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/tickets/scan/:qrCode', requireAdminOrArtist, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ qrCode: req.params.qrCode })
      .populate('eventId', 'title venue date')
      .populate('userId', 'nom email');
    if (!ticket) return res.status(404).json({ valid: false, message: 'Billet invalide' });
    if (ticket.status !== 'confirmed')
      return res.json({ valid: false, message: 'Billet non confirmÃ©' });
    if (ticket.used)
      return res.json({ valid: false, message: 'Billet dÃ©jÃ  utilisÃ©', usedAt: ticket.usedAt });
    await Ticket.findByIdAndUpdate(ticket._id, { used: true, usedAt: new Date() });
    res.json({ valid: true, ticket, message: 'âœ… EntrÃ©e valide' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/admin/events', requireAdmin, async (req, res) => {
  try {
    const events = await Event.find()
      .populate('artisteId', 'nom')
      .sort({ date: -1 })
      .limit(50)
      .lean(); // â† FIX : plain objects, pas besoin de .toObject()

    const result = await Promise.all(events.map(async (ev) => {
      try {
        const revenue = await Ticket.aggregate([
          { $match: { eventId: ev._id, status: 'confirmed' } },
          { $group: { _id: null, total: { $sum: '$totalPaid' }, count: { $sum: '$quantity' } } },
        ]);
        return {
          ...ev,
          revenue:         revenue[0]?.total || 0,
          ticketsSoldReal: revenue[0]?.count || 0,
          revenueEuros:    toEuros(revenue[0]?.total || 0),
        };
      } catch (innerErr) {
        // Un event cassÃ© ne fait pas planter toute la liste
        console.warn(`Aggregate error for event ${ev._id}:`, innerErr.message);
        return {
          ...ev,
          revenue:         0,
          ticketsSoldReal: 0,
          revenueEuros:    '0.00',
        };
      }
    }));

    res.json(result);
  } catch (e) {
    console.error('GET /admin/events error:', e);
    res.status(500).json({ message: e.message });
  }
});

router.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) { return res.status(400).json({ message: e.message }); }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const { type, purchaseId, ticketId, userId, planId } = session.metadata || {};

          if (type === 'song_purchase' && purchaseId) {
            await Purchase.findByIdAndUpdate(purchaseId, {
              status: 'completed', stripePaymentIntentId: session.payment_intent,
            });
            const purchase = await Purchase.findById(purchaseId);
            if (purchase) {
              await addToRoyalty(
                purchase.artistId, purchase.songId, 'purchases',
                Math.round(purchase.price * (1 - PLATFORM_PERCENT / 100)),
                currentPeriod()
              );
            }
          }

          if (type === 'ticket' && ticketId) {
            const ticket = await Ticket.findByIdAndUpdate(
              ticketId,
              { status: 'confirmed', stripePaymentIntentId: session.payment_intent },
              { returnDocument: 'after' }
            );
            if (ticket) {
              await Event.findByIdAndUpdate(ticket.eventId, { $inc: { ticketsSold: ticket.quantity } });
            }
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub    = event.data.object;
          const userId = sub.metadata?.userId;
          if (userId) {
            const plan = await Plan.findOne({ stripePriceId: sub.items?.data?.[0]?.price?.id });
            await Subscription.findOneAndUpdate(
              { stripeSubscriptionId: sub.id },
              {
                userId,
                planId:               plan?._id,
                planName:             plan?.name || 'premium',
                status:               sub.status,
                stripeSubscriptionId: sub.id,
                stripeCustomerId:     sub.customer,
                currentPeriodStart:   new Date(sub.current_period_start * 1000),
                currentPeriodEnd:     new Date(sub.current_period_end   * 1000),
                cancelAtPeriodEnd:    sub.cancel_at_period_end,
              },
              { upsert: true }
            );
          }
          break;
        }

        case 'customer.subscription.deleted': {
          await Subscription.findOneAndUpdate(
            { stripeSubscriptionId: event.data.object.id },
            { status: 'cancelled' }
          );
          break;
        }

        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          if (pi.metadata?.type === 'tip') {
            const tip = await Tip.findOneAndUpdate(
              { stripePaymentIntentId: pi.id },
              { status: 'completed' },
              { returnDocument: 'after' }
            );
            if (tip) {
              await addToRoyalty(
                tip.toArtistId, null, 'tips',
                Math.round(tip.amount * (1 - PLATFORM_PERCENT / 100)),
                currentPeriod()
              );
            }
          }
          break;
        }
      }
    } catch (e) { console.error('Webhook handler error:', e.message); }

    res.json({ received: true });
  }
);

router.get('/admin/monetisation/config', requireAdmin, async (_req, res) => {
  try {
    const configs = await MonetisationConfig.find();
    const obj = {};
    configs.forEach(c => { obj[c.key] = c.value; });
    res.json({ ...obj, platformPercent: PLATFORM_PERCENT, royaltyPremium: ROYALTY_PREMIUM, royaltyFree: ROYALTY_FREE });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.put('/admin/monetisation/config', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    await Promise.all(Object.entries(updates).map(([key, value]) =>
      MonetisationConfig.findOneAndUpdate({ key }, { key, value }, { upsert: true })
    ));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// â”€â”€ Helpers internes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function addToRoyalty(artistId, songId, source, amount, period) {
  if (!artistId || !amount) return;
  const inc = { revenue: amount, [`sources.${source}`]: amount };
  await Royalty.findOneAndUpdate(
    { artisteId: artistId, period },
    { $inc: inc, $setOnInsert: { artisteId: artistId, period } },
    { upsert: true }
  );
  await ArtistPayout.findOneAndUpdate(
    { artisteId: artistId },
    { $inc: { pendingBalance: amount, totalEarned: amount } },
    { upsert: true }
  );
}

async function paydunyaInvoice({ amount, description, returnUrl, cancelUrl, meta }) {
  const mode    = process.env.PAYDUNYA_MODE === 'live' ? 'live' : 'test';
  const baseUrl = mode === 'live'
    ? 'https://app.paydunya.com/api/v1'
    : 'https://app.paydunya.com/sandbox-api/v1';

  const response = await fetch(`${baseUrl}/checkout-invoice/create`, {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'PAYDUNYA-MASTER-KEY':  process.env.PAYDUNYA_MASTER_KEY  || '',
      'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY || '',
      'PAYDUNYA-TOKEN':       process.env.PAYDUNYA_TOKEN       || '',
    },
    body: JSON.stringify({
      invoice:     { total_amount: amount, description },
      store:       { name: 'MOOZIK' },
      actions:     { cancel_url: cancelUrl, return_url: returnUrl },
      custom_data: meta,
    }),
  });

  const data = await response.json();
  if (!data.response_code || data.response_code !== '00')
    throw new Error(data.response_text || 'PayDunya erreur');
  return { url: data.response_text, token: data.token };
}

module.exports = router;
