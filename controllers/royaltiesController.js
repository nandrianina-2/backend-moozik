const mongoose   = require('mongoose');
const { Royalty, ArtistPayout, Tip } = require('../models/monetisationModels');
const Play = require('../models/Play');

exports.getArtistRoyalties = async (req, res) => {
  try {
    const artisteId = req.params.id;
    const royalties = await Royalty.find({ artisteId }).sort({ period: -1 }).limit(12).lean();
    const payout = await ArtistPayout.findOne({ artisteId }).lean();
    let totalTipsEuros = '0.00';
    try {
      const agg = await Tip.aggregate([
        { $match: { toArtistId: new mongoose.Types.ObjectId(artisteId) } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      totalTipsEuros = ((agg[0]?.total || 0) / 100).toFixed(2);
    } catch (_) {}
    res.json({ royalties, payout: payout || { pendingBalance:0, totalEarned:0, paypalEmail:'', mobileMoneyPhone:'', mobileMoneyProvider:'none', stripeAccountId:'', onboardingDone:false }, totalTipsEuros });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.savePayoutInfo = async (req, res) => {
  try {
    const { paypalEmail, mobileMoneyPhone, mobileMoneyProvider } = req.body;
    const updated = await ArtistPayout.findOneAndUpdate(
      { artisteId: req.params.id },
      { paypalEmail, mobileMoneyPhone, mobileMoneyProvider },
      { upsert: true, new: true }
    );
    res.json(updated);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getAdminRoyalties = async (req, res) => {
  try {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    const royalties = await Royalty.aggregate([
      { $match: { period } },
      { $sort: { revenue: -1 } },
      { $lookup: { from: 'artists', localField: 'artistId', foreignField: '_id', as: 'artisteId' } },
      { $addFields: { artisteId: { $arrayElemAt: ['$artisteId', 0] } } },
      { $project: { period:1, plays:1, revenue:1, status:1, sources:1, currency:1, 'artisteId._id':1, 'artisteId.nom':1, 'artisteId.image':1 } },
    ]);
    const totalCents = royalties.reduce((s, r) => s + (r.revenue || 0), 0);
    res.json({ period, royalties, totalEuros: (totalCents / 100).toFixed(2) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.triggerPayout = async (req, res) => {
  try {
    const period = req.body.period || new Date().toISOString().slice(0, 7);
    const pending = await Royalty.find({ period, status: 'pending', revenue: { $gt: 0 } }).lean();
    if (pending.length === 0) return res.json({ message: `Aucune royaltie en attente pour ${period}` });
    let versed = 0;
    for (const royalty of pending) {
      await Royalty.findByIdAndUpdate(royalty._id, { status: 'processing', paidAt: new Date() });
      await ArtistPayout.findOneAndUpdate(
        { artisteId: royalty.artistId },
        { $inc: { pendingBalance: -royalty.revenue, totalPaid: royalty.revenue } },
        { upsert: true }
      );
      versed++;
    }
    res.json({ message: `${versed} artiste(s) mis en traitement pour ${period}`, period, versed });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
