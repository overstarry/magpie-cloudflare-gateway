import { readFile } from "node:fs/promises";
import { createPlugin } from "./lib.mjs";

const icon = `data:image/png;base64,${(await readFile(new URL("./assets/icon.png", import.meta.url))).toString("base64")}`;

export default {
  id: "cloudflare-gateway-byok",
  server: async (input, options) => {
    const hooks = createPlugin(options, globalThis.fetch, {
      directory: input?.directory,
      log(diagnostic) {
        const message = `${diagnostic.code}${diagnostic.provider ? `: ${diagnostic.provider}` : ""}${diagnostic.message ? `: ${diagnostic.message}` : ""}`;
        const level = diagnostic.code === "missing_byok_key" ? "info" : "warn";
        const result = input?.client?.app?.log?.({
          body: { service: "cloudflare-gateway-byok", level, message },
        });
        result?.catch?.(() => {});
      },
    });
    hooks.auth.icon = icon;
    return hooks;
  },
};
