export function rankScore(bm25: number, importance: number, updatedAt: number, now: number, importanceBoost: number, recencyBoost: number): number {
  const ageDays = Math.max(0, now - updatedAt) / 86400000;
  // Multiplicative boosts cannot promote non-matching records into the candidate set.
  return Math.max(0, -bm25) * (1 + importanceBoost * importance / 10 + recencyBoost / (1 + ageDays / 90));
}
export function literalFtsQuery(query: string): string {
  return query.trim().split(/\s+/u).map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
}
