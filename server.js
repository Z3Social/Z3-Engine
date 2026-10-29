import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { query } from './config/db.js';
import { xrpcRouter } from './routes/xrpc.js';
import { bridgeRouter } from './routes/bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3036;

// Resolve static distribution directory for Z3-UI
const Z3_DIST_DIR = [
  path.join(__dirname, '..', 'Z3-UI', 'static'),
  path.join(__dirname, '..', 'Z3-UI', 'dist'),
  path.join(__dirname, 'static'),
].find((p) => fs.existsSync(p)) || path.join(__dirname, '..', 'Z3-UI', 'static');

const MEDIA_DIR = [
  path.join(__dirname, '..', 'Media', 'Logo'),
  path.join(__dirname, '..', 'wixwebsiteclone', 'public', 'media'),
  path.join(__dirname, 'public', 'media'),
].find((p) => fs.existsSync(p)) || path.join(__dirname, 'public', 'media');

const app = express();
app.disable('x-powered-by');

// Body parsers mounted globally for all routes (XRPC, OAuth, Mastodon API)
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// Lightweight request logging
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Z3-Engine] ${req.method} ${req.url}`);
  }
  next();
});

// Universal Sovereign CORS Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static assets & Media
if (fs.existsSync(MEDIA_DIR)) {
  app.use('/media', express.static(MEDIA_DIR));
}
app.get('/favicon.png', (req, res) => {
  const logoPath = path.join(MEDIA_DIR, 'logo.png');
  if (fs.existsSync(logoPath)) return res.sendFile(logoPath);
  res.sendStatus(204);
});

// 1. XRPC Sovereign Router (/xrpc/:nsid)
app.use('/xrpc', xrpcRouter);

// 2. Frontend Contract Compatibility Router for Z3-UI
app.use(bridgeRouter);

// 3. Static SPA Hosting & Client Fallback
if (fs.existsSync(Z3_DIST_DIR)) {
  console.log(`[Z3-Engine] Serving Z3-UI SPA from: ${Z3_DIST_DIR}`);
  app.use(express.static(Z3_DIST_DIR, { index: false }));

  app.get('*', (req, res) => {
    // Return 404 for missing API/XRPC calls
    if (req.path.startsWith('/api') || req.path.startsWith('/xrpc')) {
      return res.status(404).json({ error: 'Endpoint not found.' });
    }
    const indexHtml = path.join(Z3_DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).send('Z3-UI index.html not found. Run yarn build in Z3-UI.');
    }
  });
}

// Global async error boundary
app.use((err, req, res, next) => {
  console.error('[Z3-Engine Uncaught Error]:', err);
  res.status(500).json({ error: 'InternalServerError', message: err.message });
});

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`       Z3-ENGINE: Sovereign Social Core            `);
  console.log(` Listening: http://localhost:${PORT}               `);
  console.log(` XRPC Root: http://localhost:${PORT}/xrpc/         `);
  console.log(` Memory at boot: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RAM`);
  console.log(`===================================================`);
});

export default app;
