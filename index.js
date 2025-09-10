// server.js — Keep old grant-access & Razorpay; new OAuth2 upload into My Drive

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const Razorpay = require('razorpay');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, 'tokens.json');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());                 // you can lock this down later to specific origins
app.use(express.json());
app.use((req, _res, next) => {
  next();
});

// Health
app.get('/', (_req, res) => res.json({ ok: true, message: 'API up' }));

// ── Multer (in-memory) ───────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ── Razorpay (unchanged) ─────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'your_fallback_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'your_fallback_key_secret',
});

app.post('/create-razorpay-order', async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    if (!orderId || !amount) {
      return res.status(400).json({ error: 'orderId and amount are required' });
    }

    const options = { amount, currency: 'INR', receipt: orderId, payment_capture: 1 };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Razorpay order creation error:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to create Razorpay order' });
  }
});

// ── OAuth2 client (FULL Drive scope) ─────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

// Load saved tokens if present
if (fs.existsSync(TOKENS_PATH)) {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
  } catch (e) {
    console.warn('Could not parse tokens.json; will require /auth again');
  }
}

const getDrive = () => google.drive({ version: 'v3', auth: oauth2Client });
const hasRefreshToken = () => !!(oauth2Client.credentials && oauth2Client.credentials.refresh_token);

async function ensureAuthed(res) {
  if (!hasRefreshToken()) {
    res.status(401).json({ error: 'Not authorized. Visit /auth in your browser to grant access.' });
    return false;
  }
  return true;
}

// Start OAuth flow (FULL scope so we can see existing folders)
app.get('/auth', (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',                    // ensures a refresh token on first approval
    scope: ['https://www.googleapis.com/auth/drive'], // FULL DRIVE scope
  });
  res.redirect(url);
});

// OAuth2 callback
app.get('/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    res.send('Authorization successful! You can close this tab and try the upload again.');
  } catch (e) {
    console.error('OAuth callback error:', e?.response?.data || e?.message || e);
    res.status(500).send('OAuth error. Check server logs.');
  }
});

// Quick auth status
app.get('/auth/status', (_req, res) => {
  res.json({ authorized: hasRefreshToken() });
});

// ── Helper: resolve a folder (follows shortcuts; works for My Drive) ─────────
async function resolveParentFolder(folderIdInput) {
  const drive = getDrive();
  let meta;
  try {
    meta = await drive.files.get({
      fileId: folderIdInput,
      fields: 'id,name,mimeType,shortcutDetails',
      supportsAllDrives: true,
    });
  } catch (e) {
    console.error('Drive get (parent) failed:', e?.response?.data || e?.message || e);
    throw new Error(`File not found or no permission for folder ID: ${folderIdInput}`);
  }

  if (meta.data.shortcutDetails?.targetId) {
    const targetId = meta.data.shortcutDetails.targetId;
    try {
      const target = await drive.files.get({
        fileId: targetId,
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      });
      if (target.data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error('Shortcut target is not a folder');
      }
      return target.data.id;
    } catch (e) {
      console.error('Drive get (shortcut target) failed:', e?.response?.data || e?.message || e);
      throw new Error(`Shortcut target not accessible for ID: ${targetId}`);
    }
  }

  if (meta.data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('Provided ID is not a folder');
  }

  return meta.data.id;
}

// Debug: verify folder visibility
app.get('/debug/parent/:id', async (req, res) => {
  try {
    if (!(await ensureAuthed(res))) return;
    const id = await resolveParentFolder(req.params.id);
    res.json({ ok: true, resolvedId: id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── NEW: Upload to Google Drive using OAuth2 (replaces old service-account upload) ──
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!(await ensureAuthed(res))) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!DRIVE_FOLDER_ID) return res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID' });

    const drive = getDrive();
    const parentId = await resolveParentFolder(DRIVE_FOLDER_ID);
    const fileName = req.body.desiredFileName || req.file.originalname;


    const fileMetadata = { name: fileName, parents: [parentId] };
    const media = { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) };

    const createResp = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    // (Optional) re-fetch metadata to ensure webViewLink exists
    const meta = await drive.files.get({
      fileId: createResp.data.id,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    res.json({
      id: meta.data.id,
      name: meta.data.name,
      webViewLink: meta.data.webViewLink || `https://drive.google.com/file/d/${meta.data.id}/view`,
    });
  } catch (error) {
    console.error('Upload error:', error?.response?.data || error?.errors || error?.message || error);
    res.status(500).json({
      error: (error?.response?.data?.error?.message) || error?.message || 'Upload failed',
    });
  }
});

// ── OLD behavior kept: Grant access endpoint (works with OAuth auth) ──────────
app.post('/grant-access', async (req, res) => {
  try {
    if (!(await ensureAuthed(res))) return;
    const { fileId, email } = req.body;
    if (!fileId || !email) {
      return res.status(400).json({ error: 'fileId and email are required' });
    }

    const drive = getDrive();
    const permission = { type: 'user', role: 'reader', emailAddress: email };

    const permissionResponse = await drive.permissions.create({
      fileId,
      requestBody: permission,
      fields: 'id',
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });

    res.json({ success: true, message: `Access granted to ${email}` });
  } catch (error) {
    console.error('Grant access error:', error?.response?.data || error?.errors || error?.message || error);
    res.status(500).json({
      error: (error?.response?.data?.error?.message) || error?.message || 'Grant access failed',
    });
  }
});

// ── Start (local) or export (serverless) ──────────────────────────────────────
if (process.env.VERCEL) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {

  });
}
