export const CONTENT_CATEGORIES = Object.freeze([
  'Gaming', 'Social media', 'Video', 'Music', 'Messaging', 'Forums', 'Shopping', 'Sports', 'News', 'Entertainment',
  'AI tools', 'Finance', 'Travel', 'Lifestyle', 'Technology', 'Health', 'Education', 'Reference', 'Productivity', 'Gambling',
]);
export function contentCategory(value) { return CONTENT_CATEGORIES.includes(value) ? value : null; }
export function normalizeCategoryBreakdown(value, expectedSeconds) {
  if (!Array.isArray(value) || !Number.isSafeInteger(expectedSeconds) || expectedSeconds < 0) return null;
  const rows = value.map(row => ({ contentCategory: contentCategory(row?.contentCategory), seconds: Number(row?.seconds) }));
  if (rows.some(row => !Number.isSafeInteger(row.seconds) || row.seconds < 0)) return null;
  if (rows.reduce((sum, row) => sum + row.seconds, 0) !== expectedSeconds) return null;
  return rows;
}
