# Security Hardening Guide for TrustCar.io

## Critical Security Implementation Requirements

### 1. Token Security (CRITICAL - Implement Immediately)

#### Current Vulnerability
- Upload tokens (`?t=`) are exposed in URL and reusable
- `inspectionId` derived from pathname allows enumeration
- No rate limiting or IP binding

#### Required Server-Side Changes

**A. Generate Short-Lived, Single-Use Tokens**

```javascript
// server.js - Token generation
const crypto = require('crypto');
const tokenStore = new Map(); // Use Redis in production

function generateUploadToken(inspectionId, ipAddress) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + (48 * 60 * 60 * 1000); // 48 hours
  
  tokenStore.set(token, {
    inspectionId,
    ipAddress,
    expiresAt,
    used: false,
    createdAt: Date.now()
  });
  
  return token;
}

// Validation middleware
function validateUploadToken(req, res, next) {
  const token = req.query.t || req.body.token;
  const tokenData = tokenStore.get(token);
  
  // Validation checks
  if (!tokenData) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  if (tokenData.used) {
    return res.status(403).json({ error: 'Token already used (single-use)' });
  }
  
  if (Date.now() > tokenData.expiresAt) {
    tokenStore.delete(token);
    return res.status(410).json({ error: 'Token expired' });
  }
  
  // Optional: IP binding for added security
  if (tokenData.ipAddress !== req.ip) {
    return res.status(403).json({ error: 'Token IP mismatch' });
  }
  
  // Attach to request
  req.inspectionId = tokenData.inspectionId;
  req.tokenData = tokenData;
  
  next();
}

// Mark token as used after successful upload
function markTokenUsed(token) {
  const tokenData = tokenStore.get(token);
  if (tokenData) {
    tokenData.used = true;
    tokenStore.set(token, tokenData);
  }
}
```

**B. Rate Limiting**

```javascript
const rateLimit = require('express-rate-limit');

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 uploads per window
  message: 'Too many upload requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/inspections/:id/uploads', uploadLimiter);
```

**C. Remove InspectionId from URL Path**

```javascript
// OLD (vulnerable):
// /seller-upload/ABC123?t=token

// NEW (secure):
// /seller-upload?t=ENCRYPTED_TOKEN_CONTAINING_INSPECTION_ID

// Token now includes encrypted inspection ID
function generateSecureUploadToken(inspectionId, ipAddress) {
  const payload = {
    id: inspectionId,
    ip: ipAddress,
    exp: Date.now() + (48 * 60 * 60 * 1000)
  };
  
  // Use JWT or encrypted token
  const jwt = require('jsonwebtoken');
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '48h' });
}

function decodeUploadToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}
```

### 2. HTTPS Enforcement (CRITICAL)

**A. Server Configuration**

```javascript
// server.js - Force HTTPS
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
    return res.redirect(301, `https://${req.hostname}${req.url}`);
  }
  next();
});

// Add security headers
const helmet = require('helmet');
app.use(helmet({
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://docs.opencv.org"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "https://vpic.nhtsa.dot.gov", "https://api.nhtsa.gov"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"]
    }
  }
}));
```

### 3. API Key Protection

**Current Risk:** Client-side API calls to market data providers expose keys

**Solution:**

```javascript
// server.js - Proxy all external API calls
app.get('/api/vin/market-comps', validateAuth, async (req, res) => {
  const { vin, zip, radius } = req.query;
  
  // Validate inputs
  if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: 'Invalid VIN' });
  }
  
  // Call external API with server-side key
  const marketData = await fetch(
    `https://api.marketcheck.com/v2/search/car?vin=${vin}&radius=${radius}&zip=${zip}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.MARKETCHECK_API_KEY}`
      }
    }
  );
  
  const data = await marketData.json();
  
  // Return only necessary data (don't expose full API response)
  res.json({
    summary: data.summary,
    listings: data.listings.slice(0, 10) // Limit results
  });
});
```

### 4. Input Validation & Sanitization

```javascript
const { body, query, validationResult } = require('express-validator');

// VIN validation middleware
const vinValidation = [
  body('vin').isLength({ min: 17, max: 17 })
    .matches(/^[A-HJ-NPR-Z0-9]{17}$/)
    .withMessage('Invalid VIN format'),
  body('ocrDetectedVin').optional().isLength({ min: 17, max: 17 }),
  body('manuallyEnteredVin').optional().isLength({ min: 17, max: 17 })
];

