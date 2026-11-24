import type { IconKey } from "../icons";
import type { EdgeCategory } from "../lookup";
import { NODE_CAPTION } from "./labels";
import type { Island, Region } from "./types";

type Rgb = readonly [number, number, number];

/**
 * Service colours matching the local SVGs, including Studio's blue database
 * backgrounds, so a trim and its icons read as one system.
 */
const AWS = {
  compute: "#ED7100",
  networking: "#8C4FFF",
  integration: "#E7157B",
  ai: "#01A88D",
  database: "#3B82F6",
  storage: "#7AA116",
  security: "#DD344C",
} as const;

const NEUTRAL = "#9fb3c8";
const EVENT_YELLOW = "#facc15";
/**
 * The WebSocket badge's colour, for its glyph (`public/icons/generic/unplug-blue.svg` strokes in this
 * same value), border and the ground glow. Distinct from the dev environment's teal (`--dev`)
 * and the agent badge's AgentCore green, so it never reads as either.
 */
const WEBSOCKET_BLUE = "#2496ED";

/**
 * One palette for problems (`src/issues.ts`): badge borders, node captions, wires and their markers.
 * The map's DOM cards use the matching `map-error` and `map-warning` theme tokens.
 */
export const ISSUE_COLOR = { error: "#ff5f6d", warning: "#f0b96b" } as const;

/** The dark plate behind a role badge's glyph, unless the badge has a backdrop of its own. */
export const ROLE_BADGE_PLATE = "#121b28";

/** Role badges with their own backdrop or artwork. Every other badge keeps the dark plate, its own icon and a border in its own tint. */
export const ROLE_BADGE: Readonly<Partial<Record<IconKey, { readonly fill: string; readonly artwork?: IconKey }>>> = {
  // The "Not created in application.ts" badge's construction (dark plate, tinted glyph and border) in the WebSocket blue.
  webSocket: { fill: ROLE_BADGE_PLATE, artwork: "webSocketBadge" },
  event: { fill: EVENT_YELLOW, artwork: "eventBadge" },
};

/** The colour each icon spills onto the ground beneath it. */
export const ICON_TINT: Readonly<Record<IconKey, string>> = {
  lambda: AWS.compute,
  gateway: AWS.networking,
  webSocket: WEBSOCKET_BLUE,
  webSocketBadge: WEBSOCKET_BLUE,
  event: EVENT_YELLOW,
  eventBadge: EVENT_YELLOW,
  internetGateway: AWS.networking,
  natGateway: AWS.networking,
  endpoint: AWS.networking,
  service: AWS.compute,
  task: AWS.compute,
  workflow: AWS.integration,
  agent: AWS.ai,
  stack: AWS.integration,
  unattached: ISSUE_COLOR.warning,
  error: ISSUE_COLOR.error,
  warning: ISSUE_COLOR.warning,
  managed: "#a9c5e8",
  table: AWS.database,
  bucket: AWS.storage,
  queue: AWS.integration,
  topic: AWS.integration,
  bus: AWS.integration,
  userpool: AWS.security,
  database: AWS.database,
  postgres: "#2fb3bc",
  secret: AWS.security,
  group: NEUTRAL,
  input: NEUTRAL,
  envFile: NEUTRAL,
  value: NEUTRAL,
  construct: NEUTRAL,
  route: NEUTRAL,
  identityCenter: AWS.security,
  iam: AWS.security,
};

/** Trim by island: the category of what stands on it. */
export const ISLAND_TRIM: Readonly<Record<string, string>> = {
  "island:apis": AWS.networking,
  "island:lambda": AWS.compute,
  "island:vpc": "#9d6bff",
  "island:agentcore": AWS.ai,
  "island:orchestration": AWS.integration,
  "island:stacks": "#6f93c9",
  "island:inputs": AWS.security,
  "island:environment": "#2fb3bc",
  "island:client-environment": "#5b9ee6",
};

/** Filter swatches and fallback colours. */
export const EDGE_COLORS: Readonly<Record<EdgeCategory, string>> = {
  routes: "#a374ff",
  inputs: "#8fb7d9",
  interactions: "#e59a86",
  structure: "#67d7df",
};

/** Lighter than the island's own trim so a hairline stays legible on the dark ground. */
export const API_EDGE_COLOR = EDGE_COLORS.routes;

/** Light orange for non-interaction compute references. */
export const COMPUTE_EDGE_COLOR = "#ff9a3d";

/** A value being read, whether a stack field or an input parameter: the look of an environment file supplying an input. */
export const READ_EDGE_COLOR = EDGE_COLORS.inputs;

