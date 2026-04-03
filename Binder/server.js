require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security: Helmet + CSP ────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://*.supabase.co',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.supabase.co',
          'https://api.dicebear.com',
        ],
        connectSrc: [
          "'self'",
          'https://*.supabase.co',
          'wss://*.supabase.co', // Realtime WebSocket
        ],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    permittedCrossDomainPolicies: false,
    crossOriginEmbedderPolicy: false, // allows Supabase CDN
  })
);

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET'],
    credentials: false,
  })
);

// ── Rate Limiting ─────────────────────────────────────────────
// Global: 200 req / 15min per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות. נסה שוב בעוד מספר דקות.' },
});
app.use(globalLimiter);

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── Remove X-Powered-By ──────────────────────────────────────
app.disable('x-powered-by');

// ── Static files ──────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        // HTML: no cache, always fresh
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.match(/\.(js|css)$/)) {
        // JS/CSS: 1 hour cache
        res.setHeader('Cache-Control', 'public, max-age=3600');
      } else {
        // Fonts, images: 1 week
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  })
);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
});

app.listen(PORT, () => {
  console.log(`🚀 Binder server: http://localhost:${PORT}`);
});
