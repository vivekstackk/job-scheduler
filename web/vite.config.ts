import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Every client route that has to survive a direct load, a refresh or a pasted
 * link. The dashboard is one BrowserRouter app, so not one of these exists as a
 * file on disk — which is the whole problem on a static host.
 */
const CLIENT_ROUTES = [
  "dashboard",
  "dashboard/jobs",
  "dashboard/runs",
  "dashboard/schedules",
  "dashboard/metrics",
  "dashboard/api",
  "dashboard/logs",
  "dashboard/settings",
];

/**
 * Writes a copy of the built shell at every client route.
 *
 * Render's static host takes redirects and rewrites from rules configured in
 * its dashboard, or from a `routes:` block in an applied blueprint. It does not
 * read a `_redirects` file out of the publish directory. So that file shipped
 * inside web/dist doing nothing at all, and a direct load of /dashboard came
 * back as the host's own plain-text "Not Found".
 *
 * The same docs note that a rule is skipped whenever a resource already exists
 * at the requested path, and that is the opening used here: emitting
 * dashboard/index.html — and one index.html per sub-route — makes each of those
 * paths a real file. The host serves it, React Router reads the URL from the
 * address bar, and the page renders. No dashboard rule, no blueprint apply.
 *
 * 404.html covers what cannot be enumerated, /dashboard/jobs/<id>, on a host
 * that serves a custom error document. Render does not document that behaviour,
 * so treat the routes above as the guaranteed part, and a dashboard rewrite of
 * /* to /index.html as the complete one.
 */
function spaFallbackPages(): Plugin {
  return {
    name: "spa-fallback-pages",
    apply: "build",
    // post, so Vite has already emitted index.html into the bundle by now.
    enforce: "post",

    generateBundle(_options, bundle) {
      const shell = bundle["index.html"];

      // Nothing to copy if the HTML entry is absent — a library build, say.
      // Failing the build over a fallback page would be the wrong trade.
      if (!shell || shell.type !== "asset") return;

      const source = shell.source;

      for (const route of CLIENT_ROUTES) {
        this.emitFile({
          type: "asset",
          fileName: `${route}/index.html`,
          source,
        });
      }

      this.emitFile({ type: "asset", fileName: "404.html", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), spaFallbackPages()],

  server: {
    port: 5173,

    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});