/** Red for secret inputs and route authorizers, distinct from the error red of missing-input X markers. */
export const GUARD_EDGE_COLOR = "#ff4d5e";

const REGION_TRIM: Readonly<Record<Region, string>> = {
  entry: AWS.networking,
  compute: AWS.compute,
  network: "#9d6bff",
  agents: AWS.ai,
  orchestration: AWS.integration,
  catalog: "#6f93c9",
};

export function trimColor(island: Pick<Island, "id" | "region">): string {
  return ISLAND_TRIM[island.id.startsWith("island:vpc:") ? "island:vpc" : island.id] ?? REGION_TRIM[island.region];
}

export function hexRgb(value: string): Rgb {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/** Terraces with a colour of their own: subnets read as public (green), private (blue) or isolated (purple). */
export const BAND_TRIM: Readonly<Record<string, string>> = {
  "band:public": "#5fc75a",
  "band:private": "#3d8bfd",
  "band:isolated": "#b07cff",
};

/** A terrace's trim: its own colour where it has one, otherwise its island's. */
export function bandTrim(island: Pick<Island, "id" | "region" | "bands">, index: number): Rgb {
  return hexRgb(BAND_TRIM[`band:${island.bands[index]?.id.split(":").at(-1) ?? ""}`] ?? trimColor(island));
}

/**
 * A development network is one raised deck rather than a slice per subnet. Its surface is a built island's
 * opaque graphite in one colour, the VPC violet, as on the APIs island, so ghosted and solid icons stay legible:
 * no subnet washes, headings or lines between subnets. Its dashed rim and wall edges in that violet say it is
 * not built here. Production networks keep their separate terraces.
 */
export const DECK = {
  /** The dashed rim of the whole deck. */
  rim: 0.9,
  /** The dashed edge along each wall. */
  wallEdge: 0.4,
  /** The share of a built island's cast shadow, so the deck stands off the ground. */
  shadow: 0.35,
} as const;

/** The graphite look's fixed values. Colours are RGB; widths are screen pixels. */
export const GRAPHITE = {
  void: { top: "#0b1018", bottom: "#05070b", vignette: [4, 6, 10] as Rgb },
  blooms: [
    { x: 0.16, y: 0.1, radius: 0.62, color: [47, 179, 188] as Rgb, alpha: 0.085 },
    { x: 0.88, y: 0.92, radius: 0.6, color: [140, 79, 255] as Rgb, alpha: 0.07 },
  ],
  grid: { minor: "rgba(120, 160, 210, 0.045)", major: "rgba(120, 160, 210, 0.09)" },
  /** How much of the trim tints the graphite top. */
  tint: 0.07,
  top: { light: [58, 66, 80] as Rgb, dark: [38, 44, 55] as Rgb },
  walls: {
    left: { top: [38, 45, 55] as Rgb, bottom: [19, 23, 30] as Rgb },
    front: { top: [31, 37, 46] as Rgb, bottom: [15, 18, 24] as Rgb },
    right: { top: [25, 30, 38] as Rgb, bottom: [11, 14, 19] as Rgb },
  },
  lip: 0.2,
  rim: 0.07,
  etch: 0.035,
  glow: [
    { width: 7, alpha: 0.07 },
    { width: 3.2, alpha: 0.17 },
    { width: 1.3, alpha: 0.92 },
  ],
  /** The cast shadow on the floor far below: steps beneath the island's floor, and its soft layers. */
  shadow: { drop: 5, shift: 22, layers: [{ grow: 0, alpha: 0.3 }, { grow: 0.6, alpha: 0.15 }, { grow: 1.3, alpha: 0.08 }, { grow: 2.2, alpha: 0.045 }] },
  /** The seam between a terraced island's slabs, in cells. */
  terraceGap: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** Studio's colour scheme (`src/theme.ts`); the map draws one look per scheme. */
export type MapTheme = "dark" | "light";

const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const round = (color: Rgb): Rgb => [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])];

/**
 * Deepen a colour, keeping its hue, until it holds `target` contrast against `ground`. Scaling toward
 * black keeps saturation that mixing toward a tinted ink would wash out. A colour that already holds is returned unchanged.
 */
export function deepen(color: Rgb, ground: Rgb, target: number, ink: Rgb = [0, 0, 0]): Rgb {
  for (let step = 0; step <= 25; step += 1) {
    const candidate = round(mix(color, ink, step / 25));
    if (contrastRatio(candidate, ground) >= target) return candidate;
  }
  return ink;
}

