import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  server: {
    allowedHosts: ["vite.f-tuma.dev"],
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "^/w(?:/|$)": { target: "http://localhost:3000", changeOrigin: true },
      "^/v(?:/|$)": { target: "http://localhost:3000", changeOrigin: true },
      "/assets": { target: "http://localhost:3000", changeOrigin: true },
      "/health": { target: "http://localhost:3000", changeOrigin: true },
      "/storage": {
        target: "http://localhost:9000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/storage/, ""),
      },
    },
  },
});
