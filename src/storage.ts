import { Store } from "@tauri-apps/plugin-store";
import type {
  CurrentTimer,
  DayData,
  Earning,
  Project,
  SeasonSnapshot,
  Settings,
} from "./types";
import {
  fileMtime as syncFileMtime,
  initSync,
  readBlob,
  thisDevice,
  writeBlobIfNotStale,
  type SyncBlob,
} from "./sync";

const LEGACY_STORE_FILE = "hour-tracker.json";

let legacyStorePromise: Promise<Store> | null = null;

async function getLegacyStore(): Promise<Store> {
  if (!legacyStorePromise) {
    legacyStorePromise = Store.load(LEGACY_STORE_FILE);
  }
  return legacyStorePromise;
}

let cache: SyncBlob | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let remoteOverrideCallback: ((blob: SyncBlob) => void) | null = null;

export function onRemoteOverride(cb: (blob: SyncBlob) => void) {
  remoteOverrideCallback = cb;
}

async function ensureLoaded(): Promise<SyncBlob> {
  if (cache) return cache;
  cache = await initSync();
  return cache;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!cache) return;
    try {
      const result = await writeBlobIfNotStale(cache, cache.updatedMs);
      if (result.kind === "stale") {
        cache = result.freshBlob;
        remoteOverrideCallback?.(result.freshBlob);
      } else {
        cache = result.blob;
      }
    } catch (err) {
      console.error("writeBlob failed", err);
    }
  }, 250);
}

export async function initStorage(): Promise<SyncBlob> {
  return await ensureLoaded();
}

export async function loadProjects(): Promise<Project[]> {
  return (await ensureLoaded()).projects;
}

export async function saveProjects(projects: Project[]) {
  const c = await ensureLoaded();
  c.projects = projects;
  scheduleSave();
}

export async function loadDays(): Promise<Record<string, DayData>> {
  return (await ensureLoaded()).days;
}

export async function saveDays(days: Record<string, DayData>) {
  const c = await ensureLoaded();
  c.days = days;
  scheduleSave();
}

export async function loadSettings(): Promise<Settings> {
  const s = (await ensureLoaded()).settings;
  return {
    carryOverFactor: s?.carryOverFactor ?? 0.25,
    theme: s?.theme ?? "blue",
    showMenubarTimer: s?.showMenubarTimer ?? true,
    currencySymbol: s?.currencySymbol ?? "$",
    notifications: s?.notifications ?? true,
    launchAtLogin: s?.launchAtLogin ?? false,
    idleThresholdMin: s?.idleThresholdMin ?? 10,
    shareCurrentProject: s?.shareCurrentProject ?? true,
  };
}

export async function saveSettings(settings: Settings) {
  const c = await ensureLoaded();
  c.settings = settings;
  scheduleSave();
}

export async function loadCurrentTimer(): Promise<CurrentTimer> {
  return (await ensureLoaded()).currentTimer ?? null;
}

export async function saveCurrentTimer(timer: CurrentTimer) {
  const c = await ensureLoaded();
  c.currentTimer = timer;
  scheduleSave();
}

export async function loadEarnings(): Promise<Earning[]> {
  return (await ensureLoaded()).earnings ?? [];
}

export async function saveEarnings(earnings: Earning[]) {
  const c = await ensureLoaded();
  c.earnings = earnings;
  scheduleSave();
}

export async function loadMonthlyGoals(): Promise<Record<string, number>> {
  return (await ensureLoaded()).monthlyGoals ?? {};
}

export async function saveMonthlyGoals(goals: Record<string, number>) {
  const c = await ensureLoaded();
  c.monthlyGoals = goals;
  scheduleSave();
}

export async function loadSeasons(): Promise<Record<string, SeasonSnapshot>> {
  return (await ensureLoaded()).seasons ?? {};
}

export async function saveSeasons(seasons: Record<string, SeasonSnapshot>) {
  const c = await ensureLoaded();
  c.seasons = seasons;
  scheduleSave();
}

