// server.js – OAuth Drive upload + grant-access + Razorpay (optional)
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const cors = require('cors');
const Razorpay = require('razorpay');
const { Readable } = require('stream');

// ---------- ENV ----------
const {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,     // e.g. https://<your-vercel-app>.vercel.app/oauth2callback
  DRIVE_FOLDER_ID,        // The FOLDER ID you want to upload into
  TOKENS_B64,             // base64 of tokens.json (recommended)  OR
  TOKENS_JSON,            // raw JSON (multiline) – only if Vercel accepts it
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  CORS_ORIGIN,             // optional: e.g. https://your-frontend-domain.com
  BREVO_SMTP_HOST,
  BREVO_SMTP_PORT,
  BREVO_SMTP_USER,
  BREVO_SMTP_KEY,
  MAIL_FROM
} = process.env;

// ---------- APP ----------
const app = express();
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN } : undefined));
app.use(express.json());

app.get('/', (_req, res) => res.json({ ok: true, message: 'API up' }));

// ---------- Multer (in-memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- Razorpay (optional) ----------
let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}
app.post('/create-razorpay-order', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(400).json({ error: 'Razorpay not configured. Set RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET.' });
    }
    const { orderId, amount } = req.body;
    if (!orderId || !amount) return res.status(400).json({ error: 'orderId and amount are required' });

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: orderId,
      payment_capture: 1,
    });
    res.json(order);
  } catch (err) {
    console.error('Razorpay error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Failed to create Razorpay order' });
  }
});

// ---------- OAuth2 client ----------
function requireOAuthEnv() {
  const missing = [];
  if (!OAUTH_CLIENT_ID) missing.push('OAUTH_CLIENT_ID');
  if (!OAUTH_CLIENT_SECRET) missing.push('OAUTH_CLIENT_SECRET');
  if (!OAUTH_REDIRECT_URI) missing.push('OAUTH_REDIRECT_URI');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

requireOAuthEnv();
const oauth2Client = new google.auth.OAuth2(
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

// load tokens from env (prefer base64)
(function loadTokens() {
  try {
    let json = null;
    if (TOKENS_B64) {
      const raw = Buffer.from(TOKENS_B64, 'base64').toString('utf8');
      json = JSON.parse(raw);
    } else if (TOKENS_JSON) {
      json = JSON.parse(TOKENS_JSON);
    }
    if (json) oauth2Client.setCredentials(json);
  } catch (e) {
    console.warn('Could not parse tokens from env; /auth is required once.', e?.message || e);
  }
})();

const getDrive = () => google.drive({ version: 'v3', auth: oauth2Client });
const hasRefreshToken = () => !!(oauth2Client.credentials && oauth2Client.credentials.refresh_token);

async function ensureAuthed(res) {
  if (!hasRefreshToken()) {
    res.status(401).json({ error: 'Not authorized. Visit /auth to grant access.' });
    return false;
  }
  return true;
}

// ---------- Auth endpoints ----------
app.get('/auth', (_req, res) => {
  try {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive'],
    });
    res.redirect(url);
  } catch (e) {
    res.status(500).send(e?.message || 'Failed to init OAuth');
  }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // IMPORTANT: In serverless we can’t write files. Copy this JSON from logs and
    // store it in Vercel env (TOKENS_B64 or TOKENS_JSON).
    console.log('=== COPY THIS TOKENS JSON INTO VERCEL ENV (TOKENS_JSON or TOKENS_B64) ===');
    console.log(JSON.stringify(tokens, null, 2));

    res.send('Authorization successful! Copy tokens from logs → add to Vercel env → redeploy.');
  } catch (e) {
    console.error('OAuth callback error:', e?.response?.data || e?.message || e);
    res.status(500).send('OAuth error. Check logs.');
  }
});

app.get('/auth/status', (_req, res) => {
  res.json({ authorized: hasRefreshToken() });
});

// ---------- Resolve parent folder (follows shortcuts) ----------
async function resolveParentFolder(folderIdInput) {
  const drive = getDrive();
  const meta = await drive.files.get({
    fileId: folderIdInput,
    fields: 'id,name,mimeType,shortcutDetails',
    supportsAllDrives: true,
  });

  if (meta.data.shortcutDetails?.targetId) {
    const targetId = meta.data.shortcutDetails.targetId;
    const target = await drive.files.get({
      fileId: targetId,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });
    if (target.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('Shortcut target is not a folder');
    }
    return target.data.id;
  }
  if (meta.data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('Provided ID is not a folder');
  }
  return meta.data.id;
}

// ---------- Upload ----------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!(await ensureAuthed(res))) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!DRIVE_FOLDER_ID) return res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID' });

    const drive = getDrive();
    const parentId = await resolveParentFolder(DRIVE_FOLDER_ID);
    const fileName = req.body.desiredFileName || req.file.originalname;

    const createResp = await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });

    // Ensure webViewLink
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

// ---------- Grant access ----------
app.post('/grant-access', async (req, res) => {
  try {
    if (!(await ensureAuthed(res))) return;
    const { fileId, email } = req.body;
    if (!fileId || !email) return res.status(400).json({ error: 'fileId and email are required' });

    const drive = getDrive();
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'user', role: 'reader', emailAddress: email },
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
const nodemailer = require('nodemailer');

// Create a reusable SMTP transport (Brevo)
const mailer = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false, // TLS is auto-started on 587
  auth: {
    user: process.env.BREVO_SMTP_USER, // usually your Brevo login/email
    pass: process.env.BREVO_SMTP_KEY,  // the SMTP key from Brevo
  },
});

// POST /send-email
app.post('/send-email', async (req, res) => {
  try {
    const { to, template, vars } = req.body;
    if (!to || !template) {
      return res.status(400).json({ error: 'to and template are required' });
    }

    // Simple templates (mirror your WhatsApp ones)
    const subjects = {
      order_placed: 'Your order is placed',
      order_accepted: 'Your order was accepted',
      check_completion: 'Please confirm completion',
      admin_posted: 'Order posted',
    };

    const bodies = {
      order_placed: ({ name, orderId }) =>
        `Dear ${name || 'customer'}, your order ${orderId} is placed. Please wait for a writer to accept.`,
      order_accepted: ({ orderId, deadline }) =>
        `Yay! Order ${orderId} accepted. Please make payment before ${deadline} to confirm. Writing starts after payment.`,
      check_completion: ({ orderId, requestedAt }) =>
        `Your writer requested completion confirmation for order ${orderId} at ${requestedAt}. Please check your dashboard.`,
      admin_posted: ({ orderId, amount }) =>
        `Order ${orderId} has been posted. Please check website for receipt/ID. Amount: ₹${amount}.`,
    };

    const subject = subjects[template] || 'VWRITE update';
    const bodyMaker = bodies[template];
    const text = bodyMaker ? bodyMaker(vars || {}) : 'Hello from VWRITE.';

    const info = await mailer.sendMail({
      from: process.env.MAIL_FROM || 'VWRITE <noreply@yourdomain.com>',
      to,
      subject,
      text,
      // (optional) nice HTML version:
      html: `<p>${text.replace(/\n/g, '<br/>')}</p>`,
    });

    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error('send-email error:', e?.message || e);
    res.status(500).json({ error: e?.message || 'send failed' });
  }
});

// ---------- Export for Vercel / or start locally ----------
if (process.env.VERCEL) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
}
