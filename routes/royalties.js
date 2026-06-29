const express  = require('express');
const router   = express.Router();
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/auth');
const playCtrl = require('../controllers/playController');
const royCtrl  = require('../controllers/royaltiesController');
const { calculateRoyalties } = require('../jobs/royaltiesCron');
const { Royalty } = require('../models/monetisationModels');
const Play = require('../models/Play');

router.post('/songs/:id/play', optionalAuth, playCtrl.recordPlay);
router.get('/artists/:id/royalties', requireAuth, royCtrl.getArtistRoyalties);
router.put('/artists/:id/payout',    requireAuth, royCtrl.savePayoutInfo);
router.post('/admin/royalties/payout', requireAdmin, royCtrl.triggerPayout);

router.post('/admin/royalties/calculate', requireAdmin, async (req, res) => {
  try {
    const period = req.body.period || new Date().toISOString().slice(0, 7);
    const result = await calculateRoyalties(period);
    res.json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
});


module.exports = router;
