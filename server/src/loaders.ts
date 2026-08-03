/** Списки доступных версий Minecraft и модлоадеров — для выпадающих списков в админке. */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30 * 60 * 1000;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export interface MinecraftVersion {
  id: string;
  type: string;
  releaseTime: string;
}

export async function minecraftVersions(): Promise<MinecraftVersion[]> {
  return cached("mc", async () => {
    const response = await fetch(
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
    );
    if (!response.ok) throw new Error(`Mojang ответил ${response.status}`);
    const data = (await response.json()) as { versions: any[] };
    return data.versions.map((version) => ({
      id: version.id,
      type: version.type,
      releaseTime: version.releaseTime,
    }));
  });
}

async function fabricLike(base: string, minecraft: string): Promise<string[]> {
  const response = await fetch(`${base}/versions/loader/${minecraft}`);
  if (!response.ok) return [];
  const data = (await response.json()) as any[];
  return data.map((entry) => entry.loader.version);
}

/** maven-metadata.xml -> список версий; фильтр отбирает нужную ветку. */
async function mavenVersions(url: string, keep: (version: string) => boolean): Promise<string[]> {
  const response = await fetch(url);
  if (!response.ok) return [];
  const xml = await response.text();
  const versions: string[] = [];
  for (const chunk of xml.split("<version>").slice(1)) {
    const end = chunk.indexOf("</version>");
    if (end === -1) continue;
    const version = chunk.slice(0, end).trim();
    if (keep(version)) versions.push(version);
  }
  return versions.reverse();
}

export async function loaderVersions(loader: string, minecraft: string): Promise<string[]> {
  if (!minecraft) return [];
  return cached(`${loader}:${minecraft}`, async () => {
    switch (loader) {
      case "fabric":
        return fabricLike("https://meta.fabricmc.net/v2", minecraft);
      case "quilt":
        return fabricLike("https://meta.quiltmc.org/v3", minecraft);
      case "forge": {
        const prefix = `${minecraft}-`;
        const all = await mavenVersions(
          "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
          (version) => version.startsWith(prefix)
        );
        return all.map((version) => version.slice(prefix.length));
      }
      case "neoforge": {
        const parts = minecraft.split(".");
        if (parts.length < 2) return [];
        const prefix = `${parts[1]}.${parts[2] ?? "0"}.`;
        return mavenVersions(
          "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
          (version) => version.startsWith(prefix) && !version.includes("beta")
        );
      }
      default:
        return [];
    }
  });
}
