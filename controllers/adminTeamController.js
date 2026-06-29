const jwt    = require('jsonwebtoken');
const Admin  = require('../models/Admin');
const User   = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /admin/login
 * Body: { email, password }
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email et mot de passe requis' });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() })
                             .select('+password +sessionVersion');
    if (!admin) return res.status(401).json({ message: 'Identifiants incorrects' });

    const match = await admin.comparePassword(password);
    if (!match) return res.status(401).json({ message: 'Identifiants incorrects' });

    // Mettre à jour lastLogin
    admin.lastLogin = new Date();
    await admin.save({ validateBeforeSave: false });

    const token = jwt.sign(
      { id: admin._id, type: 'admin', isPrimary: admin.isPrimary, sessionVersion: admin.sessionVersion },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token, admin: admin.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /admin/register
 * Body: { email, password, secret, nom? }
 * Pas de middleware auth — protégé par le secret d'enregistrement
 */
exports.register = async (req, res) => {
  try {
    const { email, password, secret, nom } = req.body;

    if (!email || !password || !secret)
      return res.status(400).json({ message: 'Email, mot de passe et secret requis' });

    if (secret !== process.env.ADMIN_REGISTER_SECRET)
      return res.status(403).json({ message: 'Code secret incorrect' });

    const exists = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ message: 'Cet email est déjà utilisé' });

    // Le premier admin créé devient primaire automatiquement
    const count = await Admin.countDocuments();
    const admin = await Admin.create({
      email,
      password,
      nom: nom || email,
      isPrimary: count === 0,
    });

    res.status(201).json(admin.toSafeObject());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TEAM (gestion admins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/team
 * Retourne la liste de tous les admins
 */
exports.getTeam = async (req, res) => {
  try {
    const admins = await Admin.find().sort({ createdAt: 1 });
    res.json(admins.map(a => a.toSafeObject()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /admin/team/:id
 * Body: { nom?, email?, password?, isPrimary? }
 * Seul un primaire peut modifier isPrimary ou modifier un autre primaire
 */
exports.updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, email, password, isPrimary } = req.body;
    const me = req.admin;

    const target = await Admin.findById(id).select('+password');
    if (!target) return res.status(404).json({ message: 'Admin introuvable' });

    // Un non-primaire ne peut modifier que lui-même
    if (!me.isPrimary && me._id.toString() !== id)
      return res.status(403).json({ message: 'Accès refusé' });

    // Seul un primaire peut changer isPrimary
    if (isPrimary !== undefined && !me.isPrimary)
      return res.status(403).json({ message: 'Seul un admin primaire peut modifier ce champ' });

    if (nom  !== undefined) target.nom  = nom.trim();
    if (email !== undefined) target.email = email.toLowerCase().trim();
    if (password && password.trim()) target.password = password.trim(); // sera haché par le pre-save
    if (isPrimary !== undefined && me.isPrimary) target.isPrimary = isPrimary;

    await target.save();
    res.json(target.toSafeObject());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /admin/team/:id
 * Supprime un admin — réservé aux primaires, ne peut pas se supprimer soi-même
 */
exports.deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.admin;

    if (me._id.toString() === id)
      return res.status(400).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' });

    const target = await Admin.findById(id);
    if (!target) return res.status(404).json({ message: 'Admin introuvable' });

    if (target.isPrimary && !me.isPrimary)
      return res.status(403).json({ message: 'Seul un admin primaire peut supprimer un autre admin primaire' });

    await Admin.findByIdAndDelete(id);
    res.json({ message: `Admin "${target.nom}" supprimé` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /admin/team/:id/revoke
 * Révoque la session d'un admin (incrémente sessionVersion)
 */
exports.revokeSession = async (req, res) => {
  try {
    const { id } = req.params;

    const target = await Admin.findById(id).select('+sessionVersion');
    if (!target) return res.status(404).json({ message: 'Admin introuvable' });

    target.sessionVersion = (target.sessionVersion || 0) + 1;
    await target.save({ validateBeforeSave: false });

    res.json({ message: 'Session révoquée' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// USERS (gestion rôles)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/users
 * Retourne tous les utilisateurs (sans mot de passe)
 */
exports.getUsers = async (req, res) => {
  try {
    const { search, role, page = 1, limit = 200 } = req.query;

    const filter = {};
    if (role && role !== 'all') filter.role = role;
    if (search) {
      filter.$or = [
        { nom:   { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /admin/users/:id/role
 * Body: { role: 'user' | 'artist' | 'admin' }
 */
exports.updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const allowed = ['user', 'artist', 'admin'];
    if (!allowed.includes(role))
      return res.status(400).json({ message: `Rôle invalide. Valeurs possibles : ${allowed.join(', ')}` });

    const user = await User.findByIdAndUpdate(
      id,
      { role },
      { returnDocument: 'after', runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

