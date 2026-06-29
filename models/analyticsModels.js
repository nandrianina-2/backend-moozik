const mongoose = require('mongoose');

// ── Événement de rétention audio ──────────────
// Stocke à quel % d'une musique chaque utilisateur s'arrête
const RetentionEventSchema = new mongoose.Schema({
  songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deviceId:   { type: String, default: '' },
  // Buckets de 5% (0-4%, 5-9%, ..., 95-99%, 100%)
  buckets:    { type: [Number], default: Array(20).fill(0) }, // 20 buckets × 5%
  totalTime:  { type: Number, default: 0 }, // secondes écoutées
  dropped:    { type: Number, default: 0 }, // % de drop (0-100)
  completed:  { type: Boolean, default: false },
}, { timestamps: true });
RetentionEventSchema.index({ songId: 1 });
const RetentionEvent = mongoose.model('RetentionEvent', RetentionEventSchema);

// ── Écoute géolocalisée ───────────────────────
const GeoPlaySchema = new mongoose.Schema({
  songId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true },
  artistId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Artist' },
  country:   { type: String, default: 'XX' },   // ISO 3166-1 alpha-2
  countryName: { type: String, default: '' },
  region:    { type: String, default: '' },
  city:      { type: String, default: '' },
  lat:       { type: Number },
  lng:       { type: Number },
  count:     { type: Number, default: 1 },
}, { timestamps: true });
GeoPlaySchema.index({ songId: 1, country: 1 });
GeoPlaySchema.index({ artistId: 1, country: 1 });
const GeoPlay = mongoose.model('GeoPlay', GeoPlaySchema);

// ── Score trending (mis à jour toutes les heures) ──
const TrendingScoreSchema = new mongoose.Schema({
  songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true, unique: true },
  score:      { type: Number, default: 0 },   // score composite
  velocity:   { type: Number, default: 0 },   // écoutes/heure dernières 24h
  plays1h:    { type: Number, default: 0 },
  plays24h:   { type: Number, default: 0 },
  plays7d:    { type: Number, default: 0 },
  reactions:  { type: Number, default: 0 },
  shares:     { type: Number, default: 0 },
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: true });
TrendingScoreSchema.index({ score: -1 });
const TrendingScore = mongoose.model('TrendingScore', TrendingScoreSchema);

// ── Demographics audience ─────────────────────
const DemographicsSnapshotSchema = new mongoose.Schema({
  artistId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  period:    { type: String, required: true }, // 'YYYY-MM-DD'
  // Heures de pointe (24 buckets)
  hourlyPlays: { type: [Number], default: Array(24).fill(0) },
  // Appareils (user-agent simplifié)
  devices: {
    mobile:  { type: Number, default: 0 },
    desktop: { type: Number, default: 0 },
    tablet:  { type: Number, default: 0 },
  },
  // Âge estimé (via cohortes d'inscription)
  ageGroups: {
    u18:    { type: Number, default: 0 },
    '18-24':{ type: Number, default: 0 },
    '25-34':{ type: Number, default: 0 },
    '35-44':{ type: Number, default: 0 },
    o45:    { type: Number, default: 0 },
  },
  totalPlays: { type: Number, default: 0 },
  uniqueUsers: { type: Number, default: 0 },
}, { timestamps: true });
DemographicsSnapshotSchema.index({ artistId: 1, period: 1 });
const DemographicsSnapshot = mongoose.model('DemographicsSnapshot', DemographicsSnapshotSchema);

// ── Analyse de sentiment des commentaires ─────
const SentimentAnalysisSchema = new mongoose.Schema({
  songId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true, unique: true },
  positive:  { type: Number, default: 0 }, // % commentaires positifs
  negative:  { type: Number, default: 0 },
  neutral:   { type: Number, default: 0 },
  score:     { type: Number, default: 0 }, // -1 à 1
  alert:     { type: Boolean, default: false }, // true si négatif > 40%
  lastAnalyzed: { type: Date },
  commentCount: { type: Number, default: 0 },
  keywords: {
    positive: [String],
    negative: [String],
  },
}, { timestamps: true });
const SentimentAnalysis = mongoose.model('SentimentAnalysis', SentimentAnalysisSchema);

