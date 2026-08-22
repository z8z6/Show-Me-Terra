import {defineConfig} from 'vite';

export default defineConfig(({command}) => ({
  base: command === 'build' ? '/Show-Me-Terra/' : '/'
}));
