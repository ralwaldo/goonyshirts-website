require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Printful helper ──────────────────────────────────────────────────────────
const printful = axios.create({
  baseURL: 'https://api.printful.com',
  headers: {
    Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Goonyshirts server is running 🧠' });
});

// GET /products — fetch all products from Printful with pricing
app.get('/products', async (req, res) => {
  try {
    const response = await printful.get('/store/products');
    const products = response.data.result;

    // Fetch variant details (including price) for each product
    const detailed = await Promise.all(products.map(async (p) => {
      try {
        const detail = await printful.get(`/store/products/${p.id}`);
        const variants = detail.data.result.sync_variants || [];
        const price = variants.length > 0 ? variants[0].retail_price : null;
        const variantId = variants.length > 0 ? variants[0].id : null;
        return { ...p, price, variantId };
      } catch {
        return { ...p, price: null, variantId: null };
      }
    }));

    res.json({ ...response.data, result: detailed });
  } catch (err) {
    console.error('Printful products error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch products from Printful' });
  }
});

// GET /products/:id — fetch a single product
app.get('/products/:id', async (req, res) => {
  try {
    const response = await printful.get(`/store/products/${req.params.id}`);
    res.json(response.data);
  } catch (err) {
    console.error('Printful product error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /create-checkout — create a Stripe Checkout session
app.post('/create-checkout', async (req, res) => {
  const { items } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'No items provided' });
  }

  try {
    const lineItems = items.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: item.description || '',
          images: item.image ? [item.image] : [],
          metadata: {
            printful_variant_id: item.variantId,
          },
        },
        unit_amount: Math.round(item.price * 100), // convert to cents
      },
      quantity: item.quantity || 1,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: {
        allowed_countries: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK'],
      },
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /webhook — Stripe sends payment confirmation here
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('Payment successful for session:', session.id);

    try {
      await fulfillOrder(session);
    } catch (err) {
      console.error('Fulfillment error:', err.message);
      // Still return 200 so Stripe doesn't retry — log for manual review
    }
  }

  res.json({ received: true });
});

// ─── Fulfillment ──────────────────────────────────────────────────────────────
async function fulfillOrder(session) {
  // Get full session with line items
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items.data.price.product'],
  });

  const shipping = fullSession.shipping_details;
  const lineItems = fullSession.line_items.data;

  const printfulItems = lineItems.map((item) => ({
    variant_id: parseInt(item.price.product.metadata.printful_variant_id),
    quantity: item.quantity,
  }));

  const order = {
    recipient: {
      name: shipping.name,
      address1: shipping.address.line1,
      address2: shipping.address.line2 || '',
      city: shipping.address.city,
      state_code: shipping.address.state,
      country_code: shipping.address.country,
      zip: shipping.address.postal_code,
      email: fullSession.customer_details.email,
    },
    items: printfulItems,
  };

  console.log('Sending order to Printful:', JSON.stringify(order, null, 2));
  const response = await printful.post('/orders', order);
  console.log('Printful order created:', response.data.result.id);

  // Confirm the order (move from draft to pending)
  await printful.post(`/orders/${response.data.result.id}/confirm`);
  console.log('Printful order confirmed!');
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Goonyshirts server running on port ${PORT}`);
});
