import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ffmpegBridge } from './tools/ffmpeg-bridge';

export default defineConfig({
  plugins: [react(), ffmpegBridge()],
  server: {
    port: 5173,
    host: true,
    watch: { ignored: ['**/.mva-renders/**', '**/.mva-assets/**'] },
    proxy: {
      // 模型网关（FastAPI，默认 8010）走同源代理：
      // · 免 CORS 配置 · 前端拿到的图片是同源 URL，canvas 栅格化不会被污染
      '/mva-api': {
        target: process.env.MVA_GATEWAY_URL || 'http://127.0.0.1:8010',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/mva-api/, ''),
      },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
