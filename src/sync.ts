import {
  copyFile,
  exists,
  mkdir,
  readTextFile,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import type {
  BreakLog,
  CurrentTimer,
  DayData,
  Earning,
  Project,
  SeasonSnapshot,
  Session,
  Settings,
} from "./types";
import {
  loadLegacyCurrentTimer,
  loadLegacySettings,
  migrateIfNeeded,
} from "./storage";

export type SyncBlob = {
  version: 1;
  projects: Project[];
  days: Record<string, DayData>;
  settings: Settings;
  currentTimer: CurrentTimer;
  // Wall-clock time of the last write that set or cleared currentTimer. Used
  // by mergeBlobs so a deliberate "stop" (currentTimer=null) on one Mac is
  // never resurrected by a stale running timer on the other side.
  currentTimerUpdatedMs: number;
  earnings: Earning[];
  monthlyGoals: Record<string, number>;
  seasons: Record<string, SeasonSnapshot>;
  updatedMs: number;
  updatedBy: string;
};

// Per-platform sync folder:
//  - macOS: iCloud Drive (auto-synced across Macs by Apple)
//  - Windows / Linux: user's Documents folder under "Forge" (user can put
//    Documents inside OneDrive / Dropbox / Nextcloud for multi-device sync).
const MAC_SYNC_FOLDER = "Library/Mobile Documents/com~apple~CloudDocs/Forge";
const GENERIC_SYNC_FOLDER = "Documents/Forge";
const BLOB_FILENAME = "data.json";
const BACKUP_COUNT = 10;

const DEVICE_ID_KEY = "hour-tracker-device-id";

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function syncFolderForPlatform(): Promise<string> {
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    return platform() === "macos" ? MAC_SYNC_FOLDER : GENERIC_SYNC_FOLDER;
  } catch {
    return GENERIC_SYNC_FOLDER;
  }
}

export async function syncDirPath(): Promise<string> {
  const home = await homeDir();
  const folder = await syncFolderForPlatform();
  return await join(home, folder);
}

export async function syncFilePath(): Promise<string> {
  const dir = await syncDirPath();
  return await join(dir, BLOB_FILENAME);
}

async function ensureDir() {
  const dir = await syncDirPath();
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
}

export async function readBlob(): Promise<SyncBlob | null> {
  try {
    const file = await syncFilePath();
    if (!(await exists(file))) return null;
    const text = await readTextFile(file);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      const rawDays = parsed.days ?? {};
      const days: Record<string, DayData> = {};
      for (const [k, d] of Object.entries(rawDays)) {
        const day = d as any;
        const goalHours =
          typeof day.goalHours === "number"
            ? day.goalHours
            : Array.isArray(day.allocations)
              ? day.allocations.reduce(
                  (acc: number, a: any) => acc + (a.hours ?? 0),
                  0,
                )
              : 0;
        days[k] = {
          date: day.date ?? k,
          goalHours,
          allocations: day.allocations ?? [],
          sessions: day.sessions ?? [],
          breaks: Array.isArray(day.breaks) ? day.breaks : [],
          carryOverHours: day.carryOverHours ?? 0,
        };
      }
      return {
        version: 1,
        projects: parsed.projects ?? [],
        days,
        settings: parsed.settings,
        currentTimer: parsed.currentTimer ?? null,
        currentTimerUpdatedMs: parsed.currentTimerUpdatedMs ?? 0,
        earnings: parsed.earnings ?? [],
        monthlyGoals: parsed.monthlyGoals ?? {},
        seasons: parsed.seasons ?? {},
        updatedMs: parsed.updatedMs ?? 0,
        updatedBy: parsed.updatedBy ?? "",
      };
    }
    return null;
  } catch (err) {
    console.error("readBlob failed", err);
    return null;
  }
}

function dedupeById<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const r of remote) map.set(r.id, r);
  for (const l of local) map.set(l.id, l); // local wins on collision
  return Array.from(map.values());
}

