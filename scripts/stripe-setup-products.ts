// One-time script to create SchoolPilot products in Stripe catalog
// Run: npx tsx scripts/stripe-setup-products.ts

import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const PRODUCTS = [
  {
    name: "ClassPilot",
    description: "Classroom device monitoring and management. Includes flight paths, block lists, screen sharing, and real-time student activity tracking.",
    metadata: { key: "CLASSPILOT" },
  },
  {
    name: "GoPilot",
    description: "Dismissal management system. Includes homerooms, dismissal queue, parent check-in, custody alerts, and bus routes.",
    metadata: { key: "GOPILOT" },
  },
  {
    name: "PassPilot",
    description: "Digital hall pass system. Includes pass creation, kiosk mode, teacher-grade assignments, and pass tracking.",
    metadata: { key: "PASSPILOT" },
  },
];

async function main() {
  console.log("Creating SchoolPilot products in Stripe...\n");

  for (const product of PRODUCTS) {
    // Check if product already exists
    const existing = await stripe.products.search({
      query: `metadata["key"]:"${product.metadata.key}"`,
    });

    if (existing.data.length > 0) {
      console.log(`✓ ${product.name} already exists (${existing.data[0].id})`);
      continue;
    }

    const created = await stripe.products.create({
      name: product.name,
      description: product.description,
      metadata: product.metadata,
      tax_code: "txcd_10103001", // SaaS
    });

    console.log(`✓ Created ${product.name} (${created.id})`);
  }

  console.log("\nDone! Products are now visible in your Stripe Product Catalog.");
  console.log("Add the product IDs to your .env if needed:\n");

  // List all for reference
  const all = await stripe.products.list({ limit: 10 });
  for (const p of all.data) {
    if (p.metadata.key) {
      console.log(`  STRIPE_PRODUCT_${p.metadata.key}=${p.id}`);
    }
  }
}

main().catch(console.error);
