import { ICONS, iconUrl, type IconKey } from "./icons";

export interface IconImage {
  readonly image: HTMLImageElement;
  readonly ready: Promise<void>;
  readonly settled: boolean;
}

/** One decoded image per URL, shared across renderer mounts (including StrictMode). */
export class IconImageCache {
  private readonly images = new Map<string, IconImage>();

  constructor(private readonly createImage: () => HTMLImageElement = () => new Image()) {}

  get(url: string): IconImage {
    const cached = this.images.get(url);
    if (cached) return cached;
    const image = this.createImage();
    let finish!: () => void;
    const entry = { image, settled: false, ready: new Promise<void>(resolve => { finish = resolve; }) };
    this.images.set(url, entry);
    let decoding = false;
    const settle = () => {
      image.onload = image.onerror = null;
      entry.settled = true;
      finish();
    };
    const loaded = () => {
      if (entry.settled || decoding) return;
      decoding = true;
      // Canvas must be able to draw the SVG on its first frame, not just have its bytes.
      if (image.naturalWidth > 0 && image.decode) void image.decode().then(settle, settle);
      else settle();
    };
    image.onload = loaded;
    // A missing asset must not hold the whole map in its loading state.
    image.onerror = settle;
    image.fetchPriority = "high";
    image.src = url;
    if (image.complete) loaded();
    return entry;
  }
}

export const iconImages = new IconImageCache();

/** Start decoding alongside snapshot/route loading, before scene layout and mounting. */
export function preloadMapIcons(): void {
  for (const key of Object.keys(ICONS) as IconKey[]) iconImages.get(iconUrl(key));
}