/** How a node's caption reads when it carries an issue (`src/issues.ts`). */
interface IssueCaption {
  readonly text: string;
  readonly ghost: string;
  readonly rim: Rgb;
  readonly plate: string;
  readonly ink: string;
  readonly edge: string;
}

/**
 * Every colour the canvas paints, for one theme. Geometry stays in {@link GRAPHITE}; nothing here
 * changes where anything is drawn. Dark is the graphite void; light is a plaster model on a drafting table.
 */
export interface MapLook {
  readonly theme: MapTheme;
  /** How lights add up: additively on the dark ground, ordinarily on the light one, where adding would wash to white. */
  readonly glowBlend: GlobalCompositeOperation;
  readonly void: { readonly top: string; readonly bottom: string; readonly vignette: Rgb; readonly vignetteAlpha: number };
  readonly blooms: readonly { readonly x: number; readonly y: number; readonly radius: number; readonly color: Rgb; readonly alpha: number }[];
  readonly grid: { readonly minor: string; readonly major: string };
  readonly slab: {
    readonly tint: number;
    readonly top: { readonly light: Rgb; readonly dark: Rgb };
    readonly walls: Readonly<Record<"left" | "front" | "right", { readonly top: Rgb; readonly bottom: Rgb }>>;
    readonly etch: string;
    readonly rim: string;
    readonly lip: string;
    readonly pad: string;
    readonly feet: number;
    readonly glow: readonly { readonly width: number; readonly alpha: number }[];
    readonly stepShade: string;
  };
  /** Cast shadows on the floor: their colour and a share of each layer's alpha. */
  readonly shadow: { readonly color: string; readonly strength: number };
  /** The VPC foundation's faces, before its trim tints them, and the strength of its edge light. */
  readonly frame: { readonly left: Rgb; readonly right: Rgb; readonly top: Rgb; readonly glow: number };
  readonly contact: readonly [string, string];
  readonly spill: readonly [number, number];
  /** Plinth faces in shape order (left, right, top) and its lit front edge. */
  readonly stand: { readonly fills: readonly [string, string, string]; readonly lip: string };
  readonly plaque: {
    /** Glyph-only artwork sits on a slate tile; AWS artwork brings a tile of its own and sits in a bezel. */
    readonly glyph: { readonly face: readonly [string, string]; readonly depth: string; readonly ghost: string };
    readonly tile: { readonly face: readonly [string, string]; readonly depth: string; readonly ghost: string };
    readonly glass: number;
    readonly ghostStroke: string;
    readonly selected: string;
    readonly hovered: string;
    readonly selectedGlow: number;
  };
  readonly badge: { readonly shadow: string; readonly plate: string };
  readonly islandHighlight: { readonly selected: string; readonly hovered: string };
  readonly hull: { readonly selected: string; readonly hovered: string };
  readonly wire: {
    /** A wire's colour, adjusted to stay legible on this ground. */
    readonly ink: (color: string) => Rgb;
    /** Scale the background wires without changing the relative dimming outside this environment. */
    readonly restingStrength: number;
    readonly glow: number;
    readonly packet: string;
    /** Rings each packet in its wire's colour, where the packet alone would vanish into the ground. */
    readonly packetRing: boolean;
    readonly marker: { readonly fill: string; readonly stroke: string };
  };
  /** A trim colour as a line on this theme's slab tops. */
  readonly trimLine: (trim: Rgb) => Rgb;
  readonly caption: {
    readonly overviewOpacity: number;
    readonly plate: string;
    readonly rim: (hover: number) => string;
    readonly text: string;
    readonly ghost: string;
    readonly lock: string;
    readonly selected: { readonly plate: string; readonly edge: string; readonly ink: string };
    readonly issue: Readonly<Record<"error" | "warning", IssueCaption>>;
  };
  readonly subnet: { readonly plate: string; readonly stroke: string; readonly text: string };
  readonly title: { readonly text: string; readonly ghost: string; readonly network: (trim: Rgb) => Rgb };
}

const memo = (adjust: (color: string) => Rgb): ((color: string) => Rgb) => {
  const cache = new Map<string, Rgb>();
  return (color) => {
    let rgb = cache.get(color);
    if (!rgb) cache.set(color, rgb = adjust(color));
    return rgb;
  };
};

