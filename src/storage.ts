import { Store } from "@tauri-apps/plugin-store";
import { appConfigDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
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
  mergeBlobs,
  readBlob,
  thisDevice,
  writeBlob,
  type SyncBlob,
} from "./sync";

const LEGACY_STORE_FILE = "hour-tracker.json";
const LOCAL_CACHE_FILENAME = "forge-local.json";

let legacyStorePromise: Promise<Store> | null = null;

async function getLegacyStore(): Promise<Store> {
  if (!legacyStorePromise) {
    legacyStorePromise = Store.load(LEGACY_STORE_FILE);
  }
  return legacyStorePromise;
}

let cache: SyncBlob | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Local cache lives in ~/Library/Application Support/<bundleId>/forge-local.json
// (NOT iCloud). It's the source of truth on this device. Cross-device data
// movement only happens when the user presses the Sync button — which calls
// syncWithCloud() below.
async function localCachePath(): Promise<string> {
  const dir = await appConfigDir();
  return await join(dir, LOCAL_CACHE_FILENAME);
}

async function readLocalCache(): Promise<SyncBlob | null> {
  try {
    const path = await localCachePath();
    if (!(await exists(path))) return null;
    const text = await readTextFile(path);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed as SyncBlob;
    }
    return null;
  } catch (err) {
    console.error("readLocalCache failed", err);
    return null;
  }
}

async function writeLocalCache(blob: SyncBlob): Promise<void> {
  const dir = await appConfigDir();
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const path = await localCachePath();
  await writeTextFile(path, JSON.stringify(blob, null, 2));
}

async function ensureLoaded(): Promise<SyncBlob> {
  if (cache) return cache;
  const local = await readLocalCache();
  if (local) {
    cache = local;
    return cache;
  }
  // No local cache yet — bootstrap from iCloud (or legacy store) on this
  // device's first launch. Once written locally we never auto-touch iCloud
  // again; the user has to press the Sync button.
  cache = await initSync();
  await writeLocalCache(cache);
  return cache;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!cache) return;
    try {
      // Bump updatedMs/updatedBy so the next manual sync recognises this
      // device as having unsaved changes.
      cache = {
        ...cache,
        updatedMs: Date.now(),
        updatedBy: thisDevice(),
      };
      await writeLocalCache(cache);
    } catch (err) {
      console.error("local save failed", err);
    }
  }, 250);
}

export type SyncResult =
  | { kind: "ok"; blob: SyncBlob; pulledFromRemote: boolean }
  | { kind: "error"; error: string };

/**
 * Manual cloud sync (invoked from the Save button). Reads the latest iCloud
 * blob, unions it with the local cache (no deletes — see mergeBlobs), writes
 * the merged result back to iCloud, and updates the local cache.
 */
export async function syncWithCloud(): Promise<SyncResult> {
  try {
    const c = await ensureLoaded();
    const remote = await readBlob();
    const merged = remote ? mergeBlobs(c, remote) : c;
    const full = await writeBlob(merged);
    cache = full;
    await writeLocalCache(full);
    return {
      kind: "ok",
      blob: full,
      pulledFromRemote: !!remote && remote.updatedBy !== thisDevice(),
    };
  } catch (err) {
    return { kind: "error", error: String(err) };
  }
}

/**
 * Pull-only (invoked from the Update button). Reads the latest iCloud blob,
 * unions it with the local cache, writes the merged result to local only.
 * The cloud file is left untouched, so this is always safe to press.
 */
export async function pullFromCloud(): Promise<SyncResult> {
  try {
    const c = await ensureLoaded();
    const remote = await readBlob();
    if (!remote) {
      return { kind: "ok", blob: c, pulledFromRemote: false };
    }
    const merged = mergeBlobs(c, remote);
    const full: SyncBlob = {
      version: 1,
      projects: merged.projects,
      days: merged.days,
      settings: merged.settings,
      currentTimer: merged.currentTimer,
      currentTimerUpdatedMs: merged.currentTimerUpdatedMs ?? 0,
      earnings: merged.earnings ?? [],
      monthlyGoals: merged.monthlyGoals ?? {},
      seasons: merged.seasons ?? {},
      updatedMs: remote.updatedMs,
      updatedBy: remote.updatedBy,
    };
    cache = full;
    await writeLocalCache(full);
    return {
      kind: "ok",
      blob: full,
      pulledFromRemote: remote.updatedBy !== thisDevice(),
    };
  } catch (err) {
    return { kind: "error", error: String(err) };
  }
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
  const prev = c.currentTimer;
  c.currentTimer = timer;
  // Only bump the timestamp on a real start/stop/switch — not on heartbeat
  // writes that just refresh lastHeartbeatMs. Otherwise every heartbeat
  // would win the merge over a real "stop" recorded a moment ago on the
  // other Mac.
  const isMeaningfulChange =
    (prev?.projectId ?? null) !== (timer?.projectId ?? null) ||
    (prev?.startedAtMs ?? null) !== (timer?.startedAtMs ?? null);
  if (isMeaningfulChange) c.currentTimerUpdatedMs = Date.now();
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

export { thisDevice, syncFileMtime };
