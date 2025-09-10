// server.js — Works with My Drive folder (no Shared Drive required)

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const Razorpay = require('razorpay');
const path = require('path');
const { Readable } = require('stream');

// ───────────────────────────────────────────────────────────────────────────────
// ⇩⇩ FILL THESE ⇩⇩
const DRIVE_FOLDER_ID = 'YOUR_MYDRIVE_FOLDER_ID_HERE'; // <— put your real folder id
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json'); // or an absolute path
// ⇧⇧ FILL THESE ⇧⇧
// ───────────────────────────────────────────────────────────────────────────────

const app = express();

// In-memory upload (works on Vercel/Netlify; no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap
});

// Basic middleware
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check
app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'API up' });
});

// ───────────────────────────────────────────────────────────────────────────────
// Google Drive auth (FULL scope so SA can read shared My Drive folders)
console.log('Using service account key file:', SERVICE_ACCOUNT_PATH);

const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: ['https://www.googleapis.com/auth/drive'], // full scope (not drive.file)
});

const drive = google.drive({ version: 'v3', auth });

// Helper: resolve a parent folder ID (works for My Drive and Shared Drive)
async function resolveParentFolder(folderIdInput) {
  let meta;
  try {
    meta = await drive.files.get({
      fileId: folderIdInput,
      fields: 'id,name,mimeType,shortcutDetails',
      supportsAllDrives: true, // harmless for My Drive
    });
  } catch (e) {
    console.error('Drive get (parent folder) failed:', e?.response?.data || e?.message || e);
    throw new Error(`File not found or no permission for folder ID: ${folderIdInput}`);
  }

  // Follow shortcut if needed
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

// ───────────────────────────────────────────────────────────────────────────────
// === Upload to Google Drive (My Drive folder) ===
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Received /upload request');

  try {
    if (!req.file) {
      console.warn('No file uploaded in /upload');
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    if (!DRIVE_FOLDER_ID) {
      return res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID in server.js' });
    }

    const parentId = await resolveParentFolder(DRIVE_FOLDER_ID);
    const fileName = req.body.desiredFileName || req.file.originalname;

    console.log('Uploading file:', fileName, 'to parent:', parentId);

    const fileMetadata = {
      name: fileName,
      parents: [parentId],
    };

    const media = {
      mimeType: req.file.mimetype,
      body: Readable.from(req.file.buffer),
    };

    const createResp = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    // Sometimes webViewLink is only populated after a get
    const meta = await drive.files.get({
      fileId: createResp.data.id,
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    console.log('File uploaded:', meta.data);

    return res.json({
      id: meta.data.id,
      name: meta.data.name,
      webViewLink:
        meta.data.webViewLink ||
        `https://drive.google.com/file/d/${meta.data.id}/view`,
    });
  } catch (error) {
    console.error('Upload error:', error?.response?.data || error?.errors || error?.message || error);
    return res.status(500).json({
      error:
        (error?.response?.data?.error?.message) ||
        error?.message ||
        'Upload failed',
    });
  }
});

// === Grant read access to a user (email) ===
app.post('/grant-access', async (req, res) => {
  console.log('Received /grant-access request with body:', req.body);
  try {
    const { fileId, email } = req.body;
    if (!fileId || !email) {
      console.warn('Missing fileId or email in /grant-access');
      return res.status(400).json({ error: 'fileId and email are required' });
    }

    const permission = {
      type: 'user',
      role: 'reader',
      emailAddress: email,
    };

    const permissionResponse = await drive.permissions.create({
      fileId,
      requestBody: permission,
      fields: 'id',
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });

    console.log(`Granted access to ${email} on file ${fileId}`, permissionResponse.data);
    return res.json({ success: true, message: `Access granted to ${email}` });
  } catch (error) {
    console.error('Grant access error:', error?.response?.data || error?.errors || error?.message || error);
    return res.status(500).json({
      error:
        (error?.response?.data?.error?.message) ||
        error?.message ||
        'Grant access failed',
    });
  }
});

// === Debug: verify the server can see/resolve the folder ===
app.get('/debug/parent/:id', async (req, res) => {
  try {
    const id = await resolveParentFolder(req.params.id);
    res.json({ ok: true, resolvedId: id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Razorpay (leave your own keys here or keep placeholders)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'your_fallback_key_id', 
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'your_fallback_key_secret',
});

app.post('/create-razorpay-order', async (req, res) => {
  console.log('Received /create-razorpay-order request:', req.body);
  try {
    const { orderId, amount } = req.body;
    if (!orderId || !amount) {
      console.warn('Missing orderId or amount in /create-razorpay-order');
      return res.status(400).json({ error: 'orderId and amount are required' });
    }

    const options = {
      amount, // in paise
      currency: 'INR',
      receipt: orderId,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', order);
    return res.json(order);
  } catch (error) {
    console.error('Razorpay order creation error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to create Razorpay order' });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Export for serverless or start locally
if (process.env.VERCEL) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Debug parent check: http://localhost:${PORT}/debug/parent/${DRIVE_FOLDER_ID}`);
  });
}
