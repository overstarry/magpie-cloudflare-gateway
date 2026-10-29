import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CATALOG_URL = "https://models.dev/api.json";
const TTL = 6 * 60 * 60 * 1000;

// Only the public metadata catalog is written to disk, never credentials or account lists.
export function createCatalog({ fetchImpl, directory, now = Date.now }) {
  let kept,
    fetchedAt = 0,
    retryAt = 0,
    pending;
  const file = directory
    ? join(directory, "cloudflare-byok-models-dev.json")
    : null;
  function usable(data) {
    return (
      data &&
      typeof data === "object" &&
      Object.values(data).some(
        (p) =>
          p?.models && typeof p.models === "object" && !Array.isArray(p.models),
      )
    );
  }
  return async function load() {
    if (pending) return pending;
    if (kept && now() - fetchedAt < TTL) return kept;
    if (now() < retryAt) return kept ?? {};
    pending = (async () => {
      if (!kept && file) {
        try {
          const saved = JSON.parse(await readFile(file, "utf8"));
          if (
            usable(saved.data) &&
            Number.isFinite(saved.fetchedAt) &&
            saved.fetchedAt <= now()
          ) {
            kept = saved.data;
            fetchedAt = saved.fetchedAt;
            if (now() - fetchedAt < TTL) return kept;
          }
        } catch {
          /* A corrupt cache is treated as a miss. */
        }
      }
      try {
        const response = await fetchImpl(
          new Request(CATALOG_URL, {
            signal: AbortSignal.timeout(8000),
            redirect: "error",
          }),
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Catalog unavailable");
        }
        const data = await response.json();
        if (!usable(data)) throw new Error("Invalid catalog");
        kept = data;
        fetchedAt = now();
        if (file) {
          try {
            await mkdir(directory, { recursive: true });
            const temp = `${file}.${randomUUID()}.tmp`;
            await writeFile(temp, JSON.stringify({ fetchedAt, data }));
            await rename(temp, file);
          } catch {
            /* Disk caching must not prevent inference. */
          }
        }
      } catch {
        retryAt = now() + 60_000;
      }
      return kept ?? {};
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export function modelMetadata(catalog, provider, id) {
  // Model IDs come from vendors, so names like "constructor" must not hit the prototype.
  const models =
    (Object.hasOwn(catalog, provider) && catalog[provider]?.models) || {};
  for (const key of [id, id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "")])
    if (Object.hasOwn(models, key)) return models[key];
  return {};
}
