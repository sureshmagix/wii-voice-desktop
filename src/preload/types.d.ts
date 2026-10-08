import type { voiceAPI } from './index.ts';

declare global {
  interface Window {
    voiceAPI: typeof voiceAPI;
  }
}
export {};
