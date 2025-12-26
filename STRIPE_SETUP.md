# Stripe Configuration

## Setup Instructions

1. **Get Stripe API Keys**
   - Sign up at https://stripe.com
   - Get your API keys from the Stripe Dashboard
   - Use test keys for development (starts with `sk_test_` and `pk_test_`)

2. **Add to Environment Variables**
   
   Create or update `.env` file in the project root:
   
   ```bash
   # Stripe Configuration (REQUIRED for checkout)
   STRIPE_SECRET_KEY=sk_test_your_secret_key_here
   STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key_here
   ```

3. **Restart the Server**
   ```bash
   node server.js
   ```

4. **Test Checkout Flow**
   - Visit http://localhost:3000/pricing.html
   - Click "Get Started" on any tier
   - Complete checkout with Stripe test card: `4242 4242 4242 4242`
   - Use any future expiration date and any CVC

## Production Checklist

Before going live:

- [ ] Replace test keys with live keys (`sk_live_` and `pk_live_`)
- [ ] Enable HTTPS/SSL on your domain
- [ ] Verify webhook endpoints (for payment confirmation)
- [ ] Test with real payment methods
- [ ] Set up Stripe webhook to handle `checkout.session.completed` event
- [ ] Add refund policy and terms of service links

## Security Notes

- ✅ All payment processing happens on Stripe's secure servers
- ✅ No credit card data touches your server
- ✅ API keys are loaded from environment variables (never committed to git)
- ✅ Success URL includes session_id for verification
- ⚠️ Add `.env` to `.gitignore` to prevent accidental commits
