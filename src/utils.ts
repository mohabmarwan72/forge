import type { DayData, Session } from "./types";

export function todayKey(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return todayKey(date);
}

export function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTrayTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function formatHoursMinutes(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function hoursToMs(hours: number): number {
  return Math.round(hours * 3600_000);
}

export function msToHours(ms: number): number {
  return ms / 3600_000;
}

export function sessionDurationMs(s: Session): number {
  return Math.max(0, s.endMs - s.startMs);
}

export function projectSpentMs(day: DayData, projectId: string): number {
  return day.sessions
    .filter((s) => s.projectId === projectId)
    .reduce((acc, s) => acc + sessionDurationMs(s), 0);
}

export function daySpentMs(day: DayData): number {
  return day.sessions.reduce((acc, s) => acc + sessionDurationMs(s), 0);
}

export const SESSION_BLOCK_MS = 50 * 60 * 1000;

export function sessionsCompleted(day: DayData, liveMs: number = 0): number {
  return Math.floor((daySpentMs(day) + liveMs) / SESSION_BLOCK_MS);
}

export function sessionProgressMs(day: DayData, liveMs: number = 0): number {
  return (daySpentMs(day) + liveMs) % SESSION_BLOCK_MS;
}

export const BREAK_MAX_MS = 20 * 60 * 1000;
export const BREAK_DURATION_OPTIONS_MIN = [5, 10, 15, 20] as const;

export function dayBreakMs(day: DayData, liveBreakMs: number = 0): number {
  return (
    (day.breaks ?? []).reduce((acc, b) => acc + (b.endMs - b.startMs), 0) +
    liveBreakMs
  );
}

export function dayTargetMs(day: DayData): number {
  return hoursToMs(day.goalHours ?? 0);
}

export function dayRemainingMs(day: DayData, liveMs: number = 0): number {
  return Math.max(0, dayTargetMs(day) - daySpentMs(day) - liveMs);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function formatDateHeader(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function startOfWeek(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  date.setDate(date.getDate() + diff);
  return todayKey(date);
}

export function weekKeys(dateKey: string): string[] {
  const start = startOfWeek(dateKey);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const STREAK_THRESHOLD_HOURS_EXTERN = 8;
const STREAK_THRESHOLD_MS = STREAK_THRESHOLD_HOURS_EXTERN * 3600_000;
const STREAK_GRACE_DAYS_EXTERN = 3;
export const SHIELD_MAX = 2;
export const SHIELD_THRESHOLDS = [7, 60]; // streak days to earn shield #1 and #2
export const SHIELD_REGEN_STREAK = 180; // streak day when regen kicks in
export const SHIELD_REGEN_EVERY_DAYS = 60; // regen frequency after regen streak
export const DECAY_PERIOD_DAYS = 7; // additional 50% decay every N days
export const DECAY_RATIO = 0.5;
export const LP_DECAY_PER_DAY_GM = 10;

export function computeStreak(
  days: Record<string, DayData>,
  todayKey: string,
): number {
  return computeStreakState(days, todayKey).streak;
}

export type StreakState = {
  streak: number;
  shields: number;
  inDecay: boolean;
  /** Number of missed days since shields ran out (includes the current one). */
  decayDays: number;
  /** Total LP lost today from GM+ inactivity decay (for display). */
  lpDecayToday: number;
};

/**
 * Walks every logged day from earliest to today, applying:
 *  - streak gain on 8h+ days
 *  - 3-day grace on misses
 *  - shield consumption beyond grace
 *  - 50% decay once grace + shields depleted, then every 7 extra days
 */
export function computeStreakState(
  days: Record<string, DayData>,
  todayKey: string,
): StreakState {
  const sortedKeys = Object.keys(days).sort();
  const earliestKey = sortedKeys[0];
  if (!earliestKey) {
    return {
      streak: 0,
      shields: 0,
      inDecay: false,
      decayDays: 0,
      lpDecayToday: 0,
    };
  }

  let streak = 0;
  let shields = 0;
  let missedInARow = 0;
  let shielelessMisses = 0;
  let nextRegenAtStreak = SHIELD_REGEN_STREAK;

  const hit = (key: string) => {
    const d = days[key];
    return d ? daySpentMs(d) >= STREAK_THRESHOLD_MS : false;
  };

  let date = earliestKey;
  let guard = 0;
  while (date <= todayKey && guard < 4000) {
    guard++;
    if (hit(date)) {
      streak++;
      missedInARow = 0;
      shielelessMisses = 0;
      // Earn first two shields at fixed thresholds
      if (streak === SHIELD_THRESHOLDS[0] && shields < SHIELD_MAX) shields++;
      if (streak === SHIELD_THRESHOLDS[1] && shields < SHIELD_MAX) shields++;
      // Regen after the regen streak, every N streak days
      if (
        streak >= SHIELD_REGEN_STREAK &&
        streak === nextRegenAtStreak &&
        shields < SHIELD_MAX
      ) {
        shields++;
      }
      if (streak >= nextRegenAtStreak) {
        nextRegenAtStreak = streak + SHIELD_REGEN_EVERY_DAYS;
      }
    } else {
      missedInARow++;
      if (missedInARow <= STREAK_GRACE_DAYS_EXTERN) {
        // Within 3-day grace, nothing happens to streak or shields
      } else if (shields > 0) {
        shields--;
      } else {
        shielelessMisses++;
        // Immediate −50% on first shieldless miss, and every 7 more.
        if (
          shielelessMisses === 1 ||
          (shielelessMisses - 1) % DECAY_PERIOD_DAYS === 0
        ) {
          streak = Math.floor(streak * DECAY_RATIO);
          if (streak === 0) shielelessMisses = 0; // streak fully gone
        }
      }
    }
    date = addDays(date, 1);
  }

  return {
    streak,
    shields,
    inDecay: shielelessMisses > 0,
    decayDays: shielelessMisses,
    lpDecayToday: 0, // filled by caller if needed per-day
  };
}

/**
 * LP penalty for being away at GM+ while streak is in decay.
 * Called as part of seasonal LP computation.
 */
export function computeLPDecay(
  days: Record<string, DayData>,
  todayKey: string,
  currentLP: number,
): number {
  const rank = computeRank(currentLP);
  if (rank.tierIndex < 9) return 0;
  const state = computeStreakState(days, todayKey);
  return state.decayDays * LP_DECAY_PER_DAY_GM;
}

export const RANKS = [
  "Wood",
  "Iron",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Emerald",
  "Diamond",
  "Master",
  "Grand Master",
  "Challenger",
] as const;

export const DIVISIONS_PER_RANK = 3;
export const LP_PER_DIVISION = 100;
export const LP_PER_RANK = LP_PER_DIVISION * DIVISIONS_PER_RANK;

// Ranks 0-8 (Wood through Master) have 3 divisions of 100 LP each.
// Grand Master is a single 500 LP window. Challenger is unlimited above that.
export const DIVISIONED_TIERS = 9;
export const GM_TIER_INDEX = 9;
export const CHALLENGER_TIER_INDEX = 10;
export const LP_TO_REACH_GM = DIVISIONED_TIERS * DIVISIONS_PER_RANK * LP_PER_DIVISION; // 2700
export const LP_GM_WINDOW = 500;
export const LP_TO_REACH_CHALLENGER = LP_TO_REACH_GM + LP_GM_WINDOW; // 3200

// Journey length from Wood III to reaching Challenger (ignoring that it's
// then unlimited). Useful for "how close are you" displays.
export const TOTAL_DIVISIONS = DIVISIONED_TIERS * DIVISIONS_PER_RANK;
export const MAX_LP = LP_TO_REACH_CHALLENGER;

export const LP_PER_HOUR = 6;
export const LP_PER_OVERTIME_HOUR = 8;
export const LP_PENALTY_PER_MISSED_HOUR = 3;
export const MIN_GOAL_HOURS = 4;
export const MAX_GOAL_HOURS = 24;
export const BONUS_THRESHOLD_HOURS = 10;
export const STREAK_THRESHOLD_HOURS = STREAK_THRESHOLD_HOURS_EXTERN;
export const STREAK_GRACE_DAYS = 3;

/**
 * Compute the LP for a single day.
 *
 * Earn: +6 LP/hour for hours 0–10. If goal > 10 and you pass 10, additional
 * hours earn +7.5 LP/hour (×1.25 bonus). If goal ≤ 10, hours past 10 still
 * count at the normal +6 rate.
 *
 * Penalty (past days only): −3 LP/hour short of your goal, with the penalty
 * target clamped to [4h .. 10h]. Goals below 4h still penalize as if it were
 * 4h; goals above 10h never penalize for the hours above 10.
 */
export function computeDayLP(
  day: DayData,
  isPast: boolean,
): number {
  const workedHours = msToHours(daySpentMs(day));
  // Only the locked day goal drives LP math. Allocation sums are ignored so
  // removing projects can never shrink your goal retroactively.
  const goalHours = day.goalHours ?? 0;

  const regular = Math.min(workedHours, BONUS_THRESHOLD_HOURS);
  const overtime = Math.max(0, workedHours - BONUS_THRESHOLD_HOURS);
  const overtimeRate =
    goalHours > BONUS_THRESHOLD_HOURS ? LP_PER_OVERTIME_HOUR : LP_PER_HOUR;
  const earned = regular * LP_PER_HOUR + overtime * overtimeRate;

  let penalty = 0;
  if (isPast && goalHours > 0) {
    const penalizedTarget = Math.min(
      Math.max(goalHours, MIN_GOAL_HOURS),
      BONUS_THRESHOLD_HOURS,
    );
    const missed = Math.max(0, penalizedTarget - workedHours);
    penalty = missed * LP_PENALTY_PER_MISSED_HOUR;
  }

  return earned - penalty;
}

export function computeTotalLP(
  days: Record<string, DayData>,
  todayKey: string,
): number {
  let total = 0;
  for (const day of Object.values(days)) {
    total += computeDayLP(day, day.date !== todayKey);
  }
  return Math.max(0, Math.floor(total));
}

export const DIVISION_ROMAN = ["III", "II", "I"] as const;

export type RankInfo = {
  tier: string;
  tierIndex: number;
  /** -1 for GM / Challenger (they have no divisions) */
  division: number;
  /** Empty string for GM / Challenger */
  divisionRoman: string;
  /** LP within the current division / GM window / Challenger (uncapped) */
  lp: number;
  /** LP needed to reach next tier; 0 for Challenger (no ceiling) */
  lpToNext: number;
  /** Name of the next tier, or null if at Challenger */
  nextTier: string | null;
  totalLP: number;
  isMax: boolean;
};

export function computeRank(totalLP: number): RankInfo {
  const clamped = Math.max(0, totalLP);

  if (clamped >= LP_TO_REACH_CHALLENGER) {
    return {
      tier: RANKS[CHALLENGER_TIER_INDEX],
      tierIndex: CHALLENGER_TIER_INDEX,
      division: -1,
      divisionRoman: "",
      lp: clamped - LP_TO_REACH_CHALLENGER,
      lpToNext: 0,
      nextTier: null,
      totalLP,
      isMax: true,
    };
  }
  if (clamped >= LP_TO_REACH_GM) {
    const lp = clamped - LP_TO_REACH_GM;
    return {
      tier: RANKS[GM_TIER_INDEX],
      tierIndex: GM_TIER_INDEX,
      division: -1,
      divisionRoman: "",
      lp,
      lpToNext: LP_GM_WINDOW - lp,
      nextTier: RANKS[CHALLENGER_TIER_INDEX],
      totalLP,
      isMax: false,
    };
  }
  const divisionIndex = Math.floor(clamped / LP_PER_DIVISION);
  const tierIndex = Math.min(
    DIVISIONED_TIERS - 1,
    Math.floor(divisionIndex / DIVISIONS_PER_RANK),
  );
  const division = divisionIndex % DIVISIONS_PER_RANK;
  const lp = clamped - divisionIndex * LP_PER_DIVISION;
  const isLastDivisionOfTier = division === DIVISIONS_PER_RANK - 1;
  const nextTier = isLastDivisionOfTier
    ? tierIndex === DIVISIONED_TIERS - 1
      ? RANKS[GM_TIER_INDEX]
      : RANKS[tierIndex + 1]
    : `${RANKS[tierIndex]} ${DIVISION_ROMAN[division + 1]}`;
  return {
    tier: RANKS[tierIndex],
    tierIndex,
    division,
    divisionRoman: DIVISION_ROMAN[division],
    lp,
    lpToNext: LP_PER_DIVISION - lp,
    nextTier,
    totalLP,
    isMax: false,
  };
}

/**
 * Season-aware LP. Only sums earnings/penalties within the season window
 * and adds placement boost. Today is exempt from penalty (still in progress).
 */
export function computeSeasonalLP(
  days: Record<string, DayData>,
  todayKey: string,
  seasonStartDate: string,
  seasonStartLP: number,
  seasonEndDate?: string,
): number {
  let earned = 0;
  for (const day of Object.values(days)) {
    if (day.date < seasonStartDate) continue;
    if (seasonEndDate && day.date > seasonEndDate) continue;
    earned += computeDayLP(day, day.date !== todayKey);
  }
  return Math.max(0, Math.floor(seasonStartLP + earned));
}

/**
 * For each day in the season, compute the tier you ended that day at
 * and count how many days you spent at each tier.
 */
export function computeDailyRankHistogram(
  days: Record<string, DayData>,
  seasonStartDate: string,
  seasonStartLP: number,
  seasonEndDate?: string,
): Record<string, number> {
  const sorted = Object.values(days)
    .filter(
      (d) =>
        d.date >= seasonStartDate &&
        (!seasonEndDate || d.date <= seasonEndDate),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let running = seasonStartLP;
  const counts: Record<string, number> = {};
  for (const day of sorted) {
    running = Math.max(0, running + computeDayLP(day, true));
    const r = computeRank(Math.floor(running));
    counts[r.tier] = (counts[r.tier] ?? 0) + 1;
  }
  return counts;
}

/**
 * Placement boost for a new season: drop one tier below last season's final
 * tier and start at the lowest division (III) of that tier with 0 LP.
 */
export function placementBoostLP(finalTierIndex: number): number {
  const newTierIndex = Math.max(0, finalTierIndex - 1);
  if (newTierIndex === CHALLENGER_TIER_INDEX) return LP_TO_REACH_CHALLENGER;
  if (newTierIndex === GM_TIER_INDEX) return LP_TO_REACH_GM;
  return newTierIndex * DIVISIONS_PER_RANK * LP_PER_DIVISION;
}

export function yearOfDateKey(dateKey: string): number {
  return Number(dateKey.slice(0, 4));
}

export function januaryFirst(year: number): string {
  return `${year}-01-01`;
}

export function decemberLast(year: number): string {
  return `${year}-12-31`;
}

// Money helpers

export function monthKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function monthKeyFromDateKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function formatMoney(cents: number, symbol: string = "$"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const fraction = abs % 100;
  const dollarStr = dollars.toLocaleString();
  return `${sign}${symbol}${dollarStr}.${String(fraction).padStart(2, "0")}`;
}

export function quarterKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

export function yearKey(monthKey: string): string {
  return monthKey.slice(0, 4);
}

export function monthsAgo(mk: string, n: number): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return monthKey(d);
}

export function quarterRange(year: number, q: number): string[] {
  const startMonth = (q - 1) * 3 + 1;
  return [0, 1, 2].map((i) => {
    const m = startMonth + i;
    return `${year}-${String(m).padStart(2, "0")}`;
  });
}

export function formatMonthHeader(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function daysLeftInMonth(d: Date = new Date()): number {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Math.max(0, last - d.getDate());
}
