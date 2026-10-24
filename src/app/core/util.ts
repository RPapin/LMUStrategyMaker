export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

const pad = (n: number, len = 2) => String(Math.floor(n)).padStart(len, '0');

/** 125.432 -> "2:05.432" */
export function formatLap(sec: number): string {
  if (!isFinite(sec)) return '-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Accepts "2:05.432", "2:05", "125.4". Returns NaN when invalid. */
export function parseLap(text: string): number {
  const t = text.trim().replace(',', '.');
  if (!t) return NaN;
  const parts = t.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!isFinite(v) || v < 0) return NaN;
    total = total * 60 + v;
  }
  return total;
}

/** 3725 -> "1:02:05" */
export function formatDuration(sec: number): string {
  if (!isFinite(sec)) return '-';
  const neg = sec < 0;
  sec = Math.round(Math.abs(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${neg ? '-' : ''}${h}:${pad(m)}:${pad(s)}`;
}

/** 3725 -> "1h02" */
export function formatHours(sec: number): string {
  const totalMin = Math.round(sec / 60);
  return `${Math.floor(totalMin / 60)}h${pad(totalMin % 60)}`;
}

export function startEpoch(startTime: string): number {
  const t = new Date(startTime).getTime();
  return isNaN(t) ? Date.now() : t;
}

/** Real clock time for a race-clock second. */
export function clockAt(startTime: string, raceSec: number, withDay = false): string {
  const d = new Date(startEpoch(startTime) + raceSec * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}` : hm;
}

/** Real clock time with seconds ("14:05:09") for a race-clock second. */
export function clockSecAt(startTime: string, raceSec: number): string {
  const d = new Date(startEpoch(startTime) + raceSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Race-clock second for a real clock time ("14:05" or "14:05:09"). The day is the one that puts it
 * closest to `nearSec`, so long races going past midnight work. NaN when invalid.
 */
export function raceSecAt(startTime: string, clock: string, nearSec: number): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim());
  if (!m) return NaN;
  const start = startEpoch(startTime);
  const day = new Date(start + nearSec * 1000);
  day.setHours(+m[1], +m[2], +(m[3] ?? 0), 0);
  let best = NaN;
  for (const offset of [-1, 0, 1]) {
    const sec = (day.getTime() + offset * 86_400_000 - start) / 1000;
    if (isNaN(best) || Math.abs(sec - nearSec) < Math.abs(best - nearSec)) best = sec;
  }
  return best;
}

/** epoch ms -> value for <input type="datetime-local"> */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
