# TrustCar AI Vision Platform

## Overview
TrustCar.io is an **AI-driven vehicle inspection platform** using computer vision and machine learning to provide comprehensive damage detection, 360° mapping, and reconditioning cost estimation—all without relying on third-party proprietary AI services.

---

## Core Capabilities

### 1. **360° Photo Capture System**
- **20-point guided photo checklist** covering every vehicle angle
- Front, rear, driver/passenger sides, 4 corner angles, wheels, roof, VIN, odometer, engine bay, trunk, interior
- **Mobile-first capture** with real-time quality validation
- EXIF metadata extraction (GPS coordinates, timestamps) for authenticity verification
- Instant feedback on photo quality (blur detection, lighting issues, resolution checks)

### 2. **Computer Vision Damage Detection**
- **Roboflow-powered AI models** trained on vehicle damage datasets
- Detects: dents, scratches, cracks, rust, paint damage, glass damage, bumper/panel damage
- Each damage point includes:
  - **Pinpoint location** mapped to 360° vehicle diagram
  - **Severity classification** (minor, moderate, severe)
  - **Confidence score** (AI certainty percentage)
  - **Size measurements** (dimensions in pixels/inches)
  - **Bounding box coordinates** for exact positioning

### 3. **Interactive 360° Damage Map**
- Visual vehicle diagram with clickable damage hotspots
- Switch between views: Front, Rear, Driver Side, Passenger Side, Top
- Click markers to see detailed damage card with:
  - Photo evidence with annotations
  - AI-generated description
  - Repair method recommendations (PDR, body filler, panel replacement)
  - Local reconditioning cost estimates

### 4. **Reconditioning Cost Estimation Engine**
- Automatic cost calculation based on:
  - Damage type (dent, scratch, crack, etc.)
  - Severity level (minor/moderate/severe)
  - Size of damage (small, medium, large)
  - Vehicle location (bumper, door, quarter panel, etc.)
- **Estimated total reconditioning cost** aggregated across all damages
- Disclaimer: Based on average local shop rates, subject to actual mechanic quotes

### 5. **Fraud Detection System**
- 6-signal fraud scoring (0-100 risk score):
  1. **GPS mismatch**: Photo location vs. seller-declared location
  2. **Undisclosed damage**: AI-detected damage not mentioned in listing
  3. **VIN OCR verification**: VIN plate photo vs. entered VIN number
  4. **Title flipping**: Multiple owners in short timeframe
  5. **Image manipulation**: Metadata tampering, photoshop detection
  6. **Odometer rollback**: Mileage inconsistency across records

### 6. **AI-Generated Comprehensive Reports**
- **OpenAI GPT-4** powered narrative summaries
- Synthesizes all data points:
  - VIN decode (make, model, year, specs)
  - NHTSA safety ratings + recalls
  - Title history (clean, salvage, rebuilt)
  - Damage analysis with 360° map
  - Fraud risk score breakdown
  - Market comps (similar vehicles for sale nearby)
- Human-readable format optimized for buyer decision-making

---

## Technical Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Damage Detection** | Roboflow Vision API | Computer vision models for dent/scratch/crack detection |
| **Report Generation** | OpenAI GPT-4o-mini | Natural language summaries and insights |
| **Image Processing** | Sharp (Node.js) | Quality analysis (blur, darkness, resolution) |
| **Metadata Extraction** | exif-parser | GPS, timestamps, camera info from photos |
| **VIN Data** | NHTSA API (free) | Decode, safety ratings, recalls |
| **Title History** | VinAudit API (planned) | Title status, accident records, odometer |
| **Backend** | Node.js + Express | REST API for inspections, uploads, analysis |
| **Database** | JSON file (upgradable to PostgreSQL) | Inspection records, damage data |

---

## Key Differentiators

✅ **Core Capabilities:**
- Mobile photo capture with guided checklist
- AI damage detection with pinpoint accuracy
- 360° interactive damage maps
- Reconditioning cost estimation
- Used by dealers, fleets, insurers (B2B2C model)

