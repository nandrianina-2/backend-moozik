const mongoose = require('mongoose');

const PlaySchema = new mongoose.Schema({
  songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song',   required: true },
  artisteId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',   default: null },
  isPremium:  { type: Boolean, default: false }, // abonné premium au moment de l'écoute
  period:     { type: String,  required: true  }, // "2025-01"
  duration:   { type: Number,  default: 0      }, // secondes écoutées
  counted:    { type: Boolean, default: false  }, // déjà comptabilisé dans royalties ?
  listenedAt: { type: Date,    default: Date.now },
}, { timestamps: false });

PlaySchema.index({ artisteId: 1, period: 1 });
PlaySchema.index({ period: 1, counted: 1 });

module.exports = mongoose.model('Play', PlaySchema);