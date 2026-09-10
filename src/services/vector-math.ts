export function cosine(a: number[],b: number[]): number {
  if (a.length!==b.length || !a.length) return 0;
  let dot=0,aa=0,bb=0;
  for (let i=0;i<a.length;i++) { dot+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2; }
  return aa && bb ? Math.max(-1,Math.min(1,dot/Math.sqrt(aa*bb))) : 0;
}
export function rrf(rankings: string[][],k=60): Map<string,number> {
  const scores=new Map<string,number>();
  for (const ranking of rankings) [...new Set(ranking)].forEach((id,i)=>scores.set(id,(scores.get(id) ?? 0)+1/(k+i+1)));
  return scores;
}
function shingles(text: string): Set<string> {
  const normalized=text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
  const points=Array.from(normalized);
  if (points.length<3) return new Set([normalized]);
  const result=new Set<string>();for (let i=0;i<points.length-2;i++) result.add(points.slice(i,i+3).join(''));return result;
}
export function textSimilarity(a: string,b: string): number {
  const left=shingles(a),right=shingles(b);let overlap=0;
  for (const term of left) if (right.has(term)) overlap++;
  return left.size+right.size ? 2*overlap/(left.size+right.size) : 1;
}
