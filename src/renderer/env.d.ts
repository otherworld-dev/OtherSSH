import type { SshitApi } from '../shared/types';

declare global {
  interface Window {
    sshit: SshitApi;
  }
}

export {};
