# TrustCar.io Chatbot Security & Repair Estimates API Guide

## Overview
This document outlines the backend implementation requirements for the secure chatbot widget and intelligent post-inspection repair cost workflow.

---

## 🔒 Critical Security Implementation

### 1. Token-Based Access (Replaces Direct Inspection ID Exposure)

**Current Risk**: Raw `inspectionId` in URLs enables enumeration attacks and unauthorized access.

**Solution**: Generate short-lived, signed JWT tokens for each chat session.

#### Backend Implementation

```javascript
// server.js - Token generation
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_CHAT_SECRET || 'your-secret-key-change-in-production';
const TOKEN_EXPIRY = '48h'; // Match inspection link expiry

// Generate chat token when creating buyer report link
app.post('/api/inspections/:id/generate-chat-token', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    const inspection = await getInspection(id);
    if (!inspection) {
      return res.status(404).json({ error: 'Inspection not found' });
    }
    
    // Sign token with inspection ID, buyer info, and expiry
    const chatToken = jwt.sign(
      { 
        inspectionId: id,
        buyerEmail: inspection.buyerEmail || null,
        type: 'chat',
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );
    
    res.json({ chatToken });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate chat token' });
  }
});

// Middleware to verify chat tokens
function verifyChatToken(req, res, next) {
  const { token } = req.body;
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Validate token type
    if (decoded.type !== 'chat') {
      return res.status(403).json({ error: 'Invalid token type' });
    }
    
    // Attach decoded data to request
    req.chatAuth = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please request a new report link.' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}
```

#### Update Report Link Generation

```javascript
// When generating buyer report links (view-report.html)
app.get('/api/inspections/:id/share-link', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  
  // Generate chat token
  const tokenResponse = await generateChatToken(id);
  const chatToken = tokenResponse.chatToken;
  
  // Build secure report URL
  const reportUrl = `${process.env.BASE_URL}/view-report.html?token=${chatToken}`;
  
  res.json({ reportUrl, expiresIn: '48 hours' });
});
```

---

### 2. Rate Limiting (Prevent Abuse)

**Risk**: Unlimited chat requests enable DoS attacks and API abuse.

**Solution**: Implement per-token and per-IP rate limiting.

```javascript
const rateLimit = require('express-rate-limit');

// Global rate limiter (per IP)
const chatRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 messages per 15 min per IP
  message: { error: 'Too many messages. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Per-token rate limiter (in-memory, use Redis for production)
const tokenMessageCounts = new Map();

function perTokenRateLimit(req, res, next) {
  const { inspectionId } = req.chatAuth;
  const key = `${inspectionId}-${Date.now() / (15 * 60 * 1000)}`; // 15-min buckets
  
  const count = tokenMessageCounts.get(key) || 0;
  if (count >= 50) {
    return res.status(429).json({ error: 'Message limit exceeded for this session.' });
  }
  
  tokenMessageCounts.set(key, count + 1);
  
  // Cleanup old entries (run every 30 min)
  if (tokenMessageCounts.size > 1000) {
    const now = Date.now() / (15 * 60 * 1000);
    for (const [k] of tokenMessageCounts) {
      const bucket = parseInt(k.split('-')[1]);
      if (now - bucket > 4) { // Delete buckets older than 1 hour
        tokenMessageCounts.delete(k);
      }
    }
  }
  
  next();
}

// Apply to chat endpoints
app.post('/api/chat/message', chatRateLimiter, verifyChatToken, perTokenRateLimit, handleChatMessage);
app.post('/api/chat/context', chatRateLimiter, verifyChatToken, handleChatContext);
app.post('/api/chat/repair-estimates', chatRateLimiter, verifyChatToken, handleRepairEstimates);
```

---

### 3. Input Sanitization (XSS Prevention)

**Risk**: Malicious user messages could inject scripts if not sanitized.

**Solution**: Server-side HTML stripping and length limits.

