require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const compression = require('compression');
const http       = require('http');

const { createIndexes } = require('./models');
const { router: routes } = require('./routes');

const featureRoutes = require('./routes/featureRoutes');

// ── App ───────────────────────────────────────
const app = express();

const monetisationRoutes = require('./routes/monetisationRoutes');

const analyticsRoutes = require('./routes/analyticsRoutes');

const radioRoutes = require('./routes/radioRoutes');
const adminRoutes = require('./routes/adminRoutes');
const tsComments = require('./routes/timestampCommentRoutes');
const { startRoyaltiesCron } = require('./jobs/royaltiesCron');
const royaltiesRoutes        = require('./routes/royalties');

// ── CORS ──────────────────────────────────────
const cors = require('cors');

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Force le header pour Cloudflare/Render
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('X-Custom-Test', 'hello'); // ← test
  next();
});

app.use(compression({ level: 6, threshold: 1024 }));

// ── Cache-Control headers ─────────────────────
// Assets statiques (JS, CSS, images) — cache 1 an (Vite génère des noms hashés)
app.use((req, res, next) => {
  const url = req.url;
  // Fichiers avec hash dans le nom → immutables
  if (/\.(js|css|woff2?|ttf|eot)$/.test(url) && /[a-f0-9]{8}/.test(url)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  // Images statiques → cache 7 jours
  else if (/\.(png|jpg|jpeg|svg|ico|webp)$/.test(url)) {
    res.set('Cache-Control', 'public, max-age=604800');
  }
  // HTML → pas de cache (toujours la dernière version)
  else if (/\.html$/.test(url) || url === '/') {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});

app.use(express.json());

// ── MongoDB ───────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const { User } = require('./models');
  await User.updateMany({ banned: { $exists: false } }, { $set: { banned: false } });
  console.log('✅ MongoDB connecté');
  createIndexes();
  startRoyaltiesCron();
});

// ── Routes ────────────────────────────────────
app.post('/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res, next) => { req.rawBody = req.body; next(); }
);
app.use('/', monetisationRoutes);
app.use('/', routes);
app.use('/', featureRoutes);
app.use('/', analyticsRoutes);
app.use('/', radioRoutes);
app.use('/admin', adminRoutes);
app.use('/', tsComments);
app.use('/', royaltiesRoutes);


// ── Health check ──────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Error handler ─────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ message: err.message || 'Erreur serveur' });
});


// ══════════════════════════════════════════════
// HTTP + WebSocket server
// ══════════════════════════════════════════════
const PORT   = process.env.PORT || 5000;
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur sur le port ${PORT}`));

// ── WebSocket — auditeurs en temps réel ───────
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const wss = new WebSocketServer({ server, path: '/ws/listeners' });
const listeners = new Map();

// Dans server.js, ajoute temporairement
const https = require('https');
https.get('https://api.ipify.org', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('IP Render:', data));
});

setInterval(() => {
  listeners.forEach((v, k) => { if (v.ws.readyState !== 1) listeners.delete(k); });
}, 30_000);

function broadcast() {
  const users = [...listeners.values()].map(l => ({
    nom: l.nom, avatar: l.avatar, songId: l.songId,
    songTitle: l.songTitle, artiste: l.artiste, image: l.image,
  }));
  const payload = JSON.stringify({ type: 'listeners', users });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      let nom = 'Anonyme', avatar = null;
      try {
        const d = jwt.verify(msg.token, process.env.JWT_SECRET);
        nom    = d.nom || d.email || 'Utilisateur';
        avatar = d.avatar || null;
      } catch {}
      listeners.set(msg.token, { ws, nom, avatar, songId: msg.songId, songTitle: msg.songTitle, artiste: msg.artiste, image: msg.image, lastSeen: Date.now() });
      broadcast();
    }
    if (msg.type === 'leave')  { listeners.delete(msg.token); broadcast(); }
    if (msg.type === 'ping')   { const e = listeners.get(msg.token); if (e) e.lastSeen = Date.now(); ws.send(JSON.stringify({ type: 'pong' })); }
  });

  ws.on('close', () => { listeners.forEach((v, k) => { if (v.ws === ws) listeners.delete(k); }); broadcast(); });
  ws.on('error', () => ws.close());
});