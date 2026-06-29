const router  = require('express').Router();
const auth    = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const song  = require('../controllers/songController');
const ac    = require('../controllers/authController');
const admin = require('../controllers/adminController');
const featureRoutes = require('./featureRoutes');

const monetisationModels = require('../models/monetisationModels');

const sessionRoutes = require('./sessionRoutes');

router.use('/', featureRoutes);

// ══════════════════════════════════════════════
// SONGS
// ══════════════════════════════════════════════
router.get('/songs/favorites', auth.requireAuth,         song.getFavorites);
router.get('/songs/meta',                                song.getMeta);
router.get('/songs',           auth.optionalAuth,        song.listSongs);
router.post('/upload',         auth.requireAdminOrArtist, upload.fields([{ name:'audio', maxCount:1 },{ name:'image', maxCount:1 }]), song.upload);
router.put('/songs/reorder',   auth.requireAdmin,        song.reorder);
router.put('/songs/:id',       auth.requireAdminOrArtist, upload.single('image'), song.updateSong);
router.put('/songs/:id/like',  auth.requireAuth,         song.toggleLike);
router.put('/songs/:id/play',  song.registerPlay);
router.delete('/songs/:id',    auth.requireAdminOrArtist, song.deleteSong);
router.get('/songs/:id/similar', song.similar);

// Comments
router.get('/songs/:id/comments',              auth.optionalAuth,  admin.getComments);
router.post('/songs/:id/comments',             auth.requireAuth,   admin.addComment);
router.put('/songs/:sid/comments/:cid/like',   auth.requireAuth,   admin.likeComment);
router.post('/songs/:sid/comments/:cid/reply', auth.requireAuth,   admin.replyComment);
router.delete('/songs/:sid/comments/:cid',     auth.requireAuth,   admin.deleteComment);

// Reactions
router.get('/songs/:id/reactions',  auth.optionalAuth, admin.getReactions);
router.post('/songs/:id/reactions', auth.requireAuth,  admin.addReaction);

// Share
router.post('/songs/:id/share',  song.createShare);
router.get('/share/:token',      song.resolveShare);
router.put('/share/:token/play', song.trackSharePlay);
router.get('/my-shares',         auth.requireAuth, song.myShares);

// Search
router.get('/search',        song.search);
router.get('/search/global', song.globalSearch);

// ══════════════════════════════════════════════
// ADMIN AUTH + MANAGEMENT
// ══════════════════════════════════════════════
router.post('/admin/register',  ac.adminRegister);
router.post('/admin/login',     ac.adminLogin);
router.get('/admin/verify',     auth.requireAdmin, ac.adminVerify);
router.put('/admin/profile',    auth.requireAdmin, ac.adminUpdateProfile);
router.put('/admin/password',   auth.requireAdmin, ac.adminChangePassword);
router.get('/admin/admins',     auth.requireAdmin, ac.listAdmins);
router.post('/admin/admins',    auth.requireAdmin, ac.createAdmin);
router.put('/admin/admins/:id', auth.requireAdmin, ac.updateAdmin);
router.delete('/admin/admins/:id', auth.requireAdmin, ac.deleteAdmin);
router.use('/sessions', sessionRoutes);

// Admin stats
router.get('/admin/stats',                  auth.requireAdmin, admin.getStats);
router.get('/admin/stats/plays-history',    auth.requireAdmin, admin.getPlaysHistory);
router.get('/admin/stats/top-songs',        auth.requireAdmin, admin.getTopSongs);
router.get('/admin/stats/top-artists',      auth.requireAdmin, admin.getTopArtists);
router.get('/admin/stats/users-growth',     auth.requireAdmin, admin.getUsersGrowth);
router.get('/admin/active-users',           auth.requireAdmin, admin.getActiveUsers);
router.get('/admin/unassigned-songs',       auth.requireAdmin, admin.getUnassignedSongs);
router.get('/admin/songs',                  auth.requireAdmin, admin.listAdminSongs);
router.get('/admin/albums',                 auth.requireAdmin, admin.listAdminAlbums);
router.get('/admin/shares',                 auth.requireAdmin, admin.getAdminShares);
router.post('/admin/broadcast', auth.requireAdmin, admin.broadcastNewsletter);

// Admin users
router.get('/admin/users',          auth.requireAdmin, admin.listUsers);
router.get('/admin/users/:id/stats',auth.requireAdmin, admin.getUserStats);
router.put('/admin/users/:id',      auth.requireAdmin, admin.updateUserAdmin);
router.delete('/admin/users/:id',   auth.requireAdmin, admin.deleteUser);
router.put('/admin/users/:id/ban',   auth.requireAdmin, admin.banUser);  // ← ajouter