// Two devices that flush the same in-progress timer produce sessions with the
// same deterministic id (see timerSessionId). When that happens, prefer the
// earlier endMs — that's the Mac where the user actually pressed stop; a
// later endMs is a stale clone that kept ticking after the timer should have
// died.
//
// Legacy data written before deterministic ids has random ids on duplicates,
// so we ALSO group by (projectId, startMs) for timer-source sessions. That
// way old duplicates still collapse on the next sync after the fix lands.
function mergeSessions(local: Session[], remote: Session[]): Session[] {
  const map = new Map<string, Session>();
  const keyFor = (s: Session) =>
    s.source === "timer" ? `t:${s.projectId}:${s.startMs}` : `i:${s.id}`;
  const put = (s: Session) => {
    const k = keyFor(s);
    const existing = map.get(k);
    if (!existing || s.endMs < existing.endMs) map.set(k, s);
  };
  for (const r of remote) put(r);
  for (const l of local) put(l);
  return Array.from(map.values());
}

function mergeBreaks(local: BreakLog[], remote: BreakLog[]): BreakLog[] {
  const key = (b: BreakLog) => `${b.startMs}-${b.endMs}`;
  const map = new Map<string, BreakLog>();
  for (const r of remote) map.set(key(r), r);
  for (const l of local) map.set(key(l), l);
  return Array.from(map.values());
}

function mergeDay(local: DayData, remote: DayData): DayData {
  return {
    date: local.date,
    goalHours: Math.max(local.goalHours ?? 0, remote.goalHours ?? 0),
    allocations: local.allocations ?? remote.allocations ?? [],
    sessions: mergeSessions(local.sessions ?? [], remote.sessions ?? []),
    breaks: mergeBreaks(local.breaks ?? [], remote.breaks ?? []),
    carryOverHours: Math.max(
      local.carryOverHours ?? 0,
      remote.carryOverHours ?? 0,
    ),
  };
}

function mergeDays(
  local: Record<string, DayData>,
  remote: Record<string, DayData>,
): Record<string, DayData> {
  const out: Record<string, DayData> = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    if (local[k] && remote[k]) out[k] = mergeDay(local[k], remote[k]);
    else out[k] = local[k] ?? remote[k];
  }
  return out;
}

/**
 * Combine local in-memory state with a remote on-disk blob without ever
 * deleting data that exists on either side. The local writer's intent wins
 * for scalar metadata (settings, monthlyGoals); arrays of tracked work
 * (sessions, earnings, breaks, days) are unioned by id. currentTimer is
 * resolved by which side recorded its set/clear most recently — so a stop
 * on one Mac is not undone by a stale running timer on the other.
 */
export function mergeBlobs(
  local: Omit<SyncBlob, "version" | "updatedMs" | "updatedBy">,
  remote: SyncBlob,
): Omit<SyncBlob, "version" | "updatedMs" | "updatedBy"> {
  const localTimerMs = local.currentTimerUpdatedMs ?? 0;
  const remoteTimerMs = remote.currentTimerUpdatedMs ?? 0;
  const localTimerWins = localTimerMs >= remoteTimerMs;
  return {
    projects: dedupeById<Project>(local.projects, remote.projects),
    days: mergeDays(local.days, remote.days ?? {}),
    settings: local.settings ?? remote.settings,
    currentTimer: localTimerWins ? local.currentTimer : remote.currentTimer,
    currentTimerUpdatedMs: localTimerWins ? localTimerMs : remoteTimerMs,
    earnings: dedupeById<Earning>(
      local.earnings ?? [],
      remote.earnings ?? [],
    ),
    monthlyGoals: { ...(remote.monthlyGoals ?? {}), ...(local.monthlyGoals ?? {}) },
    seasons: { ...(remote.seasons ?? {}), ...(local.seasons ?? {}) },
  };
}

// lastHeartbeatMs is a local-only signal — it tells *this* device whether the
// app crashed mid-session (gap >> heartbeat interval). The other Mac always
// sees a stale heartbeat (iCloud only updates on Save), so if we left the
// field in iCloud the other Mac's startup-recovery would chop a still-live
// timer down to the last Saved heartbeat. Strip it when serializing to
// iCloud.
function stripHeartbeat(timer: CurrentTimer): CurrentTimer {
  if (!timer) return timer;
  return { projectId: timer.projectId, startedAtMs: timer.startedAtMs };
}

function forICloud(full: SyncBlob): SyncBlob {
  return { ...full, currentTimer: stripHeartbeat(full.currentTimer) };
}

async function writeBackup(serialized: string): Promise<void> {
  try {
    const dir = await syncDirPath();
    const slot = (Date.now() % BACKUP_COUNT) + 1;
    const path = await join(dir, `data.bak${slot}.json`);
    await writeTextFile(path, serialized);
  } catch (err) {
    // Backups are best-effort. A backup failure must not block the real save.
    console.warn("backup write failed", err);
  }
}

