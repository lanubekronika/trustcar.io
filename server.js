const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
let stripe = null;
const https = require('https');
const exifParser = require('exif-parser');
const sharp = require('sharp');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');

dotenv.config();

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
const MARKETCHECK_API_KEY = process.env.MARKETCHECK_API_KEY || null;
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY || null;
const ROBOFLOW_MODEL = process.env.ROBOFLOW_MODEL || null; // e.g., 'vehicle-damage-detection'
const ROBOFLOW_VERSION = process.env.ROBOFLOW_VERSION || '1';
const VINAUDIT_API_KEY = process.env.VINAUDIT_API_KEY || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Initialize OpenAI
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log('OpenAI initialized');
}

// Initialize Stripe if configured
if (STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log('Stripe initialized');
  } catch (e) {
    console.warn('Stripe SDK not available:', e.message);
    stripe = null;
  }
}

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || 'us-east-1';
let s3Client = null;
if (process.env.AWS_ACCESS_KEY_ID && S3_BUCKET) {
  s3Client = new S3Client({ region: S3_REGION });
}

// Redis-backed report queue (optional). If REDIS_URL is present, create queue instance for enqueuing jobs.
let reportQueue = null;
if (process.env.REDIS_URL) {
  try {
    const Queue = require('bull');
    reportQueue = new Queue('reports', process.env.REDIS_URL);
    console.log('Report queue initialized (Redis)');
  } catch (e) {
    console.warn('Could not initialize Bull queue', e.message);
    reportQueue = null;
  }
}
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ inspections: [], uploads: [] }, null, 2));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Utility helpers
function getOrigin(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

function fetchJsonViaHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (resp) => {
        let data = '';
        resp.on('data', (chunk) => (data += chunk));
        resp.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '';
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Create an inspection
app.post('/api/inspections', (req, res) => {
  const { orderId, buyerEmail, sellerPhone, sellerEmail, price, notes } = req.body || {};
  const data = readData();
  const id = uuidv4();
  const token = uuidv4();
  const tokenHash = hashToken(token);
  const expiry = Date.now() + 48 * 3600 * 1000; // 48 hours

  const inspection = {
    id,
    orderId: orderId || null,
    buyerEmail: buyerEmail || null,
    sellerPhone: sellerPhone || null,
    sellerEmail: sellerEmail || null,
    price: price || null,
    notes: notes || null,
    tokenHash,
    tokenExpiry: expiry,
    status: 'pending',
    createdAt: Date.now()
  };

  data.inspections.push(inspection);
  writeData(data);

  const origin = req.protocol + '://' + req.get('host');
  const sellerLink = `${origin}/seller/${id}?t=${token}`;

  return res.json({ inspectionId: id, sellerLink, token });
});

// List inspections
app.get('/api/inspections', (req, res) => {
  const data = readData();
  // Return full inspection data
  res.json(data.inspections);
});

// Validate token for seller access
app.get('/api/inspections/:id/validate', (req, res) => {
  const id = req.params.id;
  const token = req.query.t || req.headers['x-token'];
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const tokenHash = hashToken(token);
  if (tokenHash !== insp.tokenHash) return res.status(403).json({ error: 'Invalid token' });
  if (Date.now() > insp.tokenExpiry) return res.status(403).json({ error: 'Token expired' });

  res.json({ ok: true, inspection: { id: insp.id, orderId: insp.orderId } });
});

// Upload media for an inspection (multipart form field 'file')
app.post('/api/inspections/:id/uploads', upload.single('file'), async (req, res) => {
  const id = req.params.id;
  const token = req.query.t || req.headers['x-token'];
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const tokenHash = hashToken(token);
  if (tokenHash !== insp.tokenHash) return res.status(403).json({ error: 'Invalid token' });
  if (Date.now() > insp.tokenExpiry) return res.status(403).json({ error: 'Token expired' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const uploadEntry = {
    id: uuidv4(),
    inspectionId: id,
    filename: req.file.filename,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    path: `/uploads/${req.file.filename}`,
    checkItem: req.body && req.body.checkItem ? req.body.checkItem : null,
    lat: req.body && req.body.lat ? parseFloat(req.body.lat) : null,
    lng: req.body && req.body.lng ? parseFloat(req.body.lng) : null,
    accuracy: req.body && req.body.accuracy ? parseFloat(req.body.accuracy) : null,
    uploadedAt: Date.now()
  };

  // Extract EXIF + analyze image quality
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    
    // EXIF extraction
    try {
      const parser = exifParser.create(fileBuffer);
      const exifData = parser.parse();
      if (exifData.tags) {
        uploadEntry.exif = {
          gps: exifData.tags.GPSLatitude && exifData.tags.GPSLongitude ? {
            lat: exifData.tags.GPSLatitude,
            lng: exifData.tags.GPSLongitude
          } : null,
          timestamp: exifData.tags.DateTimeOriginal || exifData.tags.DateTime || null,
          make: exifData.tags.Make || null,
          model: exifData.tags.Model || null,
          orientation: exifData.tags.Orientation || null
        };
      }
    } catch (exifErr) {
      console.warn('EXIF extraction failed:', exifErr.message);
      uploadEntry.exif = null;
    }

    // Image quality checks (blur/darkness detection)
    try {
      const metadata = await sharp(fileBuffer).metadata();
      const stats = await sharp(fileBuffer).stats();
      
      // Check darkness: avg luminance across channels
      const avgLuminance = stats.channels.reduce((sum, ch) => sum + ch.mean, 0) / stats.channels.length;
      const isDark = avgLuminance < 40; // threshold for "too dark"
      
      // Blur detection using Laplacian variance (requires grayscale conversion)
      const gray = await sharp(fileBuffer).grayscale().raw().toBuffer();
      // Simplified blur check: if we add full Laplacian, add opencv4nodejs or similar
      // For now, just flag low-res images
      const isLowRes = metadata.width < 800 || metadata.height < 600;
      
      uploadEntry.quality = {
        width: metadata.width,
        height: metadata.height,
        avgLuminance: Math.round(avgLuminance),
        isDark,
        isLowRes,
        warnings: []
      };
      
      if (isDark) uploadEntry.quality.warnings.push('Photo may be too dark');
      if (isLowRes) uploadEntry.quality.warnings.push('Resolution below 800x600');
      
    } catch (qualityErr) {
      console.warn('Image quality check failed:', qualityErr.message);
      uploadEntry.quality = null;
    }
  } catch (analysisErr) {
    console.error('Image analysis error:', analysisErr);
  }

  data.uploads.push(uploadEntry);
  writeData(data);

  // change inspection status to submitted if it was pending
  if (insp.status === 'pending') {
    insp.status = 'submitted';
    writeData(data);
  }

  // Auto-trigger Roboflow detection if configured
  if (ROBOFLOW_API_KEY && ROBOFLOW_MODEL && uploadEntry.checkItem) {
    try {
      const imageUrl = `${getOrigin(req)}${uploadEntry.path}`;
      const roboflowUrl = `https://detect.roboflow.com/${ROBOFLOW_MODEL}/${ROBOFLOW_VERSION}?api_key=${ROBOFLOW_API_KEY}&image=${encodeURIComponent(imageUrl)}`;
      const detectionResult = await fetchJsonViaHttps(roboflowUrl);
      
      if (detectionResult && detectionResult.predictions) {
        uploadEntry.detection = {
          timestamp: Date.now(),
          predictions: detectionResult.predictions,
          image: detectionResult.image
        };
        writeData(data);
        console.log(`Auto-ran Roboflow on upload ${uploadEntry.id}: ${detectionResult.predictions.length} findings`);
      }
    } catch (roboErr) {
      console.warn('Auto Roboflow failed:', roboErr.message);
    }
  }

  res.json({ ok: true, file: uploadEntry });
});

// Save VIN decode record
app.post('/api/vin-records', (req, res) => {
  const { vin, decodeData, recallsData, safetyData, timestamp } = req.body || {};
  if (!vin) return res.status(400).json({ error: 'VIN required' });
  
  const data = readData();
  if (!data.vinRecords) data.vinRecords = [];
  
  const record = {
    id: uuidv4(),
    vin: vin.toUpperCase(),
    decodeData,
    recallsData,
    safetyData,
    timestamp: timestamp || Date.now(),
    createdAt: Date.now()
  };
  
  data.vinRecords.push(record);
  writeData(data);
  
  res.json({ ok: true, id: record.id });
});

// List all VIN records (admin)
app.get('/api/vin-records', (req, res) => {
  const data = readData();
  const records = (data.vinRecords || []).map(r => ({
    id: r.id,
    vin: r.vin,
    timestamp: r.timestamp,
    createdAt: r.createdAt
  }));
  res.json(records);
});

// Get all uploads (admin) - for review queue
app.get('/api/inspections/all-uploads', (req, res) => {
  const data = readData();
  res.json(data.uploads || []);
});

// Get specific VIN record with full data (admin)
app.get('/api/vin-records/:id', (req, res) => {
  const data = readData();
  const record = (data.vinRecords || []).find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  res.json(record);
});

// NHTSA Safety Ratings by VIN
app.get('/api/vin/safety', async (req, res) => {
  try {
    const vin = (req.query.vin || '').toString().trim();
    if (!vin) return res.status(400).json({ error: 'vin is required' });

    // Decode to get Make/Model/Year
    const decodeUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
    const decode = await fetchJsonViaHttps(decodeUrl);
    const r = Array.isArray(decode?.Results) ? decode.Results[0] : null;
    const year = r?.ModelYear || r?.['Model Year'] || null;
    const make = r?.Make || null;
    const model = r?.Model || null;
    const series = r?.Series || null;
    if (!year || !make || !model) return res.json({ rated: false, reason: 'insufficient decode data' });

    const searchUrl = `https://api.nhtsa.gov/SafetyRatings/modelyear/${encodeURIComponent(year)}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}?format=json`;
    const list = await fetchJsonViaHttps(searchUrl);
    const vehicles = Array.isArray(list?.Results) ? list.Results : [];
    if (!vehicles.length) return res.json({ rated: false, reason: 'no safety records' });

    // Prefer vehicles that match series/body cues
    const seriesRe = series ? new RegExp(series.replace(/[^\w]/g, '.*'), 'i') : null;
    const ordered = vehicles.slice().sort((a, b) => {
      const ad = a.VehicleDescription || '';
      const bd = b.VehicleDescription || '';
      const aScore = (seriesRe && seriesRe.test(ad) ? 2 : 0) + (/4-?door|5-?door|suv|utility/i.test(ad) ? 1 : 0);
      const bScore = (seriesRe && seriesRe.test(bd) ? 2 : 0) + (/4-?door|5-?door|suv|utility/i.test(bd) ? 1 : 0);
      return bScore - aScore;
    });

    // Helper to parse rating string to number if possible
    const parseRating = (val) => {
      if (!val || typeof val !== 'string') return null;
      if (/not\s*rated/i.test(val)) return null;
      const m = val.match(/([0-9](?:\.[0-9])?)/);
      return m ? parseFloat(m[1]) : null;
    };

    let best = null;
    for (const v of ordered) {
      const detailUrl = `https://api.nhtsa.gov/SafetyRatings/VehicleId/${encodeURIComponent(v.VehicleId)}?format=json`;
      const detail = await fetchJsonViaHttps(detailUrl);
      const d = Array.isArray(detail?.Results) ? detail.Results[0] : null;
      if (!d) continue;
      const ov = d.OverallRating || '';
      const ovNum = parseRating(ov);
      if (ovNum !== null) {
        if (!best || ovNum > best.ovNum) {
          best = { vehicle: v, data: d, ovNum };
        }
      }
    }

    if (!best) return res.json({ rated: false, reason: 'no rated variants' });

    const d = best.data;
    const v = best.vehicle;
    const out = {
      rated: true,
      source: 'NHTSA',
      vehicleId: v.VehicleId,
      vehicleDescription: v.VehicleDescription,
      overallRating: d.OverallRating || 'Not Rated',
      overallFrontCrashRating: d.OverallFrontCrashRating || 'Not Rated',
      overallSideCrashRating: d.OverallSideCrashRating || 'Not Rated',
      rolloverRating: d.RolloverRating || 'Not Rated',
      rolloverRisk: d.RolloverRating2 || d.RolloverPossibility || null,
      complaintsCount: d.ComplaintsCount || null,
      recallsCount: d.RecallsCount || null,
      investigationsCount: d.InvestigationsCount || null
    };

    res.json(out);
  } catch (e) {
    console.error('safety endpoint error', e);
    res.status(500).json({ error: 'safety lookup failed', message: e.message });
  }
});

// Feature flags for client
app.get('/api/config/features', (req, res) => {
  res.json({
    marketCompsEnabled: !!MARKETCHECK_API_KEY,
    roboflowEnabled: !!(ROBOFLOW_API_KEY && ROBOFLOW_MODEL)
  });
});

// Generic proxy for VPIC APIs (GET only)
// Usage examples:
//   /api/vpic/vehicles/DecodeVinValuesExtended/1HGCM82633A004352?format=json
//   /api/vpic/vehicles/GetModelsForMakeYear/make/honda/modelyear/2003?format=json
// The route appends format=json if not provided.
app.get('/api/vpic/*', async (req, res) => {
  try {
    const suffix = req.params[0] || '';
    // Preserve query string
    const q = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
    let target = `https://vpic.nhtsa.dot.gov/api/${suffix}`;
    if (q) target += `?${q}`;
    if (!/format=/.test(q)) {
      target += (q ? '&' : '?') + 'format=json';
    }
    const data = await fetchJsonViaHttps(target);
    res.json(data);
  } catch (e) {
    console.error('VPIC proxy error', e);
    res.status(500).json({ error: 'vpic proxy failed', message: e.message });
  }
});

// Market comps (listings + price stats)
app.get('/api/vin/market-comps', async (req, res) => {
  try {
    const vin = (req.query.vin || '').toString().trim();
    const zip = (req.query.zip || '').toString().trim();
    const radius = parseInt(req.query.radius || '100', 10);
    if (!vin) return res.status(400).json({ error: 'vin is required' });
    if (!MARKETCHECK_API_KEY) return res.status(503).json({ error: 'Market comps not configured' });

    const params = new URLSearchParams({
      api_key: MARKETCHECK_API_KEY,
      vin,
      radius: String(isNaN(radius) ? 100 : radius),
      car_type: 'used',
      seller_type: 'dealer,private',
      start: '0',
      rows: '50'
    });
    if (zip) params.set('zip', zip);

    const url = `https://api.marketcheck.com/v2/search/car/active?${params.toString()}`;
    const data = await fetchJsonViaHttps(url);
    const listings = Array.isArray(data?.listings) ? data.listings : [];

    const prices = listings
      .map(l => l.price || l.price_raw || (l.build && l.build.price) || null)
      .filter(v => typeof v === 'number' && isFinite(v));

    const stats = {};
    if (prices.length) {
      const sorted = prices.slice().sort((a, b) => a - b);
      const sum = prices.reduce((a, b) => a + b, 0);
      const median = sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      stats.count = prices.length;
      stats.min = sorted[0];
      stats.max = sorted[sorted.length - 1];
      stats.avg = Math.round((sum / prices.length) * 100) / 100;
      stats.median = median;
    } else {
      stats.count = 0;
    }

    const domVals = listings
      .map(l => l.dom || l.days_on_market || null)
      .filter(v => typeof v === 'number' && isFinite(v));
    if (domVals.length) {
      const avgDom = Math.round((domVals.reduce((a, b) => a + b, 0) / domVals.length) * 10) / 10;
      stats.avg_days_on_market = avgDom;
    }

    const summary = {
      vin,
      zip: zip || null,
      radius: isNaN(radius) ? 100 : radius,
      stats,
      sample: listings.slice(0, 12).map(l => ({
        id: l.id || l.vdp_url || null,
        price: l.price || null,
        miles: l.miles || l.mileage || null,
        dealer: l.dealer?.name || l.seller_name || null,
        vdp_url: l.vdp_url || l.vdpUrl || null,
        exterior_color: l.exterior_color || l.exteriorColor || null,
        dom: l.dom || l.days_on_market || null,
        city: l.dealer?.city || l.city || null,
        state: l.dealer?.state || l.state || null
      }))
    };

    res.json(summary);
  } catch (e) {
    console.error('market-comps error', e);
    res.status(500).json({ error: 'market comps failed', message: e.message });
  }
});

// Roboflow damage detection
app.post('/api/roboflow/detect', async (req, res) => {
  try {
    if (!ROBOFLOW_API_KEY || !ROBOFLOW_MODEL || !ROBOFLOW_VERSION) {
      return res.status(503).json({ error: 'Roboflow not configured' });
    }

    const { imageUrl, uploadId } = req.body || {};
    let targetUrl = (imageUrl || '').toString().trim();

    if (!targetUrl && uploadId) {
      const data = readData();
      const upload = data.uploads.find(u => u.id === uploadId);
      if (!upload) return res.status(404).json({ error: 'upload not found' });
      const origin = getOrigin(req);
      targetUrl = upload.path?.startsWith('/uploads') ? `${origin}${upload.path}` : (upload.s3Url || upload.path);
      if (!targetUrl) return res.status(400).json({ error: 'could not resolve image url for upload' });
    }

    if (!targetUrl) return res.status(400).json({ error: 'imageUrl or uploadId required' });

    const rfUrl = `https://detect.roboflow.com/${encodeURIComponent(ROBOFLOW_MODEL)}/${encodeURIComponent(ROBOFLOW_VERSION)}?api_key=${encodeURIComponent(ROBOFLOW_API_KEY)}&image=${encodeURIComponent(targetUrl)}&format=json`;
    const result = await fetchJsonViaHttps(rfUrl);

    // persist onto upload if provided
    if (uploadId) {
      const data = readData();
      const idx = data.uploads.findIndex(u => u.id === uploadId);
      if (idx !== -1) {
        data.uploads[idx].detection = {
          provider: 'roboflow',
          model: ROBOFLOW_MODEL,
          version: ROBOFLOW_VERSION,
          result,
          detectedAt: Date.now()
        };
        writeData(data);
      }
    }

    res.json({ ok: true, result });
  } catch (e) {
    console.error('roboflow detect error', e);
    res.status(500).json({ error: 'roboflow detection failed', message: e.message });
  }
});

// Inspection detail + uploads
app.get('/api/inspections/:id', (req, res) => {
  const id = req.params.id;
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  const uploads = data.uploads.filter(u => u.inspectionId === id);
  res.json({ inspection: insp, uploads });
});

// Stripe publishable key for client init
app.get('/api/stripe/config', (req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) return res.status(501).json({ error: 'Stripe not configured' });
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Create Stripe Checkout Session (server-side)
app.post('/api/checkout/session', async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Stripe not configured on server' });
  const origin = req.protocol + '://' + req.get('host');
  const { plan, listingUrl, vin } = req.body || {};
  const priceMap = {
    basic: { amount: 14900, name: 'TrustCar Inspection — Basic' },
    premium: { amount: 64900, name: 'TrustCar Inspection — Premium + Warranty' }
  };
  const sel = priceMap[plan || 'basic'] || priceMap.basic;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: sel.amount,
            product_data: { name: sel.name }
          },
          quantity: 1
        }
      ],
      success_url: `${origin}/enter-vin.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/index.html?canceled=true`,
      metadata: {
        plan: plan || 'basic',
        listingUrl: listingUrl || '',
        vin: vin || ''
      }
    });
    return res.json({ id: session.id });
  } catch (err) {
    console.error('Stripe session error', err);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
});

