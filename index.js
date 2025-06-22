const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: '/tmp/' }); // ✅ Only /tmp is writable in Vercel

// === Use credentials from environment variable ===
let credentials;
try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable.");
  }
  credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err);
  throw err;
}

// === Initialize Google Drive client ===
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

app.use(cors());
app.use(express.json());

// === Upload Endpoint ===
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const fileName = req.body.desiredFileName || req.file.originalname;

    const fileMetadata = {
      name: fileName,
      parents: ['1dvJc1L-3_Ws74EISHdpUnfk0gBJqSCgv'], // 🔁 Your Drive folder ID
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, webViewLink',
    });

    // ✅ Clean up temp file
    fs.unlinkSync(req.file.path);

    res.json({
      id: response.data.id,
      name: response.data.name,
      webViewLink:
        response.data.webViewLink ||
        `https://drive.google.com/file/d/${response.data.id}/view`,
    });
  } catch (error) {
    console.error('Upload error:', error);

    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {
        console.error('Error deleting temp file:', err);
      }
    }

    res.status(500).json({ error: error.message });
  }
});

// === Grant Access Endpoint ===
app.post('/grant-access', async (req, res) => {
  try {
    const { fileId, email } = req.body;

    if (!fileId || !email) {
      return res.status(400).json({ error: 'fileId and email are required' });
    }

    const permission = {
      type: 'user',
      role: 'reader',
      emailAddress: email,
    };

    await drive.permissions.create({
      fileId,
      requestBody: permission,
      fields: 'id',
    });

    res.json({ success: true, message: `Access granted to ${email}` });
  } catch (error) {
    console.error('Grant access error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Export as Vercel Serverless Function ===
module.exports = app;