```javascript
const sanitizeHtml = require('sanitize-html');

function sanitizeUserMessage(message) {
  // Strip all HTML tags
  const cleaned = sanitizeHtml(message, {
    allowedTags: [], // No HTML allowed
    allowedAttributes: {}
  });
  
  // Trim and limit length
  return cleaned.trim().substring(0, 500);
}

// Apply in all chat handlers
app.post('/api/chat/message', verifyChatToken, async (req, res) => {
  const { message } = req.body;
  const sanitizedMessage = sanitizeUserMessage(message);
  
  if (!sanitizedMessage) {
    return res.status(400).json({ error: 'Invalid message' });
  }
  
  // Process sanitized message...
});
```

---

### 4. Audit Logging (Security Monitoring)

**Purpose**: Track suspicious activity (token reuse attempts, enumeration, unusual volume).

```javascript
// Add to database schema
CREATE TABLE chat_audit_logs (
  id SERIAL PRIMARY KEY,
  inspection_id VARCHAR(255),
  token_hash VARCHAR(64), -- SHA256 hash of token (never store raw tokens)
  ip_address VARCHAR(45),
  user_agent TEXT,
  message_count INTEGER DEFAULT 1,
  suspicious_activity BOOLEAN DEFAULT FALSE,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

// Logging function
const crypto = require('crypto');

function logChatActivity(req, inspectionId, suspicious = false) {
  const { token } = req.body;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  // Log to database (async, don't block response)
  db.query(
    `INSERT INTO chat_audit_logs (inspection_id, token_hash, ip_address, user_agent, suspicious_activity)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token_hash) DO UPDATE 
     SET message_count = chat_audit_logs.message_count + 1`,
    [inspectionId, tokenHash, req.ip, req.get('user-agent'), suspicious]
  ).catch(err => console.error('Audit log error:', err));
}

// Use in chat handlers
app.post('/api/chat/message', verifyChatToken, async (req, res) => {
  logChatActivity(req, req.chatAuth.inspectionId);
  // ... handle message
});
```

---

## 🛠️ Chat API Endpoints

### 1. POST `/api/chat/context` - Load Inspection Summary

**Purpose**: Fetch inspection details for chatbot context (called once on widget init).

**Request**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response**:
```json
{
  "id": "INS-20231225-ABC123",
  "status": "complete",
  "vin": "1HGBH41JXMN109186",
  "year": 2021,
  "make": "Honda",
  "model": "Accord",
  "uploadCount": 47,
  "checklistComplete": 45,
  "damageFindings": [
    { "area": "Front Bumper", "severity": "minor", "confidence": 87 },
    { "area": "Driver Door", "severity": "moderate", "confidence": 92 }
  ],
  "tireCondition": {
    "avgTreadDepth": 5.2,
    "rating": "Fair - Monitor"
  }
}
```

**Implementation**:
```javascript
app.post('/api/chat/context', verifyChatToken, async (req, res) => {
  const { inspectionId } = req.chatAuth;
  
  try {
    const inspection = await db.query(
      `SELECT id, status, vin, year, make, model, 
              (SELECT COUNT(*) FROM uploads WHERE inspection_id = $1) as upload_count,
              tire_data
       FROM inspections WHERE id = $1`,
      [inspectionId]
    );
    
    if (!inspection.rows.length) {
      return res.status(404).json({ error: 'Inspection not found' });
    }
    
    const data = inspection.rows[0];
    
    // Fetch damage findings
    const damages = await db.query(
      `SELECT u.checklist_item, d.predictions
       FROM uploads u
       JOIN detections d ON u.id = d.upload_id
       WHERE u.inspection_id = $1 AND d.result IS NOT NULL`,
      [inspectionId]
    );
    
    res.json({
      id: data.id,
      status: data.status,
      vin: data.vin,
      year: data.year,
      make: data.make,
      model: data.model,
      uploadCount: data.upload_count,
      damageFindings: damages.rows.map(d => ({
        area: d.checklist_item,
        severity: determineSeverity(d.predictions),
        confidence: avgConfidence(d.predictions)
      })),
      tireCondition: data.tire_data
    });
  } catch (error) {
    console.error('Context load error:', error);
    res.status(500).json({ error: 'Failed to load context' });
  }
});
```

