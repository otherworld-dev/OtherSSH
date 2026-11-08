import type { OtherSshApi } from '../shared/types';

declare global {
  interface Window {
    otherssh: OtherSshApi;
  }
}

export {};
