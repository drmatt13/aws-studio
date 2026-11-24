import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { cx } from "../../ui/classes";
import { DockerStartPopover } from "./DockerStartPopover";
import { useDockerStart, useDockerStatus } from "../../machine/docker";
import { useLocalRuntime } from "../../deploy/local-runtime";
import { LocalRuntimePopover } from "./LocalRuntimePopover";
import { buttonClasses } from "../../ui/Button";

/*
 * Motion. The card tells one story per scene. Every change is a CSS transition with
 * per-part delays, so a change mid-flight reverses each part from wherever it is.
 *   Starting: the water rises and the whale surfaces, then containers stack onto its
 *   back, the whale riding lower under the load. The stack rests for a long beat before
 *   it clears and loads again, so a slow start reads as steady work, not alarm.
 *   Running: the last containers land, the whale lifts, spouts, and light runs once
 *   around the card.
 *   Stopping: the containers come off top row first while the whale settles lower and
 *   slowly ebbs toward its resting colour; once shutdown is confirmed it dives. Pressing
 *   the switch mid-start cancels the start and runs the same stop.
 *   Appearing and leaving: the whole card dissolves in when it becomes available and
 *   dissolves out before it is removed, so it never pops in or cuts out.
 * Keyframes are only the idle loops, the stopping ebb and one-shot accents.
 */
const EXPO_OUT = "cubic-bezier(.16,1,.3,1)";
const EASE_IN = "cubic-bezier(.5,0,.75,0)";
const IN_OUT = "cubic-bezier(.65,0,.35,1)";
const BOUNCE = "var(--spring-bounce)";

/** `display` flips with `hidden` at the end of the fade-out; entering starts from `starting:opacity-0`. */
const FADE_IN = `opacity 420ms ${EXPO_OUT}, display 420ms allow-discrete`;
const FADE_OUT_MS = 260;
const FADE_OUT = `opacity ${FADE_OUT_MS}ms ${IN_OUT}, display ${FADE_OUT_MS}ms allow-discrete`;

/** Container positions on the whale's back, in loading order: bottom row left to right, then the top row. */
const CARGO = [[12.1, 17.9], [18.04, 17.9], [23.98, 17.9], [29.92, 17.9], [18.04, 11.96], [23.98, 11.96]] as const;
/** The first load waits for the whale to surface. */
const LOAD_AT = 240;
const LOAD_STAGGER = 55;
/** While starting, each container is placed one at a time and the full stack rests before it is reloaded. */
const LOOP_STAGGER = 110;
const LOOP_DROP = 560;
const LOOP_HOLD = 10_000;
const LOOP_CLEAR = 560;
const UNLOAD_STAGGER = { starting: 45, stopping: 70, other: 28 } as const;
/** A running Docker observation this recent is trusted; an older one is checked again first. */
const DOCKER_FRESH_MS = 15_000;
/** Horizontal drift of each spout droplet, in SVG units. */
const SPOUT = [-2.6, 0.4, 3] as const;
const WAVE = "q5.5-1.6 11 0t11 0t11 0t11 0t11 0t11 0t11 0t11 0V44H-44Z";
const SWELL = "q5.5 1.4 11 0t11 0t11 0t11 0t11 0t11 0t11 0t11 0V44H-44Z";
const HULL =
  "M11 23.4H33C37.18 23.4 39.38 25.49 39.38 28.35C39.38 33.63 33.44 37.26 24.86 37.26C17.38 37.26 12.54 34.4 10.45 30C7.48 29.89 4.73 27.8 3.74 22.96C3.63 22.3 4.18 21.86 4.73 22.08C7.04 22.96 9.02 23.4 11 23.4Z";
/** Rotation and bobbing pivot on the waterline, in viewBox units. */
const PIVOT = "[transform-box:view-box] origin-[22px_30px]";

