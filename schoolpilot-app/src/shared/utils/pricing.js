export const PRODUCT_PRICING = {
  CLASSPILOT: { label: 'ClassPilot', basePriceDollars: 0, perStudentDollars: 3 },
  GOPILOT:    { label: 'GoPilot',    basePriceDollars: 0, perStudentDollars: 3 },
  PASSPILOT:  { label: 'PassPilot',  basePriceDollars: 0, perStudentDollars: 3 },
};

// Per-student rate by number of products: 1 app = $3, 2 apps = $5, 3 apps = $7
export const PER_STUDENT_BY_PRODUCT_COUNT = { 1: 3, 2: 5, 3: 7 };

// Legacy — kept for compatibility
export const BUNDLE_DISCOUNTS = { 2: 0, 3: 0 };

export function calculateInvoicePreview(products, studentCount) {
  const productCount = products.length;
  const bundlePerStudent = PER_STUDENT_BY_PRODUCT_COUNT[productCount] ?? (productCount * 3);
  const perStudentDollars = bundlePerStudent / productCount;

  const lineItems = products.map((key) => {
    const p = PRODUCT_PRICING[key];
    if (!p) return null;
    const perStudentCents = Math.round(perStudentDollars * 100);
    const perStudentTotalCents = perStudentCents * studentCount;
    return {
      product: key,
      label: p.label,
      baseCents: 0,
      perStudentDollars,
      perStudentTotalCents,
      subtotalCents: perStudentTotalCents,
    };
  }).filter(Boolean);

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0);
  const totalCents = subtotalCents;

  return { lineItems, subtotalCents, discountRate: 0, discountCents: 0, totalCents };
}

export function formatCents(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