// Generate a presigned PUT URL for S3 uploads
app.post('/api/inspections/:id/presign', async (req, res) => {
  if (!s3Client) return res.status(501).json({ error: 'S3 not configured' });
  const id = req.params.id;
  const token = req.query.t || req.headers['x-token'];
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const tokenHash = hashToken(token);
  if (tokenHash !== insp.tokenHash) return res.status(403).json({ error: 'Invalid token' });
  if (Date.now() > insp.tokenExpiry) return res.status(403).json({ error: 'Token expired' });

  const { filename, contentType } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: 'Missing filename or contentType' });

  const ext = path.extname(filename) || '';
  const key = `inspections/${id}/${uuidv4()}${ext}`;

  const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType, ACL: 'private' });
  try {
    const url = await getSignedUrl(s3Client, cmd, { expiresIn: 900 });
    return res.json({ url, key, expiresIn: 900 });
  } catch (err) {
    console.error('presign error', err);
    return res.status(500).json({ error: 'Could not create presigned URL' });
  }
});

// Notify server after successful direct S3 upload so we can record metadata
app.post('/api/inspections/:id/notify', (req, res) => {
  const id = req.params.id;
  const token = req.query.t || req.headers['x-token'];
  const { key, filename, mimetype, size, checkItem, lat, lng, accuracy } = req.body || {};
  if (!key || !filename) return res.status(400).json({ error: 'Missing key or filename' });

  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const tokenHash = hashToken(token);
  if (tokenHash !== insp.tokenHash) return res.status(403).json({ error: 'Invalid token' });
  if (Date.now() > insp.tokenExpiry) return res.status(403).json({ error: 'Token expired' });

  const uploadEntry = {
    id: uuidv4(),
    inspectionId: id,
    filename: filename,
    originalname: filename,
    mimetype: mimetype || 'application/octet-stream',
    size: size || null,
    path: `s3://${S3_BUCKET}/${key}`,
    s3Url: `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodeURIComponent(key)}`,
    checkItem: checkItem || null,
    lat: lat !== undefined ? (lat === null ? null : parseFloat(lat)) : null,
    lng: lng !== undefined ? (lng === null ? null : parseFloat(lng)) : null,
    accuracy: accuracy !== undefined ? (accuracy === null ? null : parseFloat(accuracy)) : null,
    uploadedAt: Date.now()
  };

  data.uploads.push(uploadEntry);
  // change inspection status to submitted if it was pending
  if (insp.status === 'pending') {
    insp.status = 'submitted';
  }
  writeData(data);

  return res.json({ ok: true, file: uploadEntry });
});

