import { ICON_NAMES, type IconName } from '../content/assetnames.ts';
import { usesPack } from '../content/mode.ts';
import { pack, packUrl } from '../content/pack.ts';
import { provider } from '../content/provider.ts';

export type { IconName };

/** An icon's address: the game's own pack's (a PNG) where it has one, else the provider's, or null if neither has it. */
export function iconUrl(name: IconName): Promise<string | null> {
  const own = usesPack ? pack().icons[name] : undefined;
  if (own) return Promise.resolve(packUrl(own));
  return provider()?.icon(name) ?? Promise.resolve(null);
}

/** Every icon, by name. */
export async function loadIcons(): Promise<Partial<Record<IconName, string>>> {
  const urls = await Promise.all(ICON_NAMES.map((n) => iconUrl(n)));
  const out: Partial<Record<IconName, string>> = {};
  ICON_NAMES.forEach((n, i) => {
    if (urls[i]) out[n] = urls[i]!;
  });
  return out;
}