---

### 2. POST `/api/chat/message` - Handle User Questions

**Purpose**: Process natural language questions about inspection (integrate OpenAI/Claude).

**Request**:
```json
{
  "token": "eyJhbGc...",
  "message": "What damage was found?",
  "zipCode": "90210"
}
```

**Response**:
```json
{
  "reply": "Based on the inspection, I found **2 areas of concern**:\n\n1. **Front Bumper** - Minor scuff with 87% confidence\n2. **Driver Door** - Moderate dent with 92% confidence\n\nBoth are cosmetic and don't affect safety, but may require professional repair for resale value."
}
```

**Implementation** (with OpenAI GPT-4):
```javascript
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/chat/message', chatRateLimiter, verifyChatToken, perTokenRateLimit, async (req, res) => {
  const { message, zipCode } = req.body;
  const { inspectionId } = req.chatAuth;
  
  const sanitizedMessage = sanitizeUserMessage(message);
  if (!sanitizedMessage) {
    return res.status(400).json({ error: 'Invalid message' });
  }
  
  logChatActivity(req, inspectionId);
  
  try {
    // Fetch inspection context
    const contextResponse = await getInspectionContext(inspectionId);
    
    // Build system prompt with inspection data
    const systemPrompt = `You are TrustCar AI, an expert vehicle inspection assistant. 

**Inspection Summary:**
- VIN: ${contextResponse.vin}
- Vehicle: ${contextResponse.year} ${contextResponse.make} ${contextResponse.model}
- Status: ${contextResponse.status}
- Damage Findings: ${JSON.stringify(contextResponse.damageFindings)}
- Tire Condition: ${contextResponse.tireCondition?.rating || 'Not assessed'}
${zipCode ? `- Buyer Location: ${zipCode}` : ''}

Answer the buyer's questions clearly and concisely. Focus on safety, repairability, and cost implications. Use **bold** for emphasis.`;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitizedMessage }
      ],
      max_tokens: 300,
      temperature: 0.7
    });
    
    const reply = completion.choices[0].message.content;
    
    // Store conversation (optional)
    await db.query(
      `INSERT INTO chat_history (inspection_id, sender, message, timestamp)
       VALUES ($1, 'user', $2, NOW()), ($1, 'bot', $3, NOW())`,
      [inspectionId, sanitizedMessage, reply]
    );
    
    res.json({ reply });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Unable to process message. Please try again.' });
  }
});
```

---

### 3. POST `/api/chat/repair-estimates` - ZIP-Based Repair Costs

**Purpose**: Provide itemized repair estimates based on buyer location and inspection findings.

**Request**:
```json
{
  "token": "eyJhbGc...",
  "zipCode": "90210"
}
```

**Response**:
```json
{
  "zipCode": "90210",
  "source": "RepairPal API",
  "estimates": [
    {
      "issue": "Front Bumper Repair (Minor Scuff)",
      "partsCost": 120,
      "laborCost": 180,
      "laborHours": 2,
      "laborRate": 90,
      "totalCost": 300,
      "description": "Buff, sand, repaint front bumper cover"
    },
    {
      "issue": "Driver Door Dent Repair (Moderate)",
      "partsCost": 0,
      "laborCost": 225,
      "laborHours": 2.5,
      "laborRate": 90,
      "totalCost": 225,
      "description": "Paintless dent removal (PDR)"
    },
    {
      "issue": "Tire Replacement (4 Tires)",
      "partsCost": 480,
      "laborCost": 80,
      "laborHours": 1,
      "laborRate": 80,
      "totalCost": 560,
      "description": "4x mid-range all-season tires + mount/balance"
    }
  ],
  "totalEstimate": 1085,
  "disclaimer": "Estimates based on RepairPal data for Beverly Hills, CA. Actual costs may vary by shop."
}
```

**Implementation** (RepairPal Integration - Future):

```javascript
// RepairPal API Integration (placeholder for when API key available)
async function fetchRepairPalEstimates(inspectionData, zipCode) {
  // When RepairPal API key is available:
  // const response = await fetch('https://repairpal.com/api/v1/estimates', {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': `Bearer ${process.env.REPAIRPAL_API_KEY}`,
  //     'Content-Type': 'application/json'
  //   },
  //   body: JSON.stringify({
  //     zipCode,
  //     vehicle: { year: inspectionData.year, make: inspectionData.make, model: inspectionData.model },
  //     repairs: inspectionData.damageFindings.map(d => ({ type: d.area, severity: d.severity }))
  //   })
  // });
  // return response.json();
  
  // Placeholder: Return mock data until API key available
  return null;
}

