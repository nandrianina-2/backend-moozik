// models/User.js
// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  nom: {
    type:  String,
    trim:  true,
  },
  email: {
    type:      String,
    required:  [true, 'Email requis'],
    unique:    true,
    lowercase: true,
    trim:      true,
  },
  password: {
    type:   String,
    select: false,
  },
  role: {
    type:    String,
    enum:    ['user', 'artist', 'admin'],
    default: 'user',
  },
  avatar: {
    type:    String,
    default: null,
  },
  banned: {
    type:    Boolean,
    default: false,
  },
  isVerified: {
    type:    Boolean,
    default: false,
  },
  verifyEmailToken: {
    type:   String,
    select: false,
  },
  verifyEmailExpires: {
    type:   Date,
    select: false,
  },

  // ── Champs reset mot de passe ──────────────────────────────────────────────
  resetPasswordToken: {
    type:   String,
    select: false,        // jamais exposé dans les requêtes
  },
  resetPasswordExpires: {
    type:   Date,
    select: false,
  },

}, { timestamps: true });

// ── Hash du mot de passe avant sauvegarde ─────────────────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Objet sans champs sensibles ───────────────────────────────────────────────
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  return obj;
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);