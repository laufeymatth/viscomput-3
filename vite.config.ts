import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => ({
  // Relative base so the build works under any sub-path (e.g. GitHub Pages /<repo>/).
  base: "./",
  // `npm run dev:https`: self-signed HTTPS so a headset (WebXR) or phone (tilt) on the LAN gets a secure context.
  plugins: mode === "https" ? [basicSsl()] : [],
}));
