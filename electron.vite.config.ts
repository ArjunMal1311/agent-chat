import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import { DEFAULT_APP_PORT } from "./src/constants/app.ts";

const PORT = Number(process.env.AGENT_CHAT_PORT || DEFAULT_APP_PORT);

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    // In `npm run dev` the page comes from Vite; the API and the live stream still live in the app's own server.
    server: { proxy: { "/api": `http://127.0.0.1:${PORT}`, "/events": `http://127.0.0.1:${PORT}` } },
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
  },
});
