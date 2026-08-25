import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/*
 * 面板服务的端口。
 *
 * 服务端早就认 PORT 环境变量了，这里却写死 8787 —— 于是 8787 被别的进程占用时，
 * 换个端口起服务，前端仍然固执地往 8787 代理，表现是接口全 500 而服务日志干干净净。
 */
const API_PORT = process.env.SONAR_API_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
});
