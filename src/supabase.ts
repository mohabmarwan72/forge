import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let clientInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (!clientInstance) {
    clientInstance = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "hour-tracker-supabase-auth",
      },
    });
  }
  return clientInstance;
}

// ---- Types ----

export type Profile = {
  id: string;
  display_name: string;
  friend_code: string;
  created_at: string;
};

export type Stats = {
  user_id: string;
  tier_index: number;
  division: number;
  lp: number;
  streak: number;
  shields: number;
  is_working: boolean;
  current_project: string | null;
  session_started_at: string | null;
  hours_today_ms: number;
  updated_at: string;
};

export type FriendshipRow = {
  user_id: string;
  friend_id: string;
  status: "pending" | "accepted";
  created_at: string;
};

// ---- Auth ----

export async function sendOtp(email: string): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  return { error: error?.message };
}

export async function verifyOtp(
  email: string,
  token: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  return { error: error?.message };
}

export async function signOut() {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}

// ---- Profile ----

export function generateFriendCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function ensureProfile(
  userId: string,
  email: string,
): Promise<Profile | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("ensureProfile read failed", error);
    return null;
  }
  if (data) return data as Profile;
  const displayName = email.split("@")[0];
  const insert = {
    id: userId,
    display_name: displayName,
    friend_code: generateFriendCode(),
  };
  const { data: inserted, error: insErr } = await sb
    .from("profiles")
    .insert(insert)
    .select()
    .single();
  if (insErr) {
    console.error("ensureProfile insert failed", insErr);
    return null;
  }
  return inserted as Profile;
}

export async function updateDisplayName(
  userId: string,
  newName: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb
    .from("profiles")
    .update({ display_name: newName })
    .eq("id", userId);
  return { error: error?.message };
}

// ---- Stats sync ----

export async function upsertStats(stats: Omit<Stats, "updated_at">) {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb
    .from("stats")
    .upsert({ ...stats, updated_at: new Date().toISOString() });
  if (error) console.error("upsertStats failed", error);
}

// ---- Friendships ----

export async function lookupProfileByFriendCode(
  code: string,
): Promise<Profile | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb
    .from("profiles")
    .select("*")
    .eq("friend_code", code.toUpperCase().trim())
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

export async function sendFriendRequest(
  fromUserId: string,
  toUserId: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb.from("friendships").insert({
    user_id: fromUserId,
    friend_id: toUserId,
    status: "pending",
  });
  return { error: error?.message };
}

export async function acceptFriendRequest(
  myUserId: string,
  fromUserId: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  // Update original request to accepted
  const { error: upErr } = await sb
    .from("friendships")
    .update({ status: "accepted" })
    .eq("user_id", fromUserId)
    .eq("friend_id", myUserId);
  if (upErr) return { error: upErr.message };
  // Insert reciprocal (accepted)
  const { error } = await sb.from("friendships").upsert({
    user_id: myUserId,
    friend_id: fromUserId,
    status: "accepted",
  });
  return { error: error?.message };
}

export async function rejectFriendRequest(
  myUserId: string,
  fromUserId: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  const { error } = await sb
    .from("friendships")
    .delete()
    .eq("user_id", fromUserId)
    .eq("friend_id", myUserId);
  return { error: error?.message };
}

export async function removeFriend(
  myUserId: string,
  friendId: string,
): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase not configured" };
  // Delete both directions
  await sb
    .from("friendships")
    .delete()
    .eq("user_id", myUserId)
    .eq("friend_id", friendId);
  const { error } = await sb
    .from("friendships")
    .delete()
    .eq("user_id", friendId)
    .eq("friend_id", myUserId);
  return { error: error?.message };
}

export async function loadFriendships(myUserId: string): Promise<{
  friends: Profile[];
  incoming: Profile[];
  outgoing: Profile[];
}> {
  const sb = getSupabase();
  if (!sb) return { friends: [], incoming: [], outgoing: [] };
  const { data: rows } = await sb
    .from("friendships")
    .select("*")
    .or(`user_id.eq.${myUserId},friend_id.eq.${myUserId}`);
  if (!rows || rows.length === 0) {
    return { friends: [], incoming: [], outgoing: [] };
  }
  const friends: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const r of rows as FriendshipRow[]) {
    if (r.status === "accepted") {
      friends.push(r.user_id === myUserId ? r.friend_id : r.user_id);
    } else if (r.user_id === myUserId) {
      outgoing.push(r.friend_id);
    } else {
      incoming.push(r.user_id);
    }
  }
  const ids = Array.from(new Set([...friends, ...incoming, ...outgoing]));
  if (ids.length === 0) return { friends: [], incoming: [], outgoing: [] };
  const { data: profs } = await sb
    .from("profiles")
    .select("*")
    .in("id", ids);
  const byId = new Map((profs ?? []).map((p: Profile) => [p.id, p]));
  return {
    friends: friends.map((id) => byId.get(id)).filter(Boolean) as Profile[],
    incoming: incoming.map((id) => byId.get(id)).filter(Boolean) as Profile[],
    outgoing: outgoing.map((id) => byId.get(id)).filter(Boolean) as Profile[],
  };
}

export async function loadStatsFor(userIds: string[]): Promise<Record<string, Stats>> {
  const sb = getSupabase();
  if (!sb || userIds.length === 0) return {};
  const { data } = await sb.from("stats").select("*").in("user_id", userIds);
  const out: Record<string, Stats> = {};
  for (const row of (data ?? []) as Stats[]) {
    out[row.user_id] = row;
  }
  return out;
}

export async function loadGlobalTop(limit = 50): Promise<
  Array<{ profile: Profile; stats: Stats }>
> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data: stats } = await sb
    .from("stats")
    .select("*")
    .order("lp", { ascending: false })
    .limit(limit);
  if (!stats || stats.length === 0) return [];
  const ids = (stats as Stats[]).map((s) => s.user_id);
  const { data: profs } = await sb
    .from("profiles")
    .select("*")
    .in("id", ids);
  const byId = new Map((profs ?? []).map((p: Profile) => [p.id, p]));
  return (stats as Stats[])
    .map((s) => {
      const p = byId.get(s.user_id);
      return p ? { profile: p, stats: s } : null;
    })
    .filter(Boolean) as Array<{ profile: Profile; stats: Stats }>;
}
