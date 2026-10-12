// The portal is static files (`npm run build` makes dist/), served by Caddy at
// sealeye.online. It talks to the API at /api, which Caddy passes to the API: one
// origin, so the session cookie never crosses to another site (DESIGN.md, "The portal
// signs in with a session cookie"). In development and in the browser tests, Vite does
// what Caddy does, against SEALEYE_PORTAL_API.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";

// The version the portal was built from, so the Health page can say when the page in
// the browser is older or newer than the platform behind it.
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const target = process.env.SEALEYE_PORTAL_API || "http://localhost:3000";
const proxy = {
  "/api": {
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, "")
  }
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __PORTAL_VERSION__: JSON.stringify(version) },
  // Pages share words with the command through ../core (test/boundaries.test.js keeps
  // those files browser-safe), so the dev server may read there too.
  server: { proxy, fs: { allow: [".", "../core"] } },
  preview: { proxy },
  build: { sourcemap: false }
});
