const mongoose = require('mongoose');

// ── Paroles synchronisées (LRC) ───────────────
const LyricsSchema = new mongoose.Schema({
  songId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true, unique: true },
  lines: [{
    time:  { type: Number, required: true }, // secondes
    text:  { type: String, required: true },
  }],
  source: { type: String, default: 'manual' }, // 'manual' | 'lrc'
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'uploaderModel' },
  uploaderModel: { type: String, enum: ['User','Artist','Admin'] },
}, { timestamps: true });
const Lyrics = mongoose.model('Lyrics', LyricsSchema);

// ── Certification artiste ─────────────────────
const CertificationSchema = new mongoose.Schema({
  artistId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true, unique: true },
  status:     { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  level:      { type: String, enum: ['blue','gold'], default: 'blue' }, // bleu = vérifié, or = premium
  requestedAt:{ type: Date, default: Date.now },
  reviewedAt: { type: Date },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  note:       { type: String, default: '' }, // Note de refus ou commentaire admin
  documents:  [{ type: String }],            // URLs justificatifs
}, { timestamps: true });
const Certification = mongoose.model('Certification', CertificationSchema);

// ── Smart Link artiste (moozik.app/nom) ────────
const SmartLinkSchema = new mongoose.Schema({
  artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true, unique: true },
  slug:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  views:    { type: Number, default: 0 },
  clicks:   { type: Number, default: 0 },
  customBio:{ type: String, default: '' },
  socialLinks: {
    instagram: { type: String, default: '' },
    tiktok:    { type: String, default: '' },
    youtube:   { type: String, default: '' },
    twitter:   { type: String, default: '' },
    facebook:  { type: String, default: '' },
  },
}, { timestamps: true });

const SmartLink = mongoose.model('SmartLink', SmartLinkSchema);

// ── Featuting officiel ────────────────────────
const FeaturingSchema = new mongoose.Schema({
  songId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Song',   required: true },
  mainArtistId:{ type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  featArtistId:{ type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  role:        { type: String, default: 'feat' }, // 'feat' | 'prod' | 'remix'
  confirmedAt: { type: Date },
  status:      { type: String, enum: ['pending','confirmed','declined'], default: 'confirmed' },
}, { timestamps: true });
FeaturingSchema.index({ songId: 1 });
const Featuring = mongoose.model('Featuring', FeaturingSchema);

// ── Programmation de sortie (scheduled release) ─
const ScheduledReleaseSchema = new mongoose.Schema({
  songId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true, unique: true },
  artistId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Artist' },
  releaseAt:   { type: Date, required: true },
  isPublished: { type: Boolean, default: false },
  notified:    { type: Boolean, default: false },
  teaser:      { type: String, default: '' }, // URL image teaser
}, { timestamps: true });
const ScheduledRelease = mongoose.model('ScheduledRelease', ScheduledReleaseSchema);

// ── Newsletter / Abonnés artiste ──────────────
const ArtistFollowerSchema = new mongoose.Schema({
  artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  email:    { type: String },
  notifyNewSong:  { type: Boolean, default: true },
  notifyNewAlbum: { type: Boolean, default: true },
}, { timestamps: true });
ArtistFollowerSchema.index({ artistId: 1, userId: 1 }, { unique: true });
const ArtistFollower = mongoose.model('ArtistFollower', ArtistFollowerSchema);

const NewsletterCampaignSchema = new mongoose.Schema({
  artistId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  subject:    { type: String, required: true },
  message:    { type: String, required: true },
  sentTo:     { type: Number, default: 0 },
  openCount:  { type: Number, default: 0 },
  sentAt:     { type: Date },
  status:     { type: String, enum: ['draft','sent'], default: 'draft' },
}, { timestamps: true });
const NewsletterCampaign = mongoose.model('NewsletterCampaign', NewsletterCampaignSchema);

// ── WebPush subscriptions ─────────────────────
const PushSubscriptionSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  subscription: { type: Object, required: true }, // { endpoint, keys: {p256dh, auth} }
  userAgent:    { type: String, default: '' },
}, { timestamps: true });
PushSubscriptionSchema.index({ 'subscription.endpoint': 1 }, { unique: true });
const PushSubscription = mongoose.model('PushSubscription', PushSubscriptionSchema);

module.exports = {
  Lyrics, Certification, SmartLink, Featuring,
  ScheduledRelease, ArtistFollower, NewsletterCampaign, PushSubscription,
};