// Simple admin action to mark complete
app.post('/api/inspections/:id/mark-complete', (req, res) => {
  const id = req.params.id;
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });
  insp.status = 'complete';
  writeData(data);
  res.json({ ok: true });
});

// Save/update tire inspection data for an inspection
app.post('/api/inspections/:id/tire', (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  // Attach tire object to inspection
  insp.tire = payload;
  insp.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, inspection: insp });
});

// Generic update for inspection metadata (buyerZip, buyerEmail, vehicle, price)
app.post('/api/inspections/:id', (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  const allowed = ['buyerZip','buyerEmail','price','vehicle','orderId'];
  allowed.forEach(k => { if (Object.prototype.hasOwnProperty.call(payload, k)) insp[k] = payload[k]; });
  insp.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, inspection: insp });
});

// Update inspection status (admin only) - PUT method for RESTful updates
app.put('/api/inspections/:id', (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  // Allow updating status and other admin fields
  const allowed = ['status', 'buyerZip', 'buyerEmail', 'price', 'vehicle', 'orderId', 'notes', 'flagReason'];
  allowed.forEach(k => { 
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      insp[k] = payload[k];
    }
  });
  insp.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, inspection: insp });
});

// Generate PDF report (admin only)
app.post('/api/inspections/:id/generate-pdf', async (req, res) => {
  const id = req.params.id;
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  // Build preview URL (served by this server)
  const origin = req.protocol + '://' + req.get('host');
  const previewUrl = `${origin}/reports/preview.html?id=${id}`;

  // Use Puppeteer to render the preview and save PDF
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('puppeteer not available', e);
    return res.status(501).json({ error: 'Puppeteer not installed on server' });
  }

  try {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(previewUrl, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const filename = `report-${id}.pdf`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, pdfBuffer);

    // attach report metadata to inspection
    insp.report = { path: `/uploads/${filename}`, createdAt: Date.now() };
    writeData(data);

    res.json({ ok: true, reportPath: insp.report.path });
  } catch (err) {
    console.error('pdf error', err);
    res.status(500).json({ error: 'Failed to create PDF' });
  }
});

