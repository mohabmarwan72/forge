export type Project = {
  id: string;
  name: string;
  lastHours: number;
};

export type Allocation = {
  projectId: string;
  hours: number;
};

export type Session = {
  id: string;
  projectId: string;
  startMs: number;
  endMs: number;
  source: "timer" | "manual";
};

export type BreakLog = {
  startMs: number;
  endMs: number;
  /** Original duration the user picked, in ms. */
  plannedMs: number;
};

export type DayData = {
  date: string;
  /** Fixed daily goal in hours, set once at day start. 0 means unset. */
  goalHours: number;
  allocations: Allocation[];
  sessions: Session[];
  breaks: BreakLog[];
  carryOverHours: number;
};

export type Theme = "blue" | "neutral" | "violet" | "teal";

export type Settings = {
  carryOverFactor: number;
  theme: Theme;
  showMenubarTimer: boolean;
  currencySymbol: string;
  notifications: boolean;
  launchAtLogin: boolean;
  /** Minutes of no keyboard/mouse before timer auto-pauses. */
  idleThresholdMin: number;
  /** Whether to share the active project name with friends / global ladder. */
  shareCurrentProject: boolean;
};

export type BreakState = {
  startedAtMs: number;
  endMs: number;
  plannedMs: number;
} | null;

export type CurrentTimer = {
  projectId: string;
  startedAtMs: number;
} | null;

export type Tab = "today" | "week" | "ladder" | "money" | "settings";

export type Earning = {
  id: string;
  amountCents: number;
  source: string;
  dateKey: string;
  createdMs: number;
  note?: string;
};

export type SeasonSnapshot = {
  year: number;
  startLP: number;
  finalLP?: number;
  finalTier?: number;
  finalDivision?: number;
  daysPerTier?: Record<string, number>;
};
