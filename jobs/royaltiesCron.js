const cron     = require('node-cron');
const mongoose = require('mongoose');
const Play     = require('../models/Play');
const { Royalty, Purchase, ArtistPayout } = require('../models/monetisationModels');

// ─── Constantes ───────────────────────────────────────────────────────────────

const RATE_FREE    = 0.001; // € par écoute gratuite
const RATE_PREMIUM = 0.004; // € par écoute premium
const PLATFORM_CUT = 0.20;  // 20 % de commission plateforme

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Retourne la période du mois précédent au format "YYYY-MM". */
const previousPeriod = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** Convertit des euros en centimes entiers (arrondi au supérieur). */
const toCents = (euros) => Math.ceil(euros * 100);

// ─── Calcul des royalties ─────────────────────────────────────────────────────

/**
 * Calcule et enregistre les royalties pour la période donnée.
 * Utilise une transaction pour garantir la cohérence Royalty ↔ ArtistPayout.
 *
 * sources.free / sources.premium sont stockés en centimes NETS (après commission).
 * sources.purchases est la part artiste déjà calculée à l'achat (nette).
 * revenue = sources.free + sources.premium + sources.purchases + sources.tips
 *
 * @param {string} period  Format "YYYY-MM"
 * @returns {{ processed: number, period: string }}
 */
const calculateRoyalties = async (period) => {
  console.log(`[ROYALTIES] ▶ Calcul pour ${period}...`);

  // ── 1. Agrégation des écoutes non comptabilisées ───────────────────────────
  const playAgg = await Play.aggregate([
    {
      $match: {
        period,
        counted:   false,
        artisteId: { $ne: null },
      },
    },
    {
      $group: {
        _id:   { artisteId: '$artisteId', isPremium: '$isPremium' },
        count: { $sum: 1 },
      },
    },
  ]);

  if (playAgg.length === 0) {
    console.log(`[ROYALTIES] Aucune écoute à traiter pour ${period}`);
    return { processed: 0, period };
  }

  // ── 2. Regroupement par artiste ────────────────────────────────────────────
  const byArtist = {};
  for (const row of playAgg) {
    const aid = String(row._id.artisteId);
    if (!byArtist[aid]) byArtist[aid] = { free: 0, premium: 0, totalPlays: 0 };
    if (row._id.isPremium) byArtist[aid].premium += row.count;
    else                   byArtist[aid].free    += row.count;
    byArtist[aid].totalPlays += row.count;
  }

  // ── 3. Agrégation des ventes (part artiste déjà calculée à l'achat) ────────
  const salesByArtist = {};
  try {
    const salesAgg = await Purchase.aggregate([
      {
        $match: {
          period,
          counted:   { $ne: true },
          artisteId: { $ne: null },
        },
      },
      {
        $group: {
          _id:   '$artisteId',
          total: { $sum: '$artistShare' }, // centimes nets, calculés à l'achat
        },
      },
    ]);
    for (const row of salesAgg) salesByArtist[String(row._id)] = row.total;
  } catch (err) {
    console.warn('[ROYALTIES] ⚠ Impossible de charger les ventes:', err.message);
  }

  // ── 4. Écriture avec transaction ───────────────────────────────────────────
  const session    = await mongoose.startSession();
  const royaltyCol = Royalty.collection;
  let processed    = 0;
  const artistObjectIds = [];

  try {
    session.startTransaction();

    for (const [artisteId, data] of Object.entries(byArtist)) {

      // Revenus nets streaming après commission plateforme (en centimes)
      const netFree    = toCents(data.free    * RATE_FREE    * (1 - PLATFORM_CUT));
      const netPremium = toCents(data.premium * RATE_PREMIUM * (1 - PLATFORM_CUT));
      const fromSales  = salesByArtist[artisteId] ?? 0; // déjà net en centimes

      // Revenue total = streaming net + ventes nettes
      const netRevenue = netFree + netPremium + fromSales;

      if (netRevenue <= 0) continue;

      const artisteObjId = new mongoose.Types.ObjectId(artisteId);
      artistObjectIds.push(artisteObjId);

      // Upsert Royalty — accès direct collection pour contourner le strict mode
      await royaltyCol.updateOne(
        { artisteId: artisteObjId, period },
        {
          $setOnInsert: { status: 'pending', currency: 'EUR' },
          $inc: {
            plays:               data.totalPlays,
            // sources stockent les montants NETS artiste en centimes
            'sources.free':      netFree,
            'sources.premium':   netPremium,
            'sources.purchases': fromSales,
            revenue:             netRevenue,
          },
        },
        { upsert: true, session },
      );

      // Upsert ArtistPayout (modèle fusionné)
      await ArtistPayout.updateOne(
        { artisteId },
        {
          $setOnInsert: { artisteId },
          $inc: {
            pendingBalance: netRevenue,
            totalEarned:    netRevenue,
          },
        },
        { upsert: true, session },
      );

      processed++;
    }

    // ── 5. Marquer uniquement les écoutes des artistes traités ────────────────
    const { modifiedCount } = await Play.updateMany(
      {
        period,
        counted:   false,
        artisteId: { $in: artistObjectIds },
      },
      { $set: { counted: true } },
      { session },
    );

    // ── 6. Marquer les achats comptabilisés ────────────────────────────────────
    await Purchase.updateMany(
      {
        period,
        counted:   { $ne: true },
        artisteId: { $in: artistObjectIds },
      },
      { $set: { counted: true } },
      { session },
    );

    await session.commitTransaction();
    console.log(`[ROYALTIES] ✅ ${processed} artiste(s), ${modifiedCount} écoute(s) marquée(s)`);

  } catch (err) {
    await session.abortTransaction();
    console.error('[ROYALTIES] ❌ Transaction annulée:', err);
    throw err;

  } finally {
    session.endSession();
  }

  return { processed, period };
};

// ─── Cron ─────────────────────────────────────────────────────────────────────

/** Planifie le calcul des royalties le 1er de chaque mois à 02:00 UTC. */
const startRoyaltiesCron = () => {
  cron.schedule(
    '0 2 1 * *',
    async () => {
      const period = previousPeriod();
      try {
        await calculateRoyalties(period);
      } catch {
        process.exitCode = 1;
      }
    },
    { timezone: 'UTC' },
  );

  console.log('[ROYALTIES] ⏰ Cron planifié — 1er du mois à 02:00 UTC');
};

module.exports = { startRoyaltiesCron, calculateRoyalties };