// The portal is static files (`npm run build` makes dist/), served by Caddy at
// sealeye.online. It talks to the API at /api, which Caddy passes to the API: one
// origin, so the session cookie never crosses to another site (DESIGN.md, "The portal
// signs in with a session cookie"). In development and in the browser tests, Vite does
// what Caddy does, against SEALEYE_PORTAL_API.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  server: { proxy },
  preview: { proxy },
  build: { sourcemap: false }
});
