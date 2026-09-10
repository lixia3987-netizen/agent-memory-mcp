/** Imported clocks may be ahead of this host. Preserve their chronology on edits. */
export function nextUpdatedAt(memory: { created_at:string; updated_at:string }): string {
  return new Date(Math.max(Date.now(),Date.parse(memory.created_at),Date.parse(memory.updated_at))).toISOString();
}