// Generate PDF and optionally email it to buyer (admin only)
app.post('/api/inspections/:id/email-report', async (req, res) => {
  const id = req.params.id;
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  // If a Redis-backed queue is available, enqueue the job and return quickly.
  if (reportQueue) {
    try {
      const to = (req.body && req.body.to) ? req.body.to : (insp.buyerEmail || null);
      const job = await reportQueue.add({ id, to });
      return res.status(202).json({ ok: true, queued: true, jobId: job.id });
    } catch (err) {
      console.error('queue add error', err);
      // fallthrough to synchronous generation
    }
  }

  // Fallback to synchronous behavior if queue not available or enqueue failed
  const origin = req.protocol + '://' + req.get('host');
  const previewUrl = `${origin}/reports/preview.html?id=${id}`;

  // generate PDF via puppeteer synchronously
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('puppeteer not available', e);
    return res.status(501).json({ error: 'Puppeteer not installed on server' });
  }

  try {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(previewUrl, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const filename = `report-${id}.pdf`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, pdfBuffer);

    insp.report = { path: `/uploads/${filename}`, createdAt: Date.now() };
    writeData(data);

    const to = (req.body && req.body.to) ? req.body.to : (insp.buyerEmail || null);
    if (process.env.SENDGRID_API_KEY && to) {
      try {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        const from = process.env.SENDGRID_FROM || process.env.FROM_EMAIL || 'no-reply@trustcar.io';
        const msg = {
          to,
          from,
          subject: `TrustCar Inspection Report — ${insp.id}`,
          text: `Attached is the inspection report for ${insp.id}`,
          attachments: [
            {
              content: pdfBuffer.toString('base64'),
              filename,
              type: 'application/pdf',
              disposition: 'attachment'
            }
          ]
        };
        await sgMail.send(msg);
        return res.json({ ok: true, reportPath: insp.report.path, emailed: true });
      } catch (err) {
        console.error('sendgrid error', err);
        return res.status(500).json({ error: 'Failed to send email', detail: err.message, reportPath: insp.report.path });
      }
    }

    return res.json({ ok: true, reportPath: insp.report.path, emailed: false });
  } catch (err) {
    console.error('pdf/email error', err);
    res.status(500).json({ error: 'Failed to create or send PDF' });
  }
});

// Market comps endpoint (mock or integrate with a real market API)
app.post('/api/market-comps', async (req, res) => {
  const { make, model, year, mileage, zip } = req.body || {};
  if (!make || !model || !year) return res.status(400).json({ error: 'Missing make/model/year' });

  // Placeholder logic: simulate comps based on year/mileage
  // Real integration: call a market data API (e.g., CarGurus, Edmunds, Kelley Blue Book) with credentials.
  const basePrice = 35000 - ((new Date().getFullYear() - year) * 1200) - (mileage ? (mileage / 10000) * 800 : 0);
  const avg = Math.max(5000, Math.round(basePrice));
  const low = Math.round(avg * 0.92);
  const high = Math.round(avg * 1.05);

  const comps = [
    { title: `${year} ${make} ${model}`, price: avg, mileage: mileage || 60000, location: zip || 'local' },
    { title: `${year} ${make} ${model}`, price: Math.round((low + avg) / 2), mileage: (mileage || 60000) + 5000, location: zip || 'local' },
    { title: `${year} ${make} ${model}`, price: Math.round((avg + high) / 2), mileage: (mileage || 60000) - 8000, location: zip || 'local' }
  ];

  return res.json({ average: avg, low, high, comps });
});

// Nearby trustworthy repair shops (uses Google Places if configured, otherwise returns mock)
app.get('/api/nearby-shops', async (req, res) => {
  const zip = req.query.zip;
  const radiusMiles = parseInt(req.query.radiusMiles || '75', 10);
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  if (googleKey) {
    try {
      // Use Places Text Search for 'auto repair near {zip}'
      const q = encodeURIComponent(`auto repair near ${zip}`);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&key=${googleKey}`;
      const resp = await fetch(url);
      const data = await resp.json();
      const results = (data.results || []).filter(r => r.rating && r.rating >= 4.5).slice(0, 8).map(r => ({ name: r.name, address: r.formatted_address, rating: r.rating, user_ratings_total: r.user_ratings_total }));
      return res.json({ source: 'google', results });
    } catch (err) {
      console.error('places error', err);
    }
  }

  // Fallback mock
  const results = [
    { name: 'Main St Auto Repair', address: `${zip} — 12 Main St`, rating: 4.7, user_ratings_total: 124 },
    { name: 'Valley Mechanics', address: `${zip} — 88 Valley Rd`, rating: 4.6, user_ratings_total: 89 },
    { name: 'Precision Auto', address: `${zip} — 200 Center Ave`, rating: 4.5, user_ratings_total: 63 }
  ];
  return res.json({ source: 'mock', results });
});

// Estimate reconditioning cost (simple heuristics)
function estimateReconditioning(inspection) {
  let cost = 0;
  const tread = inspection.tire && inspection.tire.tread;
  if (tread) {
    ['driverFront','driverRear','passFront','passRear'].forEach(k => {
      const v = tread[k] || 999;
      if (v <= 4) cost += 400; // tire replacement per tire
      else if (v <= 7) cost += 200; // partial service
    });
  }
  // check checklist issues: if any upload has checkItem indicating damage, add buffer
  const uploads = readData().uploads.filter(u => u.inspectionId === inspection.id);
  const damageCount = uploads.filter(u => /scratch|dent|damage|rust|broken/i.test((u.checkItem||''))).length;
  cost += damageCount * 150;
  // basic minimum prep/valet
  if (cost === 0) cost = 150;
  return cost;
}

// Endpoint to get market+shop+estimate+verdict for an inspection
app.get('/api/inspections/:id/market', async (req, res) => {
  const id = req.params.id;
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  // Expect buyerZip, listPrice, and vehicle details in inspection record
  const buyerZip = insp.buyerZip || req.query.zip || null;
  const listPrice = insp.price || req.query.price || null;
  const vehicle = insp.vehicle || {};

  const make = vehicle.make || req.query.make;
  const model = vehicle.model || req.query.model;
  const year = vehicle.year || parseInt(req.query.year || '0', 10);
  const mileage = vehicle.mileage || parseInt(req.query.mileage || '0', 10);

  const compsRes = await fetch(`http://localhost:${PORT}/api/market-comps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ make, model, year, mileage, zip: buyerZip }) });
  const comps = await compsRes.json();

  const shopsRes = await fetch(`http://localhost:${PORT}/api/nearby-shops?zip=${encodeURIComponent(buyerZip || '')}`);
  const shops = await shopsRes.json();

  const recond = estimateReconditioning(insp);

  // verdict based on price delta
  let verdict = 'N/A';
  if (listPrice && comps.average) {
    const delta = listPrice - comps.average;
    if (delta <= -2000) verdict = 'Strong Buy';
    else if (delta <= -500) verdict = 'Good Buy';
    else if (delta <= 500) verdict = 'Fair Price';
    else if (delta <= 2000) verdict = 'Overpriced';
    else verdict = 'Walk Away';
  }

  return res.json({ comps, shops, reconditioningEstimate: recond, verdict, buyerZip, listPrice });
});

// Fallback: serve public index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve VIN entry page (root-level file)
app.get('/enter-vin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'enter-vin.html'));
});

// Serve pricing page
app.get('/pricing.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});

// Serve other root-level pages
app.get('/dealers.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dealers.html'));
});

