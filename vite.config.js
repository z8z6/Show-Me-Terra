import {defineConfig} from 'vite';

export default defineConfig(({command}) => ({
  base: command === 'build' ? '/Show-Me-Terra/' : '/',
  define: {
    __BUILD_ID__: JSON.stringify(process.env.GITHUB_SHA || `local-${Date.now()}`)
  }
}));
