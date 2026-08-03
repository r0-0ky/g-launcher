/** Тонкий клиент Modrinth: поиск проектов и выбор подходящей версии файла. */

const API = "https://api.modrinth.com/v2";
const UA = "gandoni-launcher-server/0.1 (admin panel)";

export type ProjectType = "mod" | "shader" | "resourcepack";

export interface SearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  categories: string[];
  projectType: string;
}

export interface VersionFile {
  versionId: string;
  versionNumber: string;
  name: string;
  filename: string;
  url: string;
  sha1: string;
  size: number;
  gameVersions: string[];
  loaders: string[];
  dependencies: Array<{ projectId: string | null; versionId: string | null; type: string }>;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { "User-Agent": UA } });
  if (!response.ok) {
    throw new Error(`Modrinth ответил ${response.status} на ${path}`);
  }
  return (await response.json()) as T;
}

/** Шейдеры и ресурс-паки не привязаны к модлоадеру, фильтруем их только по версии игры. */
function buildFacets(type: ProjectType, minecraft: string, loader: string): string {
  const facets: string[][] = [[`project_type:${type}`]];
  if (minecraft) facets.push([`versions:${minecraft}`]);
  if (type === "mod" && loader && loader !== "vanilla") {
    // У Quilt почти всё работает через слой совместимости с Fabric.
    const loaders = loader === "quilt" ? ["quilt", "fabric"] : [loader];
    facets.push(loaders.map((item) => `categories:${item}`));
  }
  return JSON.stringify(facets);
}

export async function search(
  query: string,
  type: ProjectType,
  minecraft: string,
  loader: string,
  limit = 20
): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    index: query ? "relevance" : "downloads",
    facets: buildFacets(type, minecraft, loader),
  });

  const data = await request<{ hits: any[] }>(`/search?${params}`);
  return data.hits.map((hit) => ({
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url ?? null,
    downloads: hit.downloads ?? 0,
    categories: hit.categories ?? [],
    projectType: hit.project_type,
  }));
}

function mapVersion(version: any): VersionFile | null {
  const files: any[] = version.files ?? [];
  const file = files.find((item) => item.primary) ?? files[0];
  if (!file?.hashes?.sha1) return null;

  return {
    versionId: version.id,
    versionNumber: version.version_number,
    name: version.name,
    filename: file.filename,
    url: file.url,
    sha1: file.hashes.sha1,
    size: file.size ?? 0,
    gameVersions: version.game_versions ?? [],
    loaders: version.loaders ?? [],
    dependencies: (version.dependencies ?? []).map((dep: any) => ({
      projectId: dep.project_id ?? null,
      versionId: dep.version_id ?? null,
      type: dep.dependency_type,
    })),
  };
}

/** Версии проекта, подходящие под сборку. Свежие идут первыми. */
export async function versions(
  projectId: string,
  type: ProjectType,
  minecraft: string,
  loader: string
): Promise<VersionFile[]> {
  const params = new URLSearchParams();
  if (minecraft) params.set("game_versions", JSON.stringify([minecraft]));
  if (type === "mod" && loader && loader !== "vanilla") {
    const loaders = loader === "quilt" ? ["quilt", "fabric"] : [loader];
    params.set("loaders", JSON.stringify(loaders));
  }

  const raw = await request<any[]>(`/project/${projectId}/version?${params}`);
  const mapped = raw.map(mapVersion).filter((item): item is VersionFile => item !== null);

  if (mapped.length > 0) return mapped;

  // Иногда автор не проставил лоадер — показываем всё, что есть под эту версию игры.
  const fallbackParams = new URLSearchParams();
  if (minecraft) fallbackParams.set("game_versions", JSON.stringify([minecraft]));
  const fallback = await request<any[]>(`/project/${projectId}/version?${fallbackParams}`);
  return fallback.map(mapVersion).filter((item): item is VersionFile => item !== null);
}

export async function project(projectId: string): Promise<{
  id: string;
  title: string;
  slug: string;
  projectType: string;
  iconUrl: string | null;
}> {
  const data = await request<any>(`/project/${projectId}`);
  return {
    id: data.id,
    title: data.title,
    slug: data.slug,
    projectType: data.project_type,
    iconUrl: data.icon_url ?? null,
  };
}