export async function writeBlob(
  blob: Omit<SyncBlob, "version" | "updatedMs" | "updatedBy">,
): Promise<SyncBlob> {
  await ensureDir();
  const full: SyncBlob = {
    version: 1,
    projects: blob.projects,
    days: blob.days,
    settings: blob.settings,
    currentTimer: blob.currentTimer,
    currentTimerUpdatedMs: blob.currentTimerUpdatedMs ?? 0,
    earnings: blob.earnings ?? [],
    monthlyGoals: blob.monthlyGoals ?? {},
    seasons: blob.seasons ?? {},
    updatedMs: Date.now(),
    updatedBy: deviceId(),
  };
  const file = await syncFilePath();
  const serialized = JSON.stringify(forICloud(full), null, 2);
  await writeTextFile(file, serialized);
  await writeBackup(serialized);
  return full;
}

export type WriteResult = { kind: "written"; blob: SyncBlob };

/**
 * Merge-on-write. Reads the latest version from disk and unions our local
 * cache into it before persisting, so an in-flight write can never delete
 * sessions/earnings/days that exist on disk (the failure mode that lost
 * Apr 27's sessions in v0.2.4 — see NOTES.md).
 *
 * Returns the merged blob so the caller can replace its in-memory cache
 * with the merged result and re-render any newly-adopted data.
 */
export async function writeBlobIfNotStale(
  blob: Omit<SyncBlob, "version" | "updatedMs" | "updatedBy">,
  _expectedPrevUpdatedMs: number,
): Promise<WriteResult> {
  await ensureDir();
  const me = deviceId();
  const remote = await readBlob();
  const merged = remote ? mergeBlobs(blob, remote) : blob;
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
    updatedMs: Date.now(),
    updatedBy: me,
  };
  const file = await syncFilePath();
  const serialized = JSON.stringify(forICloud(full), null, 2);
  await writeTextFile(file, serialized);
  await writeBackup(serialized);
  return { kind: "written", blob: full };
}

/**
 * Wait briefly for iCloud to deliver a newer remote version of data.json
 * before the app starts accepting writes. Polls file mtime/contents up to
 * timeoutMs; resolves with the freshest blob seen (or null if no change).
 *
 * Mitigates the cold-start race where the local file is still a placeholder
 * or stale while iCloud is mid-download — without this, the first user
 * interaction would write our stale cache up and clobber the cloud copy.
 */
export async function waitForFreshRemote(
  baselineUpdatedMs: number,
  timeoutMs = 10000,
): Promise<SyncBlob | null> {
  const start = Date.now();
  let latest: SyncBlob | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const fresh = await readBlob();
      if (
        fresh &&
        fresh.updatedBy !== deviceId() &&
        fresh.updatedMs > baselineUpdatedMs + 500
      ) {
        latest = fresh;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return latest;
}

export async function listBackups(): Promise<string[]> {
  const dir = await syncDirPath();
  const out: string[] = [];
  for (let i = 1; i <= BACKUP_COUNT; i++) {
    const p = await join(dir, `data.bak${i}.json`);
    if (await exists(p)) out.push(p);
  }
  return out;
}

export { copyFile };

export async function fileMtime(): Promise<number | null> {
  try {
    const file = await syncFilePath();
    if (!(await exists(file))) return null;
    const s = await stat(file);
    return s.mtime ? new Date(s.mtime as unknown as string).getTime() : null;
  } catch {
    return null;
  }
}

/**
 * Load the sync blob. If missing, migrate from local plugin-store and create
 * the initial iCloud file.
 */
export async function initSync(): Promise<SyncBlob> {
  const existing = await readBlob();
  if (existing) return existing;

  const migrated = await migrateIfNeeded();
  const [settings, currentTimer] = await Promise.all([
    loadLegacySettings(),
    loadLegacyCurrentTimer(),
  ]);

  return await writeBlob({
    projects: migrated.projects,
    days: migrated.days,
    settings,
    currentTimer,
    currentTimerUpdatedMs: currentTimer ? Date.now() : 0,
    earnings: [],
    monthlyGoals: {},
    seasons: {},
  });
}

export function thisDevice(): string {
  return deviceId();
}
