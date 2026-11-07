import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base: "./" — a Little app must load from a CDN/bucket prefix, not just an origin root,
// or root-absolute asset URLs 404 once published. allowedHosts: tunnels change per run.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "0.0.0.0", port: 7140, strictPort: true, allowedHosts: true },
});