app.post('/api/chat/repair-estimates', chatRateLimiter, verifyChatToken, async (req, res) => {
  const { zipCode } = req.body;
  const { inspectionId } = req.chatAuth;
  
  // Validate ZIP
  if (!/^\d{5}$/.test(zipCode)) {
    return res.status(400).json({ error: 'Invalid ZIP code format' });
  }
  
  logChatActivity(req, inspectionId);
  
  try {
    // Fetch inspection data
    const inspectionData = await getInspectionContext(inspectionId);
    
    // Store buyer ZIP for future reference
    await db.query(
      `UPDATE inspections SET buyer_zip = $1 WHERE id = $2`,
      [zipCode, inspectionId]
    );
    
    // Attempt RepairPal API (if key available)
    let estimates = await fetchRepairPalEstimates(inspectionData, zipCode);
    
    if (!estimates) {
      // Fallback: Generate estimates from internal logic
      estimates = generateFallbackEstimates(inspectionData, zipCode);
    }
    
    res.json({
      zipCode,
      source: estimates.source || 'TrustCar estimates',
      estimates: estimates.items || [],
      totalEstimate: estimates.items?.reduce((sum, e) => sum + e.totalCost, 0) || 0,
      disclaimer: estimates.disclaimer || 'Estimates are approximate. Actual costs vary by shop and region.'
    });
  } catch (error) {
    console.error('Repair estimates error:', error);
    res.status(500).json({ error: 'Unable to generate estimates at this time' });
  }
});

// Fallback estimate generator (rule-based until RepairPal available)
function generateFallbackEstimates(inspectionData, zipCode) {
  const estimates = [];
  const avgLaborRate = getAvgLaborRate(zipCode); // Lookup by ZIP (use cached data)
  
  // Damage-based estimates
  inspectionData.damageFindings.forEach(finding => {
    if (finding.severity === 'minor') {
      estimates.push({
        issue: `${finding.area} Repair (Minor)`,
        partsCost: 100,
        laborCost: avgLaborRate * 2,
        laborHours: 2,
        laborRate: avgLaborRate,
        totalCost: 100 + (avgLaborRate * 2),
        description: 'Cosmetic repair (buff, touch-up, or minor panel work)'
      });
    } else if (finding.severity === 'moderate') {
      estimates.push({
        issue: `${finding.area} Repair (Moderate)`,
        partsCost: 250,
        laborCost: avgLaborRate * 3,
        laborHours: 3,
        laborRate: avgLaborRate,
        totalCost: 250 + (avgLaborRate * 3),
        description: 'Panel replacement or paintless dent repair'
      });
    }
  });
  
  // Tire-based estimates
  if (inspectionData.tireCondition?.rating?.includes('Replace')) {
    estimates.push({
      issue: 'Tire Replacement (4 Tires)',
      partsCost: 480,
      laborCost: 80,
      laborHours: 1,
      laborRate: avgLaborRate,
      totalCost: 560,
      description: '4x mid-range all-season tires + mount/balance'
    });
  }
  
  return {
    source: 'TrustCar estimates',
    items: estimates,
    disclaimer: 'Estimates based on national averages. Contact local shops for exact quotes.'
  };
}

