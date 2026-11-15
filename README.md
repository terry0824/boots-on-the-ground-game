# Boots on the Ground

**A fan-made shooter inspired by StarCraft II.**

> **Fan-made · Free · Non-commercial.** Boots on the Ground is a free, open fan project, inspired by StarCraft II and made by players who love it. It is not affiliated with or endorsed by Blizzard Entertainment. The game and everything you see and hear in it are the project's own. An optional plugin, the [StarCraft II loader](https://github.com/terry0824/boots-on-the-ground-sc2-loader), lets players who own StarCraft II borrow its content from their own copy. StarCraft, StarCraft II and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. Free for personal use; never to be sold or distributed for commercial use.

A squad shooter at true scale, in first and third person, in the browser. You're one soldier in a battle of hundreds. When your body falls, you rise above the battlefield and pick the next one: a rifleman at the ramp, a howitzer on the high ground, a warship overhead.

The world is the game's own. Harlan's Holdouts, a frontier militia of miners, ranchers and haulers, hold the line against the Crawl, an alien swarm, on the dry worlds of the Calder system. You fight beside Echo Squad: Sergeant Rourke, Private Vey, "Doc" Marrow and Corporal Briggs.

So is everything in it: the engine, the models, the music, the sounds, the story and the numbers. Some of it is still being made; plain stand-ins fill in until it is.

**This repository is the game's code.** Its own content (models, textures, music, voices, sound effects, icons, portraits) isn't here: it comes with the [ready build](#host-it-yourself), under [its own terms](#license).

## The StarCraft II loader

If you own StarCraft II, the [StarCraft II loader](https://github.com/terry0824/boots-on-the-ground-sc2-loader), a separate, optional plugin, lets the game borrow StarCraft II's models, sounds, music and maps from your own copy, with its names and story, and adds the missions that play on its maps. Your copy is read on your computer as you play: nothing is uploaded, copied or shared, and nothing connects to Battle.net. Your browser remembers which folder you picked, on your computer only.

The start page asks each time you open the game: **Play original (work in progress)**, the game's own content, or **Play with your StarCraft II installation** with the loader (**Continue with your StarCraft II installation** with the folder you picked last time). Moving between missions doesn't ask again. To try it straight away, open [the game's page](https://boots-on-the-ground.pages.dev): the game with the loader built in.

## Play

**In the browser:** open [the game's page](https://boots-on-the-ground.pages.dev) (Chrome or Edge; it needs WebGL 2). It's the game with the loader built in: choose **Play original (work in progress)**, or **Play with your StarCraft II installation** if you own it.

## Host it yourself

The [ready build](https://github.com/terry0824/boots-on-the-ground-sc2-loader/releases/latest) is the whole game, content and loader included, as a folder of plain files: unzip it and put the folder on any static web host (Cloudflare Pages, GitHub Pages, Netlify, or any web server). It needs HTTPS for the loader's folder picker; nothing runs on the server. Keep [its terms](#license) with it.

## From the source

Node.js 25 or later:

```bash
git clone https://github.com/terry0824/boots-on-the-ground-game.git
cd boots-on-the-ground-game
npm ci
npm run dev
```

Then open http://localhost:5173. Built from this source alone, the game plays with plain stand-ins and no music. To play your build with the game's own content, copy the ready build's `content/original/` folder over `public/content/original/`.

**With the loader:** put it in the game's `plugins` folder, as its README says, and run the game as above.

## What's in it

- **Hold the Line:** the stand on the plateau, three ramps, seven waves of the Crawl. More missions arrive as the game's own maps are made.
- **Six soldiers** to play, unlocked by rank: the Trooper, the Medic, the Grenadier, the Burner, the Vaulter and the Seer. Each has its own weapon and ability.
- **Machines** to drive and fly, a bunker to hold, and call-ins from orbit: a Skyscan, a Mender to patch the wounded machines, a Dustoff with a fireteam.
- **The command view:** scroll out of your body to see the whole battle, move the squads, and dive into any of them.
- **Progression:** rank, credits for the Armory's research, records and citations.

## Controls

| | |
|---|---|
| Mouse | Aim; left button fires, right button aims down the sights |
| W A S D | Move |
| Shift · Space | A Jolt (a Seer's Shroud too) · a Vaulter's jet pack |
| E | Your soldier's own: a Seer's Shroud, a Vaulter's jet pack; brace or unbrace a howitzer |
| Q | The Keel Gun on your crosshair (a Seer: its Warhead Strike) |
| Hold T | Call-ins: flick toward one, let go, click the ground |
| F | Garrison a bunker, take a howitzer, hold beside a downed squadmate |
| V | First or third person |
| Mouse wheel | Camera distance; keep scrolling out for the command view |
| Esc | Pause |

## Build

| Command | What it makes |
|---|---|
| `npm run dev` | the game, served on this computer |
| `npm run build` | the game, built into `dist/` for any web host |
| `npm run build:standalone` | the game in one HTML file, `dist-standalone/index.html` |

## License

The code is under the [PolyForm Noncommercial License 1.0.0](LICENSE): use it, change it and share it, for anything but commerce. Code from other projects is listed with its license in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The game's own content isn't open source and isn't in this repository: it comes with the ready build, which you may play, host and share free and unchanged, as its [LICENSE-CONTENT.md](LICENSE-CONTENT.md) says.

StarCraft, StarCraft II and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. This project is not affiliated with, endorsed or sponsored by Blizzard Entertainment.