// ══════════════════════════════════════════════
// USER AUTH
// ══════════════════════════════════════════════
router.post('/users/register',       ac.userRegister);
router.post('/users/login',          ac.userLogin);
router.get('/users/verify',          auth.requireAuth, ac.userVerify);
router.post('/users/forgot-password', ac.forgotPassword);
router.post('/users/reset-password',  ac.resetPassword);
router.get('/users/verify-email', ac.verifyEmail);
router.delete('/users/:id', auth.requireAuth, ac.deleteUser);
router.put('/users/:id',             auth.requireAuth, upload.single('avatar'), ac.updateUser);
router.put('/users/:id/password',    auth.requireAuth, ac.changeUserPassword);
router.get('/users/:id/profile',     ac.publicProfile);
router.get('/users/:id/playlists',   ac.publicPlaylists);
router.get('/users/:id/favorites',   ac.publicFavorites);


// ══════════════════════════════════════════════
// ARTIST AUTH
// ══════════════════════════════════════════════
router.post('/artists/login',          ac.artistLogin);
router.get('/artists/verify',          auth.requireArtist, ac.artistVerify);
router.get('/artists',                 ac.listArtists);
router.get('/artists/:id',             ac.getArtist);
router.post('/artists',                auth.requireAdmin, upload.single('image'), ac.createArtist);
router.put('/artists/me',              auth.requireArtist, upload.single('image'), ac.updateArtistMe);
router.put('/artists/:id',             auth.requireAdminOrArtist, upload.single('image'), ac.updateArtist);
router.put('/artists/:id/password',    auth.requireArtist, ac.changeArtistPassword);
router.delete('/artists/:id',          auth.requireAdmin, ac.deleteArtist);

// ══════════════════════════════════════════════
// ALBUMS
// ══════════════════════════════════════════════
const albumCtrl = require('../controllers/albumController');
router.post('/albums',                  auth.requireAdminOrArtist, upload.single('image'), albumCtrl.create);
router.get('/albums',                   albumCtrl.list);
router.get('/albums/:id',               albumCtrl.get);
router.put('/albums/:id',               auth.requireAdminOrArtist, upload.single('image'), albumCtrl.update);
router.delete('/albums/:id',            auth.requireAdminOrArtist, albumCtrl.remove);
router.post('/albums/:id/add/:songId',  auth.requireAdminOrArtist, albumCtrl.addSong);
router.delete('/albums/:id/remove/:songId', auth.requireAdminOrArtist, albumCtrl.removeSong);

// ══════════════════════════════════════════════
// PLAYLISTS (admin)
// ══════════════════════════════════════════════
const plCtrl = require('../controllers/playlistController');
router.get('/playlists',                       plCtrl.list);
router.post('/playlists',                      auth.requireAdmin, plCtrl.create);
router.delete('/playlists/:id',                auth.requireAdmin, plCtrl.remove);
router.post('/playlists/:pid/add/:sid',        auth.requireAdmin, plCtrl.addSong);
router.delete('/playlists/:pid/remove/:sid',   auth.requireAdmin, plCtrl.removeSong);

// ── User playlists ────────────────────────────
router.post('/user-playlists',                     auth.requireAuth, plCtrl.createUser);
router.get('/user-playlists/mine',                 auth.requireAuth, plCtrl.listMine);
router.get('/user-playlists/public',               plCtrl.listPublic);
router.get('/user-playlists/:id',                  auth.optionalAuth, plCtrl.getOne);
router.post('/user-playlists/:id/add/:sid',        auth.requireAuth, plCtrl.addSongUser);
router.delete('/user-playlists/:id/remove/:sid',   auth.requireAuth, plCtrl.removeSongUser);
router.put('/user-playlists/:id/visibility',       auth.requireAuth, plCtrl.toggleVisibility);
router.delete('/user-playlists/:id',               auth.requireAuth, plCtrl.removeUser);

// ══════════════════════════════════════════════
// HISTORY + RECOMMENDATIONS + NOTIFICATIONS
// ══════════════════════════════════════════════
router.get('/history',       auth.requireAuth, admin.getHistory);
router.get('/history/stats', auth.requireAuth, admin.getHistoryStats);
router.delete('/history',    auth.requireAuth, admin.clearHistory);
router.get('/recommendations', auth.requireAuth, admin.getRecommendations);
router.get('/notifications/unread-count', auth.requireAuth, admin.getUnreadCount);
router.get('/notifications',              auth.requireAuth, admin.getNotifications);
router.put('/notifications/read-all',     auth.requireAuth, admin.markAllRead);
router.put('/notifications/:id/read',     auth.requireAuth, admin.markOneRead);
router.delete('/notifications/clear',     auth.requireAuth, admin.clearNotifications);


module.exports = {router, monetisationModels};

