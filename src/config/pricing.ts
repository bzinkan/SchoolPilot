export const PRODUCT_PRICING = {
  CLASSPILOT: {
    label: "ClassPilot",
    basePriceDollars: 0,
    perStudentDollars: 3,
    stripeProductId: process.env.STRIPE_PRODUCT_CLASSPILOT || "prod_U6MPNh7Ygg2xZ5",
  },
  GOPILOT: {
    label: "GoPilot",
    basePriceDollars: 0,
    perStudentDollars: 3,
    stripeProductId: process.env.STRIPE_PRODUCT_GOPILOT || "prod_U6MPwHnROzofRz",
  },
  PASSPILOT: {
    label: "PassPilot",
    basePriceDollars: 0,
    perStudentDollars: 3,
    stripeProductId: process.env.STRIPE_PRODUCT_PASSPILOT || "prod_U6MPEdSLnMl3Or",
  },
} as const;

export type ProductKey = keyof typeof PRODUCT_PRICING;

// Per-student rate by number of products: 1 app = $3, 2 apps = $5 ($2.50 each), 3 apps = $7 (~$2.33 each)
export const PER_STUDENT_BY_PRODUCT_COUNT: Record<number, number> = {
  1: 3,
  2: 5,
  3: 7,
};

// 24/7 monitoring add-on: $1/student/year
export const MONITORING_24_7_PER_STUDENT = 1;

// Legacy — kept for compatibility but no longer used
export const BUNDLE_DISCOUNTS: Record<number, number> = {
  2: 0,
  3: 0,
};

export function calculateInvoice(
  products: ProductKey[],
  studentCount: number,
  options?: { has24x7Monitoring?: boolean }
) {
  const productCount = products.length;
  const bundlePerStudent = PER_STUDENT_BY_PRODUCT_COUNT[productCount] ?? (productCount * 3);
  const perStudentDollars = bundlePerStudent / productCount;

  const lineItems = products.map((key) => {
    const p = PRODUCT_PRICING[key];
    const baseCents = 0;
    const perStudentCents = Math.round(perStudentDollars * 100);
    const perStudentTotalCents = perStudentCents * studentCount;
    return {
      product: key,
      label: p.label,
      baseCents,
      perStudentCents,
      perStudentDollars,
      studentCount,
      perStudentTotalCents,
      subtotalCents: perStudentTotalCents,
    };
  });

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0);

  // 24/7 monitoring add-on
  const addonCents = options?.has24x7Monitoring
    ? MONITORING_24_7_PER_STUDENT * 100 * studentCount
    : 0;

  const totalCents = subtotalCents + addonCents;

  return {
    lineItems,
    subtotalCents,
    addonCents,
    addonLabel: options?.has24x7Monitoring ? "24/7 Monitoring" : null,
    discountRate: 0,
    discountCents: 0,
    totalCents,
    productCount,
  };
}