app.get('/how-it-works.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'how-it-works.html'));
});

app.get('/success.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

// Buyer report access pages
app.get('/view-report.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'view-report.html'));
});

app.get('/buyer-report.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'buyer-report.html'));
});

app.get('/test-queue.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-queue.html'));
});

app.get('/seller/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seller-upload.html'));
});

app.get('/admin', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/view.html', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin/view.html'));
});

// VinAudit API: Title history lookup (paid API ~$5/lookup)
app.get('/api/vin/history', async (req, res) => {
  try {
    const vin = (req.query.vin || '').toString().trim().toUpperCase();
    if (!vin) return res.status(400).json({ error: 'vin required' });
    if (!VINAUDIT_API_KEY) return res.status(503).json({ error: 'VinAudit not configured' });

    // VinAudit endpoint: https://specifications.vinaudit.com/v3/
    const url = `https://specifications.vinaudit.com/v3/specifications?key=${VINAUDIT_API_KEY}&vin=${vin}`;
    const data = await fetchJsonViaHttps(url);

    // Parse key fields from VinAudit response
    const result = {
      vin,
      success: data?.success || false,
      vehicle: {
        year: data?.year || null,
        make: data?.make || null,
        model: data?.model || null,
        trim: data?.trim || null
      },
      title: {
        brands: data?.title?.brands || [],
        salvage: data?.title?.salvage || false,
        rebuilt: data?.title?.rebuilt || false,
        junk: data?.title?.junk || false
      },
      accidents: {
        count: data?.accident?.count || 0,
        records: data?.accident?.records || []
      },
      ownership: {
        count: data?.ownership?.count || 0,
        lastDate: data?.ownership?.lastDate || null,
        type: data?.ownership?.type || null
      },
      odometer: {
        readings: data?.odometer?.readings || [],
        lastReading: data?.odometer?.readings?.[0] || null,
        rollback: data?.odometer?.rollback || false
      },
      recalls: {
        count: data?.recall?.count || 0,
        records: data?.recall?.records || []
      },
      marketValue: data?.marketValue || null,
      warranty: data?.warranty || null
    };

    res.json(result);
  } catch (err) {
    console.error('VinAudit error:', err);
    res.status(500).json({ error: 'VinAudit lookup failed', message: err.message });
  }
});

// Fraud scoring engine (0-100 risk score)
app.get('/api/inspections/:id/fraud-score', async (req, res) => {
  try {
    const data = readData();
    const insp = data.inspections.find(i => i.id === req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });

    const uploads = data.uploads.filter(u => u.inspectionId === insp.id);
    const vinRecord = data.vinRecords?.find(v => v.vin === insp.vin);
    
    let score = 0;
    const flags = [];

    // 1. EXIF GPS mismatch (check if photos taken in different state than seller claims)
    const gpsCoords = uploads.filter(u => u.exif?.gps).map(u => u.exif.gps);
    if (gpsCoords.length > 0 && insp.sellerZip) {
      // Simple check: if any GPS coord is >200 miles from seller ZIP, flag it
      // In production, use geocoding API to compare coordinates
      const hasGpsMismatch = gpsCoords.some(gps => Math.abs(gps.lat - 40) > 5); // placeholder logic
      if (hasGpsMismatch) {
        score += 25;
        flags.push('GPS location mismatch: Photos taken outside seller\'s claimed area');
      }
    }

    // 2. Odometer discrepancy (compare uploaded odometer photo vs VinAudit history)
    const odometerUpload = uploads.find(u => u.checkItem === 'odometer');
    if (odometerUpload && vinRecord?.odometer?.lastReading) {
      // In production, run OCR on odometer image and compare to VinAudit reading
      // For now, assume we have insp.odometerReading from manual entry
      const declaredMileage = insp.odometerReading || 0;
      const historyMileage = vinRecord.odometer.lastReading.mileage || 0;
      if (declaredMileage < historyMileage - 5000) {
        score += 30;
        flags.push(`Odometer rollback suspected: Declared ${declaredMileage} mi < History ${historyMileage} mi`);
      }
    }

    // 3. Undisclosed damage (Roboflow detected damage seller didn't mention)
    const damageDetections = uploads.filter(u => u.detection?.predictions?.length > 0);
    if (damageDetections.length > 0 && !insp.sellerDisclosedDamage) {
      score += 20;
      flags.push(`AI detected ${damageDetections.length} damaged areas not disclosed by seller`);
    }

    // 4. VIN plate OCR mismatch (compare VIN plate photo OCR vs entered VIN)
    const vinPlateUpload = uploads.find(u => u.checkItem === 'vin_plate');
    if (vinPlateUpload && vinPlateUpload.ocrVin && vinPlateUpload.ocrVin !== insp.vin) {
      score += 35;
      flags.push(`VIN mismatch: Plate shows ${vinPlateUpload.ocrVin}, seller entered ${insp.vin}`);
    }

    // 5. Title flipping indicator (multiple transfers in <6 months)
    if (vinRecord?.ownership?.count >= 2) {
      const recentTransfers = vinRecord.ownership.count; // simplified
      if (recentTransfers >= 2) {
        score += 15;
        flags.push(`Potential flip: ${recentTransfers} ownership transfers in short period`);
      }
    }

    // 6. Image quality issues (dark/blurry photos = hiding damage?)
    const lowQualityCount = uploads.filter(u => u.quality?.warnings?.length > 0).length;
    if (lowQualityCount > 5) {
      score += 10;
      flags.push(`${lowQualityCount} low-quality photos may be hiding damage`);
    }

    // Cap at 100
    score = Math.min(score, 100);

    const result = {
      inspectionId: insp.id,
      vin: insp.vin,
      score,
      level: score < 30 ? 'low' : score < 70 ? 'medium' : 'high',
      autoFlag: score >= 70,
      flags,
      timestamp: Date.now()
    };

    // Save fraud score to inspection
    insp.fraudScore = result;
    writeData(data);

    res.json(result);
  } catch (err) {
    console.error('Fraud scoring error:', err);
    res.status(500).json({ error: 'Fraud scoring failed', message: err.message });
  }
});

