export const PRODUCT_PRICING = {
  CLASSPILOT: {
    label: "ClassPilot",
    basePriceDollars: 500,
    perStudentDollars: 2,
  },
  GOPILOT: {
    label: "GoPilot",
    basePriceDollars: 300,
    perStudentDollars: 2,
  },
  PASSPILOT: {
    label: "PassPilot",
    basePriceDollars: 0,
    perStudentDollars: 2,
  },
} as const;

export type ProductKey = keyof typeof PRODUCT_PRICING;

export const BUNDLE_DISCOUNTS: Record<number, number> = {
  2: 0.1,
  3: 0.2,
};

export function calculateInvoice(
  products: ProductKey[],
  studentCount: number
) {
  const lineItems = products.map((key) => {
    const p = PRODUCT_PRICING[key];
    const baseCents = Math.round(p.basePriceDollars * 100);
    const perStudentCents = Math.round(p.perStudentDollars * 100);
    const perStudentTotalCents = perStudentCents * studentCount;
    return {
      product: key,
      label: p.label,
      baseCents,
      perStudentCents,
      perStudentDollars: p.perStudentDollars,
      studentCount,
      perStudentTotalCents,
      subtotalCents: baseCents + perStudentTotalCents,
    };
  });

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0);
  const discountRate = BUNDLE_DISCOUNTS[products.length] ?? 0;
  const discountCents = Math.round(subtotalCents * discountRate);
  const totalCents = subtotalCents - discountCents;

  return {
    lineItems,
    subtotalCents,
    discountRate,
    discountCents,
    totalCents,
    productCount: products.length,
  };
}
