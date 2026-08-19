/**
 * Аватарка новичка — случайный игровой предмет с mc-icons.com.
 *
 * Поиск там отдаёт до двадцати совпадений по алфавиту, поэтому запрос одной
 * буквой каждый раз приносит одни и те же лодки. Спрашиваем по случайному
 * слову из списка ходовых — так выбор получается разным.
 */

const HINTS = [
  "ingot", "sword", "apple", "pearl", "star", "book", "potion", "cake",
  "torch", "bucket", "shovel", "pickaxe", "boat", "arrow", "egg", "shell",
  "flower", "rod", "gem", "dust", "seed", "disc", "helmet", "bow", "axe",
  "carrot", "bread", "fish", "key", "lantern", "map", "shield", "berry",
];

/** Если сервис недоступен — берём из своего набора, он всегда под рукой. */
const FALLBACK = [
  "diamond", "emerald", "golden_apple", "ender_pearl", "netherite_ingot",
  "cake", "torch", "tnt", "compass", "clock", "bucket", "nether_star",
  "totem_of_undying", "blaze_rod", "amethyst_shard", "cookie",
];

interface SearchResult {
  results?: Array<{ id: string; type: string }>;
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function iconUrl(id: string): string {
  return `https://mc-icons.com/thumbs/${id}.png`;
}

/** Возвращает id предмета. Ошибку наружу не выпускает: аватарка не повод падать. */
export async function randomItemIcon(): Promise<string> {
  try {
    const response = await fetch(
      `https://mc-icons.com/api/v1/search?q=${encodeURIComponent(pick(HINTS))}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return pick(FALLBACK);

    const data = (await response.json()) as SearchResult;
    // Блоки отсеиваем: просили предмет, да и мелкие спрайты читаются лучше.
    const items = (data.results ?? []).filter((entry) => entry.type === "item");
    return items.length ? pick(items).id : pick(FALLBACK);
  } catch {
    return pick(FALLBACK);
  }
}
