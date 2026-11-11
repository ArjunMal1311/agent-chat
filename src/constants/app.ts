// Ports. The desktop app uses a fixed one so the page's origin stays the same and settings like the theme stick;
// the headless server (`npm start`) and tests default to another.

export const DEFAULT_APP_PORT = 48765; // the Electron app, and the dev server's proxy target
export const DEFAULT_SERVER_PORT = 8765; // `node src/main/cli.ts` and startServer()