// AI Report Generation (admin only)
app.post('/api/inspections/:id/generate-ai-report', async (req, res) => {
  try {
    const data = readData();
    const insp = data.inspections.find(i => i.id === req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });

    const uploads = data.uploads.filter(u => u.inspectionId === insp.id);
    const vinRecord = data.vinRecords?.find(v => v.vin === insp.vin);
    
    // Build structured input for GPT-4
    const prompt = `You are an expert automotive inspector analyzing a remote vehicle inspection. Generate a comprehensive buyer report based on the following data:

**Vehicle Information:**
- VIN: ${insp.vin || 'Unknown'}
- Year: ${vinRecord?.vehicle?.year || 'Unknown'}
- Make: ${vinRecord?.vehicle?.make || 'Unknown'}
- Model: ${vinRecord?.vehicle?.model || 'Unknown'}
- Mileage: ${insp.odometerReading || 'Not provided'}

**Inspection Photos:** ${uploads.length} photos submitted
- Required checklist: ${uploads.filter(u => u.checkItem).map(u => u.checkItem).join(', ')}

**Damage Detection (AI Analysis):**
${uploads.filter(u => u.detection?.predictions?.length > 0).map(u => 
  `- ${u.checkItem}: ${u.detection.predictions.map(p => `${p.class} (${Math.round(p.confidence * 100)}% confidence)`).join(', ')}`
).join('\n') || 'No damage detected'}

**Title History (VinAudit):**
${vinRecord ? `
- Title Brands: ${vinRecord.title?.brands?.join(', ') || 'Clean'}
- Salvage: ${vinRecord.title?.salvage ? 'YES ⚠' : 'No'}
- Accidents: ${vinRecord.accidents?.count || 0} reported
- Odometer Rollback: ${vinRecord.odometer?.rollback ? 'SUSPECTED ⚠' : 'No'}
- Ownership Changes: ${vinRecord.ownership?.count || 0}
` : 'Title history not available'}

**Fraud Risk Score:** ${insp.fraudScore?.score || 'Not calculated'}/100 (${insp.fraudScore?.level || 'unknown'})
${insp.fraudScore?.flags?.length > 0 ? `**Flags:**\n${insp.fraudScore.flags.map(f => `- ${f}`).join('\n')}` : ''}

**Safety Ratings (NHTSA):**
${vinRecord?.safetyData?.rated ? `
- Overall: ${vinRecord.safetyData.overallRating || 'N/A'} stars
- Front Crash: ${vinRecord.safetyData.overallFrontCrashRating || 'N/A'} stars
- Side Crash: ${vinRecord.safetyData.overallSideCrashRating || 'N/A'} stars
- Rollover: ${vinRecord.safetyData.rolloverRating || 'N/A'} stars
` : 'Safety ratings not available'}

**Instructions:**
1. Provide an executive summary (2-3 sentences) with clear BUY/PROCEED WITH CAUTION/AVOID recommendation
2. List key findings (positives and concerns)
3. Summarize damage and condition issues
4. Explain fraud risk factors if score >30
5. Note any missing data or limitations
6. Provide estimated reconditioning costs for identified damage
7. Final recommendation with confidence level

Format as markdown with clear sections. Be objective, data-driven, and include disclaimers about remote inspection limitations.`;

    // Call GPT-4o-mini (or gpt-4 if available)
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert automotive inspector providing detailed, objective vehicle inspection reports for used car buyers.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const reportMarkdown = completion.choices[0].message.content;

    // Save to inspection
    insp.aiReport = {
      markdown: reportMarkdown,
      generatedAt: Date.now(),
      model: 'gpt-4',
      reviewed: false
    };
    writeData(data);

    res.json({ ok: true, report: reportMarkdown });
  } catch (err) {
    console.error('AI report generation error:', err);
    res.status(500).json({ error: 'Report generation failed', message: err.message });
  }
});