// ── Stories artiste (24h) ─────────────────────
const StorySchema = new mongoose.Schema({
  artistId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  type:        { type: String, enum: ['audio','image','video','text'], default: 'audio' },
  mediaUrl:    { type: String, required: true },
  mediaPublicId: { type: String, default: '' },
  caption:     { type: String, default: '' },
  duration:    { type: Number, default: 30 }, // secondes pour audio/video
  views:       { type: Number, default: 0 },
  viewedBy:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  expiresAt:   { type: Date, required: true }, // createdAt + 24h
  active:      { type: Boolean, default: true },
}, { timestamps: true });
StorySchema.index({ artistId: 1, expiresAt: 1 });
StorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto
const Story = mongoose.model('Story', StorySchema);

// ── Programme de fidélité (points) ───────────
const LoyaltyPointSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  points:    { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  level:     { type: String, enum: ['bronze','silver','gold','platinum'], default: 'bronze' },
  // Historique des gains
  history: [{
    action:  String, // 'play','comment','share','favorite','register','referral'
    points:  Number,
    date:    { type: Date, default: Date.now },
    meta:    String,
  }],
}, { timestamps: true });
LoyaltyPointSchema.index({ points: -1 });
const LoyaltyPoint = mongoose.model('LoyaltyPoint', LoyaltyPointSchema);

// ── Classement hebdomadaire + Challenges ──────
const WeeklyChartSchema = new mongoose.Schema({
  week:      { type: String, required: true }, // 'YYYY-WXX'
  type:      { type: String, enum: ['songs','artists','new','viral'], default: 'songs' },
  entries: [{
    rank:       Number,
    songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
    artistId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Artist' },
    score:      Number,
    change:     Number, // +/- par rapport à la semaine précédente
    isNewEntry:      { type: Boolean, default: false },
  }],
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });
WeeklyChartSchema.index({ week: 1, type: 1 }, { unique: true });
const WeeklyChart = mongoose.model('WeeklyChart', WeeklyChartSchema);

const ChallengeSchema = new mongoose.Schema({
  hashtag:    { type: String, required: true, unique: true }, // '#TitreDuMois'
  title:      { type: String, required: true },
  description:{ type: String, default: '' },
  songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
  startsAt:   { type: Date, required: true },
  endsAt:     { type: Date, required: true },
  prize:      { type: String, default: '' }, // Description du prix
  entries:    { type: Number, default: 0 },  // Nombre de participations
  active:     { type: Boolean, default: true },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });
const Challenge = mongoose.model('Challenge', ChallengeSchema);

// Badge "Fan #1" — l'auditeur le plus actif d'un artiste
const FanBadgeSchema = new mongoose.Schema({
  artistId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plays:     { type: Number, default: 0 },
  awardedAt: { type: Date, default: Date.now },
}, { timestamps: true });
const FanBadge = mongoose.model('FanBadge', FanBadgeSchema);

// ── Listen Party (écoute collaborative) ───────
const ListenPartySchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true }, // 6 chars
  hostId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  songId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
  currentTime:{ type: Number, default: 0 },
  isPlaying:  { type: Boolean, default: false },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  maxParticipants: { type: Number, default: 10 },
  messages: [{
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    nom:      String,
    avatar:   String,
    text:     String,
    time:     { type: Date, default: Date.now },
  }],
  active:     { type: Boolean, default: true },
  expiresAt:  { type: Date },
}, { timestamps: true });
ListenPartySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const ListenParty = mongoose.model('ListenParty', ListenPartySchema);

// ── Rapport hebdomadaire artiste ──────────────
const WeeklyReportSchema = new mongoose.Schema({
  artistId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  week:      { type: String, required: true }, // 'YYYY-WXX'
  plays:     { type: Number, default: 0 },
  newFollowers: { type: Number, default: 0 },
  estimatedRevenue: { type: Number, default: 0 }, // centimes
  topSong:   { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
  topCountry:{ type: String, default: '' },
  sentAt:    { type: Date },
  emailSent: { type: Boolean, default: false },
}, { timestamps: true });
WeeklyReportSchema.index({ artistId: 1, week: 1 }, { unique: true });
const WeeklyReport = mongoose.model('WeeklyReport', WeeklyReportSchema);

module.exports = {
  RetentionEvent, GeoPlay, TrendingScore, DemographicsSnapshot,
  SentimentAnalysis, Story, LoyaltyPoint, WeeklyChart, Challenge,
  FanBadge, ListenParty, WeeklyReport,
};