/**
 * Legacy one-time migration from the old per-day embedded-projects model
 * stored in tauri-plugin-store. Only runs when the iCloud blob hasn't been
 * initialized yet. Callers normally just use initStorage().
 */
export async function migrateIfNeeded(): Promise<{
  projects: Project[];
  days: Record<string, DayData>;
}> {
  const s = await getLegacyStore();
  const existingProjects = (await s.get<Project[]>("projects")) ?? [];
  const rawDays = (await s.get<Record<string, any>>("days")) ?? {};

  const hasLegacyShape = Object.values(rawDays).some(
    (d) => d && Array.isArray(d.projects) && !Array.isArray(d.allocations),
  );

  if (existingProjects.length > 0 && !hasLegacyShape) {
    return {
      projects: existingProjects,
      days: rawDays as Record<string, DayData>,
    };
  }

  const sortedDates = Object.keys(rawDays).sort().reverse();
  const projectMap = new Map<string, Project>();
  for (const existing of existingProjects) {
    projectMap.set(existing.id, existing);
  }

  for (const date of sortedDates) {
    const day = rawDays[date];
    const legacy = day?.projects;
    if (!Array.isArray(legacy)) continue;
    for (const p of legacy) {
      if (!projectMap.has(p.id)) {
        projectMap.set(p.id, {
          id: p.id,
          name: p.name,
          lastHours: p.targetHours ?? 0,
        });
      }
    }
  }

  const newDays: Record<string, DayData> = {};
  for (const [date, day] of Object.entries(rawDays)) {
    if (day && Array.isArray(day.allocations)) {
      newDays[date] = day as DayData;
      continue;
    }
    const legacy = day?.projects;
    const allocations = Array.isArray(legacy)
      ? legacy.map((p: any) => ({
          projectId: p.id,
          hours: p.targetHours ?? 0,
        }))
      : [];
    newDays[date] = {
      date: day?.date ?? date,
      goalHours:
        typeof day?.goalHours === "number"
          ? day.goalHours
          : allocations.reduce((acc, a) => acc + a.hours, 0),
      allocations,
      sessions: day?.sessions ?? [],
      breaks: Array.isArray(day?.breaks) ? day.breaks : [],
      carryOverHours: day?.carryOverHours ?? 0,
    };
  }

  const projects = Array.from(projectMap.values());
  await s.set("projects", projects);
  await s.set("days", newDays);
  await s.save();

  return { projects, days: newDays };
}

export async function loadLegacyCurrentTimer(): Promise<CurrentTimer> {
  const s = await getLegacyStore();
  return (await s.get<CurrentTimer>("currentTimer")) ?? null;
}

export async function loadLegacySettings(): Promise<Settings> {
  const s = await getLegacyStore();
  const stored = await s.get<Partial<Settings>>("settings");
  return {
    carryOverFactor: stored?.carryOverFactor ?? 0.25,
    theme: stored?.theme ?? "blue",
    showMenubarTimer: stored?.showMenubarTimer ?? true,
    currencySymbol: stored?.currencySymbol ?? "$",
    notifications: stored?.notifications ?? true,
    launchAtLogin: stored?.launchAtLogin ?? false,
    idleThresholdMin: stored?.idleThresholdMin ?? 10,
    shareCurrentProject: stored?.shareCurrentProject ?? true,
  };
}

/**
 * Poll the iCloud file for remote changes. If another device wrote a newer
 * blob, returns it; otherwise returns null.
 */
export async function pollRemoteChanges(): Promise<SyncBlob | null> {
  if (!cache) return null;
  const mtime = await syncFileMtime();
  if (mtime == null) return null;
  if (mtime <= cache.updatedMs + 500) return null;
  const fresh = await readBlob();
  if (!fresh) return null;
  if (fresh.updatedBy === thisDevice()) return null;
  if (fresh.updatedMs <= cache.updatedMs) return null;
  cache = fresh;
  return fresh;
}

export { thisDevice, syncFileMtime };