app.post('/api/inspections/:id', vinValidation, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  // Process validated data
});
```

### 5. Database Security

```javascript
// Use parameterized queries (already good with your current setup)
// Add encryption for sensitive fields

const crypto = require('crypto');

function encryptField(text) {
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
    Buffer.from(process.env.ENCRYPTION_IV, 'hex')
  );
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    encrypted,
    authTag: cipher.getAuthTag().toString('hex')
  };
}

// Encrypt geolocation data
function storeUpload(data) {
  const encryptedLocation = data.lat && data.lng 
    ? encryptField(JSON.stringify({ lat: data.lat, lng: data.lng }))
    : null;
  
  return db.run(`
    INSERT INTO uploads (inspection_id, filename, encrypted_location, uploaded_at)
    VALUES (?, ?, ?, ?)
  `, [data.inspectionId, data.filename, encryptedLocation?.encrypted, Date.now()]);
}
```

## Environment Variables Required

Create `.env` file with:

```bash
# JWT for token signing
JWT_SECRET=your-256-bit-secret-here

# Encryption for sensitive data
ENCRYPTION_KEY=your-aes-256-key-hex
ENCRYPTION_IV=your-16-byte-iv-hex

# External API keys (never expose to client)
MARKETCHECK_API_KEY=your-marketcheck-key
NHTSA_API_KEY=not-required-but-add-if-available

# Database
DATABASE_URL=postgresql://user:pass@host:5432/trustcar

# Session secrets
SESSION_SECRET=your-session-secret-here

# Environment
NODE_ENV=production
```

## Audit Logging

```javascript
// server.js - Comprehensive audit trail
function logSecurityEvent(event, req, details = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    inspectionId: req.inspectionId,
    ...details
  };
  
  // Log to file and/or external service
  console.log('[SECURITY]', JSON.stringify(logEntry));
  
  // Store in database for compliance
  db.run(`
    INSERT INTO security_logs (event, ip, user_agent, inspection_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [event, logEntry.ip, logEntry.userAgent, logEntry.inspectionId, JSON.stringify(details), Date.now()]);
}

// Use in middleware
app.use('/api/inspections/:id/uploads', (req, res, next) => {
  logSecurityEvent('upload_attempt', req, { 
    fileSize: req.headers['content-length'],
    contentType: req.headers['content-type']
  });
  next();
});
```

## Deployment Checklist

- [ ] Generate strong JWT_SECRET (256 bits minimum)
- [ ] Generate encryption keys for sensitive data
- [ ] Configure HTTPS certificates (Let's Encrypt recommended)
- [ ] Set up rate limiting on all upload endpoints
- [ ] Implement token-based authentication (single-use, time-limited)
- [ ] Remove inspectionId from URL paths
- [ ] Proxy all external API calls through backend
- [ ] Add comprehensive audit logging
- [ ] Set up monitoring for suspicious activity
- [ ] Configure CORS properly (whitelist only your domain)
- [ ] Enable HSTS headers
- [ ] Regular security audits and penetration testing

## Client-Side Security Notes (Already Implemented)

✅ Permission request modal before camera/geolocation access
✅ Manual upload fallback for denied permissions
✅ VIN cross-validation (OCR vs manual entry)
✅ Audit trail for both OCR and manual VIN entries
✅ Content Security Policy meta tag
✅ Secure session banner with expiration notice

## Testing Security

```bash
# Test rate limiting
for i in {1..101}; do curl -X POST http://localhost:3000/api/inspections/test/uploads; done

# Test token expiration
# Generate token, wait 48h, attempt use

# Test token reuse
# Use same token twice, should fail on second attempt

# Test HTTPS redirect
curl -v http://yoursite.com/seller-upload

# Test CSP
# Open browser console, check for CSP violations
```

## Monitoring & Alerting

Set up alerts for:
- Multiple failed token validations from same IP
- Unusually high upload volume
- Token enumeration attempts
- VIN mismatch rates above threshold
- Geolocation denial rates (may indicate bot activity)

## Compliance Considerations

- **GDPR:** Location data is PII - must be encrypted, retention limited, deletable on request
- **CCPA:** Users must be able to request data deletion
- **SOC 2:** Audit logging required for all access
- **PCI DSS:** Not applicable unless processing payments directly

---

**Priority Implementation Order:**

1. **Week 1:** Single-use tokens, HTTPS enforcement, rate limiting
2. **Week 2:** API proxying, input validation, encryption
3. **Week 3:** Audit logging, monitoring, alerting
4. **Week 4:** Security testing, penetration testing, compliance review