// Labor rate lookup by ZIP (cached data, update monthly)
function getAvgLaborRate(zipCode) {
  const laborRates = {
    // High-cost areas
    '90210': 120, // Beverly Hills
    '10001': 110, // NYC
    '94102': 115, // San Francisco
    // Mid-cost areas
    '60601': 90,  // Chicago
    '75201': 85,  // Dallas
    // Low-cost areas
    '73301': 75,  // Austin
    '85001': 70   // Phoenix
  };
  
  return laborRates[zipCode] || 85; // Default $85/hr
}
```

---

## 📊 Database Schema Updates

```sql
-- Chat audit logs
CREATE TABLE chat_audit_logs (
  id SERIAL PRIMARY KEY,
  inspection_id VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  message_count INTEGER DEFAULT 1,
  suspicious_activity BOOLEAN DEFAULT FALSE,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inspection_id (inspection_id),
  INDEX idx_token_hash (token_hash),
  INDEX idx_timestamp (timestamp)
);

-- Chat conversation history (optional, for training/analytics)
CREATE TABLE chat_history (
  id SERIAL PRIMARY KEY,
  inspection_id VARCHAR(255) NOT NULL,
  sender ENUM('user', 'bot') NOT NULL,
  message TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inspection_id (inspection_id)
);

-- Add buyer ZIP to inspections table
ALTER TABLE inspections ADD COLUMN buyer_zip VARCHAR(5);
```

---

## 🚀 Deployment Checklist

### Environment Variables
```bash
# Add to .env
JWT_CHAT_SECRET=<generate-secure-random-string>
OPENAI_API_KEY=<your-openai-key>
REPAIRPAL_API_KEY=<when-available>
BASE_URL=https://trustcar.io
```

### Security Hardening
- [ ] Generate strong JWT secret (32+ chars, random)
- [ ] Enable HTTPS only (no HTTP fallback)
- [ ] Configure CORS (whitelist trustcar.io domain only)
- [ ] Enable rate limiting on all chat endpoints
- [ ] Set up monitoring alerts for:
  - Token reuse attempts (same token, different IPs)
  - High message volume (>100/hour per token)
  - Failed token verifications (>10/hour)

### Testing
- [ ] Token expiry (test 48h+ old tokens are rejected)
- [ ] Rate limiting (101st message returns 429)
- [ ] XSS protection (inject `<script>alert('xss')</script>` in message)
- [ ] ZIP detection (test "My ZIP is 90210" triggers repair flow)
- [ ] Repair estimate accuracy (compare with RepairPal manual quotes)

### Analytics
- [ ] Track chat engagement (% of buyers who use chatbot)
- [ ] Track repair estimate requests (% who provide ZIP)
- [ ] Track message volume by inspection status
- [ ] Track most common questions (train better responses)

---

## 🔮 Future Enhancements

1. **Multi-language Support**: Detect buyer language, translate responses
2. **Voice Input**: Speech-to-text for hands-free questions
3. **Image Analysis**: "Send photo of damage for instant estimate"
4. **Shop Recommendations**: "3 nearby shops with 4.5★+ ratings"
5. **Financing Calculator**: "Estimated monthly payment with $1085 repairs"
6. **Recall Alerts**: "This vehicle has 1 open safety recall"

---

## 📞 Support

For backend implementation questions:
- Security: Refer to `SECURITY_HARDENING_GUIDE.md`
- API Integration: Contact RepairPal support for API key
- OpenAI Setup: https://platform.openai.com/docs

**Implementation Priority**: Critical (Week 1-2)
**Estimated Effort**: 16-24 hours (security + API endpoints)
**Dependencies**: OpenAI API key, JWT library, rate-limit middleware
