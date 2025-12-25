# Real-Time Pricing API Integration Guide

## Overview
TrustCar.io chatbot can pull real-time pricing data from NAPA Auto Parts and TireRack APIs to provide accurate cost estimates based on specific VINs and tire sizes.

## APIs Supported

### 1. NAPA Auto Parts API
**Purpose:** Real-time parts pricing for specific vehicles by VIN

**Setup:**
1. Visit https://developer.napaonline.com/
2. Sign up for developer account
3. Request API access (may require business verification)
4. Get your API key from the developer dashboard
5. Add to `.env`:
   ```
   NAPA_API_KEY=your-actual-key-here
   NAPA_API_URL=https://api.napaonline.com/v1
   ```

**What it provides:**
- Part-specific pricing for bumpers, fenders, lights, etc.
- Part numbers and availability (In Stock vs Special Order)
- OEM vs aftermarket pricing ranges
- Labor hour estimates

**Example Response:**
```json
{
  "parts": {
    "front_bumper": {
      "price": 285.99,
      "part_number": "BUM-12345",
      "brand": "NAPA",
      "in_stock": true,
      "labor_hours": 2
    }
  }
}
```

### 2. TireRack API
**Purpose:** Real-time tire pricing by size with brand/model options

**Setup:**
1. Visit https://www.tirerack.com/content/tirerack/desktop/en/api.html
2. Contact TireRack API team for business account
3. Get API credentials
4. Add to `.env`:
   ```
   TIRERACK_API_KEY=your-actual-key-here
   TIRERACK_API_URL=https://api.tirerack.com/v2
   ```

**What it provides:**
- Tire pricing by exact size (e.g., 275/65R15)
- Multiple options per tier (economy/mid-range/premium)
- Brand names, models, ratings, and reviews
- Warranty information
- Installation costs
- Real-time availability

**Example Response:**
```json
{
  "results": [
    {
      "brand": "Michelin",
      "model": "Defender T+H",
      "price": 145.99,
      "rating": 4.6,
      "review_count": 2847,
      "warranty_miles": 80000,
      "in_stock": true
    }
  ]
}
```

## How It Works

### Fallback Strategy
1. **API Available:** Uses real-time data from NAPA/TireRack
2. **API Unavailable:** Falls back to `pricing-data.json` static pricing
3. **Graceful Degradation:** If API call fails, chatbot still functions with estimates

### Data Flow
```
User asks: "How much for 4 new tires?"
         ↓
Chatbot extracts tire size from inspection.tire.size
         ↓
Calls TireRack API with size (275/65/15)
         ↓
Gets real prices: Economy $240, Mid-range $440, Premium $600
         ↓
Responds with actual brands and installation costs
```

### VIN-Specific Parts Pricing
```
User asks: "Cost to replace front bumper?"
         ↓
Chatbot gets VIN from inspection record
         ↓
Calls NAPA API with VIN + part type
         ↓
Gets exact part: $285.99, Part#BUM-12345, In Stock
         ↓
Adds labor (2hrs × $95 = $190)
         ↓
Total: $475.99
```

## Testing Without APIs

If you don't have API keys yet, the system works with static pricing:

1. Edit `pricing-data.json` with your own estimates
2. Chatbot uses those values
3. Add API keys later when ready to go live

## API Costs

### NAPA Auto Parts
- Typically tiered pricing based on API call volume
- Free tier: Usually 1,000 calls/month
- Paid tier: $0.01-0.05 per API call

### TireRack
- Contact for pricing (usually B2B partnership required)
- May charge per transaction or monthly fee
- Some plans include revenue sharing on sales

## Alternative APIs

Don't have NAPA/TireRack access? Try these alternatives:

### Parts:
- **AutoZone API** - Similar to NAPA
- **O'Reilly Auto Parts API** - Parts pricing by VIN
- **RockAuto API** - Aftermarket parts catalog

### Tires:
- **Discount Tire API** - Tire pricing and installation
- **SimpleTire API** - Online tire marketplace
- **Goodyear API** - Direct manufacturer pricing

## Implementation Notes

### Rate Limiting
The code includes error handling for API failures:
```javascript
if (!response.ok) {
  console.warn('API request failed:', response.status);
  return null; // Falls back to static pricing
}
```

### Caching (Recommended for Production)
To avoid excessive API calls:
```javascript
// Cache API responses for 1 hour
const cacheKey = `pricing_${vin}_${tireSize}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

// ... make API call ...
await redis.setex(cacheKey, 3600, JSON.stringify(result));
```

### Security
- Store API keys in `.env`, never commit to git
- Add `.env` to `.gitignore`
- Use environment variables in production (Heroku Config Vars, etc.)

## Testing API Integration

1. Add API keys to `.env`
2. Restart server: `node server.js`
3. Complete an inspection with VIN and tire size
4. Open buyer report and ask chatbot: "How much for new tires?"
5. Check server logs for API calls:
   ```
   TireRack API: Fetching prices for 275/65/15
   ✓ Got 12 tire options
   ```

## Support

Questions about API integration? Contact:
- NAPA Developer Support: developer@napaonline.com
- TireRack API Team: api@tirerack.com
