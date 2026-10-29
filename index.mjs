import { createPlugin } from "./lib.mjs";

export default {
  id: "cloudflare-gateway-byok",
  server: async (input, options) =>
    createPlugin(options, globalThis.fetch, {
      directory: input?.directory,
      log(diagnostic) {
        const message = `${diagnostic.code}${diagnostic.provider ? `: ${diagnostic.provider}` : ""}${diagnostic.message ? `: ${diagnostic.message}` : ""}`;
        const level = diagnostic.code === "missing_byok_key" ? "info" : "warn";
        const result = input?.client?.app?.log?.({
          body: { service: "cloudflare-gateway-byok", level, message },
        });
        result?.catch?.(() => {});
      },
    }),
};
