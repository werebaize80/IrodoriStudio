import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @fontsourceのCSSはwoff2とwoffの両方を参照するため、そのままだと両方が同梱される。
// WebView2はwoff2に対応しているので、woffの参照を外してアプリのサイズを抑える。
function woff2Only(): Plugin {
  return {
    name: "woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@fontsource") || !id.endsWith(".css")) return null;
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
    },
  };
}

// @ts-expect-error Vite exposes process only while configuring Tauri development.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [woff2Only(), react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] }
  }
});
