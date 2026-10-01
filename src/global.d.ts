import { Browser } from "webextension-polyfill";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      SENTRY_DSN?: string;
    }
  }

  const browser: Browser;
}
