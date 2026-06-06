import { createHmac, timingSafeEqual } from "crypto";

export type CheckoutInput = {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  customerEmail: string;
  appUrl: string;
};

export type CheckoutResult = {
  provider: string;
  status: "active" | "checkout_required";
  checkoutSessionId?: string;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: Date;
  url?: string;
};

export type BillingWebhookResult = {
  workspaceId?: string;
  customerId?: string;
  subscriptionId?: string;
  checkoutSessionId?: string;
  status: "ACTIVE" | "PAST_DUE" | "CANCELED";
  currentPeriodEnd?: Date;
};

export interface BillingProvider {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  verifyConfiguration?(): Promise<void>;
  parseWebhook?(request: Request): Promise<BillingWebhookResult | null>;
}

export class MockBillingProvider implements BillingProvider {
  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    return {
      provider: "mock",
      status: "active",
      customerId: `mock_customer_${input.workspaceSlug}`,
      subscriptionId: `mock_subscription_${input.workspaceSlug}`,
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    };
  }

}

export class StripeBillingProvider implements BillingProvider {
  constructor(
    private readonly secretKey = process.env.STRIPE_SECRET_KEY,
    private readonly priceId = process.env.STRIPE_PRICE_ID,
    private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    if (!this.secretKey || !this.priceId) {
      throw new Error("STRIPE_SECRET_KEY and STRIPE_PRICE_ID are required for Stripe billing");
    }

    const params = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": this.priceId,
      "line_items[0][quantity]": "1",
      customer_email: input.customerEmail,
      client_reference_id: input.workspaceId,
      success_url: `${input.appUrl}?checkout=success`,
      cancel_url: `${input.appUrl}?checkout=canceled`,
      "metadata[workspaceId]": input.workspaceId,
      "subscription_data[metadata][workspaceId]": input.workspaceId,
    });

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!response.ok) {
      throw new Error(`Stripe checkout failed: ${response.status}`);
    }

    const session = (await response.json()) as {
      id: string;
      url?: string;
      customer?: string;
      subscription?: string;
    };

    return {
      provider: "stripe",
      status: "checkout_required",
      checkoutSessionId: session.id,
      customerId: typeof session.customer === "string" ? session.customer : undefined,
      subscriptionId: typeof session.subscription === "string" ? session.subscription : undefined,
      url: session.url,
    };
  }

  async verifyConfiguration() {
    if (!this.secretKey || !this.priceId) {
      throw new Error("STRIPE_SECRET_KEY and STRIPE_PRICE_ID are required for Stripe billing");
    }

    const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(this.priceId)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    if (!response.ok) {
      throw new Error(`Stripe price validation failed: ${response.status}`);
    }

    const price = (await response.json()) as { id?: string; active?: boolean };
    if (price.id !== this.priceId || price.active === false) {
      throw new Error("Stripe price is missing or inactive");
    }
  }

  async parseWebhook(request: Request): Promise<BillingWebhookResult | null> {
    if (!this.webhookSecret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe billing webhooks");
    }
    const payload = await request.text();
    verifyStripeWebhookSignature(
      payload,
      request.headers.get("stripe-signature"),
      this.webhookSecret,
    );
    const event = JSON.parse(payload) as {
      type?: string;
      data?: {
        object?: {
          id?: string;
          client_reference_id?: string;
          customer?: string;
          subscription?: string;
          status?: string;
          metadata?: Record<string, string>;
          current_period_end?: number;
        };
      };
    };
    const object = event.data?.object;
    if (!event.type || !object) return null;

    if (event.type === "checkout.session.completed") {
      const workspaceId = object.client_reference_id || object.metadata?.workspaceId;
      if (!workspaceId) return null;
      return {
        workspaceId,
        checkoutSessionId: object.id,
        customerId: object.customer,
        subscriptionId: object.subscription,
        status: "ACTIVE",
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      };
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const workspaceId = object.metadata?.workspaceId;
      if (!workspaceId) return null;
      return {
        workspaceId,
        customerId: object.customer,
        subscriptionId: object.id,
        status: object.status === "active" || object.status === "trialing" ? "ACTIVE" : object.status === "canceled" ? "CANCELED" : "PAST_DUE",
        currentPeriodEnd: object.current_period_end ? new Date(object.current_period_end * 1000) : undefined,
      };
    }

    return null;
  }
}

export function getBillingProvider(): BillingProvider {
  if (process.env.BILLING_PROVIDER === "stripe") {
    return new StripeBillingProvider();
  }
  return new MockBillingProvider();
}

const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

function verifyStripeWebhookSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
) {
  if (!signatureHeader) {
    throw new Error("Stripe webhook signature missing");
  }
  const pairs = signatureHeader
    .split(",")
    .map((part) => part.split("=") as [string, string | undefined]);
  const timestamp = pairs.find(([key]) => key === "t")?.[1];
  const signatures = pairs
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter(Boolean) as string[];
  if (!timestamp || signatures.length === 0) {
    throw new Error("Stripe webhook signature malformed");
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Stripe webhook timestamp malformed");
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Stripe webhook timestamp outside tolerance");
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const valid = signatures.some((signature) => {
    const signatureBuffer = Buffer.from(signature, "hex");
    return signatureBuffer.length === expectedBuffer.length && timingSafeEqual(signatureBuffer, expectedBuffer);
  });
  if (!valid) {
    throw new Error("Stripe webhook signature invalid");
  }
}
