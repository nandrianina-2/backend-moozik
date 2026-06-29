const multer      = require('multer');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Upload stream helper ──────────────────────
const toCloud = (buffer, opts) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(opts, (err, r) => err ? reject(err) : resolve(r))
      .end(buffer);
  });

// ── Delete helper ─────────────────────────────
const fromCloud = async (publicId, resourceType = 'image') => {
  if (!publicId) return;
  try { await cloudinary.uploader.destroy(publicId, { resource_type: resourceType }); }
  catch (e) { console.warn('Cloudinary destroy:', e.message); }
};

// ── Transformation presets ────────────────────
const IMG_TRANSFORM = [{ width: 400, height: 400, crop: 'fill', gravity: 'auto', quality: 70, fetch_format: 'auto' }];
const AVT_TRANSFORM = [{ width: 200, height: 200, crop: 'fill', quality: 75, fetch_format: 'auto' }];

// ── Multer (memory storage) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Type non supporté'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = { cloudinary, toCloud, fromCloud, IMG_TRANSFORM, AVT_TRANSFORM, upload };

