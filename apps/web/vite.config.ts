import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_INTERNAL_URL ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5173,
    // Dev only: production traffic goes through the Bun server's proxy (server.ts).
    proxy: {
      "/api/auth": { target: apiTarget },
      "/api": { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