🔥 **Unique Features:**
- **Fraud detection** built-in (GPS verification, VIN OCR, odometer checks)
- **Transparent pricing** ($49-$299 for all customers)
- **Consumer-first** (anyone can order a report, not just dealers)
- **AI-generated narrative reports** (not just raw data)
- **Open platform** (dealers can become "TrustCar Approved")

---

## Use Cases

### For Buyers (Consumer)
- Order Standard ($149) or Premium ($299) inspection before purchasing used car
- Get 360° damage map, fraud score, title history, reconditioning cost estimates
- Negotiate price reductions based on documented damage
- Avoid lemons, salvage titles, odometer fraud

### For Dealers (B2B)
- Become "TrustCar Approved Dealer" by using platform for all inventory
- Transparency badge attracts buyers who trust pre-inspected vehicles
- Reduce returns, complaints, legal issues from undisclosed damage
- Use reports in listings to build buyer confidence

### For Insurers/Fleets (Enterprise)
- Pre-claim damage documentation for rental car returns
- Fleet vehicle condition monitoring across locations
- Automated damage assessment for insurance claims
- Reduce manual inspection costs

---

## Implementation Files

| File | Purpose |
|------|---------|
| `public/seller-upload-v2.html` | 20-point photo capture interface |
| `public/reports/damage-map.html` | Interactive 360° damage visualization |
| `server.js` (damage-analysis endpoint) | API for damage aggregation + cost estimation |
| `how-it-works.html` | Marketing page explaining AI vision system |
| `pricing.html` | Updated with "360° damage mapping" highlights |

---

## API Endpoints

```javascript
// Get 360° damage analysis with repair estimates
GET /api/inspections/:id/damage-analysis
Response: {
  damages: [
    {
      id: 1,
      type: "Dent",
      location: "Front Bumper - Driver Side",
      severity: "moderate",
      view: "front",
      x: 25, y: 60,  // Position on 360° diagram
      confidence: 94,
      size: "4 x 3 inches",
      estimatedCost: 450,
      photo: "front_driver_angle",
      description: "Medium-depth dent with paint damage..."
    }
  ],
  summary: {
    total: 5,
    severe: 1,
    moderate: 2,
    minor: 2,
    totalCost: 2225
  }
}
```

---

## Next Steps to Enhance

1. **Mobile App** (React Native or Flutter)
   - Native camera integration with real-time AI feedback
   - Augmented reality guides for photo angles
   - Offline mode with background sync

2. **Real-Time Damage Annotations**
   - Draw boxes/circles on photos showing exact damage locations
   - Overlay AI confidence heatmaps

3. **Video Support**
   - Upload walk-around video → extract keyframes → run AI on frames
   - 360° spin capture (like Carvana/CarGurus)

4. **Historical Damage Tracking**
   - Compare reports over time to see if damage worsens
   - Pre/post-repair comparison

5. **Integration with Dealer CRMs**
   - API for dealerships to push inventory → auto-inspect → publish reports
   - Webhook notifications when inspection completes

---

## Positioning Statement

**"TrustCar is the AI-driven transparency platform for used car buying. We use computer vision to detect and map vehicle damage with pinpoint accuracy, combined with fraud detection, transparent pricing, and comprehensive buyer reports. Our mission: make car buying as trustworthy as buying a home (complete with inspection reports)."

---

## Demo Flow

1. **Seller/Buyer orders inspection** → Chooses Standard ($149) or Premium ($299)
2. **Seller captures 20 photos** using guided checklist (5-10 minutes)
3. **AI analyzes photos** → Detects 5 damages (2 dents, 2 scratches, 1 crack)
4. **360° map generated** → Front view shows markers at damage locations
5. **Reconditioning costs calculated** → $450 + $200 + $850 + $200 + $525 = **$2,225 total**
6. **Fraud score calculated** → Low risk (score: 15/100)
7. **AI report generated** → "This 2019 Honda Civic shows moderate damage on front bumper and rear panel. Estimated reconditioning cost $2,225. No fraud indicators detected. Title is clean. NHTSA safety rating: 5 stars."
8. **Buyer receives shareable link** → Interactive report with 360° map, photos, estimates

---

**Status**: ✅ Core features implemented and ready for testing
**Test URL**: http://localhost:3000/public/reports/damage-map.html?id=demo
