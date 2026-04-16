import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as autostart from "@tauri-apps/plugin-autostart";
import type { Session as SupaSession } from "@supabase/supabase-js";
import { notify } from "./notifications";
import {
  acceptFriendRequest,
  ensureProfile,
  getSupabase,
  loadFriendships,
  loadGlobalTop,
  loadStatsFor,
  lookupProfileByFriendCode,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  sendOtp,
  signOut,
  supabaseConfigured,
  updateDisplayName,
  upsertStats,
  verifyOtp,
  type Profile,
  type Stats as RemoteStats,
} from "./supabase";

const IS_PERSONAL = import.meta.env.VITE_PERSONAL === "true";
import {
  initStorage,
  saveProjects,
  saveDays,
  saveSettings,
  saveCurrentTimer,
  saveEarnings,
  saveMonthlyGoals,
  saveSeasons,
  pollRemoteChanges,
} from "./storage";
import { RankIcon } from "./RankIcon";
import type {
  Allocation,
  BreakLog,
  BreakState,
  CurrentTimer,
  DayData,
  Earning,
  Project,
  SeasonSnapshot,
  Session,
  Settings,
  Tab,
} from "./types";
import {
  addDays,
  BREAK_DURATION_OPTIONS_MIN,
  dayBreakMs,
  computeDailyRankHistogram,
  computeLPDecay,
  computeRank,
  computeSeasonalLP,
  computeStreakState,
  daysLeftInMonth,
  dayTargetMs,
  daySpentMs,
  decemberLast,
  formatClock,
  formatDateHeader,
  formatHoursMinutes,
  formatMoney,
  formatMonthHeader,
  hoursToMs,
  januaryFirst,
  yearOfDateKey,
  LP_PER_DIVISION,
  LP_PER_HOUR,
  LP_PER_OVERTIME_HOUR,
  LP_PENALTY_PER_MISSED_HOUR,
  LP_GM_WINDOW,
  MIN_GOAL_HOURS,
  MAX_GOAL_HOURS,
  BONUS_THRESHOLD_HOURS,
  CHALLENGER_TIER_INDEX,
  GM_TIER_INDEX,
  monthKey,
  monthKeyFromDateKey,
  placementBoostLP,
  projectSpentMs,
  RANKS,
  sessionsCompleted,
  todayKey,
  uid,
  weekKeys,
} from "./utils";
import "./App.css";

function emptyDay(date: string, projects: Project[]): DayData {
  return {
    date,
    goalHours: 0,
    allocations: projects.map((p) => ({ projectId: p.id, hours: p.lastHours })),
    sessions: [],
    breaks: [],
    carryOverHours: 0,
  };
}

function ensureCurrentSeason(
  existing: Record<string, SeasonSnapshot>,
  currentYear: number,
  days: Record<string, DayData>,
  todayKey: string,
): Record<string, SeasonSnapshot> {
  if (existing[String(currentYear)]) return existing;

  const dayYears = new Set<number>();
  for (const key of Object.keys(days)) dayYears.add(yearOfDateKey(key));
  for (const key of Object.keys(existing)) dayYears.add(Number(key));

  const earliestYear = dayYears.size > 0 ? Math.min(...dayYears) : currentYear;
  const next = { ...existing };

  for (let y = earliestYear; y < currentYear; y++) {
    const yKey = String(y);
    if (!next[yKey]) {
      const prev = next[String(y - 1)];
      const startLP =
        prev && prev.finalTier !== undefined
          ? placementBoostLP(prev.finalTier)
          : 0;
      next[yKey] = { year: y, startLP };
    }
    const season = next[yKey];
    if (season.finalLP === undefined) {
      const finalLP = computeSeasonalLP(
        days,
        todayKey,
        januaryFirst(y),
        season.startLP,
        decemberLast(y),
      );
      const finalRank = computeRank(finalLP);
      const daysPerTier = computeDailyRankHistogram(
        days,
        januaryFirst(y),
        season.startLP,
        decemberLast(y),
      );
      next[yKey] = {
        ...season,
        finalLP,
        finalTier: finalRank.tierIndex,
        finalDivision: finalRank.division,
        daysPerTier,
      };
    }
  }

  const prevSeason = next[String(currentYear - 1)];
  const startLP =
    prevSeason && prevSeason.finalTier !== undefined
      ? placementBoostLP(prevSeason.finalTier)
      : 0;
  next[String(currentYear)] = { year: currentYear, startLP };
  return next;
}

