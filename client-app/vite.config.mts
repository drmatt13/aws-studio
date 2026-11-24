import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { ICONS, iconUrl, type IconKey } from "./src/icons";

// The studio's page. The server runs Vite in middleware mode and injects the
// session token into index.html, so `vite dev` on its own is never used.
export default defineConfig({
  base: "/",
  plugins: [tailwindcss(), viteReact(), {
    name: "studio-map-icon-preloads",
    transformIndexHtml() {
      // Discover the small core catalog in HTML, ahead of the application/module waterfall.
      // The much larger endpoint catalog stays demand-loaded by the scene.
      return (Object.keys(ICONS) as IconKey[]).map(key => ({
        tag: "link",
        attrs: { rel: "preload", as: "image", type: "image/svg+xml", href: iconUrl(key), fetchpriority: "high" },
        injectTo: "head-prepend" as const,
      }));
    },
  }],
  // Building the isolated browser gallery must not reload an active Studio draft.
  server: { watch: { ignored: ["**/test/browser/.dist/**"] } },
  build: { outDir: "dist", emptyOutDir: true },
});
