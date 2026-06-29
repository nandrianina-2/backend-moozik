const mongoose = require('mongoose');

// ── Plan d'abonnement ─────────────────────────────────────────────────────────
const PlanSchema = new mongoose.Schema({
  name:     { type: String, required: true }, // 'free' | 'premium'
  price:    { type: Number, required: true }, // en centimes (0 pour free)
  currency: { type: String, default: 'EUR' },
  interval: { type: String, enum: ['month', 'year'], default: 'month' },
  features: {
    hd:        { type: Boolean, default: false },
    offline:   { type: Boolean, default: false },
    noAds:     { type: Boolean, default: false },
    downloads: { type: Number,  default: 0 },
  },
  stripePriceId:  { type: String, default: '' },
  paydunyaItemId: { type: String, default: '' },
  active:         { type: Boolean, default: true },
}, { timestamps: true });
const Plan = mongoose.model('Plan', PlanSchema);


// ── Abonnement utilisateur ────────────────────────────────────────────────────
const SubscriptionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  planName: { type: String, default: 'free' },
  status:   { type: String, enum: ['active', 'cancelled', 'expired', 'trialing', 'past_due'], default: 'active' },
  provider: { type: String, enum: ['stripe', 'paydunya', 'manual'], default: 'stripe' },
  // Stripe
  stripeSubscriptionId: { type: String, default: '' },
  stripeCustomerId:     { type: String, default: '' },
  // PayDunya
  paydunyaToken: { type: String, default: '' },
  // Dates
  currentPeriodStart: { type: Date },
  currentPeriodEnd:   { type: Date },
  cancelAtPeriodEnd:  { type: Boolean, default: false },
  cancelledAt:        { type: Date },
}, { timestamps: true });
SubscriptionSchema.index({ userId: 1 });
SubscriptionSchema.index({ stripeSubscriptionId: 1 }, { sparse: true });
const Subscription = mongoose.model('Subscription', SubscriptionSchema);


// ── Achat de musique (vente MP3) ──────────────────────────────────────────────
const PurchaseSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  songId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Song',   required: true },
  artisteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist' }, // ← aligné
  price:    { type: Number, required: true }, // en centimes
  currency: { type: String, default: 'EUR' },
  provider: { type: String, enum: ['stripe', 'paydunya'], default: 'stripe' },
  stripePaymentIntentId: { type: String, default: '' },
  paydunyaToken:         { type: String, default: '' },
  status:      { type: String, enum: ['pending', 'completed', 'refunded'], default: 'pending' },
  artistShare: { type: Number, default: 0 }, // part artiste en centimes (calculée à l'achat)
  period:      { type: String, default: '' }, // 'YYYY-MM' — rempli à la création
  counted:     { type: Boolean, default: false },
  downloadUrl:  { type: String, default: '' },
  downloadedAt: { type: Date },
}, { timestamps: true });
PurchaseSchema.index({ userId: 1 });
PurchaseSchema.index({ songId: 1 });
PurchaseSchema.index({ artisteId: 1 });
PurchaseSchema.index({ period: 1, counted: 1, artisteId: 1 }); // pour l'agrégation cron
const Purchase = mongoose.model('Purchase', PurchaseSchema);


// ── Prix d'une musique à vendre ───────────────────────────────────────────────
const SongPriceSchema = new mongoose.Schema({
  songId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Song',   required: true, unique: true },
  artisteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist' }, // ← aligné
  price:     { type: Number, required: true }, // en centimes
  currency:  { type: String, default: 'EUR' },
  forSale:   { type: Boolean, default: false },
  freePreviewSeconds: { type: Number, default: 30 },
}, { timestamps: true });
const SongPrice = mongoose.model('SongPrice', SongPriceSchema);


// ── Don / Pourboire ───────────────────────────────────────────────────────────
const TipSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  toArtistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
  amount:     { type: Number, required: true }, // en centimes
  currency:   { type: String, default: 'EUR' },
  message:    { type: String, default: '' },
  provider:   { type: String, enum: ['stripe', 'paydunya', 'orange_money', 'airtel_money'], default: 'stripe' },
  stripePaymentIntentId: { type: String, default: '' },
  paydunyaToken: { type: String, default: '' },
  phoneNumber:   { type: String, default: '' },
  status:    { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  anonymous: { type: Boolean, default: false },
}, { timestamps: true });
TipSchema.index({ toArtistId: 1, createdAt: -1 });
const Tip = mongoose.model('Tip', TipSchema);


// ── Royalties ─────────────────────────────────────────────────────────────────
const RoyaltySchema = new mongoose.Schema({
  artisteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true }, // ← aligné
  period:    { type: String, required: true }, // 'YYYY-MM'
  plays:     { type: Number, default: 0 },
  revenue:   { type: Number, default: 0 },  // en centimes
  currency:  { type: String, default: 'EUR' },
  status:    { type: String, enum: ['pending', 'paid', 'processing'], default: 'pending' },
  paidAt:    { type: Date },
  stripeTransferId: { type: String, default: '' },
  sources: {
    free:      { type: Number, default: 0 }, // écoutes gratuites en centimes
    premium:   { type: Number, default: 0 }, // écoutes abonnés premium en centimes
    purchases: { type: Number, default: 0 }, // ventes directes en centimes
    tips:      { type: Number, default: 0 }, // pourboires reçus en centimes
  },
}, { timestamps: true });
RoyaltySchema.index({ artisteId: 1, period: 1 }, { unique: true }); // ← unique évite les doublons
const Royalty = mongoose.model('Royalty', RoyaltySchema);


