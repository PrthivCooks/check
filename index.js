const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');
const path = require('path');
const Razorpay = require('razorpay');

// Load environment variables from .env file if running locally
require('dotenv').config();

const app = express();

// Use multer memory storage (no disk writes)
const storage = multer.memoryStorage();
const upload = multer({ storage });

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');
console.log('Starting server with service account:', SERVICE_ACCOUNT_PATH);

// Initialize Google Drive API client
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

// Initialize Razorpay client with keys from environment variables (fallback keys)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'your_fallback_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'your_fallback_key_secret',
});

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// === Google Drive Upload Endpoint ===
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const fileName = req.body.desiredFileName || req.file.originalname;

    const fileMetadata = {
      name: fileName,
      parents: ['1dvJc1L-3_Ws74EISHdpUnfk0gBJqSCgv'], // Replace with your folder ID
    };

    // Convert buffer to stream for google drive API
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const media = {
      mimeType: req.file.mimetype,
      body: bufferStream,
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, webViewLink',
    });

    console.log('File uploaded to Google Drive:', response.data);

    res.json({
      id: response.data.id,
      name: response.data.name,
      webViewLink:
        response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Google Drive Grant Access Endpoint ===
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

    const permissionResponse = await drive.permissions.create({
      fileId,
      requestBody: permission,
      fields: 'id',
    });

    console.log(`Granted access to ${email} on file ${fileId}`, permissionResponse.data);

    res.json({ success: true, message: `Access granted to ${email}` });
  } catch (error) {
    console.error('Grant access error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Razorpay Create Order Endpoint ===
app.post('/create-razorpay-order', async (req, res) => {
  try {
    const { orderId, amount } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: 'orderId and amount are required' });
    }

    const options = {
      amount, // amount in paise (INR)
      currency: 'INR',
      receipt: orderId,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', order);

    res.json(order);
  } catch (error) {
    console.error('Razorpay order creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
