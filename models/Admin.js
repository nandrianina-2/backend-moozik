const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  nom: {
    type: String,
    trim: true,
    default: function () { return this.email; }
  },
  email: {
    type: String,
    required: [true, 'Email requis'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Mot de passe requis'],
    minlength: 6,
    select: false,
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
  lastLogin: {
    type: Date,
    default: null,
  },
  sessionVersion: {
    type: Number,
    default: 0,   // incrémenter = invalide tous les tokens existants
  },
}, { timestamps: true });

// Hash password avant sauvegarde
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

adminSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

adminSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.sessionVersion;
  return obj;
};

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