// ── Publicité audio ───────────────────────────────────────────────────────────
const AudioAdSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  advertiser: { type: String, required: true },
  audioUrl:   { type: String, required: true },
  audioPublicId: { type: String, default: '' },
  imageUrl:   { type: String, default: '' },
  duration:   { type: Number, default: 30 },
  clickUrl:   { type: String, default: '' },
  targetLang: [{ type: String }],
  budget:     { type: Number, default: 0 },
  spent:      { type: Number, default: 0 },
  cpm:        { type: Number, default: 200 },
  impressions:{ type: Number, default: 0 },
  clicks:     { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  startsAt:   { type: Date },
  endsAt:     { type: Date },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });
const AudioAd = mongoose.model('AudioAd', AudioAdSchema);


// ── Impression de pub ─────────────────────────────────────────────────────────
const AdImpressionSchema = new mongoose.Schema({
  adId:     { type: mongoose.Schema.Types.ObjectId, ref: 'AudioAd', required: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deviceId: { type: String, default: '' },
  clicked:  { type: Boolean, default: false },
  skipped:  { type: Boolean, default: false },
  listenedFull: { type: Boolean, default: false },
}, { timestamps: true });
AdImpressionSchema.index({ adId: 1, createdAt: -1 });
const AdImpression = mongoose.model('AdImpression', AdImpressionSchema);


// ── Événement / Concert ───────────────────────────────────────────────────────
const EventSchema = new mongoose.Schema({
  artisteId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true }, // ← aligné
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  venue:       { type: String, required: true },
  city:        { type: String, default: '' },
  country:     { type: String, default: '' },
  date:        { type: Date, required: true },
  image:       { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  ticketPrice:    { type: Number, required: true },
  ticketCurrency: { type: String, default: 'EUR' },
  ticketCapacity: { type: Number, default: 0 },
  ticketsSold:    { type: Number, default: 0 },
  ticketOnSale:   { type: Boolean, default: true },
  stripeProductId: { type: String, default: '' },
  stripePriceId:   { type: String, default: '' },
  status: { type: String, enum: ['upcoming', 'ongoing', 'past', 'cancelled'], default: 'upcoming' },
}, { timestamps: true });
EventSchema.index({ artisteId: 1, date: 1 });
const Event = mongoose.model('Event', EventSchema);


// ── Billet ────────────────────────────────────────────────────────────────────
const TicketSchema = new mongoose.Schema({
  eventId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  quantity: { type: Number, default: 1 },
  totalPaid: { type: Number, required: true },
  currency:  { type: String, default: 'EUR' },
  provider:  { type: String, enum: ['stripe', 'paydunya'], default: 'stripe' },
  stripePaymentIntentId: { type: String, default: '' },
  qrCode: { type: String, required: true, unique: true },
  used:   { type: Boolean, default: false },
  usedAt: { type: Date },
  status: { type: String, enum: ['pending', 'confirmed', 'refunded'], default: 'pending' },
}, { timestamps: true });
TicketSchema.index({ eventId: 1 });
TicketSchema.index({ userId: 1 });
const Ticket = mongoose.model('Ticket', TicketSchema);


// ── Compte paiement artiste (fusion ArtistPayout + PayoutInfo) ────────────────
// Remplace les deux anciens modèles. Champ de référence unifié : artisteId.
const ArtistPayoutSchema = new mongoose.Schema({
  artisteId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true, unique: true },
  // Stripe Connect
  stripeAccountId:      { type: String, default: '' },
  onboardingDone:       { type: Boolean, default: false },
  // Autres méthodes de paiement
  paypalEmail:          { type: String, default: '' },
  mobileMoneyPhone:     { type: String, default: '' },
  mobileMoneyProvider:  { type: String, enum: ['orange', 'airtel', 'mpesa', 'wave', 'none'], default: 'none' },
  // Soldes en centimes EUR
  pendingBalance: { type: Number, default: 0 }, // non encore versé
  totalEarned:    { type: Number, default: 0 }, // cumul historique
  totalPaid:      { type: Number, default: 0 }, // déjà versé
}, { timestamps: true });
// Pas de schema.index() ici — unique:true sur le champ suffit
const ArtistPayout = mongoose.model('ArtistPayout', ArtistPayoutSchema);


// ── Config monétisation (admin) ───────────────────────────────────────────────
const MonetisationConfigSchema = new mongoose.Schema({
  key:   { type: String, unique: true, required: true },
  value: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
const MonetisationConfig = mongoose.model('MonetisationConfig', MonetisationConfigSchema);


module.exports = {
  Plan, Subscription, Purchase, SongPrice, Tip,
  Royalty, AudioAd, AdImpression, Event, Ticket,
  ArtistPayout, MonetisationConfig,
  // PayoutInfo n'est plus exporté — utiliser ArtistPayout
};