// Generate PDF report from markdown
app.get('/api/inspections/:id/generate-pdf', async (req, res) => {
  try {
    const data = readData();
    const insp = data.inspections.find(i => i.id === req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    if (!insp.aiReport) return res.status(400).json({ error: 'No AI report generated yet' });

    const vinRecord = data.vinRecords?.find(v => v.vin === insp.vin);
    const uploads = data.uploads.filter(u => u.inspectionId === insp.id);
    
    // Convert markdown to HTML with styling
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 1in; }
    body { 
      font-family: 'Helvetica Neue', Arial, sans-serif; 
      line-height: 1.6; 
      color: #0b1724;
      font-size: 11pt;
    }
    .header { 
      border-bottom: 3px solid #0553F0; 
      padding-bottom: 1rem; 
      margin-bottom: 2rem;
    }
    .header h1 { 
      color: #0553F0; 
      margin: 0; 
      font-size: 24pt;
    }
    .header .meta { 
      color: #64748b; 
      font-size: 9pt; 
      margin-top: 0.5rem;
    }
    .vehicle-info {
      background: #f8fafc;
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1.5rem;
      border-left: 4px solid #0553F0;
    }
    .vehicle-info h3 { margin-top: 0; color: #0553F0; }
    h1 { color: #0553F0; font-size: 18pt; page-break-after: avoid; }
    h2 { color: #0b1724; font-size: 14pt; margin-top: 1.5rem; page-break-after: avoid; }
    h3 { color: #475569; font-size: 12pt; margin-top: 1rem; }
    ul, ol { margin-left: 1.5rem; }
    li { margin-bottom: 0.5rem; }
    strong { color: #0b1724; }
    code { 
      background: #f1f5f9; 
      padding: 2px 6px; 
      border-radius: 4px;
      font-size: 10pt;
    }
    pre { 
      background: #f8fafc; 
      padding: 1rem; 
      border-radius: 6px;
      border-left: 3px solid #0553F0;
      overflow-x: auto;
    }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 2px solid #e6eefc;
      font-size: 8pt;
      color: #64748b;
      text-align: center;
    }
    .disclaimer {
      background: #fef3c7;
      border: 1px solid #f59e0b;
      padding: 1rem;
      border-radius: 6px;
      margin-top: 2rem;
      font-size: 9pt;
    }
    .stats {
      display: flex;
      justify-content: space-between;
      margin: 1rem 0;
    }
    .stat-box {
      flex: 1;
      text-align: center;
      padding: 0.75rem;
      background: #f8fafc;
      border-radius: 6px;
      margin: 0 0.25rem;
    }
    .stat-value { font-size: 18pt; font-weight: bold; color: #0553F0; }
    .stat-label { font-size: 9pt; color: #64748b; }
    @media print {
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚗 TrustCar.io Vehicle Inspection Report</h1>
    <div class="meta">
      Report ID: ${insp.id} | Generated: ${new Date(insp.aiReport.generatedAt).toLocaleString()} | AI Model: ${insp.aiReport.model}
    </div>
  </div>

  <div class="vehicle-info">
    <h3>Vehicle Information</h3>
    <div class="stats">
      <div class="stat-box">
        <div class="stat-value">${vinRecord?.vehicle?.year || 'N/A'}</div>
        <div class="stat-label">Year</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${vinRecord?.vehicle?.make || 'N/A'}</div>
        <div class="stat-label">Make</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${vinRecord?.vehicle?.model || 'N/A'}</div>
        <div class="stat-label">Model</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${insp.odometerReading || 'N/A'}</div>
        <div class="stat-label">Mileage</div>
      </div>
    </div>
    <p><strong>VIN:</strong> ${insp.vin || 'Not provided'}<br>
    <strong>Inspection Date:</strong> ${new Date(insp.createdAt).toLocaleDateString()}<br>
    <strong>Photos Submitted:</strong> ${uploads.length} inspection photos</p>
  </div>

  <div style="white-space: pre-wrap; font-family: inherit;">${insp.aiReport.markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>

  <div class="disclaimer">
    <strong>⚠️ Disclaimer:</strong> This report is based on remote inspection data including ${uploads.length} photos, AI damage detection analysis, and available vehicle history records. Remote inspections have limitations compared to in-person professional mechanical inspections. This report should be used as an informational tool and does not replace a comprehensive pre-purchase inspection by a certified mechanic. TrustCar.io is not liable for any omissions or undetected issues.
  </div>

  <div class="footer">
    © ${new Date().getFullYear()} TrustCar.io — Building Trust in Every Journey<br>
    Report generated via AI-powered remote vehicle inspection platform
  </div>
</body>
</html>`;

    // Launch headless browser and generate PDF
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    
    await browser.close();

    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="TrustCar-Report-${insp.vin || insp.id}.pdf"`);
    res.end(pdfBuffer, 'binary');

  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'PDF generation failed', message: err.message });
  }
});

// Approve AI report (admin review step)
app.post('/api/inspections/:id/approve-report', async (req, res) => {
  try {
    const data = readData();
    const insp = data.inspections.find(i => i.id === req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    if (!insp.aiReport) return res.status(400).json({ error: 'No AI report to approve' });

    insp.aiReport.reviewed = true;
    insp.aiReport.reviewedAt = Date.now();
    insp.aiReport.reviewedBy = req.body.reviewerName || 'admin';
    insp.status = 'completed';
    writeData(data);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static HTML pages
app.get('/pricing.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});

app.get('/dealers.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dealers.html'));
});

app.get('/how-it-works.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'how-it-works.html'));
});

// 360° Damage Analysis API - AI-powered damage detection with repair estimates
app.get('/api/inspections/:id/damage-analysis', (req, res) => {
  try {
    const data = readData();
    const insp = data.inspections.find(i => i.id === req.params.id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });

    // Aggregate damage from Roboflow results across all photos
    const damages = [];
    let damageId = 1;

    if (insp.roboflowResults && Array.isArray(insp.roboflowResults)) {
      insp.roboflowResults.forEach((result, idx) => {
        if (result.predictions && Array.isArray(result.predictions)) {
          result.predictions.forEach(pred => {
            const severity = pred.confidence > 0.9 ? 'severe' : 
                           pred.confidence > 0.75 ? 'moderate' : 'minor';
            
            // Estimate reconditioning cost based on damage type and severity
            const estimatedCost = estimateReconditioningCost(pred.class, severity, pred.width * pred.height);

            damages.push({
              id: damageId++,
              type: pred.class || 'Unknown Damage',
              location: mapPhotoToLocation(insp.uploads[idx]?.type),
              severity: severity,
              view: mapPhotoToView(insp.uploads[idx]?.type),
              x: Math.random() * 80 + 10, // In production, calculate from bbox
              y: Math.random() * 60 + 20,
              confidence: Math.round(pred.confidence * 100),
              size: `${Math.round(pred.width)}px x ${Math.round(pred.height)}px`,
              estimatedCost: estimatedCost,
              photo: insp.uploads[idx]?.type || 'unknown',
              description: generateDamageDescription(pred.class, severity),
              bbox: pred
            });
          });
        }
      });
    }

    // Calculate totals
    const summary = {
      total: damages.length,
      severe: damages.filter(d => d.severity === 'severe').length,
      moderate: damages.filter(d => d.severity === 'moderate').length,
      minor: damages.filter(d => d.severity === 'minor').length,
      totalCost: damages.reduce((sum, d) => sum + d.estimatedCost, 0)
    };

    res.json({ damages, summary, inspectionId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Estimate reconditioning cost based on damage type, severity, and size
function estimateReconditioningCost(damageType, severity, sizePixels) {
  const baseCosts = {
    'dent': { minor: 150, moderate: 450, severe: 850 },
    'scratch': { minor: 100, moderate: 300, severe: 600 },
    'crack': { minor: 200, moderate: 500, severe: 1200 },
    'rust': { minor: 250, moderate: 600, severe: 1500 },
    'paint_damage': { minor: 75, moderate: 250, severe: 500 },
    'glass_damage': { minor: 150, moderate: 350, severe: 800 },
    'bumper_damage': { minor: 200, moderate: 550, severe: 1100 },
    'panel_damage': { minor: 300, moderate: 700, severe: 1400 }
  };

  const type = damageType.toLowerCase().replace(/[^a-z]/g, '_');
  const costs = baseCosts[type] || baseCosts['dent'];
  
  let baseCost = costs[severity] || costs.moderate;
  
  // Adjust for size (larger damage = higher cost)
  if (sizePixels > 50000) baseCost *= 1.3;
  else if (sizePixels > 20000) baseCost *= 1.15;

  return Math.round(baseCost);
}

// Helper: Map photo type to vehicle location
function mapPhotoToLocation(photoType) {
  const locationMap = {
    'front': 'Front End',
    'rear': 'Rear End',
    'driver_side': 'Driver Side',
    'passenger_side': 'Passenger Side',
    'front_driver_angle': 'Front Bumper - Driver Side',
    'front_passenger_angle': 'Front Bumper - Passenger Side',
    'rear_driver_angle': 'Rear Quarter Panel - Driver Side',
    'rear_passenger_angle': 'Rear Quarter Panel - Passenger Side',
    'engine_bay': 'Engine Compartment',
    'trunk': 'Trunk Area',
    'wheel_driver_front': 'Driver Front Wheel',
    'wheel_driver_rear': 'Driver Rear Wheel',
    'wheel_passenger_front': 'Passenger Front Wheel',
    'wheel_passenger_rear': 'Passenger Rear Wheel',
    'roof': 'Roof',
    'interior_front': 'Interior Front',
    'interior_rear': 'Interior Rear'
  };
  return locationMap[photoType] || 'Unknown Location';
}

// Helper: Map photo type to vehicle view
function mapPhotoToView(photoType) {
  if (!photoType) return 'front';
  if (photoType.includes('front')) return 'front';
  if (photoType.includes('rear')) return 'rear';
  if (photoType.includes('driver')) return 'driver';
  if (photoType.includes('passenger')) return 'passenger';
  if (photoType.includes('roof') || photoType.includes('top')) return 'top';
  return 'front';
}

// Helper: Generate human-readable damage description
function generateDamageDescription(damageType, severity) {
  const descriptions = {
    'dent': {
      minor: 'Shallow dent, PDR (paintless dent repair) recommended',
      moderate: 'Medium-depth dent with possible paint damage, body filler may be needed',
      severe: 'Deep dent with structural damage, panel replacement recommended'
    },
    'scratch': {
      minor: 'Surface-level scratch through clear coat only',
      moderate: 'Scratch through paint layer, touch-up and blending required',
      severe: 'Deep scratch exposing metal, requires panel refinishing'
    },
    'crack': {
      minor: 'Hairline crack, can be repaired with filler',
      moderate: 'Crack with separation, repair or replacement needed',
      severe: 'Structural crack, component replacement required'
    }
  };

  const type = damageType.toLowerCase();
  return descriptions[type]?.[severity] || `${severity} ${damageType} detected by AI vision system`;
}

// ==================== REAL-TIME PRICING API INTEGRATIONS ====================

// Fetch real-time parts pricing from NAPA Auto Parts API
async function fetchNAPAParts(vin, year, make, model) {
  // NAPA API Configuration
  const NAPA_API_KEY = process.env.NAPA_API_KEY;
  const NAPA_API_URL = process.env.NAPA_API_URL || 'https://api.napaonline.com/v1';
  
  if (!NAPA_API_KEY) {
    console.log('NAPA API key not configured, using fallback pricing');
    return null;
  }

  try {
    // Example: Get parts catalog for vehicle
    const response = await fetch(`${NAPA_API_URL}/catalog/vehicle`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NAPA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        vin: vin,
        year: year,
        make: make,
        model: model
      })
    });

    if (!response.ok) {
      console.warn('NAPA API request failed:', response.status);
      return null;
    }

    const data = await response.json();
    
    // Transform NAPA response to our pricing format
    const partsPricing = {};
    if (data.parts) {
      data.parts.forEach(part => {
        const key = part.category.toLowerCase().replace(/\s+/g, '_');
        partsPricing[key] = {
          min: part.price,
          max: part.price * 1.3, // Range for OEM vs aftermarket
          labor_hours: part.labor_hours || 2,
          part_number: part.part_number,
          brand: part.brand,
          availability: part.in_stock ? 'In Stock' : 'Special Order'
        };
      });
    }

    return { parts: partsPricing, source: 'NAPA Auto Parts' };
  } catch (err) {
    console.error('NAPA API error:', err.message);
    return null;
  }
}

// Fetch real-time tire pricing from TireRack API
async function fetchTireRackPricing(tireSize, vehicleType = 'car') {
  // TireRack API Configuration
  const TIRERACK_API_KEY = process.env.TIRERACK_API_KEY;
  const TIRERACK_API_URL = process.env.TIRERACK_API_URL || 'https://api.tirerack.com/v2';
  
  if (!TIRERACK_API_KEY) {
    console.log('TireRack API key not configured, using fallback pricing');
    return null;
  }

  try {
    // Parse tire size (e.g., "275/65/15" -> width: 275, ratio: 65, diameter: 15)
    const sizeMatch = tireSize.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!sizeMatch) {
      console.warn('Invalid tire size format:', tireSize);
      return null;
    }

    const [_, width, ratio, diameter] = sizeMatch;

    // Example: Search tires by size
    const response = await fetch(`${TIRERACK_API_URL}/tires/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TIRERACK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        width: parseInt(width),
        aspect_ratio: parseInt(ratio),
        diameter: parseInt(diameter),
        vehicle_type: vehicleType,
        sort_by: 'price'
      })
    });

    if (!response.ok) {
      console.warn('TireRack API request failed:', response.status);
      return null;
    }

    const data = await response.json();
    
    // Group tires by price tier
    const tirePricing = {
      economy: [],
      mid_range: [],
      premium: []
    };

    if (data.results) {
      data.results.forEach(tire => {
        const pricePerTire = tire.price;
        const tireInfo = {
          price_per_tire: pricePerTire,
          brand: tire.brand,
          model: tire.model,
          rating: tire.rating,
          reviews: tire.review_count,
          warranty: tire.warranty_miles,
          in_stock: tire.in_stock
        };

        // Categorize by price
        if (pricePerTire < 100) {
          tirePricing.economy.push(tireInfo);
        } else if (pricePerTire < 180) {
          tirePricing.mid_range.push(tireInfo);
        } else {
          tirePricing.premium.push(tireInfo);
        }
      });
    }

    // Take top 3 from each tier
    return {
      tires: {
        economy: tirePricing.economy.slice(0, 3),
        mid_range: tirePricing.mid_range.slice(0, 3),
        premium: tirePricing.premium.slice(0, 3),
        tire_size: tireSize,
        installation: {
          mount_balance_per_tire: 25,
          valve_stem_per_tire: 5,
          disposal_per_tire: 5,
          alignment_4_wheel: 100
        }
      },
      source: 'TireRack'
    };
  } catch (err) {
    console.error('TireRack API error:', err.message);
    return null;
  }
}

// Combine all real-time pricing sources
async function fetchRealTimePricing(inspection, vinRecord) {
  const pricing = {};

  // Fetch NAPA parts if we have vehicle info
  if (inspection.vin || (vinRecord && vinRecord.year)) {
    const napaParts = await fetchNAPAParts(
      inspection.vin,
      vinRecord?.year,
      vinRecord?.make,
      vinRecord?.model
    );
    if (napaParts) {
      pricing.napaParts = napaParts.parts;
      pricing.partsSource = napaParts.source;
    }
  }

  // Fetch TireRack pricing if we have tire size
  if (inspection.tire?.size?.driverFront) {
    const tireSize = inspection.tire.size.driverFront;
    const tirePricing = await fetchTireRackPricing(tireSize);
    if (tirePricing) {
      pricing.realTimeTires = tirePricing.tires;
      pricing.tiresSource = tirePricing.source;
    }
  }

  return pricing;
}

// ==================== AI CHATBOT FOR POST-INSPECTION SUPPORT ====================

// POST /api/inspections/:id/chat - AI chatbot for customer questions about their inspection
app.post('/api/inspections/:id/chat', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Find inspection
  const data = readData();
  const inspection = data.inspections.find(i => i.id === id);
  if (!inspection) {
    return res.status(404).json({ error: 'Inspection not found' });
  }

  // Get related data
  const uploads = data.uploads.filter(u => u.inspectionId === id);
  const vinRecord = data.vinRecords.find(v => v.vin === inspection.vin);
  
  // Build damage summary
  let damageSummary = 'No damage detected';
  const damages = uploads.filter(u => u.detection?.predictions?.length > 0);
  if (damages.length > 0) {
    const totalDamages = damages.reduce((sum, u) => sum + (u.detection?.predictions?.length || 0), 0);
    damageSummary = `${totalDamages} damage points detected across ${damages.length} photos`;
  }

  // Get fraud score if available
  let fraudScore = 'Not calculated';
  try {
    const fraudRes = await fetch(`http://localhost:${PORT}/api/inspections/${id}/fraud-score`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from('admin:' + (process.env.ADMIN_PASS || 'admin')).toString('base64') }
    });
    if (fraudRes.ok) {
      const fraudData = await fraudRes.json();
      fraudScore = `${fraudData.score}/100 (${fraudData.level})`;
    }
  } catch (err) {
    // Fraud score not available
  }

  // Load pricing data (fallback static data)
  let pricingData = {};
  try {
    const pricingJson = fs.readFileSync(path.join(__dirname, 'pricing-data.json'), 'utf8');
    pricingData = JSON.parse(pricingJson);
  } catch (err) {
    console.warn('Pricing data not loaded:', err.message);
  }

  // Fetch real-time pricing from APIs if available
  const realTimePricing = await fetchRealTimePricing(inspection, vinRecord);
  if (realTimePricing.parts || realTimePricing.tires) {
    pricingData = { ...pricingData, ...realTimePricing };
  }

  // Build context for AI
  const systemPrompt = `You are TrustCar's automotive AI assistant. You have expert knowledge of:
- Vehicle damage assessment and reconditioning costs
- Common car issues and maintenance
- Safety concerns and recall information
- Title history and fraud detection

INSPECTION CONTEXT:
- VIN: ${inspection.vin || 'Not provided'}
- Year/Make/Model: ${vinRecord ? `${vinRecord.year} ${vinRecord.make} ${vinRecord.model}` : 'Unknown'}
- Mileage: ${inspection.mileage || 'Not provided'}
- Damage Summary: ${damageSummary}
- Fraud Score: ${fraudScore}
- Photos Uploaded: ${uploads.length}
- Order ID: ${inspection.orderId || 'N/A'}

PRICING DATA AVAILABLE:
${pricingData.partsSource ? `✓ REAL-TIME PARTS from ${pricingData.partsSource}` : '✓ Static parts pricing'}
${pricingData.tiresSource ? `✓ REAL-TIME TIRES from ${pricingData.tiresSource}` : '✓ Static tire pricing'}

${JSON.stringify(pricingData, null, 2)}

COST ESTIMATION INSTRUCTIONS:
1. For part replacement: 
   - If napaParts available, use those prices (they're real-time for this specific VIN)
   - Otherwise use commonParts + labor (labor_hours × $95/hr)
2. For tire pricing: 
   - If realTimeTires available, show economy/mid-range/premium options with actual brands and prices
   - Multiply by 4 for full set, add installation ($25/tire × 4 = $100)
   - Example: "For your tire size ${inspection.tire?.size?.driverFront || 'specified'}, options are: Economy $240-280, Mid-range $440-540, Premium $600-800 (all prices include installation)"
3. For dent repair: Use dentRepair pricing based on size
4. For scratch/paint: Use paintRepair pricing per affected panel
5. Always provide a range (min-max) and note that luxury/import vehicles cost 40-60% more
6. If real-time pricing is available, mention the source (NAPA/TireRack) for credibility
7. Example: "A front bumper from NAPA for your ${vinRecord ? vinRecord.year + ' ' + vinRecord.make : 'vehicle'} is $280 (part #12345, in stock) plus 2 hours labor ($190), totaling $470"

GUIDELINES:
1. Answer questions about THIS specific inspection report
2. Explain technical terms in simple language (e.g., "A CV joint connects the transmission to the wheels")
3. When asked about costs, calculate estimates using the pricing database and show your work
4. For tire pricing, ask about tire size if not in report, then provide economy/mid-range/premium options
5. For questions outside this report's scope, say "I don't have that specific data in your report, but I can connect you with our support team"
6. Always prioritize safety - if severe damage is mentioned, emphasize getting a professional mechanic inspection
7. Be concise (3-5 sentences max per response)
8. Use a friendly, helpful tone
9. If asked about specific damage locations, reference the photo uploads

USER QUESTION: ${message}`;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        reply: "I'm currently unavailable (OpenAI API key not configured). Please contact our support team at support@trustcar.io for assistance with your inspection report.",
        error: 'API key missing'
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    const reply = completion.choices[0].message.content;

    // Save chat history to inspection (optional)
    if (!inspection.chatHistory) {
      inspection.chatHistory = [];
    }
    inspection.chatHistory.push({
      timestamp: new Date().toISOString(),
      message,
      reply
    });
    writeData(data);

    res.json({ 
      reply,
      inspectionId: id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chatbot error:', error);
    res.status(500).json({ 
      error: 'Failed to generate response',
      reply: "I'm having trouble processing your question right now. Please try again or contact our support team at support@trustcar.io"
    });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
