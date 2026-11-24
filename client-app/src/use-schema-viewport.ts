import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";

interface Camera { x: number; y: number; zoom: number }
interface Bounds { x: number; y: number; width: number; height: number }
const MIN_OVERVIEW_ZOOM = 0.25;

function zoomAt(camera: Camera, zoom: number, x: number, y: number, overview: number): Camera {
  const next = Math.max(overview * MIN_OVERVIEW_ZOOM, Math.min(Math.max(1.6, overview * 8), zoom));
  const ratio = next / camera.zoom;
  return { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, zoom: next };
}

/** One camera for pointer, touch, wheel and keyboard navigation of the diagram. */
export function useSchemaViewport(bounds: Bounds, onAspectRatio: (ratio: number) => void) {
  const viewport = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [overview, setOverview] = useState(1);
  const overviewRef = useRef(1);
  const fitted = useRef(true);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const zoomBy = (factor: number) => {
    const element = viewport.current;
    if (!element) return;
    fitted.current = false;
    setCamera(value => zoomAt(value, value.zoom * factor, element.clientWidth / 2, element.clientHeight / 2, overviewRef.current));
  };
  const frame = useCallback((bounds: Bounds, maxZoom = 1) => {
    const element = viewport.current;
    if (!element || !element.clientWidth || !element.clientHeight) return;
    const zoom = Math.max(Number.EPSILON, Math.min(maxZoom,
      (element.clientWidth - 32) / bounds.width, (element.clientHeight - 32) / bounds.height));
    fitted.current = false;
    setCamera({
      x: (element.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: (element.clientHeight - bounds.height * zoom) / 2 - bounds.y * zoom,
      zoom,
    });
  }, []);
  const fit = useCallback(() => {
    const element = viewport.current;
    if (element?.clientWidth && element.clientHeight) {
      onAspectRatio((element.clientWidth - 32) / Math.max(1, element.clientHeight - 32));
    }
    frame(bounds);
    fitted.current = true;
  }, [bounds.x, bounds.y, bounds.width, bounds.height, frame, onAspectRatio]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      const next = Math.max(Number.EPSILON, Math.min(1,
        (element.clientWidth - 32) / bounds.width, (element.clientHeight - 32) / bounds.height));
      overviewRef.current = next;
      setOverview(next);
      if (fitted.current) fit();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bounds.width, bounds.height, fit, onAspectRatio]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1;
      const dx = event.deltaX * unit, dy = event.deltaY * unit;
      fitted.current = false;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        setCamera(value => zoomAt(value, value.zoom * Math.exp(-dy * 0.01), event.clientX - rect.left, event.clientY - rect.top, overviewRef.current));
      } else {
        setCamera(value => ({ ...value,
          x: value.x - (event.shiftKey && !dx ? dy : dx),
          y: value.y - (event.shiftKey && !dx ? 0 : dy),
        }));
      }
    };
    // React's wheel listener is passive; this local listener keeps gestures inside the canvas.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDown(event) {
      if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
      suppressClick.current = false;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      if (event.button === 1) event.preventDefault();
    },
    onPointerMove(event) {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (!current.moved && Math.hypot(dx, dy) < 4) return;
      if (!current.moved) {
        current.moved = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        setPanning(true);
      }
      event.preventDefault();
      current.x = event.clientX;
      current.y = event.clientY;
      fitted.current = false;
      setCamera(value => ({ ...value, x: value.x + dx, y: value.y + dy }));
    },
    onPointerUp(event) {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      setPanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() { drag.current = null; setPanning(false); },
    onLostPointerCapture(event) {
      if (event.target !== event.currentTarget) return;
      drag.current = null; setPanning(false);
    },
    onPointerLeave() { if (!drag.current?.moved) drag.current = null; },
    onClickCapture(event) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onDragStart(event) { event.preventDefault(); },
    onFocusCapture(event) {
      if (event.target === event.currentTarget || !event.target.matches("button:focus-visible")) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const target = event.target.getBoundingClientRect();
      const dx = target.left < bounds.left + 8 ? bounds.left + 8 - target.left
        : target.right > bounds.right - 8 ? bounds.right - 8 - target.right : 0;
      const dy = target.top < bounds.top + 8 ? bounds.top + 8 - target.top
        : target.bottom > bounds.bottom - 8 ? bounds.bottom - 8 - target.bottom : 0;
      if (dx || dy) {
        fitted.current = false;
        setCamera(value => ({ ...value, x: value.x + dx, y: value.y + dy }));
      }
    },
    onKeyDown(event) {
      if (event.target !== event.currentTarget) return;
      const step = event.shiftKey ? 120 : 40;
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
      };
      const delta = directions[event.key];
      if (delta) {
        event.preventDefault();
        fitted.current = false;
        setCamera(value => ({ ...value, x: value.x + delta[0], y: value.y + delta[1] }));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault(); zoomBy(1.2);
      } else if (event.key === "-") {
        event.preventDefault(); zoomBy(1 / 1.2);
      }
    },
  };
  return { viewport, camera, panning, handlers, zoomBy, frame, fit,
    zoomPercent: Math.round(camera.zoom / overview * 100),
    canZoomOut: camera.zoom > overview * MIN_OVERVIEW_ZOOM + 1e-8,
    canZoomIn: camera.zoom < Math.max(1.6, overview * 8) - 1e-8 };
}
