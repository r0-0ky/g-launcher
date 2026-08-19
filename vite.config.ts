import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri ожидает фиксированный порт и не любит, когда vite падает на занятый.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      // В сборке minecraft-react-ui tslib подключён относительным путём внутрь
      // node_modules — так пакет не собирается ничем. Отправляем импорт в
      // настоящий tslib.
      {
        find: /^(\.\.\/)+node_modules\/tslib\/tslib\.es6\.js$/,
        replacement: "tslib",
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    sourcemap: false,
  },
});
