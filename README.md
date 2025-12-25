TrustCar Prototype

Quickstart (local dev)

1. Install dependencies

```bash
npm install
```

2. Run the server

```bash
npm start
# or for dev with auto-reload
npm run dev
```

3. Create an inspection (curl)

```bash
curl -X POST http://localhost:3000/api/inspections -H "Content-Type: application/json" -d '{"orderId":"ORD123","buyerEmail":"buyer@example.com"}'
```

The response includes `inspectionId` and a `sellerLink` (with a token). Open the `sellerLink` on a mobile device to test camera capture.

Admin UI available at:

http://localhost:3000/admin

Uploads are saved to the `uploads/` folder and metadata to `data.json`.

Notes
- This is an MVP local prototype. For production, switch to S3 presigned uploads, SendGrid/Twilio for messaging, and a proper DB.
- Tokens are hashed using SHA256 in `data.json`.

PDF generation & admin auth
- Admin endpoints (including PDF generation) are protected by basic auth. Set `ADMIN_USER` and `ADMIN_PASS` in your `.env` before starting the server.
- Generate a PDF report for an inspection (admin only):

```bash
curl -u admin:changeme -X POST http://localhost:3000/api/inspections/INSPECTION_ID/generate-pdf
```

The server will create `uploads/report-INSPECTION_ID.pdf` and attach it to the inspection record. Puppeteer must be installed (dependency added). If running in a container, Puppeteer may require additional libs or use a chromium build compatible with your environment.

Market Comps (Marketcheck)
- Set env var `MARKETCHECK_API_KEY`.
- Endpoint: `GET /api/vin/market-comps?vin=1HGCM82633A004352&zip=94107&radius=100`
- Returns summarized stats (min/max/avg/median, avg days-on-market) and a sample of listings.

Roboflow Damage Detection
- Set env vars:
	- `ROBOFLOW_API_KEY`
	- `ROBOFLOW_MODEL` (e.g., `vehicle-damage-detection`)
	- `ROBOFLOW_VERSION` (default `1`)
- Endpoint: `POST /api/roboflow/detect` with JSON body:

```json
{ "imageUrl": "https://example.com/photo.jpg" }
```

or to detect on an uploaded file by id:

```json
{ "uploadId": "<UPLOAD_ID_FROM_INSPECTION>" }
```

- The admin inspection view adds a "Detect Damage" button per upload. Results are stored on the upload record and summarized inline.

VIN Record Storage
- VIN decodes are saved via `POST /api/vin-records` from the client page.
- Admin endpoints:
	- `GET /api/vin-records` (Basic Auth required)
	- `GET /api/vin-records/:id` (Basic Auth required)
- Admin UI page: `/admin/vin-records.html`

## AI-First Inspection Platform Features

### Photo Checklist Flow (`/public/seller-upload-v2.html`)
- **20 required photos**: 4 corners, 4 wheels, VIN plate, odometer, engine, trunk, interior, dash lights, roof
- **Progress tracker**: X/20 completion status with visual indicators
- **EXIF extraction**: GPS coordinates and timestamp automatically captured from photo metadata
- **Image quality validation**: Server-side blur/darkness detection; flags low-res or poor quality images
- **Auto-trigger Roboflow**: When photo uploaded with API key configured, damage detection runs automatically

### VinAudit API Integration (`VINAUDIT_API_KEY`)
- **Endpoint**: `GET /api/vin/history?vin=<VIN>`
- **Returns**: Title brands, salvage/rebuilt/junk flags, accident count, ownership history, odometer readings, rollback detection, recalls, market value
- **Cost**: ~$5 per lookup (production use only)

### Fraud Scoring Engine (0-100 Risk Score)
- **Endpoint**: `GET /api/inspections/:id/fraud-score` (admin only)
- **Signals analyzed**:
  1. **GPS mismatch** (+25 pts): Photos taken >200 miles from seller's claimed location
  2. **Odometer discrepancy** (+30 pts): Declared mileage < VinAudit history (rollback suspected)
  3. **Undisclosed damage** (+20 pts): AI detected damage seller didn't mention
  4. **VIN OCR mismatch** (+35 pts): VIN plate photo doesn't match entered VIN
  5. **Title flipping** (+15 pts): ≥2 ownership transfers in <6 months
  6. **Image quality issues** (+10 pts): >5 dark/blurry photos (hiding damage?)
- **Auto-flag**: Score ≥70 triggers manual review in admin queue
- **Fraud score saved** to inspection record and displayed in review queue

### Admin Review Queue (`/admin/queue.html`)
- **Kanban board**: 4 columns (Pending, In Review, Flagged, Completed)
- **Fraud badges**: Risk score displayed on each card (Low/Medium/High)
- **Photo thumbnails**: Preview first 4 photos inline
- **One-click actions**: Approve, Flag, or Open full inspection
- **Auto-sorting**: High fraud scores (≥70) automatically appear in Flagged column

### AI Report Generation (`OPENAI_API_KEY`)
- **Endpoint**: `POST /api/inspections/:id/generate-ai-report` (admin only)
- **Model**: GPT-4 (objective, data-driven analysis)
- **Input**: VIN decode, photo checklist, damage detections, VinAudit title history, fraud score, safety ratings
- **Output**: Markdown report with:
  - Executive summary with BUY/CAUTION/AVOID recommendation
  - Key findings (positives and concerns)
  - Damage summary with estimated reconditioning costs
  - Fraud risk explanation (if score >30)
  - Missing data/limitations disclosure
  - Final recommendation with confidence level
- **Human review required**: AI report flagged as `reviewed: false` until admin approves
- **Approval endpoint**: `POST /api/inspections/:id/approve-report` (marks reviewed, sets status to completed)

### Environment Variables (Production)
```bash
# Existing
ADMIN_USER=admin
ADMIN_PASS=<secure-password>
MARKETCHECK_API_KEY=<api-key>
ROBOFLOW_API_KEY=<api-key>
ROBOFLOW_MODEL=vehicle-damage-detection
ROBOFLOW_VERSION=1

# New
VINAUDIT_API_KEY=<api-key>         # ~$5/lookup
OPENAI_API_KEY=<api-key>           # GPT-4 report generation
```

### Workflow: Seller → Admin → Buyer
1. **Seller** receives link to `/seller/:id` (photo checklist page)
2. **Seller** uploads 20 required photos; EXIF + quality validated server-side
3. **Auto-trigger** Roboflow damage detection on each upload (if configured)
4. **Auto-calculate** fraud score using GPS, odometer, damage, VIN OCR signals
5. **Admin** reviews in queue; high fraud scores (≥70) auto-flagged
6. **Admin** generates AI report (GPT-4 analyzes all data)
7. **Admin** reviews and approves AI report (human oversight)
8. **Buyer** receives shareable report link (PDF download + web view)

### Roadmap (Not Yet Implemented)
- **Buyer report portal**: Public `/reports/{token}` page with AI report, damage map, PDF download
- **Stripe pricing tiers**: Basic ($49), Standard ($149), Premium ($249) with tier-specific features
- **OCR for VIN plate**: Extract VIN from photo and auto-compare to entered VIN
- **OBD-II integration**: Optional dongle service or instructional guide for diagnostic data
