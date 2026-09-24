/** Human-friendly Spanish timestamps for chat lists. */
export function formatRelativeDate(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayMs = 86_400_000;
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  if (timestamp >= startOfToday) return `Hoy · ${time}`;
  if (timestamp >= startOfToday - dayMs) return `Ayer · ${time}`;
  if (timestamp >= startOfToday - 6 * dayMs) {
    const weekday = date.toLocaleDateString('es-ES', { weekday: 'long' });
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} · ${time}`;
  }
  return date.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

export function formatSeconds(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Validates a YYYY-MM-DD birthday that is a real, past date. */
export function isValidBirthday(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    year >= 1900 &&
    date.getTime() <= Date.now()
  );
}
