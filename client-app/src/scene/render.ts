import { carriesOwnTile, iconUrl, type IconKey } from "../icons";
import { iconImages, type IconImage } from "../icon-images";
import { backgroundGrid } from "./grid";
import { DEPLOYMENT_BADGES, type DeploymentBadgeKind } from "../deployment";
import type { Prop, Scene, SceneEdge, SceneNode } from "./types";
import { worldToScreen, type Bounds, type Camera, type Point, type Viewport } from "./camera";
import { project } from "./iso";
import { searchOpacity, type LandscapeFocus } from "./focus";
import { bandTrim, DECK, GRAPHITE, hexRgb, ICON_TINT, MAP_LOOK, ROLE_BADGE, trimColor, type MapLook, type MapTheme } from "./look";
import { connectionHoverEase, connectionVisible, EDGE_ALPHA, EDGE_HOVER_DURATION, inLens, offLens, restingAlpha } from "./connections";
import type { EdgeCategory } from "../lookup";
import { placeIslandTitle, surfaceOutline, type CardHit } from "./picking";
import { NODE_CAPTION, NODE_DEPLOYMENT_TAG, SUBNET_LABEL, nodeCaptionPresentation, subnetLabelPresentation, subnetLabelRect, rectanglesOverlap, visibleNodeCaptions, type LabelRect } from "./labels";
import { ICON_BADGE, type Face } from "./shapes";
import { connectionMidpoint } from "./routing";
import { pathBounds } from "./layout-geometry";
import { missingConnectionInput } from "../connections";
import { islandDrawOrder, islandSlabs, type BandSlab, type IslandSlab, type WallRun } from "./slabs";
import { cornerBadges } from "./build";

/** Production displays the declared network design, including unused gateways/endpoints. */
const propIsGhost = (prop: Prop, mode: Scene["mode"]): boolean => !!prop.tagFiltered || (mode === "dev" && prop.presence === "other");

/**
 * Draws a {@link Scene} onto a 2D canvas.
 *
 * Passes, back to front: atmosphere, slab shadows, VPC foundation, lit slabs
 * with their icon plaques, relationship arcs, label cards and island names.
 * Geometry, paths and gradients are cached per scene. Per frame, only the camera,
 * focus, hover and time change; nothing here changes application configuration.
 */

export interface RenderState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  /**
   * The map's whole horizontal span in viewport coordinates, side panel included. The
   * atmosphere is lit across it, so a panel covering part of the map leaves it in place.
   * Defaults to the viewport.
   */
  readonly stage?: Stage;
  readonly dpr: number;
  readonly selected?: string;
  readonly hovered?: string;
  readonly hoveredEdge?: string;
  readonly hoveredIsland?: string;
  readonly time: number;
  readonly motion: boolean;
  readonly focus: LandscapeFocus;
  /** Background connections only; the selected resource's connections remain visible. */
  readonly categories?: ReadonlySet<EdgeCategory>;
  /**
   * The Errors filter: every wire with a missing required input stays visible, and every node with
   * an error keeps its full name at full opacity whatever the zoom (see `pinnedCaption`).
   */
  readonly errors?: boolean;
}

/**
 * With the Errors filter on, an erroring node in the viewed environment never lets its name fade,
 * shorten or yield to a neighbour. The other environment's errors recede like the rest of it.
 */
const pinnedCaption = (node: SceneNode, state: RenderState): boolean =>
  !!state.errors && inLens(node) && node.issues?.[0]?.severity === "error";

export interface Stage {
  readonly left: number;
  readonly width: number;
}

export interface FrameResult {
  /** Label cards as drawn, in painter's order, for picking. */
  readonly cards: readonly CardHit[];
  /** Separate deployment tags are also selectable as their owning node. */
  readonly badges: readonly CardHit[];
  /** Whether anything on screen moves, so the caller keeps drawing. */
  readonly animating: boolean;
  readonly ms: number;
}

const BADGE_WIDTH: Readonly<Record<DeploymentBadgeKind, number>> = { dev: 43, prod: 48, off: 43 };
const smoothstep = (progress: number): number => progress * progress * (3 - 2 * progress);

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}


