import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "^/w(?:/|$)": { target: "http://localhost:3000", changeOrigin: true },
      "^/v(?:/|$)": { target: "http://localhost:3000", changeOrigin: true },
      "/assets": { target: "http://localhost:3000", changeOrigin: true },
      "/health": { target: "http://localhost:3000", changeOrigin: true },
      "/storage": {
        target: "http://localhost:9000",
        changeOrigin: true,
        rewrite: (url) => url.replace(/^\/storage/, ""),
      },
    },
  },
});