const DARK_LOOK: MapLook = {
  theme: "dark",
  glowBlend: "lighter",
  void: { top: GRAPHITE.void.top, bottom: GRAPHITE.void.bottom, vignette: GRAPHITE.void.vignette, vignetteAlpha: 0.82 },
  blooms: GRAPHITE.blooms,
  grid: GRAPHITE.grid,
  slab: {
    tint: GRAPHITE.tint,
    top: GRAPHITE.top,
    walls: GRAPHITE.walls,
    etch: `rgba(255, 255, 255, ${GRAPHITE.etch})`,
    rim: `rgba(255, 255, 255, ${GRAPHITE.rim})`,
    lip: `rgba(255, 255, 255, ${GRAPHITE.lip})`,
    pad: "rgba(255, 255, 255, 0.03)",
    feet: 0.22,
    glow: GRAPHITE.glow,
    stepShade: "rgba(0, 0, 0, 0.42)",
  },
  shadow: { color: "#000", strength: 1 },
  frame: { left: [10, 10, 15], right: [6, 6, 10], top: [12, 12, 18], glow: 0.12 },
  contact: ["rgba(0, 0, 0, 0.55)", "rgba(0, 0, 0, 0.22)"],
  spill: [0.26, 0.08],
  stand: { fills: ["#2c343f", "#1c222a", "#3a4452"], lip: "rgba(255, 255, 255, 0.18)" },
  plaque: {
    glyph: { face: ["#1c2738", "#0c121b"], depth: "#04070b", ghost: "#111b29" },
    tile: { face: ["#1c2738", "#0c121b"], depth: "#04070b", ghost: "#111b29" },
    glass: 0.14,
    ghostStroke: "#63758d",
    selected: "#f2f6ff",
    hovered: "rgba(255, 255, 255, 0.75)",
    selectedGlow: 0.4,
  },
  badge: { shadow: "#04070b", plate: ROLE_BADGE_PLATE },
  islandHighlight: { selected: "rgba(167, 215, 255, 0.85)", hovered: "rgba(207, 229, 248, 0.6)" },
  hull: { selected: "rgba(255, 248, 230, 0.6)", hovered: "rgba(255, 255, 255, 0.35)" },
  wire: {
    ink: memo(hexRgb),
    restingStrength: 1,
    glow: 0.8,
    packet: "rgba(255, 252, 240, 0.95)",
    packetRing: false,
    marker: { fill: "#191c25", stroke: ISSUE_COLOR.error },
  },
  trimLine: (trim) => trim,
  caption: {
    overviewOpacity: NODE_CAPTION.minOpacity,
    plate: "#0e131b",
    rim: (hover) => `rgba(255, 255, 255, ${0.14 + 0.41 * hover})`,
    text: "#e7eaef",
    ghost: "#9aa3ae",
    lock: "#cfd5dd",
    selected: { plate: "#f3efe4", edge: "#fff8e6", ink: "#141922" },
    // A white name on red (deep enough for 4.8:1), a dark name on amber.
    issue: {
      error: { text: ISSUE_COLOR.error, ghost: "#b97c83", rim: hexRgb(ISSUE_COLOR.error), plate: "#d92d3a", ink: "#ffffff", edge: "#ff8f97" },
      warning: { text: ISSUE_COLOR.warning, ghost: "#b8a07c", rim: hexRgb(ISSUE_COLOR.warning), plate: ISSUE_COLOR.warning, ink: "#141922", edge: "#ffe2b0" },
    },
  },
  subnet: { plate: "rgba(13, 19, 28, 0.96)", stroke: "rgba(174, 192, 214, 0.3)", text: "#f1f5f9" },
  title: { text: "rgba(236, 239, 244, 0.94)", ghost: "rgba(214, 222, 234, 0.6)", network: (trim) => mix(trim, [255, 255, 255], 0.55) },
};

/**
 * What light wires and trims must stay legible against: the ground's darker end beneath wires, and the
 * slab top's darker end beside trims.
 */
const LIGHT_VOID = { top: "#f2f5fa", bottom: "#e9edf5" } as const;
const LIGHT_SLAB_TOP: { readonly light: Rgb; readonly dark: Rgb } = { light: [253, 254, 255], dark: [240, 244, 250] };
const LIGHT_INK: Rgb = [23, 35, 50];
/** Leave room for compositing over the darker edges of the drafting surface. */
export const LIGHT_WIRE_CONTRAST = 3.5;
/** A trim is an edge beside its own wall, not a lone mark; it stays a clear line without going muddy. */
export const LIGHT_TRIM_CONTRAST = 2.4;

/** The issue colours on a light ground: the theme tokens `--map-error` and `--map-warning` use the same values. */
export const ISSUE_COLOR_LIGHT = { error: "#c9303d", warning: "#b7791f" } as const;

