/*
 * A gym badge, drawn rather than loaded.
 *
 * The league awards one badge per champion season, walking the gym badge sequence region by
 * region. There is no badge artwork in the repository and the official sprites are not ours
 * to ship, so the badge is drawn: a medallion coloured by region, numbered by its place in
 * that region's sequence, with its name underneath. It reads as a badge, it is the same
 * shape for every region, and the colour is what tells a Kanto season from a Johto one.
 */
"use client";

/** The accent colour each region's badges are struck in. */
const REGION_COLORS: Record<string, { ring: string; core: string; text: string }> = {
  Kanto: { ring: "#f59e0b", core: "#7c2d12", text: "#fde68a" },
  Johto: { ring: "#38bdf8", core: "#0c4a6e", text: "#bae6fd" },
  Hoenn: { ring: "#34d399", core: "#064e3b", text: "#a7f3d0" },
  Sinnoh: { ring: "#a78bfa", core: "#3b0764", text: "#ddd6fe" },
  Unova: { ring: "#f472b6", core: "#500724", text: "#fbcfe8" },
  Kalos: { ring: "#f87171", core: "#450a0a", text: "#fecaca" },
  Alola: { ring: "#fbbf24", core: "#422006", text: "#fef3c7" },
  Galar: { ring: "#60a5fa", core: "#172554", text: "#dbeafe" },
  Paldea: { ring: "#fb923c", core: "#431407", text: "#fed7aa" },
};

/** What a badge that has no own colour falls back to. */
const DEFAULT_COLOR = { ring: "#94a3b8", core: "#1e293b", text: "#e2e8f0" };

/** Props for the {@link GymBadge} component. */
export interface GymBadgeProps {
  /** The region the badge belongs to, used for its colour. */
  region: string;
  /** Its position within that region, one to eight. */
  number: number;
  /** The full label, e.g. "Boulder Badge". */
  label: string;
  /** Diameter in pixels. */
  size?: number;
}

/**
 * Draws one gym badge.
 *
 * @param props - {@link GymBadgeProps}
 * @returns The badge medallion with its name beneath it.
 */
export function GymBadge({ region, number, label, size = 64 }: GymBadgeProps) {
  const color = REGION_COLORS[region] ?? DEFAULT_COLOR;
  const gradientId = `badge-${region.replace(/\W/g, "")}-${number}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        role="img"
        aria-label={`${label}, ${region} badge ${number}`}
        className="drop-shadow"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color.ring} stopOpacity="1" />
            <stop offset="100%" stopColor={color.core} stopOpacity="1" />
          </linearGradient>
        </defs>

        {/* Outer ring, then the struck face, then a rim to read as metal. */}
        <circle cx="32" cy="32" r="30" fill={color.core} />
        <circle
          cx="32"
          cy="32"
          r="30"
          fill="none"
          stroke={color.ring}
          strokeWidth="3"
        />
        <circle cx="32" cy="32" r="23" fill={`url(#${gradientId})`} />

        {/* An eight-point rosette behind the numeral, so no two badges look identical. */}
        {Array.from({ length: number }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2 - Math.PI / 2;
          const x = 32 + Math.cos(angle) * 17;
          const y = 32 + Math.sin(angle) * 17;
          return <circle key={index} cx={x} cy={y} r="2.6" fill={color.text} />;
        })}

        <text
          x="32"
          y="38"
          textAnchor="middle"
          fontSize="20"
          fontWeight="700"
          fill={color.text}
        >
          {number}
        </text>
      </svg>

      <p className="text-[11px] font-semibold text-slate-300">{label}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">
        {region}
      </p>
    </div>
  );
}