const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { Admin, User, Artist } = require('../models');
const { signToken } = require('../middleware/auth');
const { toCloud, AVT_TRANSFORM, IMG_TRANSFORM, fromCloud } = require('../middleware/upload');
const { createUniqueSession } = require('../utils/sessionHelper');
const { sendMail } = require('../utils/mailer');

// ══════════════════════════════════════════════
// ADMIN AUTH
// ══════════════════════════════════════════════
exports.adminRegister = async (req, res) => {
  try {
    const { email, password, secret } = req.body;
    if (secret !== process.env.REGISTER_SECRET) return res.status(403).json({ message: 'Secret invalide' });
    if (await Admin.findOne({ email })) return res.status(400).json({ message: 'Admin déjà existant' });
    const isPrimary = (await Admin.countDocuments()) === 0;
    await new Admin({ email, password: await bcrypt.hash(password, 12), isPrimary }).save();
    res.json({ message: isPrimary ? 'Admin principal créé ✅' : 'Admin créé ✅' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin || !await bcrypt.compare(password, admin.password))
      return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
 
    const token = await createUniqueSession(
      { id: admin._id, email: admin.email, role: 'admin' },
      req,
      '7d'
    );
 
    res.json({
      token,
      email:     admin.email,
      role:      'admin',
      nom:       admin.nom || '',
      isPrimary: admin.isPrimary,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};


exports.adminVerify = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id).select('-password');
    res.json({ valid: true, email: req.admin.email, role: 'admin', nom: admin?.nom || '', isPrimary: admin?.isPrimary || false });
  } catch { res.json({ valid: true, email: req.admin.email, role: 'admin' }); }
};

exports.adminUpdateProfile = async (req, res) => {
  try {
    const { nom } = req.body;
    if (!nom?.trim()) return res.status(400).json({ message: 'Nom requis' });
    await Admin.findByIdAndUpdate(req.admin.id, { nom: nom.trim() });
    res.json({ message: 'Profil mis à jour', nom: nom.trim() });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.adminChangePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const admin = await Admin.findById(req.admin.id);
    if (!admin || !await bcrypt.compare(currentPassword, admin.password))
      return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    admin.password = await bcrypt.hash(newPassword, 12);
    await admin.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Multi-admin management ────────────────────
exports.listAdmins = async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: 'Réservé à l\'admin principal' });
    res.json(await Admin.find().select('-password').sort({ createdAt: 1 }));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createAdmin = async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: 'Réservé à l\'admin principal' });
    const { email, password, nom } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email et mot de passe requis' });
    if (await Admin.findOne({ email })) return res.status(400).json({ message: 'Email déjà utilisé' });
    const admin = await new Admin({ email, password: await bcrypt.hash(password, 12), nom: nom || '', createdBy: req.admin.id }).save();
    res.json({ ...admin.toObject(), password: undefined });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.updateAdmin = async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    const isSelf = String(req.admin.id) === String(req.params.id);
    if (!me?.isPrimary && !isSelf) return res.status(403).json({ message: 'Accès refusé' });
    const { nom, email, password } = req.body;
    const update = {};
    if (nom !== undefined) update.nom = nom;
    if (email) update.email = email;
    if (password?.length >= 6) update.password = await bcrypt.hash(password, 12);
    res.json(await Admin.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.deleteAdmin = async (req, res) => {
  try {
    const me = await Admin.findById(req.admin.id);
    if (!me?.isPrimary) return res.status(403).json({ message: 'Réservé à l\'admin principal' });
    if (String(req.params.id) === String(req.admin.id)) return res.status(400).json({ message: 'Impossible de se supprimer soi-même' });
    const target = await Admin.findById(req.params.id);
    if (target?.isPrimary) return res.status(400).json({ message: 'Impossible de supprimer l\'admin principal' });
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ message: 'Admin supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ══════════════════════════════════════════════
// USER AUTH
// ══════════════════════════════════════════════

// POST /users/register


// GET /users/verify-email?token=xxx
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token manquant' });

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Requête finale avec vérification expiration
    const user = await User.findOne({
      verifyEmailToken:   hashedToken,
      verifyEmailExpires: { $gt: new Date() },
    }).select('+verifyEmailToken +verifyEmailExpires');

    if (!user) return res.status(400).json({ message: 'Lien invalide ou expiré.' });

    // ✅ updateOne évite le pre-save hook et le problème select:false sur password
    await User.updateOne(
      { _id: user._id },
      {
        $set:   { isVerified: true },
        $unset: { verifyEmailToken: '', verifyEmailExpires: '' },
      }
    );

    return res.json({ message: 'Email confirmé ! Vous pouvez vous connecter.' });

  } catch (e) {
    console.error('[verifyEmail]', e);
    return res.status(500).json({ message: e.message });
  }
};

// POST /users/login
// FIX #1 + #2 : email et password extraits de req.body (étaient manquants → login impossible)
exports.userLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email et mot de passe requis' });
 
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
 
    if (user.banned)
      return res.status(403).json({ message: 'Compte suspendu.' });
 
    if (!user.isVerified)
      return res.status(403).json({ message: 'Veuillez confirmer votre email avant de vous connecter.' });
 
    const token = await createUniqueSession(
      { id: user._id, email: user.email, nom: user.nom, role: 'user' },
      req,
      '30d'
    );
 
    res.json({
      token,
      email:  user.email,
      nom:    user.nom,
      role:   'user',
      userId: user._id,
      avatar: user.avatar || '',
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};


exports.userVerify = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.json({ valid: false });
    res.json({ valid: true, ...req.user, avatar: user.avatar || '', nom: user.nom || req.user.nom });
  } catch { res.json({ valid: true, ...req.user }); }
};

