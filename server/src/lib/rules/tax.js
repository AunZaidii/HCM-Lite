// Illustrative annual slab on gross x 12 (brief section 3, M6).
export function annualTax(x) {
  if (x <= 600000) return 0;
  if (x <= 1200000) return 0.05 * (x - 600000);
  if (x <= 2400000) return 30000 + 0.15 * (x - 1200000);
  if (x <= 3600000) return 210000 + 0.25 * (x - 2400000);
  return 510000 + 0.35 * (x - 3600000);
}

export const monthlyTax = (monthlyGross) => annualTax(monthlyGross * 12) / 12;
