// routes/sessionRoutes.js
const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/sessionController');

router.get    ('/',              requireAuth,  ctrl.listSessions);
router.delete ('/logout',        requireAuth,  ctrl.logout);
router.delete ('/all-others',    requireAuth,  ctrl.revokeAllOther);
router.delete ('/history',       requireAuth,  ctrl.clearHistory);
router.delete ('/:id',           requireAuth,  ctrl.revokeSession);

// Admin
router.get    ('/admin/:userId', requireAdmin, ctrl.adminListUserSessions);
router.delete ('/admin/:userId', requireAdmin, ctrl.adminRevokeUserSessions);

module.exports = router;