const LIGHT_LOOK: MapLook = {
  theme: "light",
  glowBlend: "source-over",
  void: { ...LIGHT_VOID, vignette: [199, 212, 230], vignetteAlpha: 0.22 },
  blooms: [
    { x: 0.16, y: 0.1, radius: 0.62, color: [85, 155, 163], alpha: 0.035 },
    { x: 0.88, y: 0.92, radius: 0.6, color: [120, 107, 190], alpha: 0.032 },
  ],
  grid: { minor: "rgba(65, 89, 126, 0.032)", major: "rgba(65, 89, 126, 0.075)" },
  slab: {
    tint: 0.042,
    top: LIGHT_SLAB_TOP,
    walls: {
      left: { top: [227, 234, 245], bottom: [209, 219, 235] },
      front: { top: [217, 226, 239], bottom: [199, 211, 229] },
      right: { top: [204, 215, 234], bottom: [186, 200, 221] },
    },
    etch: "rgba(49, 72, 106, 0.035)",
    rim: "rgba(49, 72, 106, 0.16)",
    lip: "rgba(255, 255, 255, 0.94)",
    pad: "rgba(49, 72, 106, 0.028)",
    feet: 0.22,
    glow: [
      { width: 4, alpha: 0.04 },
      { width: 2.5, alpha: 0.08 },
      { width: 1.4, alpha: 0.83 },
    ],
    stepShade: "rgba(37, 55, 86, 0.15)",
  },
  // Soft on purpose: at full strength the stepped layers read as a second, grey slab.
  shadow: { color: "rgb(36, 56, 92)", strength: 0.16 },
  frame: { left: [214, 223, 239], right: [200, 212, 232], top: [235, 241, 250], glow: 0.08 },
  contact: ["rgba(28, 46, 76, 0.29)", "rgba(28, 46, 76, 0.11)"],
  spill: [0.12, 0.04],
  stand: { fills: ["#d3deee", "#bdcbdf", "#f7f9fc"], lip: "rgba(255, 255, 255, 0.95)" },
  plaque: {
    glyph: { face: ["#2b3544", "#1a222d"], depth: "#0f151d", ghost: "#46505e" },
    tile: { face: ["#ffffff", "#eef3fa"], depth: "#b3c1d5", ghost: "#f2f5fa" },
    glass: 0.14,
    ghostStroke: "#7889a3",
    selected: "#2457b5",
    hovered: "#546b8f",
    selectedGlow: 0.24,
  },
  badge: { shadow: "rgba(20, 28, 40, 0.4)", plate: ROLE_BADGE_PLATE },
  islandHighlight: { selected: "#2457b5", hovered: "rgba(36, 87, 181, 0.56)" },
  hull: { selected: "#2457b5", hovered: "rgba(36, 87, 181, 0.55)" },
  wire: {
    ink: memo((color) => deepen(hexRgb(color), hexRgb(LIGHT_VOID.bottom), LIGHT_WIRE_CONTRAST)),
    restingStrength: 1.4,
    glow: 0.22,
    packet: "#ffffff",
    packetRing: true,
    marker: { fill: "#ffffff", stroke: ISSUE_COLOR_LIGHT.error },
  },
  trimLine: (trim) => deepen(round(mix(trim, LIGHT_INK, 0.12)), LIGHT_SLAB_TOP.dark, LIGHT_TRIM_CONTRAST),
  caption: {
    overviewOpacity: 0.4,
    plate: "#ffffff",
    rim: (hover) => `rgba(34, 61, 102, ${0.18 + 0.34 * hover})`,
    text: "#172332",
    ghost: "#637188",
    lock: "#475b75",
    selected: { plate: "#244979", edge: "#244979", ink: "#ffffff" },
    issue: {
      error: { text: "#a72932", ghost: "#944e5a", rim: hexRgb(ISSUE_COLOR_LIGHT.error), plate: ISSUE_COLOR_LIGHT.error, ink: "#ffffff", edge: "#a51e2a" },
      warning: { text: "#82500c", ghost: "#7e6642", rim: hexRgb(ISSUE_COLOR_LIGHT.warning), plate: "#fff0d9", ink: "#754600", edge: ISSUE_COLOR_LIGHT.warning },
    },
  },
  subnet: { plate: "rgba(255, 255, 255, 0.98)", stroke: "rgba(34, 61, 102, 0.22)", text: "#172332" },
  title: { text: "#172332", ghost: "#586781", network: (trim) => mix(trim, LIGHT_INK, 0.55) },
};

export const MAP_LOOK: Readonly<Record<MapTheme, MapLook>> = { dark: DARK_LOOK, light: LIGHT_LOOK };

/** A wire colour as hex, for DOM swatches that stand for the canvas's wires. */
export const wireCss = (theme: MapTheme, color: string): string =>
  `#${MAP_LOOK[theme].wire.ink(color).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
