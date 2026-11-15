// What the game says about itself wherever it introduces itself (the loading card, the menus,
// the credits, the web build's front door, the server's console): a free fan project inspired by
// StarCraft II, its content its own, with none of Blizzard's files in it; the StarCraft II loader,
// an optional plugin, can borrow them from the player's own copy, their trademarks and assets
// theirs. The packaging READMEs and the repository's README carry the same words.

export const TAGLINE = 'A fan-made shooter inspired by StarCraft II';

export const NOTICE_TITLE = 'Fan-made · Free · Non-commercial';

/**
 * The full notice where the StarCraft II loader's content is in use (content modes `sc2` and `mix`):
 * for the loading card, the credits, the web build's front door and the server's console.
 */
export const NOTICE =
  'Boots on the Ground is a free, open fan project, inspired by StarCraft II and made by players who love it. It is not affiliated with or ' +
  'endorsed by Blizzard Entertainment. The game is the project\'s own; with the StarCraft II loader, an optional plugin, it borrows StarCraft II\'s ' +
  'models, sounds, music, maps and names from a copy you own, read on your computer as you play and never copied, shared or published. ' +
  'StarCraft, StarCraft II and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc., and StarCraft II\'s ' +
  'assets and characters are its intellectual property. Free for personal use; never to be sold or distributed for commercial use.';

/** A shorter one, where there's less room (the menu's side column). */
export const NOTICE_SHORT =
  'A free fan project inspired by StarCraft II, not affiliated with Blizzard Entertainment. The StarCraft II loader, an optional plugin, borrows ' +
  'StarCraft II\'s assets from your own copy; they are the trademarks and intellectual property of Blizzard Entertainment, Inc., and none come ' +
  'with this game. Never to be sold or distributed for commercial use.';

/**
 * The same, for the game on its own content (content mode `original`, the default): nothing is read from a plugin,
 * and the game's own names and story are the ones shown.
 */
export const NOTICE_ORIGINAL =
  'Boots on the Ground is a free, open fan project, inspired by StarCraft II and made by players who love it. It is not affiliated with or ' +
  'endorsed by Blizzard Entertainment. The game and everything you see and hear in it are the project\'s own. An optional plugin, the ' +
  'StarCraft II loader, lets players who own StarCraft II borrow its content from their own copy. StarCraft, StarCraft II and Blizzard ' +
  'Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. Free for personal use; never to be sold or ' +
  'distributed for commercial use.';

export const NOTICE_SHORT_ORIGINAL =
  'A free fan project inspired by StarCraft II, not affiliated with Blizzard Entertainment. Everything in this game is the project\'s own; ' +
  'the optional StarCraft II loader can borrow StarCraft II\'s content from your own copy. StarCraft II is a trademark of Blizzard ' +
  'Entertainment, Inc. Never to be sold or distributed for commercial use.';

/** The notice as HTML: a heading and the text, in the `.notice` style (hud.css). */
export function noticeHtml(text = NOTICE): string {
  return `<div class="notice"><b>${NOTICE_TITLE}</b>${text}</div>`;
}
