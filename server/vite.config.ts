import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Админка живёт в /admin и собирается в dist/admin, откуда её раздаёт Fastify.
export default defineConfig({
  root: "admin",
  base: "/admin/",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8080",
      "/files": "http://localhost:8080",
      "/manifest.json": "http://localhost:8080",
    },
  },
  build: {
    outDir: "../dist/admin",
    emptyOutDir: true,
  },
});
