import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  // The production build is served by the bot at /dashboard/.
  // The standalone dev server stays at the root so `npm run dev` keeps
  // opening http://127.0.0.1:5173/.
  base: command === "build" ? "/dashboard/" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
  },
}));
