
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const apiKey = process.env.STRIPE_HANDLER_API_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY");
}

if (!apiKey) {
  throw new Error("Missing STRIPE_HANDLER_API_KEY");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-04-10",
});

function verifyApiKey(req, res, next) {
  const incoming = req.headers["x-api-key"];
  if (!incoming || incoming !== apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "stripe-handler",
  });
});

app.post("/create-checkout-session", express.json(), verifyApiKey, async (req, res) => {
  try {
    const { email, priceId, successUrl, cancelUrl } = req.body;

    if (!email || !priceId) {
      return res.status(400).json({ error: "Missing email or priceId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl || "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: cancelUrl || "https://example.com/cancel",
      metadata: {
        email,
      },
    });

    return res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Checkout session error:", error);
    return res.status(500).json({
      error: error.message || "Failed to create checkout session",
    });
  }
});

app.post("/ensure-product", express.json(), verifyApiKey, async (req, res) => {
  try {
    const { name, amount, currency, interval, lookupKey } = req.body;

    if (!name || !amount || !currency || !interval || !lookupKey) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const products = await stripe.products.list({ active: true, limit: 100 });
    let product = products.data.find((p) => p.metadata?.lookupKey === lookupKey);

    if (!product) {
      product = await stripe.products.create({
        name,
        metadata: { lookupKey },
      });
    }

    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      limit: 100,
    });

    let price = prices.data.find(
      (p) =>
        p.unit_amount === amount &&
        p.currency === currency &&
        p.recurring?.interval === interval
    );

    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: amount,
        currency,
        recurring: { interval },
        lookup_key: lookupKey,
      });
    }

    return res.json({
      productId: product.id,
      priceId: price.id,
    });
  } catch (error) {
    console.error("Ensure product error:", error);
    return res.status(500).json({
      error: error.message || "Failed to ensure product",
    });
  }
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!stripeWebhookSecret) {
      return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    const signature = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);

    switch (event.type) {
      case "checkout.session.completed":
        console.log("checkout.session.completed", event.data.object.id);
        break;
      case "customer.subscription.created":
        console.log("customer.subscription.created", event.data.object.id);
        break;
      case "customer.subscription.updated":
        console.log("customer.subscription.updated", event.data.object.id);
        break;
      case "customer.subscription.deleted":
        console.log("customer.subscription.deleted", event.data.object.id);
        break;
      case "invoice.payment_succeeded":
        console.log("invoice.payment_succeeded", event.data.object.id);
        break;
      case "invoice.payment_failed":
        console.log("invoice.payment_failed", event.data.object.id);
        break;
      default:
        console.log("Unhandled event:", event.type);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Stripe handler running on port ${port}`);
});
