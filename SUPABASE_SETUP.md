# Supabase Setup — Ladder backend

This is a one-time setup to wire up the Friends and Global leaderboards.

## 1. Create the project (2 min)

1. Go to **https://supabase.com** and sign up (free, no card).
2. Click **"New project"**.
3. Pick any name (e.g. `hour-tracker`).
4. Generate a database password (Supabase gives you one — save it somewhere but you probably won't need it).
5. Pick the region nearest to you (e.g. `eu-central-1`).
6. Click **"Create new project"**. Wait ~1 min for provisioning.

## 2. Grab the keys

Once the project is ready:

1. In the left sidebar → **Project Settings** (gear icon) → **API**.
2. Copy:
   - **Project URL** (looks like `https://xyzabc.supabase.co`)
   - **anon / public** key (the long `eyJhbGc...` JWT — it's safe to embed in the client app).

Paste both into the `.env.local` file in the dev project folder:

```
VITE_SUPABASE_URL=https://xyzabc.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

(An `.env.example` is committed; `.env.local` is gitignored.)

## 3. Create the database tables

Open Supabase → **SQL Editor** (left sidebar) → **New query** → paste all of the SQL below → **Run**.

```sql
-- Profiles: display name and friend code for each user
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  friend_code text unique not null,
  created_at timestamptz default now()
);

-- Stats: the live rank/LP/streak state, one row per user
create table public.stats (
  user_id uuid references auth.users on delete cascade primary key,
  tier_index int not null default 0,
  division int not null default 0,
  lp int not null default 0,
  streak int not null default 0,
  shields int not null default 0,
  is_working boolean not null default false,
  current_project text,
  session_started_at timestamptz,
  hours_today_ms bigint not null default 0,
  updated_at timestamptz default now()
);

-- Friendships: pending & accepted
create table public.friendships (
  user_id uuid references auth.users on delete cascade,
  friend_id uuid references auth.users on delete cascade,
  status text not null default 'pending',
  created_at timestamptz default now(),
  primary key (user_id, friend_id)
);

-- Row-level security: enable on all tables
alter table public.profiles enable row level security;
alter table public.stats enable row level security;
alter table public.friendships enable row level security;

-- Profiles: anyone signed in can read, only owner can write
create policy "profiles_read_all" on public.profiles
  for select to authenticated using (true);
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (auth.uid() = id);

-- Stats: anyone signed in can read (needed for global leaderboard),
--   only owner can write their own row
create policy "stats_read_all" on public.stats
  for select to authenticated using (true);
create policy "stats_upsert_self" on public.stats
  for insert to authenticated with check (auth.uid() = user_id);
create policy "stats_update_self" on public.stats
  for update to authenticated using (auth.uid() = user_id);

-- Friendships: only involved parties can read, send, accept, or delete
create policy "friendships_read" on public.friendships
  for select to authenticated using (
    auth.uid() = user_id or auth.uid() = friend_id
  );
create policy "friendships_insert" on public.friendships
  for insert to authenticated with check (auth.uid() = user_id);
create policy "friendships_update" on public.friendships
  for update to authenticated using (
    auth.uid() = user_id or auth.uid() = friend_id
  );
create policy "friendships_delete" on public.friendships
  for delete to authenticated using (
    auth.uid() = user_id or auth.uid() = friend_id
  );

-- Realtime: enable on stats so friends' activity pushes in real time
alter publication supabase_realtime add table public.stats;
```

After running: left sidebar → **Database** → **Tables** — you should see `profiles`, `stats`, `friendships`.

## 4. Enable email OTP auth

Supabase projects ship with email auth enabled by default. We use **OTP** (one-time 6-digit code sent to email — no passwords, no redirects needed for desktop apps).

1. Left sidebar → **Authentication** → **Providers** → **Email** → make sure it's **Enabled**.
2. Under **Email Auth** → **Email OTP** → keep **Enable Email OTP** on.
3. (Optional) **Authentication** → **Emails** → **Magic Link** template → customize the subject/body if you want.

You can also set `Site URL` to `http://localhost` and leave the rest alone — OTP doesn't need redirects.

## 5. Share with your friend (later)

When you ship the public build to your friend:
- They install the app
- They sign up with their email (OTP)
- They pick a display name + get a friend code
- You exchange friend codes and add each other
- You see each other's stats on the Friends leaderboard

## Troubleshooting

- If `npm run tauri build` complains about missing Supabase URL/key: check `.env.local` is present in the dev project root.
- If sign-in says "email not confirmed": Supabase's free tier has email confirmation on by default. Either click the link in the confirmation email first, or disable confirmation in Auth → Providers → Email → "Confirm email" toggle.
- Realtime subscriptions not firing: make sure you ran the last `alter publication` line in step 3.
