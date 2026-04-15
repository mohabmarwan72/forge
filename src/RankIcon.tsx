type Color = { light: string; mid: string; dark: string };

const RANK_PALETTE: Color[] = [
  { light: "#c29063", mid: "#825133", dark: "#3b2414" }, // Wood
  { light: "#c7c7cc", mid: "#86868c", dark: "#3a3a3f" }, // Iron
  { light: "#e8a867", mid: "#b3712a", dark: "#5a3512" }, // Bronze
  { light: "#f5f5fa", mid: "#bdbdc5", dark: "#6a6a74" }, // Silver
  { light: "#ffe58a", mid: "#f0b400", dark: "#8a6300" }, // Gold
  { light: "#9ef0ee", mid: "#5ac8c8", dark: "#266666" }, // Platinum
  { light: "#8ff0a3", mid: "#30d158", dark: "#176b2d" }, // Emerald
  { light: "#b9e7ff", mid: "#64d2ff", dark: "#2171a8" }, // Diamond
  { light: "#e5b7f8", mid: "#bf5af2", dark: "#5e1f91" }, // Master
  { light: "#ffa8b6", mid: "#ff375f", dark: "#8e1a33" }, // Grand Master
  { light: "#ffffff", mid: "#a8e2ff", dark: "#3a7cb8" }, // Challenger
];

export function RankIcon({
  tierIndex,
  size = 34,
}: {
  tierIndex: number;
  size?: number;
}) {
  const c = RANK_PALETTE[Math.max(0, Math.min(RANK_PALETTE.length - 1, tierIndex))];
  const gradId = `rank-grad-${tierIndex}`;
  const innerId = `rank-inner-${tierIndex}`;
  const glowId = `rank-glow-${tierIndex}`;
  const isChallenger = tierIndex === 10;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c.light} />
          <stop offset="55%" stopColor={c.mid} />
          <stop offset="100%" stopColor={c.dark} />
        </linearGradient>
        <linearGradient id={innerId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.05)" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.5" cy="0.3" r="0.6">
          <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>

      {/* Outer hexagon */}
      <polygon
        points="18,2 32,10 32,26 18,34 4,26 4,10"
        fill={`url(#${gradId})`}
        stroke={isChallenger ? "rgba(255,220,120,0.8)" : "rgba(255,255,255,0.2)"}
        strokeWidth="1"
      />

      {/* Highlight overlay */}
      <polygon
        points="18,4 30,11 30,18 18,12 6,18 6,11"
        fill={`url(#${innerId})`}
        opacity="0.7"
      />

      {/* Inner crest hexagon */}
      <polygon
        points="18,9 26,13.5 26,22.5 18,27 10,22.5 10,13.5"
        fill="rgba(0,0,0,0.18)"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="0.6"
      />

      {/* Center gem diamond */}
      <polygon
        points="18,13 22,18 18,23 14,18"
        fill="rgba(255,255,255,0.95)"
        opacity="0.85"
      />

      {/* Soft top glow */}
      <polygon
        points="18,2 32,10 32,12 18,6 4,12 4,10"
        fill={`url(#${glowId})`}
      />

      {/* Challenger shine */}
      {isChallenger && (
        <polygon
          points="18,2 32,10 32,26 18,34 4,26 4,10"
          fill="none"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth="0.4"
        />
      )}
    </svg>
  );
}
