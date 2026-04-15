import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (granted != null) return granted;
  try {
    granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    return granted;
  } catch {
    granted = false;
    return false;
  }
}

export async function notify(title: string, body: string, enabled: boolean) {
  if (!enabled) return;
  const ok = await ensurePermission();
  if (!ok) return;
  try {
    sendNotification({ title, body });
  } catch (err) {
    console.error("notify failed", err);
  }
}
