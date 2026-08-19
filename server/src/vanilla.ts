/**
 * Стандартные скины Minecraft.
 *
 * Их Mojang раздаёт бесплатно всем игрокам и держит на своём CDN, поэтому
 * ничего не копируем — просто ссылаемся. Кому какой достанется, решает id
 * аккаунта: как и в игре, выбор постоянный, а не новый на каждый заход.
 */

export interface VanillaSkin {
  name: string;
  model: "classic" | "slim";
  url: string;
}

const CDN = "https://textures.minecraft.net/texture/";

const SKINS: VanillaSkin[] = [
  {
    name: "Steve",
    model: "classic",
    url: `${CDN}1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b`,
  },
  {
    name: "Alex",
    model: "slim",
    url: `${CDN}46acd06e8483b176e8ea39fc12fe105eb3a2a4970f5100057e9d84d4b60bdfa7`,
  },
];

/** Домен CDN — его нужно разрешить в метаданных Yggdrasil, иначе игра не возьмёт текстуру. */
export const VANILLA_DOMAIN = ".minecraft.net";

/** Стандартный скин для того, кто своего не надел. */
export function vanillaSkin(accountId: string): VanillaSkin {
  let sum = 0;
  for (let i = 0; i < accountId.length; i += 1) sum = (sum * 31 + accountId.charCodeAt(i)) >>> 0;
  return SKINS[sum % SKINS.length];
}
