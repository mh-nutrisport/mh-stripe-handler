/**
 * External Stripe Handler Service
 * 
 * This is a standalone service that handles all Stripe operations.
 * It stores the STRIPE_SECRET_KEY securely and provides API endpoints
 * for the Manus backend to create checkout sessions and handle webhooks.
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { TEMP_PRICE_IDS, getPriceIdForTier } from "./prices.js";

dotenv.config();

const app = express();
const port = process.env.STRIPE_HANDLER_PORT || 4000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

const API_KEY = process.env.STRIPE_HANDLER_API_KEY || "dev-key-change-in-production";

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

/**
 * Verify API key from Manus backend
 */
function verifyApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "stripe-handler" });
});

/**
 * Create Stripe product and price
 * 
 * POST /ensure-product
 * Body: { name, amount, currency, interval, lookupKey }
 * Returns: { productId, priceId, lookupKey }
 */
app.post("/ensure-product", verifyApiKey, async (req, res) => {
  try {
    const { name, amount, currency = "eur", interval = "month", lookupKey } = req.body;

    console.log("[Stripe] ensure-product called with:", { name, amount, currency, interval, lookupKey });

    if (!name || !amount) {
      return res.status(400).json({ error: "Missing name or amount" });
    }

    // Create product
    const product = await stripe.products.create({
      name,
      type: "service",
      metadata: { lookupKey },
    });

    console.log(`[Stripe] Product created: ${product.id}`);

    // Create price
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency,
      recurring: {
        interval,
        interval_count: 1,
      },
      lookup_key: lookupKey,
      metadata: { lookupKey },
    });

    console.log(`[Stripe] Price created: ${price.id}`);
    console.log(`[Stripe] Product: ${product.id}, Price: ${price.id}, LookupKey: ${lookupKey}`);

    res.json({
      productId: product.id,
      priceId: price.id,
      lookupKey,
    });
  } catch (error) {
    console.error("[Stripe] Error creating product:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create Stripe Checkout Session
 * 
 * POST /create-checkout-session
 * Body: { email, priceId, successUrl, cancelUrl }
 * Returns: { sessionId, url }
 */
app.post("/create-checkout-session", verifyApiKey, async (req, res) => {
  try {
    const { email, priceId, successUrl, cancelUrl } = req.body;

    console.log("[Stripe] create-checkout-session called");
    console.log("[Stripe] Request body:", JSON.stringify(req.body, null, 2));
    console.log("[Stripe] Email:", email, "PriceId:", priceId);

    if (!email || !priceId) {
      console.error("[Stripe] Missing required fields");
      return res.status(400).json({ error: "Missing email or priceId" });
    }

    console.log(`[Stripe] Using price ID: ${priceId}`);

    // Create checkout session
    console.log("[Stripe] Creating checkout session...");
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl || "https://example.com/success",
      cancel_url: cancelUrl || "https://example.com/cancel",
      metadata: {
        email,
      },
    });

    console.log(`[Stripe] SUCCESS: Checkout session created: ${session.id}`);
    console.log(`[Stripe] Session URL: ${session.url}`);

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("[Stripe] ERROR creating checkout session:", error.message);
    console.error("[Stripe] Full error object:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Stripe Checkout Session details
 * 
 * GET /checkout-session/:sessionId
 * Returns: session details
 */
app.get("/checkout-session/:sessionId", verifyApiKey, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      id: session.id,
      status: session.payment_status,
      customer_email: session.customer_email,
      subscription: session.subscription,
      payment_intent: session.payment_intent,
      metadata: session.metadata,
    });
  } catch (error) {
    console.error("[Stripe] Error retrieving session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Webhook handler for Stripe events
 * 
 * POST /webhook
 */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[Stripe] STRIPE_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[Stripe] Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      console.log(`[Stripe] Checkout session completed: ${session.id}`);
      console.log(`  Email: ${session.customer_email}`);
      console.log(`  Subscription: ${session.subscription}`);
      break;
    }

    case "customer.subscription.created": {
      const subscription = event.data.object;
      console.log(`[Stripe] Subscription created: ${subscription.id}`);
      console.log(`  Customer: ${subscription.customer}`);
      console.log(`  Status: ${subscription.status}`);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      console.log(`[Stripe] Subscription updated: ${subscription.id}`);
      console.log(`  Status: ${subscription.status}`);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      console.log(`[Stripe] Subscription deleted: ${subscription.id}`);
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      console.log(`[Stripe] Payment succeeded: ${invoice.id}`);
      console.log(`  Amount: ${invoice.amount_paid}`);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.log(`[Stripe] Payment failed: ${invoice.id}`);
      break;
    }

    default:
      console.log(`[Stripe] Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

/**
 * Start server
 */
app.listen(port, () => {
  console.log(`[Stripe Handler] Server running on port ${port}`);
  console.log(`[Stripe Handler] API Key configured: ${API_KEY ? "yes" : "no"}`);
  console.log(`[Stripe Handler] Stripe Secret Key length: ${process.env.STRIPE_SECRET_KEY?.length || 0}`);
  console.log(`[Stripe Handler] Handler URL: https://mh-stripe-handler.vercel.app`);

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("[Stripe Handler] ❌ STRIPE_SECRET_KEY not set!");
  } else if (process.env.STRIPE_SECRET_KEY.length < 50) {
    console.error(
      `[Stripe Handler] ❌ STRIPE_SECRET_KEY is too short (${process.env.STRIPE_SECRET_KEY.length} chars)`
    );
  } else {
    console.log("[Stripe Handler] ✅ STRIPE_SECRET_KEY loaded successfully");
  }
});

export default app;
