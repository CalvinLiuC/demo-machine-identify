import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  optimizeDeps: { noDiscovery: true, include: [] },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
});