type Scene = "off" | "starting" | "running" | "attention" | "stopping";
/** A start request that is still bringing Docker up, or handing over to the runtime operation. */
type Intent = { readonly step: "check" | "docker" | "runtime"; readonly job?: string };

const message = (problem: unknown, fallback: string) => problem instanceof Error ? problem.message : fallback;

/** Alternates the cargo between a full stack and a clear deck while `enabled`. */
function useLoadingCycle(enabled: boolean) {
  const [cycle, setCycle] = useState({ loaded: false, count: 0 });
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let count = 0;
    const load = () => {
      count += 1;
      setCycle({ loaded: true, count });
      timer = setTimeout(clear, (count === 1 ? LOAD_AT : 0) + (CARGO.length - 1) * LOOP_STAGGER + LOOP_DROP + LOOP_HOLD);
    };
    const clear = () => {
      setCycle({ loaded: false, count });
      timer = setTimeout(load, LOOP_CLEAR);
    };
    load();
    return () => { clearTimeout(timer); setCycle({ loaded: false, count: 0 }); };
  }, [enabled]);
  return cycle;
}

/** True while `active` and for `ms` after it turns false, so an exit can finish before unmounting. */
function useLingering(active: boolean, ms: number) {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) { setLingering(true); return; }
    const timer = setTimeout(() => setLingering(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active || lingering;
}

/**
 * The local runtime card for development mode. Leaving development keeps it mounted
 * through its fade-out, then unmounts it so the runtime is no longer polled.
 */
export function ComposePreview({ motion, present = true }: { readonly motion: boolean; readonly present?: boolean }) {
  return useLingering(present, motion ? FADE_OUT_MS : 0) ? <ComposeCard motion={motion} present={present} /> : null;
}

/** The switch reports intent at once; the scene and status label report what is actually happening. */
function ComposeCard({ motion, present }: { readonly motion: boolean; readonly present: boolean }) {
  const docker = useDockerStatus();
  const dockerStart = useDockerStart();
  const runtime = useLocalRuntime();
  const [intent, setIntent] = useState<Intent>();
  const [help, setHelp] = useState<"docker" | "runtime">();
  const [dockerProblem, setDockerProblem] = useState<string>();
  // The checkout owner cancels startup and drains services in one stop request.
  const [interrupt, setInterrupt] = useState<string>();
  // Each start request takes a ticket; cancelling or a newer request voids older tickets.
  const attempt = useRef(0);
  // Guards against a second submission before the pending state renders.
  const submitting = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const helpId = useId();

  const scene: Scene = interrupt || runtime.phase === "stopping" ? "stopping"
    : intent || runtime.phase === "starting" ? "starting"
    : runtime.active ? runtime.ready ? "running" : "attention" : "off";
  const surfaced = scene !== "off";
  const checked = surfaced && scene !== "stopping";
  // The operation in flight, as this tab's job list knows it or as the checkout host reports it, so a
  // freshly opened tab can stop a start another tab began.
  const operation = runtime.job?.status === "running" ? { kind: runtime.job.kind, id: runtime.job.id } : runtime.local?.operation;
  // A running start can be interrupted; anything else in flight waits.
  const interruptible = scene === "starting" && !intent && operation?.kind === "local-start";
  // Stopping stays busy until shutdown is observed, even after the stop command returns.
  const busy = runtime.busy && !interruptible || intent?.step === "runtime" || scene === "stopping";
  const blocked = Boolean(runtime.local?.ownershipConflict) || scene === "off" && !runtime.canStart;
  // Hover and press affordances only where a press does something.
  const interactive = !busy && !blocked;
  const statusLabel = interrupt && runtime.phase !== "stopping" ? "Stopping…"
    : intent?.step === "docker" ? "Starting Docker…"
    : intent && !runtime.busy ? "Starting…"
    : runtime.label;
  // An off switch is amber only when the last start the user asked for failed; Details says why.
  const startFailed = runtime.job?.status === "failed" && (runtime.job.kind === "local-start" || runtime.job.kind === "local-restart");
  const warn = Boolean(runtime.problem) || scene === "attention" || scene === "off" && !blocked && startFailed;

  const loop = useLoadingCycle(motion && scene === "starting");
  const cargoLoaded = scene === "starting" ? loop.loaded : scene === "running" || scene === "attention";
  const laden = scene === "starting" && cargoLoaded;

  // Surfacing ripples play when a start begins; the spout and border light when it arrives.
  const [launches, setLaunches] = useState(0);
  const [arrivals, setArrivals] = useState(0);
  const previousScene = useRef(scene);
  const surfacing = previousScene.current === "off";
  useEffect(() => {
    const before = previousScene.current;
    previousScene.current = scene;
    if (before === "off" && scene === "starting") setLaunches(count => count + 1);
    if (before === "starting" && scene === "running") setArrivals(count => count + 1);
  }, [scene]);

  const closeHelp = useCallback(() => {
    setHelp(undefined);
    // Light dismissal keeps focus on the clicked control; Escape and Close return to the switch.
    if (document.activeElement === document.body || document.activeElement?.closest('[data-ui="compose-docker-help"], [data-ui="local-runtime-help"]'))
      [helpTrigger.current, detailsTrigger.current, control.current].find(element => element?.isConnected && !element.disabled)?.focus({ preventScroll: true });
  }, []);
  const showHelp = (kind: "docker" | "runtime", problem?: string) => {
    helpTrigger.current = control.current;
    setDockerProblem(problem);
    setHelp(kind);
  };
  const cancel = () => { attempt.current += 1; setIntent(undefined); };

  const launch = async (ticket: number) => {
    if (attempt.current !== ticket || submitting.current) return;
    submitting.current = true;
    setIntent({ step: "runtime" });
    try { await runtime.start(); }
    catch { if (attempt.current === ticket) showHelp("runtime"); }
    finally { submitting.current = false; if (attempt.current === ticket) setIntent(undefined); }
  };

  // One click carries the whole start: confirm Docker, start Docker Desktop when it is
  // only stopped, then start the runtime. Help appears only when that cannot finish alone.
  const requestStart = async () => {
    const ticket = ++attempt.current;
    setHelp(undefined);
    setIntent({ step: "check" });
    let engine = docker.status?.docker;
    if (engine?.engine !== "running" || docker.error || Date.now() - docker.dataUpdatedAt > DOCKER_FRESH_MS) {
      engine = await docker.refresh().then(status => status.docker, () => undefined);
      if (attempt.current !== ticket) return;
    }
    if (engine?.engine === "running") return launch(ticket);
    if (engine?.engine === "stopped" && engine.desktop) {
      setIntent({ step: "docker" });
      try {
        const job = await dockerStart.start();
        // Docker may already have answered and handed over to the runtime.
        if (attempt.current === ticket) setIntent(current => current?.step === "docker" ? { step: "docker", job: job.id } : current);
      } catch (problem) {
        if (attempt.current === ticket) { cancel(); showHelp("docker", message(problem, "Docker Desktop could not start.")); }
      }
      return;
    }
    cancel();
    showHelp("docker");
  };

  // While Docker Desktop starts, continue as soon as the engine answers or stop at a failure.
  const engine = docker.status?.docker.engine;
  const dockerJob = dockerStart.job;
  useEffect(() => {
    if (intent?.step !== "docker") return;
    const ticket = attempt.current;
    if (engine === "running") { void launch(ticket); return; }
    if (!intent.job || dockerJob?.id !== intent.job || dockerJob.status === "running") return;
    const block = (problem?: string) => { if (attempt.current === ticket) { cancel(); showHelp("docker", problem); } };
    if (dockerJob.status !== "succeeded") { block(dockerJob.summary ?? "Docker Desktop could not start."); return; }
    void docker.refresh().then(
      status => { if (status.docker.engine !== "running") block("Docker Desktop started, but its engine is not answering yet. Check again in a moment."); },
      () => block(),
    );
  }, [intent, engine, dockerJob?.id, dockerJob?.status]);

  // Stopping is owned by the host, including preemption of an unfinished start.
  const interruptStart = async () => {
    if (!interruptible || !operation || submitting.current) return;
    submitting.current = true;
    cancel();
    setHelp(undefined);
    setInterrupt(operation.id);
    try { await runtime.stop(); }
    catch { showHelp("runtime"); }
    finally { submitting.current = false; setInterrupt(undefined); }
  };

  const stop = async () => {
    if (submitting.current || runtime.busy) return;
    submitting.current = true;
    cancel();
    setHelp(undefined);
    try { await runtime.stop(); }
    catch { showHelp("runtime"); }
    finally { submitting.current = false; }
  };
  // Closing the details lets the switch narrate the rebuild; a refused restart reopens them.
  const restart = async () => {
    if (submitting.current || runtime.busy) return;
    submitting.current = true;
    cancel();
    setHelp(undefined);
    try { await runtime.restart(); }
    catch { showHelp("runtime"); }
    finally { submitting.current = false; }
  };

  // An unavailable card fades out under `hidden`, with `inert` releasing focus and clicks as
  // the fade begins, and is removed once it has faded; it fades in from `starting:opacity-0`.
  const shown = present && runtime.visible;
  const rendered = useLingering(shown, motion ? FADE_OUT_MS : 0);
  if (!rendered) return null;

  const loops = motion && cx(!surfaced && "[animation-play-state:paused]");
  const loadBase = scene === "starting" ? loop.count <= 1 ? LOAD_AT : 0 : surfacing ? LOAD_AT : 0;
  // Hovering the switch makes the resting whale peek, inviting the press.
  const pose = scene === "off"
    ? cx("translate-y-[3.5px] -rotate-5", interactive && "group-has-[button:hover]/compose:translate-y-[2.5px] group-has-[button:hover]/compose:-rotate-[3.5deg]")
    : scene === "stopping" ? "translate-y-[1.6px] -rotate-2" : laden ? "translate-y-[.9px] rotate-0" : "translate-y-0 rotate-0";
  const poseTiming = scene === "off" ? `translate 520ms ${IN_OUT}, rotate 560ms ${IN_OUT}`
    : scene === "stopping" ? `translate 900ms ${IN_OUT}, rotate 900ms ${IN_OUT}`
    : `translate 820ms ${BOUNCE} 120ms, rotate 900ms ${BOUNCE} 120ms`;
  const water = { transition: surfaced ? `translate 560ms ${EXPO_OUT} 30ms` : `translate 420ms ${EASE_IN} 180ms` };
  const ebb = scene === "stopping" && motion && "animate-compose-ebb";

  return (
    <div
      hidden={!shown}
      inert={!shown}
      className="pointer-events-auto flex min-w-min max-w-full flex-wrap items-end gap-1 starting:opacity-0 [&[hidden]]:opacity-0 motion-reduce:transition-none!"
      style={motion ? { transition: shown ? FADE_IN : FADE_OUT } : undefined}
    >
      <div
        ref={card}
        data-ui="compose-preview"
        data-state={checked ? "on" : "off"}
        data-scene={scene}
        data-phase={statusLabel}
        data-motion={motion ? "on" : "off"}
        className={cx(
          "group/compose relative isolate flex h-14 max-w-full min-w-[260px] items-center gap-3 rounded-[16px] border py-[5px] pr-2 pl-[5px] text-left font-sans backdrop-blur-[12px] select-none",
          "[transition:border-color_300ms,background-color_300ms,box-shadow_700ms_cubic-bezier(.16,1,.3,1)] forced-colors:border-[ButtonText]",
          surfaced
            ? cx("border-map-compose/45 bg-map-panel/95 shadow-compose", interactive && "has-[button:hover]:border-map-compose/75")
            : cx("border-map-rule/80 bg-map-surface/95 shadow-compose-rest", interactive && "has-[button:hover]:border-map-muted/60 has-[button:hover]:bg-map-panel/95"),
          !motion && "[&_*]:transition-none! [&_*]:animate-none!",
          "motion-reduce:[&_*]:animate-none!",
          blocked && "opacity-65",
        )}
      >
        {/* Light from the water spills onto the card. */}
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-radial-[150px_64px_at_27px_50%] from-map-compose/15 to-transparent to-72% transition-opacity duration-700",
            surfaced ? "opacity-100" : "opacity-0", ebb,
          )}
        />
        {/* One band of light runs once around the border when the runtime arrives. */}
        {motion && arrivals > 0 ? (
          <span
            aria-hidden
            className={cx("pointer-events-none absolute -inset-px rounded-[inherit] transition-opacity duration-200", scene === "running" ? "opacity-100" : "opacity-0")}
          >
            <span
              key={arrivals}
              data-slot="compose-arrival"
              className="absolute inset-0 animate-compose-sweep rounded-[inherit] bg-conic-[from_var(--compose-sweep)] from-transparent via-map-compose-light via-18% to-transparent to-26% p-px [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)]"
              style={{ animationDelay: "200ms" }}
            />
          </span>
        ) : null}

        {/* The porthole: radius 10 sits concentric inside the card's 16 at a 6px inset. */}
        <span aria-hidden className="group/porthole relative size-11 shrink-0 overflow-hidden rounded-[10px] bg-map-ground">
          <span
            className={cx(
              "absolute inset-0 bg-radial-[130%_80%_at_50%_108%] from-map-compose-deep/30 to-transparent to-70% transition-opacity duration-700",
              surfaced ? "opacity-100" : "opacity-0", ebb,
            )}
          />
          <svg
            viewBox="0 0 44 44"
            fill="none"
            className={cx(
              "absolute inset-0 size-full transition-colors duration-300 forced-colors:text-[CanvasText]",
              surfaced ? "text-map-compose" : cx("text-map-compose-off", interactive && "group-has-[button:hover]/compose:text-map-compose-off-hover"),
            )}
          >
            <g className={surfaced ? "translate-y-0" : "translate-y-[14px]"} style={water}>
              <path className={cx("fill-map-compose-deep/50", motion && "animate-compose-drift", loops)} d={`M-44 31.6${WAVE}`} />
            </g>
            {/* Rings spread across the water behind the whale as it breaks the surface. */}
            {motion && surfaced && launches > 0 ? (
              <g key={launches} data-slot="compose-launch" className="stroke-map-compose-light" strokeWidth=".7">
                {[320, 480].map((delay) => (
                  <ellipse
                    key={delay}
                    cx="22"
                    cy="31.8"
                    rx="16"
                    ry="2.6"
                    className="origin-center animate-compose-ripple [transform-box:fill-box]"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </g>
            ) : null}
            <g className={cx(PIVOT, motion && "animate-compose-bob", loops)}>
              <g className={cx(PIVOT, pose)} style={{ transition: poseTiming }}>
                <g data-slot="compose-whale" className={cx(scene === "stopping" && motion && "animate-compose-breathe")}>
                  <path fill="currentColor" d={HULL} />
                  {/* Empty berths keep the stack's outline readable; while starting they are the slots being filled. */}
                  <g
                    stroke="currentColor"
                    strokeWidth=".8"
                    className={scene === "starting" ? "opacity-50" : cargoLoaded ? "opacity-0" : "opacity-100"}
                    style={{ transition: cargoLoaded && scene !== "starting" ? "opacity 200ms linear 700ms" : "opacity 260ms linear 120ms" }}
                  >
                    {CARGO.map(([x, y]) => (
                      <rect key={`${x},${y}`} x={x + 0.44} y={y + 0.44} width="3.96" height="3.96" rx=".77" />
                    ))}
                  </g>
                </g>
                {CARGO.map(([x, y], index) => {
                  const looping = scene === "starting";
                  const load = loadBase + index * (looping ? LOOP_STAGGER : LOAD_STAGGER);
                  const unload = (CARGO.length - 1 - index) * (looping ? UNLOAD_STAGGER.starting : scene === "stopping" ? UNLOAD_STAGGER.stopping : UNLOAD_STAGGER.other);
                  const lift = scene === "stopping" ? 340 : 240;
                  return (
                    <rect
                      key={`${x},${y}`}
                      data-slot="compose-cargo"
                      data-loaded={cargoLoaded ? "true" : "false"}
                      x={x}
                      y={y}
                      width="4.84"
                      height="4.84"
                      rx=".88"
                      className={cx("fill-map-compose", cargoLoaded ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0")}
                      style={{
                        transition: cargoLoaded
                          ? `translate ${looping ? LOOP_DROP : 640}ms ${BOUNCE} ${load}ms, opacity 140ms linear ${load}ms`
                          : `translate ${lift}ms ${EASE_IN} ${unload}ms, opacity 200ms linear ${unload + 40}ms`,
                      }}
                    />
                  );
                })}
                <circle cx="34.32" cy="28.02" r="1.1" className="fill-map-surface" />
                <path d="M14.3 32.64C16.72 35.28 20.24 36.16 24.2 36.16" className="stroke-map-surface" strokeOpacity=".35" strokeWidth="1" strokeLinecap="round" />
                {motion && scene === "running" && arrivals > 0 ? (
                  <g key={arrivals} data-slot="compose-arrival" className="fill-map-compose-light">
                    {SPOUT.map((drift, index) => (
                      <circle
                        key={drift}
                        cx="36.74"
                        cy="22.52"
                        r="1.15"
                        className="origin-center animate-compose-spout [transform-box:fill-box]"
                        style={{ "--spout-x": `${drift}px`, animationDelay: `${640 + index * 60}ms` } as CSSProperties}
                      />
                    ))}
                  </g>
                ) : null}
                {motion && scene === "running" ? (
                  <g data-slot="compose-hover-spout" className="fill-map-compose-light">
                    {SPOUT.map((drift, index) => (
                      <circle
                        key={drift}
                        cx="36.74"
                        cy="22.52"
                        r="1.15"
                        className="origin-center opacity-0 [transform-box:fill-box] group-hover/porthole:animate-compose-spout"
                        style={{ "--spout-x": `${drift}px`, animationDelay: `${index * 60}ms` } as CSSProperties}
                      />
                    ))}
                  </g>
                ) : null}
              </g>
            </g>
            {/* The near swell passes in front of the hull, so the whale sits in the water rather than on it. */}
            <g className={surfaced ? "translate-y-0" : "translate-y-[14px]"} style={{ transition: surfaced ? `translate 560ms ${EXPO_OUT} 70ms` : `translate 400ms ${EASE_IN} 140ms` }}>
              <path className={cx("fill-map-compose/30", motion && "animate-compose-drift [animation-direction:reverse]", loops)} d={`M-44 34.2${SWELL}`} />
            </g>
          </svg>
          <span
            className={cx(
              "pointer-events-none absolute inset-0 rounded-[inherit] inset-ring transition-shadow duration-500",
              surfaced ? "inset-ring-map-compose/30" : "inset-ring-map-rule/60",
            )}
          />
        </span>

        {/* Truncating lines clip at their line box, so leave room for descenders. */}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={titleId} className="truncate text-label leading-[1.2] font-medium text-map-ink">Local runtime</span>
          <span
            aria-hidden
            data-slot="compose-status"
            data-current="true"
            className={cx(
              "truncate text-caption leading-[1.2] transition-colors duration-300",
              warn ? "text-map-warning-text" : scene === "starting" || scene === "running" ? "text-map-compose" : scene === "stopping" ? "text-map-text" : "text-map-muted",
            )}
          >
            {statusLabel}
          </span>
        </span>

        {/* Only the switch toggles. Its hit area is larger than the track it draws. */}
        <button
          ref={control}
          type="button"
          role="switch"
          data-slot="compose-switch"
          aria-checked={checked}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-haspopup="dialog"
          aria-expanded={Boolean(help)}
          aria-controls={help ? helpId : undefined}
          aria-busy={busy || runtime.busy || Boolean(intent)}
          // Busy keeps focus on the switch; only an unavailable start removes it from the tab order.
          aria-disabled={busy || undefined}
          disabled={blocked}
          title={blocked ? runtime.local?.ownershipConflict ?? runtime.blocker : intent || interruptible ? "Stop starting" : checked ? "Stop local development" : "Start local development"}
          onClick={() => {
            if (busy) return;
            if (help) { closeHelp(); return; }
            if (intent) cancel();
            else if (interruptible) void interruptStart();
            else if (checked) void stop();
            else void requestStart();
          }}
          className={cx(
            "group/switch relative -ml-1.5 m-0 grid h-11 w-[52px] shrink-0 appearance-none place-items-center rounded-[12px] border-0 bg-transparent p-0 outline-none",
            busy ? "cursor-wait" : blocked ? "cursor-not-allowed" : "cursor-pointer",
          )}
        >
          {/* The knob stretches under a press and springs across on release. */}
          <span
            aria-hidden
            className={cx(
              "relative h-[22px] w-[38px] rounded-full inset-ring transition-[background-color,box-shadow] duration-200 forced-colors:border forced-colors:border-[ButtonText]",
              "group-focus-visible/switch:outline-2 group-focus-visible/switch:outline-offset-[3px] group-focus-visible/switch:outline-map-focus",
              checked
                ? "bg-map-compose shadow-compose-glow inset-ring-white/12 forced-colors:bg-[Highlight]"
                : cx("bg-map-ground inset-ring-map-rule", interactive && "group-hover/switch:inset-ring-map-muted/60"),
            )}
          >
            <span
              className={cx(
                "absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-map-knob shadow-[0_1px_3px_#0008,0_0_0_.5px_#0000002e] [transition:translate_440ms_var(--spring),width_240ms_var(--spring)] forced-colors:bg-[ButtonText]",
                checked ? "translate-x-4" : "translate-x-0",
                interactive && (checked ? "group-active/switch:w-[22px] group-active/switch:translate-x-3" : "group-active/switch:w-[22px]"),
              )}
            />
          </span>
        </button>
      </div>
      <span id={descriptionId} className="sr-only">{statusLabel}. {blocked ? runtime.local?.ownershipConflict ?? runtime.blocker : "Starts or stops local development for this checkout. Starting uses the selected Development deployment. Empty local PostgreSQL storage is initialized automatically; existing storage is verified and migrations require review in Database. Progress and logs are in Activity."}</span>
      <span role="status" aria-live="polite" className="sr-only">{statusLabel}</span>
      {runtime.local || runtime.problem || runtime.error ? <button
        ref={detailsTrigger} type="button" aria-label="Local runtime details" aria-haspopup="dialog" aria-expanded={help === "runtime"}
        aria-controls={help === "runtime" ? helpId : undefined}
        className={buttonClasses({ variant: "link", size: "custom", className: "ml-auto min-h-6 shrink-0 px-2 text-caption text-map-text" })}
        onClick={event => { helpTrigger.current = event.currentTarget; setHelp(help === "runtime" ? undefined : "runtime"); }}>Details</button> : null}
      {shown && help === "docker" ? <DockerStartPopover id={helpId} anchor={card} problem={dockerProblem} onClose={closeHelp}
        onReady={() => { closeHelp(); void requestStart(); }} /> : null}
      {shown && help === "runtime" ? <LocalRuntimePopover id={helpId} anchor={card} runtime={runtime} onClose={closeHelp} onStop={() => void stop()} onRestart={() => void restart()} /> : null}
    </div>
  );
}
