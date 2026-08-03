export type LoaderKind = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";
export type ContentKind = "mod" | "shader" | "resourcepack" | "config" | "other";
export type ProjectType = "mod" | "shader" | "resourcepack";

export interface Mode {
  id: string;
  name: string;
  description: string;
  version: string | null;
  icon: string | null;
  banner: string | null;
  minecraft: string;
  loaderType: LoaderKind;
  loaderVersion: string | null;
  javaMajor: number | null;
  memoryMin: number | null;
  memoryMax: number | null;
  serverHost: string | null;
  serverPort: number | null;
  jvmArgs: string | null;
  syncPaths: string[];
  keep: string[];
  visible: boolean;
  sortOrder: number;
}

export interface ModeSummary extends Mode {
  filesCount: number;
  updatedAt: string;
  manifestUrl: string;
}

export interface ModeFile {
  id: number;
  path: string;
  kind: ContentKind;
  url: string;
  sha1: string;
  size: number;
  optional: boolean;
  source: "upload" | "modrinth" | "url";
  meta: { projectId?: string; title?: string; iconUrl?: string; versionNumber?: string } | null;
}

export interface ModeDetail extends Mode {
  files: ModeFile[];
}

export interface SearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  categories: string[];
}

export interface VersionFile {
  versionId: string;
  versionNumber: string;
  name: string;
  filename: string;
  size: number;
  gameVersions: string[];
  loaders: string[];
}

const TOKEN_KEY = "gandoni-admin-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`/api${path}`, { ...init, headers });
  if (response.status === 401) {
    setToken(null);
    throw new ApiError("Сессия истекла, войдите заново", 401);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? "Ошибка запроса", response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  login: async (password: string) => {
    const data = await request<{ token: string }>("/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setToken(data.token);
    return data.token;
  },
  logout: async () => {
    await request("/logout", { method: "POST" }).catch(() => undefined);
    setToken(null);
  },
  session: () => request<{ ok: boolean }>("/session"),

  minecraftVersions: () =>
    request<Array<{ id: string; type: string; releaseTime: string }>>("/minecraft/versions"),
  loaderVersions: (loader: string, minecraft: string) =>
    request<string[]>(
      `/loader/versions?loader=${encodeURIComponent(loader)}&minecraft=${encodeURIComponent(minecraft)}`
    ),

  modes: () => request<ModeSummary[]>("/modes"),
  mode: (id: string) => request<ModeDetail>(`/modes/${id}`),
  createMode: (mode: Partial<Mode>) =>
    request<Mode>("/modes", { method: "POST", body: JSON.stringify(mode) }),
  saveMode: (id: string, mode: Partial<Mode>) =>
    request<Mode>(`/modes/${id}`, { method: "PUT", body: JSON.stringify(mode) }),
  deleteMode: (id: string) => request<{ ok: true }>(`/modes/${id}`, { method: "DELETE" }),
  duplicateMode: (id: string, newId: string, name?: string) =>
    request<Mode>(`/modes/${id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ id: newId, name }),
    }),

  uploadFiles: (id: string, kind: ContentKind, files: FileList | File[]) => {
    const form = new FormData();
    for (const file of Array.from(files)) form.append("files", file);
    return request<{ added: Array<{ path: string; size: number }> }>(
      `/modes/${id}/files/upload?kind=${kind}`,
      { method: "POST", body: form }
    );
  },
  addFromModrinth: (
    id: string,
    payload: {
      projectId: string;
      versionId?: string;
      type: ProjectType;
      withDependencies: boolean;
    }
  ) =>
    request<{ added: string[] }>(`/modes/${id}/files/modrinth`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteFile: (id: string, fileId: number) =>
    request<{ ok: true }>(`/modes/${id}/files/${fileId}`, { method: "DELETE" }),
  setOptional: (id: string, fileId: number, optional: boolean) =>
    request<{ ok: true }>(`/modes/${id}/files/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify({ optional }),
    }),

  searchModrinth: (params: {
    q: string;
    type: ProjectType;
    minecraft: string;
    loader: string;
  }) =>
    request<SearchHit[]>(
      `/modrinth/search?${new URLSearchParams({
        q: params.q,
        type: params.type,
        minecraft: params.minecraft,
        loader: params.loader,
      })}`
    ),
  modrinthVersions: (params: {
    projectId: string;
    type: ProjectType;
    minecraft: string;
    loader: string;
  }) =>
    request<VersionFile[]>(
      `/modrinth/versions?${new URLSearchParams({
        projectId: params.projectId,
        type: params.type,
        minecraft: params.minecraft,
        loader: params.loader,
      })}`
    ),
};

export function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const KIND_LABELS: Record<ContentKind, string> = {
  mod: "Моды",
  shader: "Шейдеры",
  resourcepack: "Ресурс-паки",
  config: "Конфиги",
  other: "Прочие файлы",
};