function rgba(color: Rgb, alpha = 1, factor = 1): string {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
  return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${alpha})`;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const ICON_RGB = Object.fromEntries(Object.entries(ICON_TINT).map(([key, color]) => [key, hex(color)])) as Record<IconKey, Rgb>;

function toPath(points: readonly number[], close = true, into = new Path2D()): Path2D {
  if (points.length < 4) return into;
  into.moveTo(points[0]!, points[1]!);
  for (let index = 2; index < points.length; index += 2) into.lineTo(points[index]!, points[index + 1]!);
  if (close) into.closePath();
  return into;
}

function segmentsPath(segments: readonly number[]): Path2D {
  const path = new Path2D();
  for (let index = 0; index < segments.length; index += 4) {
    path.moveTo(segments[index]!, segments[index + 1]!);
    path.lineTo(segments[index + 2]!, segments[index + 3]!);
  }
  return path;
}

function trace(context: CanvasRenderingContext2D, points: readonly number[], close = true): void {
  context.beginPath();
  context.moveTo(points[0]!, points[1]!);
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index]!, points[index + 1]!);
  if (close) context.closePath();
}

type Standing =
  | { readonly kind: "node"; readonly node: SceneNode }
  | { readonly kind: "prop"; readonly prop: Prop };

interface PreparedArc {
  readonly points: readonly Point[];
  readonly path: Path2D;
  readonly length: number;
  readonly midpoint: Point;
  readonly missing: boolean;
  readonly bounds: Bounds;
  readonly color: Rgb;
  readonly offLens: boolean;
}

interface Prepared {
  readonly scene: Scene;
  readonly arcs: ReadonlyMap<SceneEdge, PreparedArc>;
  readonly nodes: ReadonlyMap<string, SceneNode>;
  readonly islands: ReadonlyMap<string, Scene["islands"][number]>;
  /** Each draw item's world bounding box, for culling. */
  readonly boxes: ReadonlyMap<Standing, { minX: number; minY: number; maxX: number; maxY: number }>;
  /** Whole islands, back to front. */
  readonly graphite: readonly GraphiteIsland[];
  /** Painted geometry, without culling headroom or shadows. */
  readonly titleSurfaces: ReadonlyMap<string, readonly (readonly number[])[]>;
  readonly outlines: ReadonlyMap<string, Path2D>;
}

/** One terrace of a graphite slab, as paths and gradients built once per scene. */
interface GraphiteBand {
  readonly slab: BandSlab;
  readonly trim: Rgb;
  /** The trim as a line on this theme's slab tops. */
  readonly line: Rgb;
  readonly top: Path2D;
  /** Painted top and walls, for this terrace's portion of the island highlight. */
  readonly surface: Path2D;
  readonly topFill: CanvasGradient;
  readonly grid: Path2D;
  readonly pads: Path2D;
  readonly walls: readonly { readonly run: WallRun; readonly path: Path2D; readonly fill: CanvasGradient }[];
  readonly lips: Path2D;
  /** The foot of each wall that falls to the floor. */
  readonly feet: Path2D;
  /** On a continuous deck: the edges of this subnet's walls that are the deck's own, never the joins to the next subnet. */
  readonly deckEdges: Path2D;
  readonly front?: Path2D;
  readonly shade?: { readonly path: Path2D; readonly fill: CanvasGradient };
  /** Buildings and fixtures standing on this terrace, in painter's order. */
  readonly items: readonly Standing[];
}

interface GraphiteIsland {
  readonly slab: IslandSlab;
  readonly bands: readonly GraphiteBand[];
  readonly shadow: readonly Path2D[];
  /** The island's whole outline at its top: the rim of a continuous deck. */
  readonly rim: Path2D;
}

const OUTSIDE = (box: Bounds | undefined, view: Bounds) =>
  box !== undefined && (box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY);

const CARD_HEIGHT = 22;

interface PlacedCard extends CardHit {
  readonly node: SceneNode;
  readonly order: number;
  readonly priority: number;
  readonly scale: number;
  readonly font: string;
  readonly text: string;
  readonly textWidth: number;
}

interface PlacedTag extends CardHit {
  readonly node: SceneNode;
  readonly scale: number;
  readonly kind: DeploymentBadgeKind;
  readonly order: number;
  readonly priority: number;
}

/** Compare the camera projection separately from animation state. Store scalar copies: callers may mutate cameras. */
function sameView(a: RenderState, b: RenderState): boolean {
  return a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.zoom === b.camera.zoom &&
    a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.dpr === b.dpr;
}
const copyView = (state: RenderState): RenderState => ({ ...state, camera: { ...state.camera }, viewport: { ...state.viewport } });

interface TitleLabel {
  readonly island: string;
  readonly text: string;
  readonly font: string;
  readonly color: string;
  readonly align: CanvasTextAlign;
  readonly x: number;
  readonly y: number;
  readonly plate?: LabelRect & { readonly accent: string };
}

export class SceneRenderer {
  private readonly context: CanvasRenderingContext2D;
  private prepared: Prepared | undefined;
  private readonly widths = new Map<string, number>();
  private cardLayout: { state: RenderState; placed: readonly PlacedCard[]; hits: readonly CardHit[]; tags: readonly PlacedTag[]; sections: readonly TitleLabel[] } | undefined;
  private titleLayout: { state: RenderState; cards: readonly CardHit[]; labels: readonly TitleLabel[] } | undefined;
  private subnetLayout: { state: RenderState; labels: readonly TitleLabel[] } | undefined;
  private groundGrid: { state: RenderState; paths: readonly Path2D[] } | undefined;
  private readonly icons = new Map<string, HTMLImageElement>();
  private iconsPending = false;
  private readonly badgePaths = new Map<DeploymentBadgeKind, readonly Path2D[]>();
  private readonly standPaths = new WeakMap<readonly Face[], { faces: readonly Path2D[]; lip?: Path2D }>();
  private readonly circle = new Path2D();
  private readonly plaqueFace = new Path2D();
  private readonly plaqueDepth = new Path2D();
  private disposed = false;
  private animating = false;
  private readonly captionHovers = new Map<string, { from: number; to: number; started: number }>();
  private readonly edgeHovers = new Map<string, { from: number; to: number; started: number }>();
  private snapEdgeHover = true;
  /** One screen pixel, in world units, for this frame. */
  private pixel = 1;
  /** Search fades every paint layer, including plinths, shadows and badges. */
  private opacity = 1;
  /** Graphite's shared unit gradients, drawn under a transform so one serves every building. */
  private readonly tints = new Map<string, CanvasGradient>();
  private contact: CanvasGradient | undefined;
  private plaque: { readonly glyph: CanvasGradient; readonly tile: CanvasGradient; readonly glass: CanvasGradient } | undefined;
  private atmosphere: { readonly left: number; readonly width: number; readonly height: number; readonly base: CanvasGradient; readonly vignette: CanvasGradient; readonly blooms: readonly CanvasGradient[] } | undefined;
  /** The palette for Studio's current theme. */
  private look: MapLook = MAP_LOOK.dark;
  /** How many slabs and standing items the last frame drew, after culling. */
  drawnItems = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly invalidate: () => void = () => {}) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser offers no 2D canvas.");
    this.context = context;
    this.circle.arc(0, 0, 1, 0, Math.PI * 2);
    this.plaqueFace.roundRect(-24, -54, 46, 46, 5);
    this.plaqueDepth.roundRect(-22, -52, 46, 46, 5);
    for (const kind of Object.keys(DEPLOYMENT_BADGES) as DeploymentBadgeKind[]) {
      this.badgePaths.set(kind, DEPLOYMENT_BADGES[kind].paths.map((d) => new Path2D(d)));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.captionHovers.clear();
    this.edgeHovers.clear();
  }

  /** Repaint in another theme. Gradients and wire colours are rebuilt; layout, hover and camera are kept. */
  setTheme(theme: MapTheme): void {
    if (this.look.theme === theme) return;
    this.look = MAP_LOOK[theme];
    this.tints.clear();
    this.contact = undefined;
    this.plaque = undefined;
    this.atmosphere = undefined;
    // Title and subnet labels carry their colours; captions are placed alongside them.
    this.cardLayout = undefined;
    this.titleLayout = undefined;
    this.subnetLayout = undefined;
    const prepared = this.prepared;
    if (!prepared) return;
    const arcs = new Map([...prepared.arcs].map(([edge, arc]) => [edge, { ...arc, color: this.look.wire.ink(edge.style.color) }]));
    const items = new Set(prepared.graphite.flatMap(island => island.bands.flatMap(band => band.items)));
    this.prepared = { ...prepared, arcs, graphite: this.prepareGraphite(prepared.scene, [...items]) };
  }

  /** Forget measured text, after web fonts arrive. */
  fontsChanged(): void {
    this.widths.clear();
    this.cardLayout = undefined;
    this.titleLayout = undefined;
    this.subnetLayout = undefined;
  }

  setScene(scene: Scene): void {
    if (this.prepared?.scene === scene) return;
    const needed = new Set<IconImage>();
    const load = (key: string, url: string) => {
      const entry = iconImages.get(url);
      this.icons.set(key, entry.image);
      needed.add(entry);
    };
    for (const item of [...scene.nodes, ...scene.props]) {
      load(item.icon, iconUrl(item.icon));
      // Include both Errors-filter states so toggling it needs no additional load.
      for (const errors of [true, false]) {
        for (const badge of Object.values(cornerBadges(item, errors))) {
          const artwork = ROLE_BADGE[badge]?.artwork ?? badge;
          load(artwork, iconUrl(artwork));
        }
      }
    }
    for (const prop of scene.props) if (prop.serviceIcon) load(prop.serviceIcon, prop.serviceIcon);
    this.iconsPending = [...needed].some(entry => !entry.settled);
    if (this.iconsPending) void Promise.all([...needed].map(entry => entry.ready)).then(() => {
      if (this.disposed || this.prepared?.scene !== scene) return;
      this.iconsPending = false;
      this.invalidate();
    });
    this.captionHovers.clear();
    this.edgeHovers.clear();
    this.snapEdgeHover = true;
    this.cardLayout = undefined;
    this.titleLayout = undefined;
    this.subnetLayout = undefined;
    const items: Standing[] = [
      ...scene.nodes.map((node): Standing => ({ kind: "node", node })),
      ...scene.props.map((prop): Standing => ({ kind: "prop", prop })),
    ];

    const arcs = new Map<SceneEdge, PreparedArc>();
    const nodeOf = new Map(scene.nodes.map((node) => [node.id, node]));
    for (const edge of scene.edges) {
      const { points, length } = scene.routes[edge.id]!;
      const path = new Path2D();
      path.moveTo(points[0]!.x, points[0]!.y);
      for (let at = 1; at < points.length; at++) path.lineTo(points[at]!.x, points[at]!.y);
      const bounds = pathBounds(points);
      arcs.set(edge, { points, path, length, bounds, midpoint: connectionMidpoint(points), missing: missingConnectionInput(edge), color: this.look.wire.ink(edge.style.color), offLens: offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to)) });
    }
    const boxes = new Map<Standing, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const item of items) {
      const hull = item.kind === "node" ? item.node.geometry.hull : item.prop.geometry.hull;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < hull.length; index += 2) {
        minX = Math.min(minX, hull[index]!);
        maxX = Math.max(maxX, hull[index]!);
        minY = Math.min(minY, hull[index + 1]!);
        maxY = Math.max(maxY, hull[index + 1]!);
      }
      // Room for the selection ring around the base.
      boxes.set(item, { minX: minX - 30, maxX: maxX + 30, minY: minY - 4, maxY: maxY + 18 });
    }
    const graphite = this.prepareGraphite(scene, items);
    const graphiteSurfaces = new Map(graphite.map(({ slab }) => [slab.island.id, slab.bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)])]));
    for (const frame of scene.frames) {
      for (const member of frame.members) {
        const surfaces = [frame.geometry.top, frame.geometry.left, frame.geometry.right];
        graphiteSurfaces.get(member)!.push(...surfaces);
      }
    }
    const outlines = (surfaces: ReadonlyMap<string, readonly (readonly number[])[]>) => new Map([...surfaces].map(([id, polygons]) => {
      const outline = new Path2D();
      const segments = surfaceOutline(polygons);
      for (let at = 0; at < segments.length; at += 4) {
        outline.moveTo(segments[at]!, segments[at + 1]!);
        outline.lineTo(segments[at + 2]!, segments[at + 3]!);
      }
      return [id, outline];
    }));
    this.prepared = { scene, arcs, nodes: nodeOf, islands: new Map(scene.islands.map((island) => [island.id, island])), boxes, graphite, titleSurfaces: graphiteSurfaces, outlines: outlines(graphiteSurfaces) };
  }

  /** Island paths, gradients and who stands on each terrace. */
  private prepareGraphite(scene: Scene, items: readonly Standing[]): GraphiteIsland[] {
    const context = this.context;
    const look = this.look;
    const ghosts = new Set([
      ...scene.nodes.filter((node) => node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent").map((node) => node.id),
      ...scene.props.filter((prop) => propIsGhost(prop, scene.mode)).map((prop) => prop.id),
    ]);
    return islandDrawOrder(islandSlabs(scene)).map((slab) => {
      const { island } = slab;
      const north = project({ x: island.gx0 - 0.5, y: island.gy0 - 0.5, h: island.top });
      const south = project({ x: island.gx1 + 0.5, y: island.gy1 + 0.5, h: island.top });
      const bands = slab.bands.map((band): GraphiteBand => {
        const meta = island.bands[band.index]!;
        // A development deck is one surface: every subnet takes the VPC's trim rather than its own colour.
        const trim = slab.deck ? hexRgb(trimColor(island)) : bandTrim(island, band.index);
        const topFill = context.createLinearGradient(north.x, north.y, south.x, south.y);
        topFill.addColorStop(0, rgba(mixRgb(look.slab.top.light, trim, look.slab.tint)));
        topFill.addColorStop(1, rgba(mixRgb(look.slab.top.dark, trim, look.slab.tint)));
        const walls = band.walls.map((run) => {
          const colors = look.slab.walls[run.side];
          const fill = context.createLinearGradient(...run.gradient);
          fill.addColorStop(0, rgba(mixRgb(colors.top, trim, look.slab.tint * 0.6)));
          fill.addColorStop(1, rgba(colors.bottom));
          return { run, path: toPath(run.quad), fill };
        });
        const lips = new Path2D();
        const feet = new Path2D();
        for (const { run } of walls) {
          toPath(run.lip, false, lips);
          if (run.rim) toPath([run.quad[6]!, run.quad[7]!, run.quad[4]!, run.quad[5]!], false, feet);
        }
        // A continuous deck is outlined by its foot and its true corners; where one subnet's wall continues into the next there is no line.
        const deckEdges = new Path2D();
        const last = slab.bands.length - 1;
        for (const { run } of walls) {
          const [lx, ly, rx, ry, fx, fy, gx, gy] = run.quad as [number, number, number, number, number, number, number, number];
          deckEdges.moveTo(gx, gy);
          deckEdges.lineTo(fx, fy);
          const joinsNext = slab.deck && run.side === "left" && band.index < last;
          const joinsPrevious = slab.deck && run.side === "left" && band.index > 0;
          if (!joinsNext) { deckEdges.moveTo(rx, ry); deckEdges.lineTo(fx, fy); }
          if (!joinsPrevious) { deckEdges.moveTo(lx, ly); deckEdges.lineTo(gx, gy); }
        }
        // Etched pads under solid buildings only: a ghost stands on bare ground.
        const pads = new Path2D();
        for (const pad of band.pads) if (!ghosts.has(pad.id)) toPath(pad.points, true, pads);
        let shade: GraphiteBand["shade"];
        if (band.stepShade) {
          const fill = context.createLinearGradient(...band.stepShade.gradient);
          fill.addColorStop(0, look.slab.stepShade);
          fill.addColorStop(1, "rgba(0, 0, 0, 0)");
          shade = { path: toPath(band.stepShade.polygon), fill };
        }
        const surface = new Path2D();
        for (const polygon of [band.top, ...band.walls.map(wall => wall.quad)]) toPath(polygon, true, surface);
        return {
          slab: band,
          trim,
          line: look.trimLine(trim),
          top: toPath(band.top),
          surface,
          topFill,
          grid: segmentsPath(band.grid),
          pads,
          walls,
          lips,
          feet,
          deckEdges,
          ...(band.front.length >= 4 ? { front: toPath(band.front, false) } : {}),
          ...(shade ? { shade } : {}),
          items: items
            .filter((item) => {
              const at = item.kind === "node" ? item.node : item.prop;
              return at.gx >= meta.gx0 && at.gx <= meta.gx1 && at.gy >= island.gy0 && at.gy <= island.gy1;
            })
            .sort((a, b) => {
              const one = a.kind === "node" ? a.node : a.prop;
              const two = b.kind === "node" ? b.node : b.prop;
              return one.gx + one.gy - (two.gx + two.gy);
            }),
        };
      });
      return { slab, bands, shadow: slab.shadow.map((layer) => toPath(layer)), rim: toPath(slab.rim) };
    });
  }

  render(state: RenderState): FrameResult {
    const started = performance.now();
    const prepared = this.prepared;
    const context = this.context;
    const { viewport, dpr, camera } = state;
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = this.atmosphereFor(viewport, state.stage).base;
    context.fillRect(0, 0, viewport.width, viewport.height);
    this.animating = false;
    if (!prepared || this.iconsPending) {
      this.drawnItems = 0;
      return { cards: [], badges: [], animating: false, ms: performance.now() - started };
    }

    const zoom = camera.zoom;
    this.pixel = 1 / zoom;
    const world = () =>
      context.setTransform(
        dpr * zoom,
        0,
        0,
        dpr * zoom,
        dpr * (viewport.width / 2 - camera.x * zoom),
        dpr * (viewport.height / 2 - camera.y * zoom),
      );
    world();
    // Keep the original vector paint order and precision. Only grid paths are
    // cached; camera changes rebuild them without resampling a previous bitmap.
    if (!this.groundGrid || !sameView(this.groundGrid.state, state)) {
      const paths = [new Path2D(), new Path2D()];
      for (const line of backgroundGrid(camera, viewport)) {
        const path = paths[Number(line.major)]!;
        path.moveTo(line.a.x, line.a.y);
        path.lineTo(line.b.x, line.b.y);
      }
      this.groundGrid = { state: copyView(state), paths };
    }
    context.lineWidth = 0.65 / zoom;
    for (const [at, path] of this.groundGrid.paths.entries()) {
      context.strokeStyle = at ? this.look.grid.major : this.look.grid.minor;
      context.stroke(path);
    }
    const atmosphere = this.atmosphereFor(viewport, state.stage);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = atmosphere.vignette;
    context.fillRect(0, 0, viewport.width, viewport.height);
    context.globalCompositeOperation = this.look.glowBlend;
    for (const bloom of atmosphere.blooms) {
      context.fillStyle = bloom;
      context.fillRect(0, 0, viewport.width, viewport.height);
    }
    context.globalCompositeOperation = "source-over";
    world();

    // What the viewport can see, in world units, with room for walls and roofs.
    const view = {
      minX: camera.x - viewport.width / 2 / zoom - 40,
      maxX: camera.x + viewport.width / 2 / zoom + 40,
      minY: camera.y - viewport.height / 2 / zoom - 80,
      maxY: camera.y + viewport.height / 2 / zoom + 40,
    };
    this.drawnItems = this.drawGraphite(prepared, state, view);

    this.drawEdges(prepared, state);
    const cards = this.drawCards(prepared, state);
    this.drawTitles(prepared, state, cards);

    return { cards, badges: this.cardLayout!.tags, animating: this.animating, ms: performance.now() - started };
  }

  // -------------------------------------------------------------------------
  // Graphite
  // -------------------------------------------------------------------------

  private atmosphereFor(viewport: Viewport, stage: Stage = { left: 0, width: viewport.width }): NonNullable<SceneRenderer["atmosphere"]> {
    const cached = this.atmosphere;
    const { left, width } = stage;
    const { height } = viewport;
    if (cached && cached.left === left && cached.width === width && cached.height === height) return cached;
    const context = this.context;
    const reach = Math.max(width, height);
    const base = context.createLinearGradient(0, 0, 0, height);
    const look = this.look;
    base.addColorStop(0, look.void.top);
    base.addColorStop(1, look.void.bottom);
    const centre = left + width / 2;
    const vignette = context.createRadialGradient(centre, height * 0.45, reach * 0.22, centre, height * 0.45, reach * 0.78);
    vignette.addColorStop(0, rgba(look.void.vignette, 0));
    vignette.addColorStop(1, rgba(look.void.vignette, look.void.vignetteAlpha));
    const blooms = look.blooms.map((bloom) => {
      const x = left + width * bloom.x;
      const gradient = context.createRadialGradient(x, height * bloom.y, 0, x, height * bloom.y, reach * bloom.radius);
      gradient.addColorStop(0, rgba(bloom.color, bloom.alpha));
      gradient.addColorStop(1, rgba(bloom.color, 0));
      return gradient;
    });
    this.atmosphere = { left, width, height, base, vignette, blooms };
    return this.atmosphere;
  }

  /**
   * Shadows on the floor far below, then the VPC
   * foundation, then whole islands back to front: each terrace's slab, then
   * whatever stands on it. Returns how many slabs and buildings it drew.
   */
  private drawGraphite(prepared: Prepared, state: RenderState, view: Bounds): number {
    const context = this.context;
    for (const { slab, shadow } of prepared.graphite) {
      if (OUTSIDE(slab.shadowBounds, view)) continue;
      this.opacity = searchOpacity(state.focus, "islands", slab.island.id);
      context.fillStyle = this.look.shadow.color;
      shadow.forEach((layer, index) => {
        context.globalAlpha = this.opacity * this.look.shadow.strength * (GRAPHITE.shadow.layers[index]!.alpha * (slab.island.ghost === "blueprint" ? DECK.shadow : slab.island.ghost ? 0.3 : 1));
        context.fill(layer);
      });
    }
    this.opacity = 1;
    context.globalAlpha = this.opacity;
    this.drawFramesGraphite(prepared, state);
    // Foundation and exposed outer strokes belong beneath all standing resources.
    for (const id of new Set([state.hoveredIsland, state.selected?.startsWith("island:") ? state.selected : undefined])) {
      if (id) this.drawIslandHighlight(prepared, state, id);
    }

    let drawn = 0;
    for (const island of prepared.graphite) {
      const { id } = island.slab.island;
      const focus = state.focus.kind !== "selection" || state.focus.islands.has(id) ? 1 : 0.4;
      for (const band of island.bands) {
        if (!OUTSIDE(band.slab.bounds, view)) {
          this.opacity = searchOpacity(state.focus, "islands", id);
          this.drawBand(island, band, focus);
          // Paint only this terrace's stroke before its resources. Repainting the
          // entire island here would put later terraces' strokes over earlier icons.
          this.drawIslandHighlight(prepared, state, id, band.surface);
          drawn += 1;
        }
        for (const item of band.items) {
          if (OUTSIDE(prepared.boxes.get(item), view)) continue;
          drawn += 1;
          if (item.kind === "node") {
            this.opacity = searchOpacity(state.focus, "nodes", item.node.id);
            const dimmed = state.focus.kind === "selection" && !state.focus.nodes.has(item.node.id);
            this.drawNodeGraphite(item.node, state, dimmed);
          } else {
            this.opacity = searchOpacity(state.focus, "props", item.prop.id);
            const factor = state.focus.kind === "selection" && !state.focus.props.has(item.prop.id) ? 0.32 : 1;
            const ghost = propIsGhost(item.prop, prepared.scene.mode);
            const matched = state.focus.kind === "search" && state.focus.props.has(item.prop.id);
            const tile = project({ x: item.prop.gx, y: item.prop.gy, h: item.prop.h });
            if (!ghost) this.drawStand(tile, item.prop.geometry.faces, item.prop.icon, factor);
            this.drawPlaqueGraphite(tile, item.prop.icon, (ghost ? 0.32 : 0.9) * factor, matched, ghost, false);
            const badges = cornerBadges(item.prop, state.errors !== false);
            if (badges.right) this.drawRoleIconGraphite(tile, badges.right, (ghost ? 0.32 : 0.9) * factor, ghost, item.prop.serviceIcon);
            if (badges.left) this.drawRoleIconGraphite(tile, badges.left, (ghost ? 0.32 : 0.9) * factor, ghost, undefined, true);
          }
        }
      }
    }
    this.opacity = 1;
    context.globalAlpha = this.opacity;
    return drawn;
  }

  private drawIslandHighlight(prepared: Prepared, state: RenderState, id: string, surface?: Path2D): void {
    if (id !== state.selected && id !== state.hoveredIsland) return;
    const outline = prepared.outlines.get(id);
    if (!outline) return;
    const context = this.context;
    context.save();
    if (surface) context.clip(surface);
    context.globalAlpha = searchOpacity(state.focus, "islands", id);
    context.strokeStyle = id === state.selected ? this.look.islandHighlight.selected : this.look.islandHighlight.hovered;
    context.lineWidth = (id === state.selected ? 2 : 1.5) / state.camera.zoom;
    context.stroke(outline);
    context.restore();
  }

  /** One terrace: its lit top, etched grid, pads and step shade, its walls and lips, then the glowing trim. */
  private drawBand(island: GraphiteIsland, band: GraphiteBand, focus: number): void {
    const context = this.context;
    context.globalAlpha = this.opacity;
    const pixel = this.pixel;
    const ghost = island.slab.island.ghost;
    const trim = band.line;
    const { slab } = this.look;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.lineWidth = pixel;
    if (ghost === "blueprint") {
      this.drawDeckBand(island, band, focus);
      return;
    }
    context.globalAlpha = this.opacity * (ghost ? 0.3 : 1);
    context.fillStyle = band.topFill;
    context.fill(band.top);
    context.save();
    context.clip(band.top);
    context.strokeStyle = slab.etch;
    context.stroke(band.grid);
    if (band.shade) {
      context.fillStyle = band.shade.fill;
      context.fill(band.shade.path);
    }
    context.restore();
    context.fillStyle = slab.pad;
    context.fill(band.pads);
    context.strokeStyle = rgba(trim, 0.34 * focus);
    context.stroke(band.pads);
    context.strokeStyle = slab.rim;
    context.stroke(band.top);
    for (const wall of band.walls) {
      context.fillStyle = wall.fill;
      context.fill(wall.path);
    }
    context.strokeStyle = slab.lip;
    context.stroke(band.lips);
    // Static light along the front edges and a faint line at the wall's foot.
    context.globalCompositeOperation = this.look.glowBlend;
    context.strokeStyle = rgba(trim, slab.feet * focus);
    context.stroke(band.feet);
    if (band.front) {
      if (ghost) {
        context.setLineDash([4 * pixel, 4 * pixel]);
        context.strokeStyle = rgba(trim, 0.5);
        context.stroke(band.front);
        context.setLineDash([]);
      } else {
        for (const pass of slab.glow) {
          context.strokeStyle = rgba(trim, pass.alpha * focus);
          context.lineWidth = pass.width * pixel;
          context.stroke(band.front);
        }
      }
    }
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = this.opacity;
    context.lineWidth = pixel;
  }

  /**
   * One subnet of a development network, as part of the single raised deck. Its top, etched grid, pads and
   * walls are a built island's graphite, all in the VPC's trim so the subnets read as one opaque surface
   * with nothing drawn between them. Dashed wall edges and one dashed rim around the whole deck (drawn with
   * the last subnet) take the place of a built island's lips and glow.
   */
  private drawDeckBand(island: GraphiteIsland, band: GraphiteBand, focus: number): void {
    const context = this.context;
    const pixel = this.pixel;
    const meta = island.slab.island;
    const violet = band.line;
    context.fillStyle = band.topFill;
    context.fill(band.top);
    context.save();
    context.clip(band.top);
    context.strokeStyle = this.look.slab.etch;
    context.stroke(band.grid);
    context.restore();
    context.fillStyle = this.look.slab.pad;
    context.fill(band.pads);
    context.strokeStyle = rgba(violet, 0.34 * focus);
    context.stroke(band.pads);
    for (const wall of band.walls) {
      context.fillStyle = wall.fill;
      context.fill(wall.path);
    }
    context.setLineDash([4 * pixel, 4 * pixel]);
    context.strokeStyle = rgba(violet, DECK.wallEdge);
    context.stroke(band.deckEdges);
    if (band.slab.index === meta.bands.length - 1) {
      context.setLineDash([6 * pixel, 4 * pixel]);
      context.strokeStyle = rgba(violet, DECK.rim);
      context.lineWidth = 1.3 * pixel;
      context.stroke(island.rim);
      context.lineWidth = pixel;
    }
    context.setLineDash([]);
  }

  /** The VPC foundation, dark glass edged in its island's trim. */
  private drawFramesGraphite(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    const { frame } = this.look;
    for (const { ghost, geometry, members } of prepared.scene.frames) {
      this.opacity = searchOpacity(state.focus, "islands", members[0]!);
      const owner = prepared.islands.get(members[0]!);
      const trim = owner ? hexRgb(trimColor(owner)) : hex("#9d6bff");
      const color = this.look.trimLine(trim);
      context.globalAlpha = this.opacity * (ghost ? 0.5 : 1);
      context.fillStyle = rgba(mixRgb(frame.left, trim, 0.1));
      if (geometry.left.length) { trace(context, geometry.left); context.fill(); }
      context.fillStyle = rgba(mixRgb(frame.right, trim, 0.07));
      if (geometry.right.length) { trace(context, geometry.right); context.fill(); }
      context.fillStyle = ghost ? rgba(trim, 0.07) : rgba(mixRgb(frame.top, trim, 0.12), 0.92);
      trace(context, geometry.top);
      context.fill();
      context.setLineDash(ghost ? [6 * pixel, 4 * pixel] : []);
      context.strokeStyle = rgba(color, ghost ? 0.55 : 0.85);
      context.lineWidth = 1.2 * pixel;
      context.stroke();
      if (!ghost) {
        context.globalCompositeOperation = this.look.glowBlend;
        context.strokeStyle = rgba(color, frame.glow);
        context.lineWidth = 5 * pixel;
        context.stroke();
        context.globalCompositeOperation = "source-over";
      }
      context.setLineDash([]);
      context.strokeStyle = rgba(color, 0.18);
      context.lineWidth = 0.7 * pixel;
      trace(context, geometry.inset);
      context.stroke();
    }
    this.opacity = 1;
    context.globalAlpha = this.opacity;
  }

  /** A filled unit circle under a transform: one cached gradient serves every building. */
  private blob(x: number, y: number, rx: number, ry: number, fill: CanvasGradient): void {
    const context = this.context;
    context.save();
    context.translate(x, y);
    context.scale(rx, ry);
    context.fillStyle = fill;
    context.fill(this.circle);
    context.restore();
  }

  private contactShadow(): CanvasGradient {
    if (!this.contact) {
      this.contact = this.context.createRadialGradient(0, 0, 0, 0, 0, 1);
      this.contact.addColorStop(0, this.look.contact[0]);
      this.contact.addColorStop(0.6, this.look.contact[1]);
      this.contact.addColorStop(1, "rgba(0, 0, 0, 0)");
    }
    return this.contact;
  }

  private spill(color: string): CanvasGradient {
    let gradient = this.tints.get(color);
    if (!gradient) {
      const rgb = hex(color);
      gradient = this.context.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, rgba(rgb, this.look.spill[0]));
      gradient.addColorStop(0.5, rgba(rgb, this.look.spill[1]));
      gradient.addColorStop(1, rgba(rgb, 0));
      this.tints.set(color, gradient);
    }
    return gradient;
  }

  private plaqueFills(): NonNullable<SceneRenderer["plaque"]> {
    if (!this.plaque) {
      const face = (stops: readonly [string, string]) => {
        const gradient = this.context.createLinearGradient(0, -54, 0, -8);
        gradient.addColorStop(0, stops[0]);
        gradient.addColorStop(1, stops[1]);
        return gradient;
      };
      const glass = this.context.createLinearGradient(0, -54, 0, -30);
      glass.addColorStop(0, `rgba(255, 255, 255, ${this.look.plaque.glass})`);
      glass.addColorStop(1, "rgba(255, 255, 255, 0)");
      this.plaque = { glyph: face(this.look.plaque.glyph.face), tile: face(this.look.plaque.tile.face), glass };
    }
    return this.plaque;
  }

  /**
   * What an enabled building stands on: its contact shadow, the light its icon
   * spills, and a raised graphite plinth. The plinth stays solid when a
   * selection dims the building (only its plaque and light fade); a ghost,
   * outside this environment, stands on nothing.
   */
  private drawStand(tile: Point, faces: readonly Face[], icon: IconKey, light: number): void {
    const context = this.context;
    const pixel = this.pixel;
    context.globalAlpha = this.opacity * 0.9;
    this.blob(tile.x + 3, tile.y + 5, 30, 14, this.contactShadow());
    context.globalCompositeOperation = this.look.glowBlend;
    context.globalAlpha = this.opacity * light;
    this.blob(tile.x, tile.y + 1, 46, 23, this.spill(ICON_TINT[icon]));
    context.globalCompositeOperation = "source-over";
    let paths = this.standPaths.get(faces);
    if (!paths) {
      const top = faces[2];
      paths = { faces: faces.map((face) => toPath(face.points)), lip: top ? toPath([
        top.points[6]!, top.points[7]!, top.points[4]!, top.points[5]!, top.points[2]!, top.points[3]!,
      ], false) : undefined };
      this.standPaths.set(faces, paths);
    }
    context.globalAlpha = this.opacity;
    for (const [at, path] of paths.faces.entries()) {
      context.fillStyle = this.look.stand.fills[at]!;
      context.fill(path);
    }
    if (paths.lip) {
      // The plinth's front edges catch the light.
      context.strokeStyle = this.look.stand.lip;
      context.lineWidth = pixel;
      context.stroke(paths.lip);
    }
    context.globalAlpha = this.opacity;
  }

  /** A service plaque with thickness: a depth edge, a glass face, a hairline in its icon's colour. */
  private drawPlaqueGraphite(tile: Point, key: IconKey, alpha: number, selected: boolean, ghost: boolean, hovered: boolean): void {
    const context = this.context;
    const pixel = this.pixel;
    const fills = this.plaqueFills();
    const { plaque } = this.look;
    const tiled = carriesOwnTile(key);
    const kind = tiled ? plaque.tile : plaque.glyph;
    const tint = ICON_RGB[key];
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = this.opacity * alpha;
    if (!ghost) {
      context.fillStyle = kind.depth;
      context.fill(this.plaqueDepth);
    }
    context.fillStyle = ghost ? kind.ghost : tiled ? fills.tile : fills.glyph;
    context.fill(this.plaqueFace);
    if (!ghost) {
      context.save();
      context.clip(this.plaqueFace);
      context.fillStyle = fills.glass;
      context.fillRect(-24, -54, 46, 24);
      context.restore();
    }
    context.setLineDash(ghost ? [3 * pixel, 3 * pixel] : []);
    context.strokeStyle = selected ? plaque.selected : hovered ? plaque.hovered : ghost ? plaque.ghostStroke : rgba(tint, 0.72);
    context.lineWidth = (selected ? 1.5 : 1) * pixel;
    context.stroke(this.plaqueFace);
    context.setLineDash([]);
    if (selected) {
      context.globalCompositeOperation = this.look.glowBlend;
      context.strokeStyle = rgba(tint, plaque.selectedGlow);
      context.lineWidth = 5 * pixel;
      context.stroke(this.plaqueFace);
      context.globalCompositeOperation = "source-over";
    }
    const icon = this.icons.get(key);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(icon, -21, -51, 40, 40);
    }
    context.restore();
  }

  private drawRoleIconGraphite(tile: Point, key: IconKey, alpha: number, ghost: boolean, artworkUrl?: string, management = false): void {
    const context = this.context;
    const { y, size, padding } = ICON_BADGE;
    const x = management ? -ICON_BADGE.x - size : ICON_BADGE.x;
    const badge = ROLE_BADGE[key];
    const artwork = badge?.artwork ?? key;
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = this.opacity * alpha;
    context.fillStyle = this.look.badge.shadow;
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, size, size, 4);
    context.fill();
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.fillStyle = badge?.fill ?? this.look.badge.plate;
    context.fill();
    const serviceIcon = artworkUrl ? this.icons.get(artworkUrl) : undefined;
    const icon = serviceIcon?.complete && serviceIcon.naturalWidth > 0 ? serviceIcon : this.icons.get(artwork);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (icon === serviceIcon || carriesOwnTile(artwork)) {
        // The service's own tile fills the badge, clipped to its corners, so no plate shows around it as a border.
        context.save();
        context.clip();
        context.drawImage(icon, x, y, size, size);
        context.restore();
      } else {
        context.drawImage(icon, x + padding, y + padding, size - padding * 2, size - padding * 2);
      }
    }
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.setLineDash(ghost ? [3 * this.pixel, 3 * this.pixel] : []);
    context.strokeStyle = ghost ? this.look.plaque.ghostStroke : rgba(hex(ICON_TINT[key]), 0.75);
    context.lineWidth = this.pixel;
    context.stroke();
    context.setLineDash([]);
    context.restore();
  }

  private drawNodeGraphite(node: SceneNode, state: RenderState, dimmed: boolean): void {
    const context = this.context;
    context.globalAlpha = this.opacity;
    const tile = project({ x: node.gx, y: node.gy, h: node.h });
    const selected = state.selected === node.id || (state.focus.kind === "search" && state.focus.nodes.has(node.id));
    const hovered = state.hovered === node.id;
    const ghost = !!node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    const factor = dimmed ? 0.32 : 1;
    if (!ghost) this.drawStand(tile, node.geometry.faces, node.icon, factor);
    this.drawPlaqueGraphite(tile, node.icon, factor * (ghost ? 0.32 : 1), selected, ghost, hovered);
    const badges = cornerBadges(node, state.errors !== false);
    if (badges.right) this.drawRoleIconGraphite(tile, badges.right, factor * (ghost ? 0.32 : 1), ghost);
    if (badges.left) this.drawRoleIconGraphite(tile, badges.left, factor * (ghost ? 0.32 : 1), ghost, undefined, true);
    if (selected || hovered) {
      trace(context, node.geometry.hull);
      context.strokeStyle = selected ? this.look.hull.selected : this.look.hull.hovered;
      context.lineWidth = this.pixel;
      context.stroke();
    }
  }

  private drawEdges(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    const { wire } = this.look;
    // A required connection with no value: red wherever it runs.
    const missingColor = hex(wire.marker.stroke);
    // Include arrowheads, packets, glow and fixed-size error markers at every zoom.
    const { camera, viewport } = state;
    // Shadow blur ignores the transform; allow for browser zoom producing DPR < 1.
    const padding = 40 / Math.min(1, state.dpr);
    const view = { minX: camera.x - (viewport.width / 2 + padding) * pixel, maxX: camera.x + (viewport.width / 2 + padding) * pixel,
      minY: camera.y - (viewport.height / 2 + padding) * pixel, maxY: camera.y + (viewport.height / 2 + padding) * pixel };
    const lit: { edge: SceneEdge; strength: number; resting: number }[] = [];
    const visible = new Set<string>();
    for (const edge of prepared.scene.edges) {
      if (!connectionVisible(edge, state.categories, state.selected, state.errors)) continue;
      const arc = prepared.arcs.get(edge)!;
      if (OUTSIDE(arc.bounds, view)) continue;
      visible.add(edge.id);
      // A connection only the other environment holds lights up when it is hovered or selected itself, never
      // because a node it touches is: the viewed environment's selection tells the viewed environment's story.
      const own = edge.otherLens === undefined;
      const active =
        state.focus.kind === "search" ? own && state.focus.nodes.has(edge.from) && state.focus.nodes.has(edge.to) :
        state.selected === edge.id ||
        (own && state.selected !== undefined && (edge.from === state.selected || edge.to === state.selected));
      const hover = this.hoverAmount(this.edgeHovers, edge.id, state.focus.kind !== "search" && state.hoveredEdge === edge.id ? 1 : 0,
        state, EDGE_HOVER_DURATION, this.snapEdgeHover, connectionHoverEase);
      // A missing input stays prominent in its own environment and recedes like any wire outside it.
      const resting = state.focus.kind === "search" ? 0.025
        : arc.missing ? (state.selected ? 0.35 : 0.9) * (arc.offLens ? EDGE_ALPHA.outOfLens : 1)
        : state.selected ? 0.06
        : restingAlpha(arc.offLens) * wire.restingStrength;
      if (active || hover > 0) {
        lit.push({ edge, strength: active ? 1 : hover, resting });
        continue;
      }
      const missing = arc.missing;
      const color = missing && edge.category === "inputs" ? missingColor : arc.color;
      context.strokeStyle = rgba(color, resting);
      context.lineWidth = 1.2 * pixel;
      context.setLineDash(edge.style.dashed ? [4 * pixel, 4 * pixel] : []);
      context.stroke(arc.path);
    }
    this.snapEdgeHover = false;
    for (const id of this.edgeHovers.keys()) if (!visible.has(id)) this.edgeHovers.delete(id);
    context.setLineDash([]);
    for (const { edge, strength, resting } of lit) {
      const arc = prepared.arcs.get(edge)!;
      const missing = arc.missing;
      const color = missing && edge.category === "inputs" ? missingColor : arc.color;
      context.shadowColor = rgba(color, wire.glow * strength);
      context.shadowBlur = 10 * strength;
      context.strokeStyle = rgba(color, resting + (0.95 - resting) * strength);
      context.lineWidth = (1.2 + strength) * pixel;
      context.setLineDash(edge.style.dashed ? [5 * pixel, 4 * pixel] : []);
      context.stroke(arc.path);
      context.setLineDash([]);
      context.globalAlpha = strength;
      // Which way it points.
      const end = arc.points[arc.points.length - 1]!;
      const before = arc.points[arc.points.length - 3]!;
      const angle = Math.atan2(end.y - before.y, end.x - before.x);
      const size = 7 * pixel;
      context.fillStyle = rgba(color, 0.95);
      context.beginPath();
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - Math.cos(angle - 0.45) * size, end.y - Math.sin(angle - 0.45) * size);
      context.lineTo(end.x - Math.cos(angle + 0.45) * size, end.y - Math.sin(angle + 0.45) * size);
      context.closePath();
      context.fill();
      if (state.motion && state.focus.kind !== "search" && !missing) {
        this.animating = true;
        // A few packets, travelling at a steady 60 world units a second.
        const count = Math.max(1, Math.min(3, Math.round(arc.length / 220)));
        for (let index = 0; index < count; index += 1) {
          const k = (((state.time * 60) / arc.length + index / count) % 1 + 1) % 1;
          const point = this.along(arc.points, k);
          context.fillStyle = wire.packet;
          context.beginPath();
          context.arc(point.x, point.y, 2.6 * pixel, 0, Math.PI * 2);
          context.fill();
          if (wire.packetRing) {
            context.strokeStyle = rgba(color, 0.95);
            context.lineWidth = pixel;
            context.stroke();
          }
        }
      }
      context.shadowBlur = 0;
      context.globalAlpha = 1;
    }
    // Fixed screen-size markers remain readable and clickable at overview zoom.
    context.setLineDash([]);
    for (const [edge, arc] of prepared.arcs) if (arc.missing && connectionVisible(edge, state.categories, state.selected, state.errors) && !OUTSIDE(arc.bounds, view)) {
      const at = arc.midpoint;
      const radius = 8 * pixel, inset = 3 * pixel;
      const matches = state.focus.kind !== "search" || state.focus.nodes.has(edge.from) && state.focus.nodes.has(edge.to);
      context.globalAlpha = !matches ? 0.08 : arc.offLens ? EDGE_ALPHA.outOfLens : 1;
      context.fillStyle = wire.marker.fill;
      context.strokeStyle = wire.marker.stroke;
      context.lineWidth = 1.8 * pixel;
      context.beginPath(); context.arc(at.x, at.y, radius, 0, Math.PI * 2); context.fill(); context.stroke();
      context.beginPath(); context.moveTo(at.x - inset, at.y - inset); context.lineTo(at.x + inset, at.y + inset); context.moveTo(at.x - inset, at.y + inset); context.lineTo(at.x + inset, at.y - inset); context.stroke();
    }
    context.globalAlpha = 1;
  }

  private along(points: readonly Point[], t: number): Point {
    const position = t * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(position));
    const fraction = position - index;
    const a = points[index]!;
    const b = points[index + 1]!;
    return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
  }

  private measure(text: string, font: string): number {
    const key = `${font}\u0000${text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      this.context.font = font;
      width = this.context.measureText(text).width;
      this.widths.set(key, width);
    }
    return width;
  }

  private fit(text: string, font: string, max: number): string {
    if (this.measure(text, font) <= max) return text;
    let low = 1;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.measure(`${text.slice(0, middle)}…`, font) <= max) low = middle;
      else high = middle - 1;
    }
    return `${text.slice(0, low)}…`;
  }

  private placeCards(prepared: Prepared, state: RenderState): NonNullable<SceneRenderer["cardLayout"]> {
    const sections = this.placeSubnetTitles(prepared, state);
    const cached = this.cardLayout;
    if (cached && cached.sections === sections && sameView(cached.state, state) && cached.state.selected === state.selected && cached.state.errors === state.errors &&
      cached.state.hovered === state.hovered && cached.state.focus === state.focus) return cached;
    const { camera, viewport } = state;
    const { scale, gap } = nodeCaptionPresentation(camera.zoom);
    const tagScale = scale;
    const font = `500 ${12 * scale}px Barlow, system-ui, sans-serif`;
    const buildings = new Map([...prepared.scene.nodes, ...prepared.scene.props].map((item) => {
      const hull = item.geometry.hull;
      const points = Array.from({ length: hull.length / 2 }, (_, at) => worldToScreen(camera, viewport, { x: hull[at * 2]!, y: hull[at * 2 + 1]! }));
      const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
      return [item.id, { x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y }] as const;
    }));
    const candidates: PlacedCard[] = [];
    const tagCandidates: PlacedTag[] = [];
    prepared.scene.nodes.forEach((node, order) => {
      if (state.focus.kind === "search" && !state.focus.nodes.has(node.id)) return;
      const building = buildings.get(node.id)!;
      if (building.x + building.width < 0 || building.x > viewport.width || building.y + building.height < 0 || building.y > viewport.height) return;
      const height = CARD_HEIGHT * scale;
      const chrome = 14 * scale + (node.auth ? 14 * scale : 0);
      // A pinned name keeps its whole width instead of the slot zoom leaves it.
      const pinned = pinnedCaption(node, state);
      const budget = (pinned ? 260 * scale : Math.min(260 * scale, NODE_CAPTION.width * camera.zoom)) - chrome;
      if (!pinned && budget < 24 * scale) return;
      const text = this.fit(node.label, font, budget);
      const textWidth = this.measure(text, font);
      const width = textWidth + chrome;
      const tile = project({ x: node.gx, y: node.gy, h: node.h });
      const anchor = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_CAPTION.offset });
      candidates.push({ id: node.id, node, order, priority: pinned ? 1 : 0, scale, font, text, textWidth, width, height, x: anchor.x - width / 2, y: anchor.y - height });
      if (node.badge) {
        const at = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_DEPLOYMENT_TAG.offset });
        const tagWidth = BADGE_WIDTH[node.badge] * tagScale, tagHeight = NODE_DEPLOYMENT_TAG.height * tagScale;
        tagCandidates.push({ id: node.id, node, order, priority: 0, scale: tagScale, kind: node.badge, width: tagWidth, height: tagHeight, x: at.x - tagWidth / 2, y: at.y - tagHeight / 2 });
      }
    });

    const controls = [
      { x: 8, y: 8, width: Math.min(360, viewport.width * 0.5), height: 42 },
      { x: viewport.width - 184, y: 8, width: 176, height: 42 },
      { x: viewport.width - 64, y: viewport.height - 64, width: 64, height: 64 },
    ];
    const sectionLabels = sections.flatMap(label => label.plate ? [label.plate] : []);
    const reserved = [
      ...controls, ...sectionLabels,
      ...[...prepared.arcs.values()].filter((arc) => arc.missing).map((arc) => {
        const at = worldToScreen(camera, viewport, arc.midpoint);
        return { x: at.x - 10, y: at.y - 10, width: 20, height: 20 };
      }),
    ];
    // A pinned name may cover neighbouring buildings and wins any overlap with another name.
    const obstacles = [...buildings.values(), ...reserved];
    const placed = visibleNodeCaptions(candidates.filter((card) =>
      (card.priority > 0 ? reserved : obstacles).every((obstacle) => !rectanglesOverlap(card, obstacle, gap))), [], viewport, gap);
    // Tags intentionally sit on their own plinth; every other node and caption
    // remains an obstacle. This fixed slot never borrows width from the name.
    const tags = visibleNodeCaptions(tagCandidates.filter((tag) => [...buildings].every(([id, rect]) => id === tag.id || !rectanglesOverlap(tag, rect))), [...controls, ...sectionLabels, ...placed], viewport);
    this.cardLayout = { state: copyView(state), sections, placed, tags, hits: placed.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })) };
    return this.cardLayout;
  }

  private hoverAmount(animations: Map<string, { from: number; to: number; started: number }>, id: string,
    target: number, state: RenderState, duration: number, snap = false, ease = smoothstep): number {
    if (!state.motion || snap) {
      if (target) animations.set(id, { from: target, to: target, started: state.time });
      else animations.delete(id);
      return target;
    }
    let animation = animations.get(id);
    const sample = () => {
      if (!animation) return 0;
      const progress = Math.max(0, Math.min(1, (state.time - animation.started) / duration));
      return animation.from + (animation.to - animation.from) * ease(progress);
    };
    const current = sample();
    if ((animation?.to ?? 0) !== target) {
      if (current === target) {
        animations.delete(id);
        return target;
      }
      animation = { from: current, to: target, started: state.time };
      animations.set(id, animation);
    }
    if (animation && animation.from !== animation.to && state.time - animation.started < duration) this.animating = true;
    else if (target === 0) animations.delete(id);
    return sample();
  }

  /** `pinnable` is false for the deployment tag: only the name is pinned; the tag keeps its zoom fade. */
  private captionAlpha(node: SceneNode, state: RenderState, detail: number, hover: number, pinnable = true): number {
    if (node.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(node.id)) || (pinnable && pinnedCaption(node, state))) return 1;
    const quiet = state.focus.kind === "selection" && !state.focus.nodes.has(node.id);
    const ghost = !!node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    const prominence = quiet ? 0.35 : ghost ? 0.7 : 1;
    const minimum = pinnable && !quiet && !ghost ? this.look.caption.overviewOpacity : NODE_CAPTION.minOpacity;
    const resting = minimum + (prominence - minimum) * detail;
    return resting + (1 - resting) * hover;
  }

  private drawCards(prepared: Prepared, state: RenderState): readonly CardHit[] {
    const context = this.context;
    const { dpr } = state;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout = this.placeCards(prepared, state);
    const visible = new Set([...layout.placed, ...layout.tags].map(({ id }) => id));
    for (const id of this.captionHovers.keys()) if (!visible.has(id)) this.captionHovers.delete(id);
    const hovers = new Map([...visible].map((id) => [id,
      this.hoverAmount(this.captionHovers, id, state.hovered === id ? 1 : 0, state, NODE_CAPTION.hoverDuration)]));
    const { detail } = nodeCaptionPresentation(state.camera.zoom);
    const plate = 0.25 + 0.75 * detail;
    const { caption } = this.look;
    for (const tag of layout.tags) {
      const hover = hovers.get(tag.id)!;
      const selected = tag.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(tag.id));
      context.globalAlpha = this.captionAlpha(tag.node, state, detail, hover, false);
      this.drawDeploymentBadge(tag.kind, tag.x, tag.y + tag.height / 2, tag.scale, selected ? 1 : plate + (1 - plate) * hover);
    }
    context.textAlign = "left";
    for (const { node, scale, font, text, textWidth, x, y, width, height } of layout.placed) {
      const padding = 7 * scale;
      const selected = node.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(node.id));
      const ghost = node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
      const hover = hovers.get(node.id)!;
      const alpha = this.captionAlpha(node, state, detail, hover);
      const visibleIssue = node.issues?.find(issue => state.errors !== false || issue.severity !== "error");
      const issue = visibleIssue ? caption.issue[visibleIssue.severity] : undefined;
      // Let the plate dissolve faster than its name so distant islands keep a quiet texture.
      context.globalAlpha = alpha * (selected || pinnedCaption(node, state) ? 1 : plate + (1 - plate) * hover);
      context.fillStyle = selected ? issue?.plate ?? caption.selected.plate : caption.plate;
      context.strokeStyle = selected ? issue?.edge ?? caption.selected.edge : issue && !ghost ? rgba(issue.rim, 0.32 + 0.4 * hover) : caption.rim(hover);
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(x, y, width, height, 5 * scale);
      context.fill();
      context.stroke();
      context.globalAlpha = alpha;
      context.font = font;
      context.textBaseline = "middle";
      context.fillStyle = selected ? issue?.ink ?? caption.selected.ink : issue ? (ghost ? issue.ghost : issue.text) : ghost ? caption.ghost : caption.text;
      context.fillText(text, x + padding, y + height / 2 + 0.5);
      if (node.auth) {
        // A padlock: the gateway admits signed-in users only.
        const lx = x + padding + textWidth + 5 * scale;
        const ly = y + height / 2;
        context.strokeStyle = selected ? issue?.ink ?? caption.selected.ink : caption.lock;
        context.fillStyle = context.strokeStyle;
        context.lineWidth = 1.2;
        context.beginPath();
        context.arc(lx + 3.5 * scale, ly - 1.5 * scale, 2.4 * scale, Math.PI, 0);
        context.stroke();
        context.fillRect(lx, ly - 1.2 * scale, 7 * scale, 5 * scale);
      }
      context.globalAlpha = this.opacity;
    }
    return layout.hits;
  }

  private drawDeploymentBadge(kind: DeploymentBadgeKind, x: number, y: number, scale: number, plateAlpha: number): void {
    const context = this.context;
    const badge = DEPLOYMENT_BADGES[kind][this.look.theme];
    const { label } = DEPLOYMENT_BADGES[kind];
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    const alpha = context.globalAlpha;
    context.globalAlpha *= plateAlpha;
    context.fillStyle = badge.background;
    context.strokeStyle = badge.color;
    context.lineWidth = 0.6;
    context.beginPath();
    context.roundRect(0, -7.5, BADGE_WIDTH[kind], 15, 3);
    context.fill();
    context.stroke();
    context.globalAlpha = alpha;
    context.save();
    context.translate(4, -5.5);
    context.scale(11 / 24, 11 / 24);
    context.lineWidth = 1.8;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const icon of this.badgePaths.get(kind) ?? []) context.stroke(icon);
    context.restore();
    context.font = "600 9px Barlow, system-ui, sans-serif";
    context.fillStyle = badge.color;
    context.textBaseline = "middle";
    context.fillText(label.toUpperCase(), 19, 0.5);
    context.restore();
  }

  /** A stable, horizontal heading rail stays visibly connected to each VPC terrace top. */
  private placeSubnetTitles(prepared: Prepared, state: RenderState): readonly TitleLabel[] {
    const cached = this.subnetLayout;
    if (cached && sameView(cached.state, state)) return cached.labels;
    const labels: TitleLabel[] = [];
    const { scene } = prepared;
    const { camera, viewport } = state;
    if (scene.mode === "prod") {
      const { scale } = subnetLabelPresentation(camera.zoom);
      const baseFont = `600 ${SUBNET_LABEL.fontSize}px Barlow, system-ui, sans-serif`;
      const font = `600 ${SUBNET_LABEL.fontSize * scale}px Barlow, system-ui, sans-serif`;
      const rimEnds = new Map(prepared.graphite.map(({ slab }) => [slab.island.id,
        Math.max(...slab.bands.flatMap(band => band.top.filter((_, at) => at % 2 === 0))),
      ]));
      for (const island of scene.islands) {
        if (island.region !== "network") continue;
        let previous: LabelRect | undefined;
        for (const [index, band] of island.bands.entries()) {
          // One consistent rail outside the top-right edge of the VPC's terrace tops;
          // resource collisions and viewport boundaries never displace an individual name.
          const gx = (band.gx0 + band.gx1) / 2;
          const anchor = worldToScreen(camera, viewport, project({ x: gx, y: island.gy0, h: band.h }));
          const width = (this.measure(band.title, baseFont) + SUBNET_LABEL.padding * 2 + SUBNET_LABEL.cue) * scale;
          const height = SUBNET_LABEL.height * scale;
          const rimEndX = worldToScreen(camera, viewport, { x: rimEnds.get(island.id)!, y: 0 }).x;
          const rect = subnetLabelRect(anchor, width, height, scale, rimEndX, previous);
          previous = rect;
          labels.push({ island: island.id, text: band.title, font, color: this.look.subnet.text, align: "left",
            x: rect.x + (SUBNET_LABEL.padding + SUBNET_LABEL.cue) * scale, y: rect.y + rect.height / 2,
            plate: { ...rect, accent: rgba(this.look.trimLine(bandTrim(island, index))) } });
        }
      }
    }
    this.subnetLayout = { state: copyView(state), labels };
    return labels;
  }

  private placeTitles(prepared: Prepared, state: RenderState, cards: readonly CardHit[]): readonly TitleLabel[] {
    const cached = this.titleLayout;
    if (cached && sameView(cached.state, state) && cached.cards === cards) return cached.labels;
    const labels: TitleLabel[] = [];
    const context = this.context;
    const { camera, viewport } = state;
    const { scene } = prepared;
    const screenPolygon = (polygon: readonly number[]) => {
      const points: number[] = [];
      for (let at = 0; at < polygon.length; at += 2) {
        const point = worldToScreen(camera, viewport, { x: polygon[at]!, y: polygon[at + 1]! });
        points.push(point.x, point.y);
      }
      return points;
    };
    const rectangle = ({ x, y, width, height }: Omit<CardHit, "id">) => [x, y, x + width, y, x + width, y + height, x, y + height];
    const surfaces = new Map([...prepared.titleSurfaces].map(([id, polygons]) => [id, polygons.map(screenPolygon)]));
    const obstacles = [
      ...[...surfaces.values()].flat(),
      ...[...scene.nodes, ...scene.props].map((item) => screenPolygon(item.geometry.hull)),
      ...cards.map(rectangle),
      ...this.placeSubnetTitles(prepared, state).flatMap(label => label.plate ? [rectangle(label.plate)] : []),
    ];
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    context.textAlign = "right";
    context.textBaseline = "middle";
    const titleFont = `600 ${15 * scale}px "Barlow Semi Condensed", Barlow, system-ui, sans-serif`;
    context.font = titleFont;
    for (const island of scene.islands) {
      const ink = context.measureText(island.title);
      const placed = placeIslandTitle(surfaces.get(island.id)!, {
        width: ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight,
        height: ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent,
      }, obstacles);
      if (!placed) continue;
      obstacles.push(rectangle(placed));
      const { title } = this.look;
      const color = island.ghost ? title.ghost : island.region === "network" ? rgba(title.network(hexRgb(trimColor(island)))) : title.text;
      labels.push({ island: island.id, text: island.title, font: titleFont, color, align: "right", x: placed.x + placed.width - ink.actualBoundingBoxRight, y: placed.y + ink.actualBoundingBoxAscent });
    }
    labels.push(...this.placeSubnetTitles(prepared, state));
    this.titleLayout = { state: copyView(state), cards, labels };
    return labels;
  }

  private drawTitles(prepared: Prepared, state: RenderState, cards: readonly CardHit[]): void {
    const context = this.context;
    const labels = this.placeTitles(prepared, state, cards);
    context.textBaseline = "middle";
    const { alpha, plateAlpha, scale } = subnetLabelPresentation(state.camera.zoom);
    for (const label of labels) {
      const presence = this.opacity * searchOpacity(state.focus, "islands", label.island);
      context.globalAlpha = presence;
      if (label.plate) {
        // Match node captions: the card dissolves faster than its readable name.
        context.globalAlpha = presence * plateAlpha;
        const { x, y, width, height, accent } = label.plate;
        context.fillStyle = this.look.subnet.plate;
        context.strokeStyle = this.look.subnet.stroke;
        context.lineWidth = scale;
        context.beginPath();
        context.roundRect(x, y, width, height, SUBNET_LABEL.radius * scale);
        context.fill(); context.stroke();
        context.fillStyle = accent;
        context.beginPath();
        context.roundRect(x + SUBNET_LABEL.padding * scale, y + 8 * scale, 3 * scale, height - 16 * scale, 1.5 * scale);
        context.fill();
      }
      context.globalAlpha = presence * (label.plate ? alpha : 1);
      context.font = label.font;
      context.textAlign = label.align;
      context.fillStyle = label.color;
      context.fillText(label.text, label.x, label.y);
    }
    context.textAlign = "start";
    context.globalAlpha = this.opacity;
  }
}
