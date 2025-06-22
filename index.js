const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const Razorpay = require('razorpay');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Load environment variables from .env file (if local)
require('dotenv').config();

// Google Drive service account JSON
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');

console.log('Starting server with service account:', SERVICE_ACCOUNT_PATH);

// Initialize Google Drive API client
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

// Initialize Razorpay client with keys from environment variables
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

// Google Drive Upload Endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Received /upload request');
  try {
    if (!req.file) {
      console.warn('No file uploaded in /upload');
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const fileName = req.body.desiredFileName || req.file.originalname;
    console.log('Uploading file:', fileName);

    const fileMetadata = {
      name: fileName,
      parents: ['1dvJc1L-3_Ws74EISHdpUnfk0gBJqSCgv'], // your Google Drive folder ID
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

    console.log('File uploaded to Google Drive:', response.data);

    fs.unlinkSync(req.file.path);
    console.log('Temporary file deleted:', req.file.path);

    res.json({
      id: response.data.id,
      name: response.data.name,
      webViewLink:
        response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`,
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
        console.log('Temporary file deleted after error:', req.file.path);
      } catch (err) {
        console.error('Error deleting temp file:', err);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

// Google Drive Grant Access Endpoint
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
    });

    console.log(`Granted access to ${email} on file ${fileId}`, permissionResponse.data);

    res.json({ success: true, message: `Access granted to ${email}` });
  } catch (error) {
    console.error('Grant access error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Razorpay Create Order Endpoint
app.post('/create-razorpay-order', async (req, res) => {
  console.log('Received /create-razorpay-order request:', req.body);
  try {
    const { orderId, amount } = req.body;

    if (!orderId || !amount) {
      console.warn('Missing orderId or amount in /create-razorpay-order');
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
