import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// node-pty is a native module and lives in package.json "dependencies";
// externalizeDepsPlugin() keeps it out of the bundle so Electron loads the
// real module (and its prebuilt pty.node) from node_modules at runtime.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {},
});
