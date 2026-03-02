export const PRODUCT_PRICING = {
  CLASSPILOT: { label: 'ClassPilot', basePriceDollars: 500, perStudentDollars: 2 },
  GOPILOT:    { label: 'GoPilot',    basePriceDollars: 300, perStudentDollars: 2 },
  PASSPILOT:  { label: 'PassPilot',  basePriceDollars: 0,   perStudentDollars: 2 },
};

export const BUNDLE_DISCOUNTS = { 2: 0.1, 3: 0.2 };

export function calculateInvoicePreview(products, studentCount) {
  const lineItems = products.map((key) => {
    const p = PRODUCT_PRICING[key];
    if (!p) return null;
    const baseCents = Math.round(p.basePriceDollars * 100);
    const perStudentCents = Math.round(p.perStudentDollars * 100);
    const perStudentTotalCents = perStudentCents * studentCount;
    return {
      product: key,
      label: p.label,
      baseCents,
      perStudentDollars: p.perStudentDollars,
      perStudentTotalCents,
      subtotalCents: baseCents + perStudentTotalCents,
    };
  }).filter(Boolean);

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0);
  const discountRate = BUNDLE_DISCOUNTS[products.length] ?? 0;
  const discountCents = Math.round(subtotalCents * discountRate);
  const totalCents = subtotalCents - discountCents;

  return { lineItems, subtotalCents, discountRate, discountCents, totalCents };
}

export function formatCents(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