// DELETE /users/:id
exports.deleteUser = async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.id) && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Accès refusé' });

    const { UserFavorite, UserPlay, History, Notification, UserPlaylist, ShareHistory } = require('../models');

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (user.avatarPublicId) await fromCloud(user.avatarPublicId).catch(() => {});

    await Promise.all([
      UserFavorite.deleteMany({ userId: req.params.id }),
      UserPlay.deleteMany({ userId: req.params.id }),
      History.deleteMany({ userId: req.params.id }),
      Notification.deleteMany({ userId: req.params.id }),
      UserPlaylist.deleteMany({ userId: req.params.id }),
      ShareHistory.deleteMany({ sharedBy: req.params.id }),
    ]);

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Compte supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.updateUser = async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.id) && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Accès refusé' });
    const update = {};
    if (req.body.nom)   update.nom   = req.body.nom;
    if (req.body.email) update.email = req.body.email.toLowerCase().trim();
    if (req.file) {
      const old = await User.findById(req.params.id);
      if (old?.avatarPublicId) await fromCloud(old.avatarPublicId).catch(() => {});
      const r = await toCloud(req.file.buffer, { folder: 'moozik/avatars', resource_type: 'image', transformation: AVT_TRANSFORM });
      update.avatar = r.secure_url; update.avatarPublicId = r.public_id;
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.changeUserPassword = async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.id) && req.user.role !== 'admin')
      return res.status(403).json({ message: 'Accès refusé' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const user = await User.findById(req.params.id).select('+password');
    if (!user || !await bcrypt.compare(currentPassword, user.password))
      return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Public user profile ───────────────────────
exports.publicProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('nom avatar role createdAt');
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    res.json(user);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.publicPlaylists = async (req, res) => {
  try {
    const { UserPlaylist } = require('../models');
    const playlists = await UserPlaylist.find({ userId: req.params.id, isPublic: true })
      .populate('musiques', 'titre artiste image src plays').sort({ createdAt: -1 });
    res.json(playlists.map(p => ({ ...p.toObject(), songs: p.musiques })));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.publicFavorites = async (req, res) => {
  try {
    const { UserFavorite } = require('../models');
    const favs  = await UserFavorite.find({ userId: req.params.id }).select('songId');
    const songs = await require('../models').Song.find({ _id: { $in: favs.map(f => f.songId) } }).select('-audioPublicId -imagePublicId -__v');
    res.json(songs.map(s => ({ ...s.toObject(), liked: true })));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ══════════════════════════════════════════════
// USER — MOT DE PASSE OUBLIÉ
// ══════════════════════════════════════════════

exports.userRegister = async (req, res) => {
  try {
    const { email, password, nom } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email et mot de passe requis' });

    const normalizedEmail = email.toLowerCase().trim();
    if (await User.findOne({ email: normalizedEmail }))
      return res.status(400).json({ message: 'Email déjà utilisé' });

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const verifyUrl   = `${process.env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;

    // 1. Crée l'utilisateur
    const user = await new User({
      email:      normalizedEmail,
      password,
      nom:        nom || normalizedEmail.split('@')[0],
      isVerified: false,
    }).save();

    // 2. Sauvegarde le token
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          verifyEmailToken:   hashedToken,
          verifyEmailExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }
      }
    );

    // 3. Envoie le mail via utils/mailer (Gmail SMTP)
    try {
      await sendMail({
        to:      user.email,
        subject: 'Confirmez votre adresse email — Moozik',
        html: `
          <div style="font-family:sans-serif;padding:32px;max-width:480px;margin:auto;">
            <h2 style="color:#dc2626;">Moozik</h2>
            <p>Bonjour <strong>${user.nom}</strong>,</p>
            <p>Merci de créer un compte ! Cliquez ci-dessous pour confirmer votre email.<br/>
              Ce lien est valable <strong>24 heures</strong>.</p>
            <p>
              <a href="${verifyUrl}"
                style="background:#dc2626;color:#fff;padding:14px 28px;border-radius:10px;
                       text-decoration:none;font-weight:bold;display:inline-block;">
                Confirmer mon email
              </a>
            </p>
            <p style="color:#999;font-size:12px;">
              Si vous n'avez pas créé de compte, ignorez cet email.
            </p>
          </div>
        `,
      });
    } catch (mailErr) {
      await User.deleteOne({ _id: user._id });
      console.error('[userRegister] Mail KO →', mailErr.message);
      return res.status(500).json({ message: `Erreur envoi email : ${mailErr.message}` });
    }

    return res.status(201).json({ message: 'Compte créé ! Vérifiez votre email pour activer votre compte.' });

  } catch (e) {
    console.error('[userRegister]', e);
    return res.status(500).json({ message: e.message });
  }
};

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  const GENERIC = 'Si cet email est associé à un compte, un lien de réinitialisation a été envoyé.';
  try {
    if (!email) return res.status(400).json({ message: 'Email requis.' });

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(200).json({ message: GENERIC });

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const resetUrl    = `${process.env.FRONTEND_URL}/reset-password?token=${rawToken}`;

    // 1. Écrit le token en base
    await User.updateOne(
      { email: normalizedEmail },
      {
        $set: {
          resetPasswordToken:   hashedToken,
          resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
        }
      }
    );

    // 2. Envoie le mail via utils/mailer (Gmail SMTP)
    try {
      await sendMail({
        to:      user.email,
        subject: 'Réinitialisation de votre mot de passe Moozik',
        html: `
          <div style="font-family:sans-serif;padding:32px;max-width:480px;margin:auto;">
            <h2 style="color:#dc2626;">Moozik</h2>
            <p>Bonjour <strong>${user.nom || user.email}</strong>,</p>
            <p>Vous avez demandé la réinitialisation de votre mot de passe.<br/>
              Ce lien est valable <strong>15 minutes</strong>.</p>
            <p>
              <a href="${resetUrl}"
                style="background:#dc2626;color:#fff;padding:14px 28px;border-radius:10px;
                       text-decoration:none;font-weight:bold;display:inline-block;">
                Réinitialiser mon mot de passe
              </a>
            </p>
            <p style="color:#999;font-size:12px;">
              Si vous n'avez pas fait cette demande, ignorez cet email.<br/>
              Lien direct : <a href="${resetUrl}">${resetUrl}</a>
            </p>
          </div>
        `,
      });
    } catch (mailErr) {
      await User.updateOne(
        { email: normalizedEmail },
        { $unset: { resetPasswordToken: '', resetPasswordExpires: '' } }
      );
      console.error('[forgotPassword] Mail KO →', mailErr.message);
      return res.status(500).json({ message: `Erreur envoi email : ${mailErr.message}` });
    }

    return res.status(200).json({ message: GENERIC });

  } catch (e) {
    console.error('[forgotPassword]', e.message);
    return res.status(500).json({ message: 'Erreur serveur. Veuillez réessayer.' });
  }
};

// POST /users/reset-password  { token, newPassword }
exports.resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    if (!token || !newPassword)
      return res.status(400).json({ message: 'Token et nouveau mot de passe requis.' });
    // FIX : aligné sur 6 caractères comme le register et changeUserPassword
    if (newPassword.length < 6)
      return res.status(400).json({ message: 'Trop court (6 min).' });

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // resetPasswordToken/Expires ont select:false → forcer leur inclusion
    const user = await User.findOne({
      resetPasswordToken:   hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+resetPasswordToken +resetPasswordExpires +password');

    if (!user)
      return res.status(400).json({ message: 'Lien invalide ou expiré. Veuillez refaire une demande.' });

    // FIX : user.save() au lieu de findOneAndUpdate + strict:false
    // Le hook pre('save') gère le hash automatiquement — pas besoin de bcrypt.hash ici
    user.password             = newPassword; // le hook pre('save') hashera
    user.resetPasswordToken   = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.status(200).json({ message: 'Mot de passe mis à jour. Vous pouvez vous connecter.' });

  } catch (e) {
    console.error('[resetPassword]', e.message);
    return res.status(500).json({ message: 'Erreur serveur. Veuillez réessayer.' });
  }
};

// ══════════════════════════════════════════════
// ARTIST AUTH
// ══════════════════════════════════════════════

// FIX #3 : email normalisé avec .toLowerCase().trim() comme dans userLogin
exports.artistLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email et mot de passe requis' });
 
    const artist = await Artist.findOne({ email: email.toLowerCase().trim() });
    if (!artist?.password || !await bcrypt.compare(password, artist.password))
      return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
 
    const token = await createUniqueSession(
      { id: artist._id, email: artist.email, nom: artist.nom, role: 'artist' },
      req,
      '7d'
    );
 
    res.json({
      token,
      email:     artist.email,
      nom:       artist.nom,
      role:      'artist',
      artisteId: artist._id,
      image:     artist.image || '',
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};


exports.artistVerify = (req, res) => res.json({ valid: true, ...req.user });

exports.listArtists = async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await Artist.find().select('-password -imagePublicId -__v').sort({ nom: 1 }));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getArtist = async (req, res) => {
  try {
    const { Song } = require('../models');
    const artist = await Artist.findById(req.params.id).select('-password');
    if (!artist) return res.status(404).json({ message: 'Artiste introuvable' });
    const songs = await Song.find({ artisteId: req.params.id }).sort({ ordre: 1, createdAt: -1 });
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ artist, songs });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createArtist = async (req, res) => {
  try {
    const { nom, bio, email, password } = req.body;
    if (!nom?.trim()) return res.status(400).json({ message: 'Nom requis' });
    let imageUrl = '', imagePublicId = '';
    if (req.file) {
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      imageUrl = r.secure_url; imagePublicId = r.public_id;
    }
    const artist = await new Artist({
      nom: nom.trim(), bio: bio || '', email: email || undefined,
      password: password ? await bcrypt.hash(password, 12) : null,
      image: imageUrl, imagePublicId,
    }).save();
    res.json(artist);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// FIX #5 : fromCloud avec await + .catch(() => {}) + guard if
exports.updateArtist = async (req, res) => {
  try {
    if (req.user.role === 'artist' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const update = {};
    if (req.body.nom) update.nom = req.body.nom;
    if (req.body.bio !== undefined) update.bio = req.body.bio;
    if (req.file) {
      const existing = await Artist.findById(req.params.id);
      if (existing?.imagePublicId) await fromCloud(existing.imagePublicId).catch(() => {}); // ← CORRECTION
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      update.image = r.secure_url; update.imagePublicId = r.public_id;
    }
    res.json(await Artist.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-password'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// FIX #5 : idem pour updateArtistMe
exports.updateArtistMe = async (req, res) => {
  try {
    const update = {};
    if (req.body.nom) update.nom = req.body.nom;
    if (req.body.bio !== undefined) update.bio = req.body.bio;
    if (req.file) {
      const old = await Artist.findById(req.user.id);
      if (old?.imagePublicId) await fromCloud(old.imagePublicId).catch(() => {}); // ← CORRECTION
      const r = await toCloud(req.file.buffer, { folder: 'moozik/images', resource_type: 'image', transformation: IMG_TRANSFORM });
      update.image = r.secure_url; update.imagePublicId = r.public_id;
    }
    res.json(await Artist.findByIdAndUpdate(req.user.id, update, { returnDocument: 'after' }).select('-password'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// FIX #4 : vérification existence artiste + 404 explicite
exports.deleteArtist = async (req, res) => {
  try {
    const a = await Artist.findById(req.params.id);
    if (!a) return res.status(404).json({ message: 'Artiste introuvable' }); // ← CORRECTION
    if (a.imagePublicId) await fromCloud(a.imagePublicId).catch(() => {});   // ← CORRECTION
    await Artist.findByIdAndDelete(req.params.id);
    res.json({ message: 'Artiste supprimé' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.changeArtistPassword = async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id))
      return res.status(403).json({ message: 'Accès refusé' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Trop court (6 min)' });
    const artist = await Artist.findById(req.params.id);
    if (!artist || !await bcrypt.compare(currentPassword, artist.password))
      return res.status(401).json({ message: 'Mot de passe actuel incorrect' });
    artist.password = await bcrypt.hash(newPassword, 12);
    await artist.save();
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};