function ensureToday(
  days: Record<string, DayData>,
  today: string,
  projects: Project[],
): Record<string, DayData> {
  if (days[today]) return days;
  return { ...days, [today]: emptyDay(today, projects) };
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [days, setDays] = useState<Record<string, DayData>>({});
  const [settings, setSettings] = useState<Settings>({
    carryOverFactor: 0.25,
    theme: "blue",
    showMenubarTimer: true,
    currencySymbol: "$",
    notifications: true,
    launchAtLogin: false,
    idleThresholdMin: 10,
    shareCurrentProject: true,
  });
  const [timer, setTimer] = useState<CurrentTimer>(null);
  const [breakState, setBreakState] = useState<BreakState>(null);
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [monthlyGoals, setMonthlyGoals] = useState<Record<string, number>>({});
  const [seasons, setSeasons] = useState<Record<string, SeasonSnapshot>>({});
  const [now, setNow] = useState<number>(Date.now());
  const [tab, setTab] = useState<Tab>("today");
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<SupaSession | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  // Bootstrap Supabase session + subscribe to auth changes
  useEffect(() => {
    if (!supabaseConfigured) return;
    const sb = getSupabase();
    if (!sb) return;
    let cancelled = false;
    sb.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }
    ensureProfile(session.user.id, session.user.email ?? "").then((p) => {
      if (p) setProfile(p);
    });
  }, [session]);

  const today = todayKey();

  useEffect(() => {
    (async () => {
      const blob = await initStorage();
      const settings: Settings = {
        carryOverFactor: blob.settings?.carryOverFactor ?? 0.25,
        theme: blob.settings?.theme ?? "blue",
        showMenubarTimer: blob.settings?.showMenubarTimer ?? true,
        currencySymbol: blob.settings?.currencySymbol ?? "$",
        notifications: blob.settings?.notifications ?? true,
        launchAtLogin: blob.settings?.launchAtLogin ?? false,
        idleThresholdMin: blob.settings?.idleThresholdMin ?? 10,
        shareCurrentProject: blob.settings?.shareCurrentProject ?? true,
      };
      const withToday = ensureToday(blob.days, today, blob.projects);
      const currentYear = new Date().getFullYear();
      const nextSeasons = ensureCurrentSeason(
        blob.seasons ?? {},
        currentYear,
        blob.days,
        today,
      );
      setProjects(blob.projects);
      setDays(withToday);
      setSettings(settings);
      setTimer(blob.currentTimer ?? null);
      setEarnings(blob.earnings ?? []);
      setMonthlyGoals(blob.monthlyGoals ?? {});
      setSeasons(nextSeasons);
      setLoaded(true);
      if (withToday !== blob.days) await saveDays(withToday);
      if (nextSeasons !== (blob.seasons ?? {})) await saveSeasons(nextSeasons);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(async () => {
      const fresh = await pollRemoteChanges();
      if (!fresh) return;
      const withToday = ensureToday(fresh.days, today, fresh.projects);
      setProjects(fresh.projects);
      setDays(withToday);
      setSettings({
        carryOverFactor: fresh.settings?.carryOverFactor ?? 0.25,
        theme: fresh.settings?.theme ?? "blue",
        showMenubarTimer: fresh.settings?.showMenubarTimer ?? true,
        currencySymbol: fresh.settings?.currencySymbol ?? "$",
        notifications: fresh.settings?.notifications ?? true,
        launchAtLogin: fresh.settings?.launchAtLogin ?? false,
        idleThresholdMin: fresh.settings?.idleThresholdMin ?? 10,
        shareCurrentProject: fresh.settings?.shareCurrentProject ?? true,
      });
      setTimer(fresh.currentTimer ?? null);
      setEarnings(fresh.earnings ?? []);
      setMonthlyGoals(fresh.monthlyGoals ?? {});
      setSeasons(fresh.seasons ?? {});
    }, 5000);
    return () => clearInterval(id);
  }, [loaded, today]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const startMs =
      settings.showMenubarTimer && timer ? timer.startedAtMs : 0;
    invoke("set_timer_start", { startMs }).catch(() => {});
  }, [timer, loaded, settings.showMenubarTimer]);

  useEffect(() => {
    if (!loaded) return;
    const endMs =
      settings.showMenubarTimer && breakState ? breakState.endMs : 0;
    invoke("set_break_end", { endMs }).catch(() => {});
  }, [breakState, loaded, settings.showMenubarTimer]);

  useEffect(() => {
    if (!breakState) return;
    if (now >= breakState.endMs) {
      void endBreak();
      void notify("Break over", "Back to it!", settings.notifications);
    }
  }, [now, breakState, settings.notifications]);

  // Idle detection — Rust tells us when the user has been idle for 5+ min.
  const flushTimerRef = useRef<(endMsOverride?: number) => Promise<void>>(async () => {});
  const timerRef = useRef<CurrentTimer>(null);
  useEffect(() => {
    timerRef.current = timer;
  }, [timer]);
  useEffect(() => {
    const unlistenWarn = listen<number>("idle-warning", () => {
      if (!timerRef.current) return;
      void notify(
        "Still working?",
        "No keyboard/mouse for 10 min. Touch anything within 3 min or we'll pause the session.",
        settings.notifications,
      );
    });
    const unlistenPause = listen<number>("idle-detected", (event) => {
      const idleMs = event.payload;
      const t = timerRef.current;
      if (!t) return;
      const effectiveEnd = Date.now() - idleMs;
      if (effectiveEnd <= t.startedAtMs) {
        setTimer(null);
        void saveCurrentTimer(null);
        return;
      }
      void flushTimerRef.current(effectiveEnd);
      const minutes = Math.round(idleMs / 60000);
      void notify(
        "Paused — you seemed away",
        `No activity for ~${minutes} min. The last ${minutes} min weren't counted.`,
        settings.notifications,
      );
    });
    return () => {
      void unlistenWarn.then((fn) => fn());
      void unlistenPause.then((fn) => fn());
    };
  }, [settings.notifications]);

  // Midnight rollover — split an active session at 00:00 and start a new day.
  const prevTodayRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = prevTodayRef.current;
    prevTodayRef.current = today;
    if (prev === null || prev === today) return;

    // Day changed. Compute midnight of today (real local midnight).
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightMs = midnight.getTime();

    (async () => {
      const activeTimer = timerRef.current;
      if (activeTimer && activeTimer.startedAtMs < midnightMs) {
        // Save pre-midnight portion to yesterday
        const yesterdaySession: Session = {
          id: uid(),
          projectId: activeTimer.projectId,
          startMs: activeTimer.startedAtMs,
          endMs: midnightMs - 1,
          source: "timer",
        };
        const prevKey = prev;
        setDays((current) => {
          const prevDay =
            current[prevKey] ?? emptyDay(prevKey, projects);
          const updated = {
            ...current,
            [prevKey]: {
              ...prevDay,
              sessions: [...prevDay.sessions, yesterdaySession],
            },
          };
          void saveDays(updated);
          return updated;
        });

        // Restart timer at midnight so the counter visually continues
        const newTimer = {
          projectId: activeTimer.projectId,
          startedAtMs: midnightMs,
        };
        setTimer(newTimer);
        await saveCurrentTimer(newTimer);
      }

      // Ensure today's day exists (so the "Set your goal" card shows)
      setDays((current) => {
        if (current[today]) return current;
        const updated = { ...current, [today]: emptyDay(today, projects) };
        void saveDays(updated);
        return updated;
      });

      void notify(
        "New day 🌅",
        "Lock in today's goal to start earning FP. Your timer's still running.",
        settings.notifications,
      );
    })();
  }, [today, loaded, projects, settings.notifications]);

  // Sync autostart setting with OS
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        const current = await autostart.isEnabled();
        if (current !== settings.launchAtLogin) {
          if (settings.launchAtLogin) await autostart.enable();
          else await autostart.disable();
        }
      } catch (err) {
        console.error("autostart sync failed", err);
      }
    })();
  }, [settings.launchAtLogin, loaded]);

  // Sync FP / rank / streak / live activity to Supabase
  const syncStats = useCallback(async () => {
    if (!session?.user || !profile || !loaded) return;
    const streakState = computeStreakState(days, today);
    const currentYear = new Date().getFullYear();
    const currentSeason = seasons[String(currentYear)];
    const earnedLP = computeSeasonalLP(
      days,
      today,
      januaryFirst(currentYear),
      currentSeason?.startLP ?? 0,
    );
    const lpDecay = computeLPDecay(days, today, earnedLP);
    const totalLP = Math.max(0, earnedLP - lpDecay);
    const rank = computeRank(totalLP);
    const todayData = days[today];
    const liveMs = timer ? Date.now() - timer.startedAtMs : 0;
    const hoursTodayMs = (todayData ? daySpentMs(todayData) : 0) + liveMs;
    const activeProjectName =
      timer && settings.shareCurrentProject
        ? projects.find((p) => p.id === timer.projectId)?.name ?? null
        : null;
    await upsertStats({
      user_id: session.user.id,
      tier_index: rank.tierIndex,
      division: rank.division,
      lp: rank.lp,
      streak: streakState.streak,
      shields: streakState.shields,
      is_working: !!timer,
      current_project: activeProjectName,
      session_started_at: timer
        ? new Date(timer.startedAtMs).toISOString()
        : null,
      hours_today_ms: hoursTodayMs,
    });
  }, [
    session,
    profile,
    loaded,
    days,
    timer,
    seasons,
    today,
    projects,
    settings.shareCurrentProject,
  ]);

  useEffect(() => {
    void syncStats();
  }, [syncStats]);

  useEffect(() => {
    if (!timer || !session?.user) return;
    const id = setInterval(() => void syncStats(), 30000);
    return () => clearInterval(id);
  }, [timer, session, syncStats]);

  // Sync idle threshold to Rust
  useEffect(() => {
    if (!loaded) return;
    invoke("set_idle_threshold", { minutes: settings.idleThresholdMin }).catch(
      () => {},
    );
  }, [settings.idleThresholdMin, loaded]);

  // Event-based notifications (session complete, goal hit, rank up)
  const prevSessionsRef = useRef<number | null>(null);
  const prevGoalHitRef = useRef<boolean | null>(null);
  const prevRankKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const today_ = days[today];
    if (!today_) return;
    const liveMs = timer ? now - timer.startedAtMs : 0;
    const currentSessions = sessionsCompleted(today_, liveMs);
    const targetMs = dayTargetMs(today_);
    const spentMs = daySpentMs(today_) + liveMs;
    const goalHit = targetMs > 0 && spentMs >= targetMs;
    const currentYear = new Date().getFullYear();
    const currentSeason = seasons[String(currentYear)];
    const totalLP = computeSeasonalLP(
      days,
      today,
      januaryFirst(currentYear),
      currentSeason?.startLP ?? 0,
    );
    const rank = computeRank(totalLP);
    const rankKey = `${rank.tierIndex}-${rank.division}`;

    if (prevSessionsRef.current != null && currentSessions > prevSessionsRef.current) {
      void notify(
        "Session complete 🎯",
        `${currentSessions} × 50-min session${currentSessions === 1 ? "" : "s"} done today.`,
        settings.notifications,
      );
    }
    if (prevGoalHitRef.current === false && goalHit) {
      void notify(
        "Daily goal hit ✅",
        `You did ${formatHoursMinutes(spentMs)} — nice.`,
        settings.notifications,
      );
    }
    if (prevRankKeyRef.current != null && prevRankKeyRef.current !== rankKey) {
      const prevKey = prevRankKeyRef.current;
      if (rankKey > prevKey) {
        void notify(
          "Rank up 🎉",
          `${rank.tier} ${rank.divisionRoman}`,
          settings.notifications,
        );
      }
    }

    prevSessionsRef.current = currentSessions;
    prevGoalHitRef.current = goalHit;
    prevRankKeyRef.current = rankKey;
  }, [days, timer, now, loaded, today, settings.notifications, seasons]);

  const day = days[today] ?? emptyDay(today, projects);
  const liveMs = timer ? now - timer.startedAtMs : 0;
  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const mutateDay = async (updater: (d: DayData) => DayData) => {
    const next = {
      ...days,
      [today]: updater(days[today] ?? emptyDay(today, projects)),
    };
    setDays(next);
    await saveDays(next);
  };

  const persistProjects = async (next: Project[]) => {
    setProjects(next);
    await saveProjects(next);
  };

  const addProject = async (name: string, hours: number) => {
    const project: Project = { id: uid(), name, lastHours: hours };
    const nextProjects = [...projects, project];
    await persistProjects(nextProjects);
    await mutateDay((d) => ({
      ...d,
      allocations: [...d.allocations, { projectId: project.id, hours }],
    }));
  };

  const renameProject = async (projectId: string, name: string) => {
    await persistProjects(
      projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
    );
  };

  const setTodayHours = async (projectId: string, hours: number) => {
    await mutateDay((d) => {
      const exists = d.allocations.some((a) => a.projectId === projectId);
      const allocations = exists
        ? d.allocations.map((a) =>
            a.projectId === projectId ? { ...a, hours } : a,
          )
        : [...d.allocations, { projectId, hours }];
      return { ...d, allocations };
    });
    if (hours > 0) {
      await persistProjects(
        projects.map((p) =>
          p.id === projectId ? { ...p, lastHours: hours } : p,
        ),
      );
    }
  };

  const deleteProject = async (projectId: string) => {
    await persistProjects(projects.filter((p) => p.id !== projectId));
    const nextDays: Record<string, DayData> = {};
    for (const [k, d] of Object.entries(days)) {
      nextDays[k] = {
        ...d,
        allocations: d.allocations.filter((a) => a.projectId !== projectId),
      };
    }
    setDays(nextDays);
    await saveDays(nextDays);
    if (timer?.projectId === projectId) {
      setTimer(null);
      await saveCurrentTimer(null);
    }
  };

  const startTimer = async (projectId: string) => {
    if (timer && timer.projectId === projectId) return;
    if (timer) await flushTimer(timer);
    const t = { projectId, startedAtMs: Date.now() };
    setTimer(t);
    await saveCurrentTimer(t);
  };

  const flushTimer = async (t: CurrentTimer, endMsOverride?: number) => {
    if (!t) return;
    const endMs = endMsOverride ?? Date.now();
    if (endMs - t.startedAtMs < 1000) return;
    const session: Session = {
      id: uid(),
      projectId: t.projectId,
      startMs: t.startedAtMs,
      endMs,
      source: "timer",
    };
    await mutateDay((d) => ({ ...d, sessions: [...d.sessions, session] }));
  };

  const pauseTimer = async () => {
    if (!timer) return;
    await flushTimer(timer);
    setTimer(null);
    await saveCurrentTimer(null);
  };

  useEffect(() => {
    flushTimerRef.current = async (endMsOverride?: number) => {
      const t = timerRef.current;
      if (!t) return;
      await flushTimer(t, endMsOverride);
      setTimer(null);
      await saveCurrentTimer(null);
    };
  });

  const startBreak = async (minutes: number) => {
    if (timer) {
      await flushTimer(timer);
      setTimer(null);
      await saveCurrentTimer(null);
    }
    const durationMs = Math.max(1, Math.floor(minutes)) * 60 * 1000;
    const now = Date.now();
    setBreakState({
      startedAtMs: now,
      endMs: now + durationMs,
      plannedMs: durationMs,
    });
  };

  const endBreak = async () => {
    const current = breakState;
    if (current) {
      const end = Math.min(Date.now(), current.endMs);
      if (end > current.startedAtMs) {
        const log: BreakLog = {
          startMs: current.startedAtMs,
          endMs: end,
          plannedMs: current.plannedMs,
        };
        await mutateDay((d) => ({ ...d, breaks: [...(d.breaks ?? []), log] }));
      }
    }
    setBreakState(null);
  };

  const setDayGoal = async (hours: number) => {
    await mutateDay((d) =>
      d.goalHours && d.goalHours > 0 ? d : { ...d, goalHours: hours },
    );
  };

  const deleteSession = async (sessionId: string) => {
    await mutateDay((d) => ({
      ...d,
      sessions: d.sessions.filter((s) => s.id !== sessionId),
    }));
  };

  const updateSettings = async (s: Settings) => {
    setSettings(s);
    await saveSettings(s);
  };

  const addEarning = async (
    amountCents: number,
    source: string,
    dateKey: string,
    note?: string,
  ) => {
    const e: Earning = {
      id: uid(),
      amountCents,
      source,
      dateKey,
      createdMs: Date.now(),
      ...(note ? { note } : {}),
    };
    const next = [...earnings, e];
    setEarnings(next);
    await saveEarnings(next);
  };

  const updateEarning = async (id: string, patch: Partial<Earning>) => {
    const next = earnings.map((e) => (e.id === id ? { ...e, ...patch } : e));
    setEarnings(next);
    await saveEarnings(next);
  };

  const deleteEarning = async (id: string) => {
    const next = earnings.filter((e) => e.id !== id);
    setEarnings(next);
    await saveEarnings(next);
  };

  const setMonthlyGoal = async (mk: string, cents: number) => {
    const next = { ...monthlyGoals, [mk]: cents };
    setMonthlyGoals(next);
    await saveMonthlyGoals(next);
  };

  const hideWindow = () => {
    invoke("toggle_window").catch(() => {});
  };

  if (!loaded) {
    return <div className="app loading">Loading...</div>;
  }

  return (
    <div className={`app theme-${settings.theme}`}>
      <div className="title-bar" data-tauri-drag-region>
        <div className="title-left" data-tauri-drag-region>
          Forge
        </div>
        <button className="close-btn" onClick={hideWindow} aria-label="Close">
          ×
        </button>
      </div>

      <nav className="tabs">
        <button
          className={tab === "today" ? "tab active" : "tab"}
          onClick={() => setTab("today")}
        >
          Today
        </button>
        <button
          className={tab === "week" ? "tab active" : "tab"}
          onClick={() => setTab("week")}
        >
          Week
        </button>
        <button
          className={tab === "ladder" ? "tab active" : "tab"}
          onClick={() => setTab("ladder")}
        >
          Ladder
        </button>
        {IS_PERSONAL && (
          <button
            className={tab === "money" ? "tab active" : "tab"}
            onClick={() => setTab("money")}
          >
            Money
          </button>
        )}
        <button
          className={`tab tab-icon ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
          aria-label="Settings"
        >
          ⚙︎
        </button>
      </nav>

      <div className="content">
        {tab === "today" && (
          <TodayView
            day={day}
            projects={projects}
            projectById={projectById}
            timer={timer}
            liveMs={liveMs}
            allDays={days}
            seasons={seasons}
            breakState={breakState}
            nowMs={now}
            onStart={startTimer}
            onPause={pauseTimer}
            onStartBreak={startBreak}
            onEndBreak={endBreak}
            onSetDayGoal={setDayGoal}
            onAddProject={addProject}
            onRenameProject={renameProject}
            onSetTodayHours={setTodayHours}
            onDeleteProject={deleteProject}
            onDeleteSession={deleteSession}
          />
        )}
        {tab === "week" && (
          <WeekView days={days} today={today} projectById={projectById} />
        )}
        {tab === "ladder" && (
          <LadderView
            session={session}
            profile={profile}
            onGoToSettings={() => setTab("settings")}
            nowTick={now}
          />
        )}
        {tab === "money" && IS_PERSONAL && (
          <MoneyView
            earnings={earnings}
            monthlyGoals={monthlyGoals}
            currencySymbol={settings.currencySymbol}
            onAdd={addEarning}
            onUpdate={updateEarning}
            onDelete={deleteEarning}
            onSetGoal={setMonthlyGoal}
          />
        )}
        {tab === "settings" && (
          <SettingsView
            settings={settings}
            earnings={earnings}
            days={days}
            projectById={projectById}
            session={session}
            profile={profile}
            onUpdate={updateSettings}
            onProfileChanged={setProfile}
          />
        )}
      </div>
    </div>
  );
}

function TodayView(props: {
  day: DayData;
  projects: Project[];
  projectById: Map<string, Project>;
  timer: CurrentTimer;
  liveMs: number;
  allDays: Record<string, DayData>;
  seasons: Record<string, SeasonSnapshot>;
  breakState: BreakState;
  nowMs: number;
  onStart: (projectId: string) => void;
  onPause: () => void;
  onStartBreak: (minutes: number) => void;
  onEndBreak: () => void;
  onSetDayGoal: (hours: number) => void;
  onAddProject: (name: string, hours: number) => void;
  onRenameProject: (id: string, name: string) => void;
  onSetTodayHours: (id: string, hours: number) => void;
  onDeleteProject: (id: string) => void;
  onDeleteSession: (id: string) => void;
}) {
  const {
    day,
    projects,
    projectById,
    timer,
    liveMs,
    allDays,
    seasons,
    breakState,
    nowMs,
    onStart,
    onPause,
    onStartBreak,
    onEndBreak,
    onSetDayGoal,
    onAddProject,
    onRenameProject,
    onSetTodayHours,
    onDeleteProject,
    onDeleteSession,
  } = props;

  const [showAdd, setShowAdd] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showBreakPicker, setShowBreakPicker] = useState(false);

  const rows = useMemo(() => {
    const byId = new Map<string, Allocation>();
    day.allocations.forEach((a) => byId.set(a.projectId, a));
    return projects
      .map((p) => ({
        project: p,
        hours: byId.get(p.id)?.hours ?? 0,
      }))
      .filter((r) => byId.has(r.project.id));
  }, [projects, day.allocations]);

  const activeProject = timer ? projectById.get(timer.projectId) : undefined;
  const targetMs = dayTargetMs(day);
  const spentMs = daySpentMs(day) + liveMs;
  const remainingMs = Math.max(0, targetMs - spentMs);
  const progressPct = targetMs > 0 ? Math.min(100, (spentMs / targetMs) * 100) : 0;

  const isOnBreak = breakState !== null;
  const breakRemainingMs = breakState
    ? Math.max(0, breakState.endMs - nowMs)
    : 0;
  const liveBreakMs = breakState
    ? Math.max(0, Math.min(nowMs, breakState.endMs) - breakState.startedAtMs)
    : 0;
  const totalBreakMs = dayBreakMs(day, liveBreakMs);

  const existingNames = new Set(projects.map((p) => p.name.toLowerCase()));

  return (
    <div className="today">
      <div className="date-header">{formatDateHeader(day.date)}</div>

      {day.goalHours === 0 && (
        <GoalSetCard onLock={onSetDayGoal} />
      )}

      <StatsStrip
        day={day}
        liveMs={liveMs}
        allDays={allDays}
        seasons={seasons}
      />

      {isOnBreak ? (
        <div className="timer-card break-mode">
          <div className="break-label">On break ☕</div>
          <div className="timer-time break-time">
            {formatClock(breakRemainingMs)}
          </div>
          <button className="btn btn-primary" onClick={onEndBreak}>
            End break
          </button>
        </div>
      ) : (
        <div className="timer-card">
          <div className={`timer-time ${timer ? "running" : ""}`}>
            {timer ? formatClock(liveMs) : "0:00"}
          </div>
          <div className="timer-project">
            {activeProject?.name ?? (timer ? "—" : "Not tracking")}
          </div>
          <div className="timer-actions">
            {timer ? (
              <button className="btn btn-danger" onClick={onPause}>
                End session
              </button>
            ) : (
              <div className="timer-hint">Pick a project below to start</div>
            )}
            <button
              className="btn btn-secondary break-btn"
              onClick={() => setShowBreakPicker(true)}
              title="Take a break"
            >
              ☕ Break
            </button>
          </div>
        </div>
      )}

      <div className="summary">
        <div className="summary-row">
          <span>Done today</span>
          <strong>{formatHoursMinutes(spentMs)}</strong>
        </div>
        <div className="summary-row">
          <span>Remaining</span>
          <strong>{formatHoursMinutes(remainingMs)}</strong>
        </div>
        <div className="summary-row subtle">
          <span>Goal</span>
          <span>
            {day.goalHours > 0
              ? `${day.goalHours}h · locked`
              : "not set"}
          </span>
        </div>
        <div className="summary-row subtle">
          <span>Breaks</span>
          <span>
            {totalBreakMs > 0 ? formatHoursMinutes(totalBreakMs) : "—"}
          </span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="section-header">
        <span>Projects</span>
        <button className="btn btn-ghost" onClick={() => setShowAdd(true)}>
          + Add
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty">
          <p>No projects yet.</p>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            Add your first project
          </button>
        </div>
      ) : (
        <ul className="project-list">
          {rows.map((r) => {
            const spent =
              projectSpentMs(day, r.project.id) +
              (timer?.projectId === r.project.id ? liveMs : 0);
            const target = hoursToMs(r.hours);
            const pct =
              target > 0 ? Math.min(100, (spent / target) * 100) : 0;
            const isActive = timer?.projectId === r.project.id;
            const isOff = r.hours === 0;
            return (
              <ProjectRow
                key={r.project.id}
                project={r.project}
                hours={r.hours}
                spent={spent}
                pct={pct}
                isActive={isActive}
                isOff={isOff}
                disabled={isOnBreak}
                onStart={() => onStart(r.project.id)}
                onPause={onPause}
                onDelete={() => onDeleteProject(r.project.id)}
                onRename={(name) => onRenameProject(r.project.id, name)}
                onSetHours={(hours) => onSetTodayHours(r.project.id, hours)}
              />
            );
          })}
        </ul>
      )}

      <div className="footer-actions">
        <button
          className="btn btn-secondary"
          onClick={() => setShowLog(true)}
          title="See all of today's tracked sessions"
        >
          History
        </button>
      </div>

      {showAdd && (
        <AddProjectModal
          existingNames={existingNames}
          goalHours={day.goalHours}
          allocatedHours={day.allocations.reduce((a, x) => a + x.hours, 0)}
          onAdd={(name, hours) => {
            onAddProject(name, hours);
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showLog && (
        <SessionLogModal
          day={day}
          projectById={projectById}
          onDelete={onDeleteSession}
          onClose={() => setShowLog(false)}
        />
      )}
      {showBreakPicker && (
        <BreakPickerModal
          onPick={(minutes) => {
            onStartBreak(minutes);
            setShowBreakPicker(false);
          }}
          onClose={() => setShowBreakPicker(false)}
        />
      )}
    </div>
  );
}

function BreakPickerModal(props: {
  onPick: (minutes: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Take a break ☕" onClose={props.onClose}>
      <p className="hint">How long? The menubar will show a countdown.</p>
      <div className="break-duration-grid">
        {BREAK_DURATION_OPTIONS_MIN.map((m) => (
          <button
            key={m}
            className="break-duration-btn"
            onClick={() => props.onPick(m)}
          >
            <span className="break-duration-num">{m}</span>
            <span className="break-duration-unit">min</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function GoalSetCard(props: { onLock: (hours: number) => void }) {
  const [hours, setHours] = useState("8");
  const parsed = Math.floor(Number(hours));
  const valid =
    Number.isFinite(parsed) &&
    parsed >= MIN_GOAL_HOURS &&
    parsed <= MAX_GOAL_HOURS;
  const error =
    hours.trim() === ""
      ? null
      : !Number.isFinite(parsed)
        ? "Enter a number."
        : parsed < MIN_GOAL_HOURS
          ? `Minimum ${MIN_GOAL_HOURS} hours.`
          : parsed > MAX_GOAL_HOURS
            ? `Maximum ${MAX_GOAL_HOURS} hours (it's a day, not more).`
            : null;
  const submit = () => {
    if (!valid) return;
    props.onLock(parsed);
  };
  return (
    <div className="goal-set-card">
      <div className="goal-set-title">Start your day</div>
      <p className="goal-set-hint">
        Set your goal for today. <strong>This can't be changed later</strong> —
        so pick something you'll actually commit to. Between{" "}
        {MIN_GOAL_HOURS}h and {MAX_GOAL_HOURS}h.
      </p>
      <div className="goal-set-row">
        <input
          className="input goal-set-input"
          type="number"
          min={MIN_GOAL_HOURS}
          max={MAX_GOAL_HOURS}
          step="1"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <span className="goal-set-unit">hours</span>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={!valid}
        >
          Lock in
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function StatsStrip(props: {
  day: DayData;
  liveMs: number;
  allDays: Record<string, DayData>;
  seasons: Record<string, SeasonSnapshot>;
}) {
  const { day, liveMs, allDays, seasons } = props;
  const [showInfo, setShowInfo] = useState(false);

  const daysForCalc = useMemo(() => {
    const liveDay: DayData = {
      ...day,
      sessions:
        liveMs > 0
          ? [
              ...day.sessions,
              {
                id: "__live__",
                projectId: "__live__",
                startMs: Date.now() - liveMs,
                endMs: Date.now(),
                source: "timer",
              },
            ]
          : day.sessions,
    };
    return { ...allDays, [day.date]: liveDay };
  }, [day, liveMs, allDays]);

  const currentYear = new Date().getFullYear();
  const currentSeason = seasons[String(currentYear)];
  const seasonStartDate = januaryFirst(currentYear);
  const seasonStartLP = currentSeason?.startLP ?? 0;

  const streakState = computeStreakState(daysForCalc, day.date);
  const streak = streakState.streak;
  const earnedLP = computeSeasonalLP(
    daysForCalc,
    day.date,
    seasonStartDate,
    seasonStartLP,
  );
  const lpDecay = computeLPDecay(daysForCalc, day.date, earnedLP);
  const totalLP = Math.max(0, earnedLP - lpDecay);
  const rank = computeRank(totalLP);
  const lpPct =
    rank.tierIndex === CHALLENGER_TIER_INDEX
      ? 100
      : rank.tierIndex === GM_TIER_INDEX
        ? (rank.lp / LP_GM_WINDOW) * 100
        : (rank.lp / LP_PER_DIVISION) * 100;
  const tierShort = rank.tier === "Grand Master" ? "GM" : rank.tier;

  return (
    <>
      <div
        className={`stats-strip rank-tint-${rank.tierIndex}`}
        role="button"
        tabIndex={0}
        onClick={() => setShowInfo(true)}
        onKeyDown={(e) => e.key === "Enter" && setShowInfo(true)}
      >
        <div className="stats-strip-top">
          <div className="rank-section">
            <div className="rank-icon-wrap">
              <RankIcon tierIndex={rank.tierIndex} size={36} />
            </div>
            <div className="rank-info">
              <div className="rank-name">
                {tierShort}
                {rank.divisionRoman && (
                  <>
                    {" "}
                    <span className="rank-division">
                      {rank.divisionRoman}
                    </span>
                  </>
                )}
              </div>
              <div className="rank-lp">
                {rank.tierIndex === CHALLENGER_TIER_INDEX
                  ? `${rank.lp} FP · top of the ladder`
                  : rank.tierIndex === GM_TIER_INDEX
                    ? `${rank.lp} / ${LP_GM_WINDOW} FP to Challenger`
                    : `${rank.lp} / ${LP_PER_DIVISION} FP`}
              </div>
            </div>
          </div>
          <div
            className="streak-section"
            title={`Streak: ${streak} day${streak === 1 ? "" : "s"} · Shields: ${streakState.shields}/2
+1 each day you work 8+ hours. Shields absorb missed days past the 3-day grace.`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="streak-icon">🔥</span>
            <span className="streak-number">{streak}</span>
            {streakState.shields > 0 && (
              <span
                className="streak-shields"
                aria-label={`${streakState.shields} shields`}
              >
                {"🛡".repeat(streakState.shields)}
              </span>
            )}
          </div>
        </div>
        <div className="rank-progress">
          <div className="rank-progress-fill" style={{ width: `${lpPct}%` }} />
        </div>
      </div>
      {showInfo && (
        <RankInfoModal
          currentYear={currentYear}
          seasons={seasons}
          currentLP={totalLP}
          currentRank={rank}
          onClose={() => setShowInfo(false)}
        />
      )}
    </>
  );
}

function RankInfoModal(props: {
  currentYear: number;
  seasons: Record<string, SeasonSnapshot>;
  currentLP: number;
  currentRank: ReturnType<typeof computeRank>;
  onClose: () => void;
}) {
  const { currentYear, seasons, currentLP, currentRank, onClose } = props;
  const lastSeason = seasons[String(currentYear - 1)];
  const current = seasons[String(currentYear)];

  const tierShort =
    currentRank.tier === "Grand Master" ? "GM" : currentRank.tier;
  const nextShort =
    currentRank.nextTier === "Grand Master" ? "GM" : currentRank.nextTier;

  return (
    <Modal title="Ranks" onClose={onClose}>
      <div className="rank-hero">
        <RankIcon tierIndex={currentRank.tierIndex} size={56} />
        <div>
          <div className="rank-hero-name">
            {tierShort}
            {currentRank.divisionRoman && ` ${currentRank.divisionRoman}`}
          </div>
          <div className="rank-hero-sub">
            {currentRank.tierIndex === CHALLENGER_TIER_INDEX
              ? `${currentRank.lp} FP · unlimited`
              : `${currentRank.lp} / ${
                  currentRank.tierIndex === GM_TIER_INDEX
                    ? LP_GM_WINDOW
                    : LP_PER_DIVISION
                } FP → ${nextShort}`}
          </div>
        </div>
      </div>

      <div className="rank-info-section">
        <h3>All ranks</h3>
        <div className="rank-grid">
          {RANKS.map((tier, i) => (
            <div
              key={tier}
              className={`rank-grid-item ${
                i === currentRank.tierIndex ? "current" : ""
              }`}
            >
              <RankIcon tierIndex={i} size={28} />
              <div className="rank-grid-name">
                {tier === "Grand Master" ? "GM" : tier}
              </div>
            </div>
          ))}
        </div>
        <p className="hint">
          Wood–Master have 3 divisions (III → II → I). GM is a single 500-LP
          window. Challenger is uncapped.
        </p>
      </div>

      <div className="rank-info-section">
        <h3>Earning FP</h3>
        <div className="rank-info-row">
          <span>Hour worked (first 10)</span>
          <strong>+{LP_PER_HOUR} FP</strong>
        </div>
        <div className="rank-info-row">
          <span>Hour worked past 10h ✦</span>
          <strong>+{LP_PER_OVERTIME_HOUR} FP</strong>
        </div>
        <div className="rank-info-row">
          <span>Hour missed · past days</span>
          <strong className="penalty">−{LP_PENALTY_PER_MISSED_HOUR} FP</strong>
        </div>
        <p className="hint">
          ✦ Only if your goal was set to more than 10h.
          <br />
          Penalty uses a {MIN_GOAL_HOURS}h–{BONUS_THRESHOLD_HOURS}h window:
          goals below {MIN_GOAL_HOURS}h still penalize as {MIN_GOAL_HOURS}h;
          goals above {BONUS_THRESHOLD_HOURS}h never penalize past{" "}
          {BONUS_THRESHOLD_HOURS}h.
          <br />
          Only <strong>past days</strong> (yesterday and earlier) penalize.
          Today is still open. FP can't go below 0.
        </p>
      </div>

      <div className="rank-info-section">
        <h3>Streaks 🔥</h3>
        <p className="hint">
          +1 each day you work <strong>8+ hours</strong>. Miss up to{" "}
          <strong>3 days</strong> in a row — grace covers them. Additional
          missed days consume shields 🛡 (max 2). Earn shield #1 at 7 streak
          days, #2 at 60. After 180 streak days, one regenerates every 60
          days.
          <br />
          Out of grace + shields? Your streak drops −50% immediately, and
          another −50% every 7 days you stay away. Come back to a full workday
          to stop the decay.
        </p>
      </div>

      <div className="rank-info-section">
        <h3>FP decay at GM+</h3>
        <p className="hint">
          Once your streak enters decay, if you're at <strong>GM</strong> or{" "}
          <strong>Challenger</strong>, you also lose <strong>−10 FP/day</strong>{" "}
          for every additional missed day. Master and below aren't affected.
        </p>
      </div>

      <div className="rank-info-section">
        <h3>Season · {currentYear}</h3>
        <div className="rank-info-row">
          <span>Earned this year</span>
          <strong>{currentLP} FP</strong>
        </div>
        {current && current.startLP > 0 && (
          <div className="rank-info-row subtle">
            <span>Placement boost</span>
            <span>+{current.startLP}</span>
          </div>
        )}
        <p className="hint">
          Resets every Jan 1. Next season you start one rank below your final.
        </p>
        {lastSeason && lastSeason.finalTier !== undefined && (
          <>
            <div className="rank-info-row">
              <span>Last season ({lastSeason.year})</span>
              <strong>
                {(() => {
                  const t = RANKS[lastSeason.finalTier];
                  const tierName = t === "Grand Master" ? "GM" : t;
                  return lastSeason.finalTier >= GM_TIER_INDEX
                    ? tierName
                    : `${tierName} ${["III", "II", "I"][lastSeason.finalDivision ?? 0]}`;
                })()}
              </strong>
            </div>
            {lastSeason.daysPerTier &&
              Object.keys(lastSeason.daysPerTier).length > 0 && (
                <ul className="rank-days-list">
                  {RANKS.filter(
                    (t) => (lastSeason.daysPerTier?.[t] ?? 0) > 0,
                  ).map((t) => (
                    <li key={t}>
                      <span>{t === "Grand Master" ? "GM" : t}</span>
                      <span>
                        {lastSeason.daysPerTier?.[t]}d
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Modal>
  );
}

function LadderView(props: {
  session: SupaSession | null;
  profile: Profile | null;
  onGoToSettings: () => void;
  nowTick: number;
}) {
  const { session, profile, onGoToSettings, nowTick } = props;
  const [sub, setSub] = useState<"friends" | "global">("friends");
  const [friends, setFriends] = useState<Profile[]>([]);
  const [incoming, setIncoming] = useState<Profile[]>([]);
  const [outgoing, setOutgoing] = useState<Profile[]>([]);
  const [stats, setStats] = useState<Record<string, RemoteStats>>({});
  const [global, setGlobal] = useState<
    Array<{ profile: Profile; stats: RemoteStats }>
  >([]);
  const [addCode, setAddCode] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  const userId = session?.user.id;

  const refreshFriends = useCallback(async () => {
    if (!userId) return;
    const res = await loadFriendships(userId);
    setFriends(res.friends);
    setIncoming(res.incoming);
    setOutgoing(res.outgoing);
    const ids = [
      ...res.friends.map((p) => p.id),
      ...res.incoming.map((p) => p.id),
    ];
    if (ids.length > 0) {
      const statsMap = await loadStatsFor(ids);
      setStats(statsMap);
    } else {
      setStats({});
    }
  }, [userId]);

  useEffect(() => {
    void refreshFriends();
  }, [refreshFriends]);

  // Realtime subscription for friends' stats
  useEffect(() => {
    if (!userId || friends.length === 0) return;
    const sb = getSupabase();
    if (!sb) return;
    const friendIds = new Set(friends.map((f) => f.id));
    const channel = sb
      .channel("friend-stats")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stats" },
        (payload) => {
          const row = payload.new as RemoteStats | undefined;
          if (!row) return;
          if (friendIds.has(row.user_id)) {
            setStats((prev) => ({ ...prev, [row.user_id]: row }));
          }
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [userId, friends]);

  useEffect(() => {
    if (sub !== "global" || !userId) return;
    void loadGlobalTop(50).then(setGlobal);
  }, [sub, userId, nowTick]);

  const sendAdd = async () => {
    setAddError(null);
    setAddSuccess(null);
    if (!userId) return;
    const code = addCode.trim().toUpperCase();
    if (code.length < 4) {
      setAddError("Enter a friend code.");
      return;
    }
    const target = await lookupProfileByFriendCode(code);
    if (!target) {
      setAddError("No one found with that code.");
      return;
    }
    if (target.id === userId) {
      setAddError("That's you.");
      return;
    }
    const { error } = await sendFriendRequest(userId, target.id);
    if (error) {
      setAddError(error.includes("duplicate") ? "Already sent." : error);
      return;
    }
    setAddSuccess(`Request sent to ${target.display_name}.`);
    setAddCode("");
    void refreshFriends();
  };

  if (!supabaseConfigured) {
    return (
      <div className="ladder">
        <div className="date-header">Ladder</div>
        <div className="ladder-placeholder">
          <div className="ladder-placeholder-icon">🔧</div>
          <h3>Backend not set up</h3>
          <p>
            The ladder needs a free Supabase project. Follow{" "}
            <code>SUPABASE_SETUP.md</code>, add the keys to{" "}
            <code>.env.local</code>, then rebuild.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="ladder">
        <div className="date-header">Ladder</div>
        <div className="ladder-placeholder">
          <div className="ladder-placeholder-icon">🔒</div>
          <h3>Sign in to compete</h3>
          <p>
            Compare FP, streaks, and live activity with your friends. Sign in
            with your email in Settings.
          </p>
          <button className="btn btn-primary" onClick={onGoToSettings}>
            Go to Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ladder">
      <div className="date-header">Ladder</div>

      <div className="range-picker">
        <button
          className={`range-option ${sub === "friends" ? "active" : ""}`}
          onClick={() => setSub("friends")}
        >
          Friends
        </button>
        <button
          className={`range-option ${sub === "global" ? "active" : ""}`}
          onClick={() => setSub("global")}
        >
          Global
        </button>
      </div>

      {sub === "friends" && (
        <>
          {profile && (
            <div className="friend-code-card">
              <div>
                <div className="friend-code-label">Your friend code</div>
                <div className="friend-code-value">{profile.friend_code}</div>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  navigator.clipboard.writeText(profile.friend_code)
                }
              >
                Copy
              </button>
            </div>
          )}

          <div className="add-friend-row">
            <input
              className="input"
              placeholder="Friend code (e.g. MOH7K2)"
              value={addCode}
              onChange={(e) => {
                setAddCode(e.target.value.toUpperCase());
                setAddError(null);
                setAddSuccess(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && sendAdd()}
              maxLength={8}
            />
            <button className="btn btn-primary" onClick={sendAdd}>
              Add
            </button>
          </div>
          {addError && <p className="error">{addError}</p>}
          {addSuccess && <p className="hint hint-over">{addSuccess}</p>}

          {incoming.length > 0 && (
            <>
              <div className="section-header">
                <span>Incoming requests</span>
              </div>
              <ul className="friend-list">
                {incoming.map((p) => (
                  <li key={p.id} className="friend-request-row">
                    <div className="friend-main">
                      <div className="friend-name">{p.display_name}</div>
                      <div className="friend-sub">{p.friend_code}</div>
                    </div>
                    <div className="row-flex">
                      <button
                        className="btn btn-primary"
                        onClick={async () => {
                          await acceptFriendRequest(userId!, p.id);
                          void refreshFriends();
                        }}
                      >
                        Accept
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={async () => {
                          await rejectFriendRequest(userId!, p.id);
                          void refreshFriends();
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="section-header">
            <span>Friends</span>
          </div>
          {friends.length === 0 ? (
            <div className="empty">
              <p>No friends yet. Share your friend code above.</p>
            </div>
          ) : (
            <ul className="friend-list">
              {friends
                .map((p) => ({ profile: p, stats: stats[p.id] }))
                .sort(
                  (a, b) => (b.stats?.lp ?? 0) - (a.stats?.lp ?? 0),
                )
                .map(({ profile: p, stats: s }) => (
                  <LadderRow
                    key={p.id}
                    profile={p}
                    stats={s}
                    nowTick={nowTick}
                    onRemove={async () => {
                      await removeFriend(userId!, p.id);
                      void refreshFriends();
                    }}
                  />
                ))}
            </ul>
          )}

          {outgoing.length > 0 && (
            <>
              <div className="section-header">
                <span>Pending (sent)</span>
              </div>
              <ul className="friend-list">
                {outgoing.map((p) => (
                  <li key={p.id} className="friend-row dim">
                    <div className="friend-main">
                      <div className="friend-name">{p.display_name}</div>
                      <div className="friend-sub">
                        Waiting for {p.friend_code}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {sub === "global" && (
        <>
          <div className="section-header">
            <span>Top {global.length || 50} by FP</span>
          </div>
          {global.length === 0 ? (
            <div className="empty">
              <p>No one on the board yet.</p>
            </div>
          ) : (
            <ul className="friend-list">
              {global.map((row, i) => {
                const isSelf = row.profile.id === userId;
                const isFriend = friends.some(
                  (f) => f.id === row.profile.id,
                );
                const isPending =
                  outgoing.some((o) => o.id === row.profile.id) ||
                  incoming.some((inc) => inc.id === row.profile.id);
                const addStatus: "none" | "pending" | "friend" = isFriend
                  ? "friend"
                  : isPending
                    ? "pending"
                    : "none";
                return (
                  <LadderRow
                    key={row.profile.id}
                    profile={row.profile}
                    stats={row.stats}
                    rank={i + 1}
                    highlight={isSelf}
                    nowTick={nowTick}
                    onAddFriend={
                      isSelf
                        ? undefined
                        : async () => {
                            if (!userId) return;
                            await sendFriendRequest(userId, row.profile.id);
                            void refreshFriends();
                          }
                    }
                    addStatus={isSelf ? "friend" : addStatus}
                  />
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function LadderRow(props: {
  profile: Profile;
  stats: RemoteStats | undefined;
  rank?: number;
  highlight?: boolean;
  nowTick: number;
  onRemove?: () => void;
  onAddFriend?: () => void;
  addStatus?: "none" | "pending" | "friend";
}) {
  const {
    profile: p,
    stats: s,
    rank,
    highlight,
    nowTick,
    onRemove,
    onAddFriend,
    addStatus,
  } = props;
  const isWorking = s?.is_working && s?.session_started_at;
  const liveElapsed = isWorking
    ? nowTick - new Date(s.session_started_at!).getTime()
    : 0;
  const hoursToday = (s?.hours_today_ms ?? 0) + (isWorking ? liveElapsed : 0);
  const tierShort =
    s !== undefined
      ? RANKS[s.tier_index] === "Grand Master"
        ? "GM"
        : RANKS[s.tier_index]
      : "—";
  const divRoman =
    s && s.tier_index < GM_TIER_INDEX ? ["III", "II", "I"][s.division] : "";
  return (
    <li className={`friend-row ${highlight ? "self" : ""}`}>
      <div className="friend-rank-icon">
        {rank && <span className="friend-rank-num">{rank}</span>}
        {s && <RankIcon tierIndex={s.tier_index} size={26} />}
      </div>
      <div className="friend-main">
        <div className="friend-name">{p.display_name}</div>
        <div className="friend-sub">
          {s ? (
            <>
              {tierShort}
              {divRoman && ` ${divRoman}`} · {s.lp} FP · 🔥 {s.streak}
            </>
          ) : (
            "No stats yet"
          )}
        </div>
      </div>
      <div className="friend-right">
        {isWorking ? (
          <>
            <div className="friend-active-label">
              ▶ {s.current_project ?? "working"}
            </div>
            <div className="friend-active-time">
              {formatClock(liveElapsed)}
            </div>
          </>
        ) : hoursToday > 0 ? (
          <>
            <div className="friend-today-label">Today</div>
            <div className="friend-today-time">
              {formatHoursMinutes(hoursToday)}
            </div>
          </>
        ) : (
          <div className="friend-idle">—</div>
        )}
      </div>
      {onRemove && (
        <button
          className="btn btn-danger-ghost friend-action-btn"
          onClick={onRemove}
          title="Remove friend"
        >
          ✕
        </button>
      )}
      {onAddFriend && addStatus === "none" && (
        <button
          className="btn btn-primary friend-action-btn"
          onClick={onAddFriend}
          title="Send friend request"
        >
          + Add
        </button>
      )}
      {onAddFriend && addStatus === "pending" && (
        <span className="friend-action-pill">Pending</span>
      )}
      {onAddFriend && addStatus === "friend" && (
        <span className="friend-action-pill friend">Friend</span>
      )}
    </li>
  );
}

function ProjectRow(props: {
  project: Project;
  hours: number;
  spent: number;
  pct: number;
  isActive: boolean;
  isOff: boolean;
  disabled: boolean;
  onStart: () => void;
  onPause: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onSetHours: (hours: number) => void;
}) {
  const {
    project,
    hours,
    spent,
    pct,
    isActive,
    isOff,
    disabled,
    onStart,
    onPause,
    onDelete,
    onRename,
    onSetHours,
  } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [hoursStr, setHoursStr] = useState(String(hours));
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(project.name);
    setHoursStr(String(hours));
    setConfirmDelete(false);
  }, [project, hours, editing]);

  if (editing) {
    return (
      <li className="project-row editing">
        <label className="field">
          <span>Project name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />
        </label>
        <label className="field">
          <span>Hours for today</span>
          <input
            className="input"
            type="number"
            step="0.25"
            min="0"
            value={hoursStr}
            onChange={(e) => setHoursStr(e.target.value)}
          />
        </label>
        <div className="row-flex">
          <button
            className="btn btn-primary"
            onClick={() => {
              const h = parseFloat(hoursStr);
              const trimmedName = name.trim();
              if (trimmedName && !isNaN(h) && h >= 0) {
                if (trimmedName !== project.name) onRename(trimmedName);
                if (h !== hours) onSetHours(h);
                setEditing(false);
              }
            }}
          >
            Save
          </button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            className="btn btn-danger-ghost"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        </div>
        {confirmDelete && (
          <div className="delete-confirm">
            <p>
              Delete <strong>{project.name}</strong> forever? Past sessions
              stay in history but lose their project name.
            </p>
            <div className="row-flex">
              <button
                className="btn btn-danger-ghost"
                onClick={() => {
                  onDelete();
                  setEditing(false);
                }}
              >
                Yes, delete
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <li className={`project-row ${isActive ? "active" : ""} ${isOff ? "off" : ""}`}>
      <div className="project-main">
        <div className="project-info" onClick={() => setEditing(true)}>
          <div className="project-name">{project.name}</div>
          <div className="project-stats">
            {isOff
              ? "Not set for today — tap to set hours"
              : `${formatHoursMinutes(spent)} / ${hours}h`}
          </div>
        </div>
        <button
          className={`play-btn ${isActive ? "active" : ""}`}
          onClick={isActive ? onPause : onStart}
          aria-label={isActive ? "Pause" : "Start"}
          disabled={disabled && !isActive}
        >
          {isActive ? "❚❚" : "▶"}
        </button>
      </div>
      {!isOff && (
        <div className="progress-bar thin">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}

function AddProjectModal(props: {
  existingNames: Set<string>;
  goalHours: number;
  allocatedHours: number;
  onAdd: (name: string, hours: number) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [hours, setHours] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const remaining = Math.max(0, props.goalHours - props.allocatedHours);
  const parsedHours = parseFloat(hours);
  const overAllocated =
    props.goalHours > 0 &&
    Number.isFinite(parsedHours) &&
    parsedHours > remaining;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a project name.");
      return;
    }
    if (props.existingNames.has(trimmed.toLowerCase())) {
      setError("A project with this name already exists.");
      return;
    }
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Enter a valid number of hours.");
      return;
    }
    props.onAdd(trimmed, parsedHours);
  };

  return (
    <Modal title="Add project" onClose={props.onClose}>
      <label className="field">
        <span>Project name</span>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. Website redesign"
        />
      </label>
      <label className="field">
        <span>
          Hours for today
          {props.goalHours > 0 && (
            <span className="field-sub">
              {" "}
              · {remaining}h left of {props.goalHours}h goal
            </span>
          )}
        </span>
        <input
          className={`input ${overAllocated ? "input-over" : ""}`}
          type="number"
          step="0.25"
          min="0.25"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {props.goalHours === 0 && (
          <p className="hint">Lock your day's goal first to see remaining time.</p>
        )}
        {overAllocated && (
          <p className="hint hint-over">
            Over-allocating — nice. More than the day's goal means bonus work.
          </p>
        )}
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit}>
          Add
        </button>
      </div>
    </Modal>
  );
}

function SessionLogModal(props: {
  day: DayData;
  projectById: Map<string, Project>;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const sessions = [...props.day.sessions].sort((a, b) => b.startMs - a.startMs);

  return (
    <Modal title="Today's sessions" onClose={props.onClose}>
      {sessions.length === 0 ? (
        <p className="hint">No sessions logged yet.</p>
      ) : (
        <ul className="log-list">
          {sessions.map((s) => {
            const start = new Date(s.startMs);
            const time = start.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const name = props.projectById.get(s.projectId)?.name ?? "(deleted)";
            return (
              <li key={s.id} className="log-row">
                <div className="log-main">
                  <div className="log-project">{name}</div>
                  <div className="log-meta">
                    {time} · {formatHoursMinutes(s.endMs - s.startMs)}
                    {s.source === "manual" && " · manual"}
                  </div>
                </div>
                <button
                  className="btn btn-danger-ghost"
                  onClick={() => props.onDelete(s.id)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function WeekView(props: {
  days: Record<string, DayData>;
  today: string;
  projectById: Map<string, Project>;
}) {
  const [offset, setOffset] = useState(0);
  const anchor = useMemo(() => addDays(props.today, offset * 7), [props.today, offset]);
  const keys = weekKeys(anchor);
  const weekDays = keys.map((k) => props.days[k]).filter(Boolean);
  const rangeLabel = (() => {
    const start = keys[0];
    const end = keys[keys.length - 1];
    const [ys, ms, ds] = start.split("-").map(Number);
    const [ye, me, de] = end.split("-").map(Number);
    const s = new Date(ys, ms - 1, ds);
    const e = new Date(ye, me - 1, de);
    const sameMonth = s.getMonth() === e.getMonth();
    if (sameMonth) {
      return `${s.toLocaleDateString(undefined, { month: "short" })} ${ds}–${de}`;
    }
    return `${s.toLocaleDateString(undefined, { month: "short" })} ${ds} – ${e.toLocaleDateString(undefined, { month: "short" })} ${de}`;
  })();

  const totalSpentMs = weekDays.reduce((acc, d) => acc + daySpentMs(d), 0);
  const totalTargetMs = weekDays.reduce((acc, d) => acc + dayTargetMs(d), 0);
  const goalHitDays = weekDays.filter(
    (d) => dayTargetMs(d) > 0 && daySpentMs(d) >= dayTargetMs(d),
  ).length;

  const projectTotals = useMemo(() => {
    const map = new Map<string, number>();
    weekDays.forEach((d) => {
      d.sessions.forEach((s) => {
        const name = props.projectById.get(s.projectId)?.name ?? "(deleted)";
        map.set(name, (map.get(name) ?? 0) + (s.endMs - s.startMs));
      });
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [weekDays, props.projectById]);

  const maxProjectMs = Math.max(1, ...projectTotals.map(([, v]) => v));
  const maxDayMs = Math.max(
    1,
    ...keys.map((k) => (props.days[k] ? daySpentMs(props.days[k]) : 0)),
  );

  return (
    <div className="week">
      <div className="week-nav">
        <button
          className="week-nav-btn"
          onClick={() => setOffset((o) => o - 1)}
          aria-label="Previous week"
        >
          ‹
        </button>
        <div className="week-nav-label">
          <div className="week-nav-title">
            {offset === 0 ? "This week" : offset === -1 ? "Last week" : rangeLabel}
          </div>
          {offset !== 0 && <div className="week-nav-sub">{rangeLabel}</div>}
        </div>
        <button
          className="week-nav-btn"
          onClick={() => setOffset((o) => Math.min(0, o + 1))}
          disabled={offset >= 0}
          aria-label="Next week"
        >
          ›
        </button>
      </div>

      <div className="week-summary">
        <div className="stat total">
          <div className="stat-value">{formatHoursMinutes(totalSpentMs)}</div>
          <div className="stat-label">Total</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            {totalTargetMs > 0
              ? Math.round((totalSpentMs / totalTargetMs) * 100)
              : 0}
            %
          </div>
          <div className="stat-label">of goal</div>
        </div>
        <div className="stat hit">
          <div className="stat-value">
            {goalHitDays}/{keys.length}
          </div>
          <div className="stat-label">goals done</div>
        </div>
      </div>

      <div className="section-header">
        <span>By day</span>
      </div>
      <div className="day-bars">
        {keys.map((k) => {
          const d = props.days[k];
          const spent = d ? daySpentMs(d) : 0;
          const target = d ? dayTargetMs(d) : 0;
          const pct = maxDayMs > 0 ? (spent / maxDayMs) * 100 : 0;
          const hit = target > 0 && spent >= target;
          const [y, m, dd] = k.split("-").map(Number);
          const date = new Date(y, m - 1, dd);
          const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
          return (
            <div
              key={k}
              className={`day-bar ${k === props.today ? "today" : ""}`}
            >
              <div className="day-bar-label">{weekday}</div>
              <div className="day-bar-track">
                <div
                  className={`day-bar-fill ${hit ? "hit" : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="day-bar-value">
                {spent > 0 ? formatHoursMinutes(spent) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="section-header">
        <span>By project</span>
      </div>
      {projectTotals.length === 0 ? (
        <div className="empty">
          <p>No sessions this week yet.</p>
        </div>
      ) : (
        <ul className="project-totals">
          {projectTotals.map(([name, ms]) => (
            <li key={name} className="project-total">
              <div className="project-total-top">
                <span>{name}</span>
                <strong>{formatHoursMinutes(ms)}</strong>
              </div>
              <div className="progress-bar thin">
                <div
                  className="progress-fill"
                  style={{ width: `${(ms / maxProjectMs) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type MoneyRange = "this-month" | "last-month" | "quarter" | "year" | "all";

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadText(filename: string, content: string, mime = "text/csv") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function exportEarningsCSV(earnings: Earning[], symbol: string) {
  const rows: (string | number)[][] = [
    ["Date", "Source", `Amount (${symbol})`, "Note"],
  ];
  const sorted = [...earnings].sort((a, b) => a.createdMs - b.createdMs);
  for (const e of sorted) {
    rows.push([
      e.dateKey,
      e.source,
      (e.amountCents / 100).toFixed(2),
      e.note ?? "",
    ]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`earnings-${stamp}.csv`, csv);
}

function exportSessionsCSV(
  days: Record<string, DayData>,
  projectById: Map<string, Project>,
) {
  const rows: (string | number)[][] = [
    ["Date", "Project", "Start", "End", "Minutes", "Source"],
  ];
  const sorted = Object.values(days).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const day of sorted) {
    for (const s of day.sessions) {
      const minutes = Math.round((s.endMs - s.startMs) / 60000);
      const name = projectById.get(s.projectId)?.name ?? "(deleted)";
      rows.push([
        day.date,
        name,
        new Date(s.startMs).toISOString(),
        new Date(s.endMs).toISOString(),
        minutes,
        s.source,
      ]);
    }
  }
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`sessions-${stamp}.csv`, csv);
}

function MoneyView(props: {
  earnings: Earning[];
  monthlyGoals: Record<string, number>;
  currencySymbol: string;
  onAdd: (
    amountCents: number,
    source: string,
    dateKey: string,
    note?: string,
  ) => void;
  onUpdate: (id: string, patch: Partial<Earning>) => void;
  onDelete: (id: string) => void;
  onSetGoal: (monthKey: string, cents: number) => void;
}) {
  const {
    earnings,
    monthlyGoals,
    currencySymbol,
    onAdd,
    onUpdate,
    onDelete,
    onSetGoal,
  } = props;
  const mk = monthKey();
  const [showAdd, setShowAdd] = useState(false);
  const [showGoal, setShowGoal] = useState(false);
  const [editing, setEditing] = useState<Earning | null>(null);
  const [range, setRange] = useState<MoneyRange>("this-month");

  const fmt = (cents: number) => formatMoney(cents, currencySymbol);

  const thisMonth = earnings.filter(
    (e) => monthKeyFromDateKey(e.dateKey) === mk,
  );
  const totalCents = thisMonth.reduce((acc, e) => acc + e.amountCents, 0);

  const goalCents = (() => {
    if (monthlyGoals[mk] != null) return monthlyGoals[mk];
    const prior = Object.keys(monthlyGoals)
      .filter((k) => k < mk)
      .sort()
      .pop();
    return prior ? monthlyGoals[prior] : 0;
  })();

  const pct = goalCents > 0 ? Math.min(100, (totalCents / goalCents) * 100) : 0;
  const daysLeft = daysLeftInMonth();

  const { rangeEarnings, rangeLabel } = useMemo(() => {
    const [yStr] = mk.split("-");
    const year = Number(yStr);
    const currentMonth = Number(mk.split("-")[1]);
    const currentQuarter = Math.floor((currentMonth - 1) / 3) + 1;

    switch (range) {
      case "this-month":
        return { rangeEarnings: thisMonth, rangeLabel: "This month" };
      case "last-month": {
        const prev = (() => {
          const [y, m] = mk.split("-").map(Number);
          const d = new Date(y, m - 2, 1);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        })();
        return {
          rangeEarnings: earnings.filter(
            (e) => monthKeyFromDateKey(e.dateKey) === prev,
          ),
          rangeLabel: "Last month",
        };
      }
      case "quarter": {
        const start = (currentQuarter - 1) * 3 + 1;
        const months = [0, 1, 2].map(
          (i) => `${year}-${String(start + i).padStart(2, "0")}`,
        );
        return {
          rangeEarnings: earnings.filter((e) =>
            months.includes(monthKeyFromDateKey(e.dateKey)),
          ),
          rangeLabel: `Q${currentQuarter} ${year}`,
        };
      }
      case "year":
        return {
          rangeEarnings: earnings.filter((e) => e.dateKey.startsWith(yStr)),
          rangeLabel: String(year),
        };
      case "all":
        return { rangeEarnings: earnings, rangeLabel: "All time" };
    }
  }, [range, earnings, mk, thisMonth]);

  const rangeTotal = rangeEarnings.reduce((a, e) => a + e.amountCents, 0);
  const sorted = [...rangeEarnings].sort((a, b) => b.createdMs - a.createdMs);

  const bySource = useMemo(() => {
    const map = new Map<string, number>();
    rangeEarnings.forEach((e) => {
      map.set(e.source, (map.get(e.source) ?? 0) + e.amountCents);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [rangeEarnings]);

  const rangeOptions: { id: MoneyRange; label: string }[] = [
    { id: "this-month", label: "This month" },
    { id: "last-month", label: "Last month" },
    { id: "quarter", label: "Quarter" },
    { id: "year", label: "Year" },
    { id: "all", label: "All" },
  ];

  return (
    <div className="money">
      <div className="date-header">{formatMonthHeader(mk)}</div>

      <div className="money-goal">
        {goalCents > 0 ? (
          <>
            <div className="money-goal-top">
              <div>
                <div className="money-amount">{fmt(totalCents)}</div>
                <div className="money-sub">of {fmt(goalCents)} goal</div>
              </div>
              <button className="btn btn-ghost" onClick={() => setShowGoal(true)}>
                Edit
              </button>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="money-meta">
              <span>{Math.round(pct)}%</span>
              <span>
                {totalCents < goalCents
                  ? `${fmt(goalCents - totalCents)} to go · ${daysLeft} days left`
                  : `Goal hit · +${fmt(totalCents - goalCents)} over`}
              </span>
            </div>
          </>
        ) : (
          <div className="empty">
            <p>No monthly goal set yet.</p>
            <button className="btn btn-primary" onClick={() => setShowGoal(true)}>
              Set a goal
            </button>
          </div>
        )}
      </div>

      <div className="range-picker">
        {rangeOptions.map((r) => (
          <button
            key={r.id}
            className={`range-option ${range === r.id ? "active" : ""}`}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="range-summary">
        <div>
          <div className="range-total">{fmt(rangeTotal)}</div>
          <div className="range-meta">
            {rangeLabel} · {rangeEarnings.length}{" "}
            {rangeEarnings.length === 1 ? "entry" : "entries"}
          </div>
        </div>
      </div>

      <div className="section-header">
        <span>Entries</span>
        <button className="btn btn-ghost" onClick={() => setShowAdd(true)}>
          + Add
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          <p>No earnings logged in this range.</p>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            Log your first earning
          </button>
        </div>
      ) : (
        <ul className="earning-list">
          {sorted.map((e) => {
            const date = new Date(e.createdMs);
            const when = date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
            return (
              <li
                key={e.id}
                className="earning-row"
                onClick={() => setEditing(e)}
              >
                <div className="earning-main">
                  <div className="earning-source">{e.source}</div>
                  <div className="earning-when">
                    {when}
                    {e.note && ` · ${e.note}`}
                  </div>
                </div>
                <div className="earning-amount">{fmt(e.amountCents)}</div>
              </li>
            );
          })}
        </ul>
      )}

      {bySource.length > 1 && (
        <>
          <div className="section-header">
            <span>By source</span>
          </div>
          <ul className="project-totals">
            {bySource.map(([source, cents]) => (
              <li key={source} className="project-total">
                <div className="project-total-top">
                  <span>{source}</span>
                  <strong>{fmt(cents)}</strong>
                </div>
                <div className="progress-bar thin">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${(cents / Math.max(1, rangeTotal)) * 100}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {showAdd && (
        <AddEarningModal
          currencySymbol={currencySymbol}
          onAdd={(amount, source, note) => {
            onAdd(amount, source, todayKey(), note);
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showGoal && (
        <SetGoalModal
          current={goalCents}
          currencySymbol={currencySymbol}
          monthLabel={formatMonthHeader(mk)}
          onSet={(cents) => {
            onSetGoal(mk, cents);
            setShowGoal(false);
          }}
          onClose={() => setShowGoal(false)}
        />
      )}
      {editing && (
        <EditEarningModal
          earning={editing}
          currencySymbol={currencySymbol}
          onSave={(patch) => {
            onUpdate(editing.id, patch);
            setEditing(null);
          }}
          onDelete={() => {
            onDelete(editing.id);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AddEarningModal(props: {
  currencySymbol: string;
  onAdd: (amountCents: number, source: string, note?: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    if (!source.trim()) {
      setError("Where did it come from?");
      return;
    }
    const cents = Math.round(parsed * 100);
    props.onAdd(cents, source.trim(), note.trim() || undefined);
  };

  return (
    <Modal title="Log earning" onClose={props.onClose}>
      <label className="field">
        <span>Amount ({props.currencySymbol})</span>
        <input
          className="input"
          type="number"
          step="0.01"
          min="0"
          autoFocus
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="200"
        />
      </label>
      <label className="field">
        <span>Source</span>
        <input
          className="input"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. Client A, Freelance gig"
        />
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Landing page"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit}>
          Add
        </button>
      </div>
    </Modal>
  );
}

function EditEarningModal(props: {
  earning: Earning;
  currencySymbol: string;
  onSave: (patch: Partial<Earning>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(
    (props.earning.amountCents / 100).toFixed(2),
  );
  const [source, setSource] = useState(props.earning.source);
  const [note, setNote] = useState(props.earning.note ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return;
    if (!source.trim()) return;
    props.onSave({
      amountCents: Math.round(parsed * 100),
      source: source.trim(),
      note: note.trim() || undefined,
    });
  };

  return (
    <Modal title="Edit earning" onClose={props.onClose}>
      <label className="field">
        <span>Amount ({props.currencySymbol})</span>
        <input
          className="input"
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Source</span>
        <input
          className="input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Note</span>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {confirmDelete ? (
        <div className="delete-confirm">
          <p>Delete this earning?</p>
          <div className="row-flex">
            <button className="btn btn-danger-ghost" onClick={props.onDelete}>
              Yes, delete
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions">
          <button
            className="btn btn-danger-ghost"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Save
          </button>
        </div>
      )}
    </Modal>
  );
}

function SetGoalModal(props: {
  current: number;
  currencySymbol: string;
  monthLabel: string;
  onSet: (cents: number) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(
    props.current > 0 ? (props.current / 100).toFixed(0) : "1000",
  );

  const submit = () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed < 0) return;
    props.onSet(Math.round(parsed * 100));
  };

  return (
    <Modal title={`Goal for ${props.monthLabel}`} onClose={props.onClose}>
      <label className="field">
        <span>Monthly goal ({props.currencySymbol})</span>
        <input
          className="input"
          type="number"
          step="1"
          min="0"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <p className="hint">
          This is your target for {props.monthLabel}. Set a new one next month
          if you want to change it.
        </p>
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function AccountSection(props: {
  session: SupaSession | null;
  profile: Profile | null;
  onProfileChanged: (p: Profile) => void;
}) {
  const { session, profile, onProfileChanged } = props;
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"email" | "otp">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);

  if (!supabaseConfigured) {
    return (
      <div className="setting">
        <div className="field">
          <span>Account</span>
        </div>
        <p className="hint">
          Ladder is off. Add your Supabase keys to <code>.env.local</code> and
          rebuild. See <code>SUPABASE_SETUP.md</code>.
        </p>
      </div>
    );
  }

  if (!session) {
    const sendCode = async () => {
      setError(null);
      if (!email.includes("@")) {
        setError("Enter a valid email.");
        return;
      }
      setBusy(true);
      const { error } = await sendOtp(email.trim());
      setBusy(false);
      if (error) {
        setError(error);
        return;
      }
      setStage("otp");
    };
    const verify = async () => {
      setError(null);
      const code = otp.trim();
      if (code.length < 4) {
        setError("Enter the code from the email.");
        return;
      }
      setBusy(true);
      const { error } = await verifyOtp(email.trim(), code);
      setBusy(false);
      if (error) {
        setError(error);
        return;
      }
    };

    return (
      <div className="setting">
        <div className="field">
          <span>Account</span>
        </div>
        <p className="hint">
          Sign in with your email to join the ladder. We'll send you a code — no
          password.
        </p>
        {stage === "email" ? (
          <>
            <input
              className="input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && sendCode()}
            />
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={sendCode}
              >
                {busy ? "Sending…" : "Send code"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              Check your inbox for the code sent to <strong>{email}</strong>.
            </p>
            <input
              className="input"
              inputMode="numeric"
              placeholder="Enter code"
              value={otp}
              onChange={(e) => {
                setOtp(e.target.value.replace(/\D/g, ""));
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && verify()}
              maxLength={10}
            />
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setStage("email");
                  setOtp("");
                  setError(null);
                }}
              >
                Back
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={verify}
              >
                {busy ? "Verifying…" : "Verify"}
              </button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="setting">
      <div className="field">
        <span>Account</span>
      </div>
      {profile ? (
        <div className="account-card">
          <div className="account-card-left">
            {editingName ? (
              <div className="account-name-edit">
                <input
                  className="input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={24}
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") {
                      const n = nameDraft.trim();
                      if (!n) return;
                      const { error } = await updateDisplayName(profile.id, n);
                      if (error) {
                        setError(error);
                        return;
                      }
                      onProfileChanged({ ...profile, display_name: n });
                      setEditingName(false);
                    }
                    if (e.key === "Escape") setEditingName(false);
                  }}
                />
                <button
                  className="icon-btn"
                  onClick={async () => {
                    const n = nameDraft.trim();
                    if (!n) return;
                    const { error } = await updateDisplayName(profile.id, n);
                    if (error) {
                      setError(error);
                      return;
                    }
                    onProfileChanged({ ...profile, display_name: n });
                    setEditingName(false);
                  }}
                  aria-label="Save"
                >
                  ✓
                </button>
              </div>
            ) : (
              <button
                className="account-name-btn"
                onClick={() => {
                  setNameDraft(profile.display_name);
                  setEditingName(true);
                }}
                aria-label="Edit display name"
              >
                <span className="account-name-text">
                  {profile.display_name}
                </span>
                <span className="account-name-pencil">✎</span>
              </button>
            )}
            <button
              className="account-code-btn"
              onClick={() => {
                navigator.clipboard.writeText(profile.friend_code);
                setCodeCopied(true);
                setTimeout(() => setCodeCopied(false), 1200);
              }}
              aria-label="Copy friend code"
            >
              <span className="account-code-text">{profile.friend_code}</span>
              <span className="account-code-copy">
                {codeCopied ? "✓" : "⧉"}
              </span>
            </button>
          </div>
          <button
            className="btn btn-danger-soft"
            onClick={async () => {
              await signOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <p className="hint">Setting up your profile…</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SettingsView(props: {
  settings: Settings;
  earnings: Earning[];
  days: Record<string, DayData>;
  projectById: Map<string, Project>;
  session: SupaSession | null;
  profile: Profile | null;
  onUpdate: (s: Settings) => void;
  onProfileChanged: (p: Profile) => void;
}) {
  const {
    settings,
    earnings,
    days,
    projectById,
    session,
    profile,
    onUpdate,
    onProfileChanged,
  } = props;
  const themes: { id: Settings["theme"]; label: string }[] = [
    { id: "blue", label: "🔵  Blue" },
    { id: "neutral", label: "⚪  Neutral" },
    { id: "violet", label: "🟣  Violet" },
    { id: "teal", label: "🩵  Teal" },
  ];

  return (
    <div className="settings">
      <div className="date-header">Settings</div>

      <AccountSection
        session={session}
        profile={profile}
        onProfileChanged={onProfileChanged}
      />

      <div className="setting">
        <label className="toggle-row">
          <span>Theme</span>
          <select
            className="input select-compact"
            value={settings.theme}
            onChange={(e) =>
              onUpdate({
                ...settings,
                theme: e.target.value as Settings["theme"],
              })
            }
          >
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="setting">
        <label className="toggle-row">
          <span>Show timer in menubar</span>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.showMenubarTimer}
            onChange={(e) =>
              onUpdate({ ...settings, showMenubarTimer: e.target.checked })
            }
          />
        </label>
        <p className="hint">
          When off, the menubar just shows the app icon — no time text.
        </p>
      </div>

      <div className="setting">
        <label className="toggle-row">
          <span>Launch at login</span>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.launchAtLogin}
            onChange={(e) =>
              onUpdate({ ...settings, launchAtLogin: e.target.checked })
            }
          />
        </label>
        <p className="hint">
          Start Forge automatically when you log in.
        </p>
      </div>

      <div className="setting">
        <label className="toggle-row">
          <span>Share current project on ladder</span>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.shareCurrentProject}
            onChange={(e) =>
              onUpdate({ ...settings, shareCurrentProject: e.target.checked })
            }
          />
        </label>
        <p className="hint">
          When on, friends see the project you're working on. When off, they
          just see "working" with the elapsed time.
        </p>
      </div>

      <div className="setting">
        <label className="toggle-row">
          <span>Notifications</span>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.notifications}
            onChange={(e) =>
              onUpdate({ ...settings, notifications: e.target.checked })
            }
          />
        </label>
        <p className="hint">
          Alerts for: break ending, daily goal hit, rank up, and auto-pause on
          inactivity.
        </p>
      </div>

      {IS_PERSONAL && (
        <>
          <div className="setting">
            <label className="toggle-row">
              <span>Currency symbol</span>
              <input
                className="input select-compact"
                value={settings.currencySymbol}
                onChange={(e) =>
                  onUpdate({ ...settings, currencySymbol: e.target.value })
                }
                maxLength={3}
                placeholder="$"
              />
            </label>
          </div>

          <div className="setting">
            <div className="field">
              <span>Export</span>
            </div>
            <div className="row-flex">
              <button
                className="btn btn-secondary"
                onClick={() =>
                  exportEarningsCSV(earnings, settings.currencySymbol)
                }
              >
                Earnings CSV
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => exportSessionsCSV(days, projectById)}
              >
                Sessions CSV
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{props.title}</div>
          <button className="close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export default App;
