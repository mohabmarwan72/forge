import {
  exists,
  mkdir,
  readTextFile,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import type {
  CurrentTimer,
  DayData,
  Earning,
  Project,
  SeasonSnapshot,
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
    earnings: blob.earnings ?? [],
    monthlyGoals: blob.monthlyGoals ?? {},
    seasons: blob.seasons ?? {},
    updatedMs: Date.now(),
    updatedBy: deviceId(),
  };
  const file = await syncFilePath();
  await writeTextFile(file, JSON.stringify(full, null, 2));
  return full;
}

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
    earnings: [],
    monthlyGoals: {},
    seasons: {},
  });
}

export function thisDevice(): string {
  return deviceId();
}
