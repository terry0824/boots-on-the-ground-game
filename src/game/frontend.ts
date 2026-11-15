import { contentMode, keepContentMode, keepVisit, usesInstall, type ContentMode } from '../content/mode.ts';
import { shown, shownHtml } from '../content/names.ts';
import { hasPlugins } from '../content/plugins.ts';
import { UPGRADES } from './armory.ts';
import { BATTLE_SIZES, DIFFICULTY, fallbackMission, MISSIONS, sizeFor, type BattleSize, type BattleSizeId, type MissionDef } from './missions.ts';
import { NOTICE, NOTICE_ORIGINAL, NOTICE_SHORT, NOTICE_SHORT_ORIGINAL, NOTICE_TITLE, TAGLINE, noticeHtml } from './notice.ts';
import { PRESETS, QUALITY_PRESETS, RANKS, rankOf, rankProgress, record, saveProfile, type Profile, type Settings } from './profile.ts';
import { SUPPLY_CAP } from './systems/production.ts';

const html = String.raw;

export interface FrontendHooks {
  /** `size` for a mission that offers battle sizes. */
  launch(mission: string, difficulty: number, size?: BattleSizeId): void;
  settingsChanged(s: Settings): void;
  sound(kind: 'click' | 'hover' | 'select'): void;
}

type Screen = 'main' | 'campaign' | 'armory' | 'settings' | 'credits';

function stars(n: number): string {
  return [0, 1, 2].map((i) => `<i class="star${i < n ? ' on' : ''}">★</i>`).join('');
}

/** What a battle size means, in a line. */
function sizeLine(s: BattleSize): string {
  if (s.scale === 1) return `The enemy at its own size, and your army capped at the usual ${SUPPLY_CAP} supply.`;
  return `The enemy grows ${s.scale === 2 ? 'twice' : 'half again'} as large, and your army can be built up to ${SUPPLY_CAP * s.scale} supply to meet it.`;
}

/** A campaign mission's number in the story (1-based). */
function campaignNumber(m: MissionDef): number {
  return MISSIONS.filter((x) => x.act > 0 && x.id !== 'hold-the-line').indexOf(m) + 1;
}

/** A mission is open once the one before it is won. */
export function unlocked(p: Profile, m: MissionDef): boolean {
  return !m.requires || !!p.missions[m.requires]?.completed;
}

/** Whether the content can play it: a campaign map is the loader's, so without it only the procedural battlefield. */
export function playable(m: MissionDef): boolean {
  return usesInstall || !m.map;
}

/** Where the credits say the content comes from, by the content mode. */
const CREDITS_LINE: Record<ContentMode, string> = {
  sc2: "You're playing with the StarCraft II loader, an optional plugin: StarCraft II's models, textures, sounds, music and maps, borrowed from your own copy, read on your computer as you play, never copied, shared or published. The game itself, and its own content, are the project's (Settings · Content).",
  original:
    "You're playing the game on its own content: its own models, textures, sounds and music (plain stand-ins where nothing is made yet); nothing is read from StarCraft II. With your own copy, the StarCraft II loader, an optional plugin, can borrow StarCraft II's instead (Settings · Content).",
  mix: "You're playing with the game's own models, sounds and music where they're made, and, through the StarCraft II loader, StarCraft II's elsewhere, borrowed from your own copy: read on your computer as you play, never copied, shared or published.",
};

/** The content modes, as the Settings screen offers them. */
const CONTENT: { mode: ContentMode; label: string }[] = [
  { mode: 'sc2', label: 'StarCraft II (your install)' },
  { mode: 'original', label: 'Original (no StarCraft II)' },
  { mode: 'mix', label: 'Original where made, StarCraft II otherwise' },
];

/**
 * The game's menus, over the live battle: main menu, the campaign's missions with their
 * briefings and difficulty, the Armory, settings and credits.
 */
export class Frontend {
  private screen: Screen = 'main';
  private selected: string;
  private difficulty = 1;
  /** The battle size picked, for missions that offer one; until then, each mission's own default. */
  private size: BattleSizeId | null = null;
  readonly el: HTMLElement;

  constructor(
    root: HTMLElement,
    private profile: Profile,
    private hooks: FrontendHooks,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'frontend';
    root.appendChild(this.el);
    const firstOpen = MISSIONS.find((m) => m.act > 0 && unlocked(profile, m) && playable(m) && !profile.missions[m.id]?.completed);
    this.selected = firstOpen?.id ?? (MISSIONS.find(playable) ?? MISSIONS[0]).id;
    this.render();
  }

  /** The size `m` would be played at, if it offers sizes. */
  private sizeOf(m: MissionDef): BattleSize | null {
    return m.rules?.size ? sizeFor(m, this.size) : null;
  }

  show(on: boolean) {
    this.el.classList.toggle('show', on);
  }

  private go(screen: Screen) {
    this.screen = screen;
    this.hooks.sound('click');
    this.render();
  }

  private render() {
    const p = this.profile;
    const rank = rankOf(p.xp);
    const next = RANKS[Math.min(RANKS.length - 1, rank + 1)];
    // The callsign every profile starts with is the side's name: shown in the game's own (the profile keeps it as it was).
    const callsign = p.callsign === 'Raider' ? shown(p.callsign) : p.callsign;
    const badge = html`
      <div class="badge">
        <div class="callsign"><span class="rank">${RANKS[rank].name}</span> <input id="fe-callsign" value="${callsign}" maxlength="18" spellcheck="false" /></div>
        <div class="xpbar"><div style="width:${(rankProgress(p.xp) * 100).toFixed(1)}%"></div></div>
        <div class="xptext">${p.xp.toLocaleString()} XP${rank < RANKS.length - 1 ? ` · next: ${next.name} at ${next.xp.toLocaleString()}` : ''} · <b>${p.credits.toLocaleString()}</b> credits</div>
      </div>`;
    const nav = (id: Screen, label: string) => `<button class="nav${this.screen === id ? ' on' : ''}" data-go="${id}">${label}</button>`;
    let body = '';
    switch (this.screen) {
      case 'main':
        body = this.mainScreen();
        break;
      case 'campaign':
        body = this.campaignScreen();
        break;
      case 'armory':
        body = this.armoryScreen();
        break;
      case 'settings':
        body = this.settingsScreen();
        break;
      case 'credits':
        body = this.creditsScreen();
        break;
    }
    // The screens in the game's own names where the content mode asks (content/names.ts): all but
    // the notice and the credits, which name StarCraft II on purpose.
    this.el.innerHTML = html`
      <div class="fe-left">
        <div class="logo"><h1>BOOTS ON THE GROUND</h1><h2>${TAGLINE}</h2></div>
        ${badge}
        <div class="navs">
          ${nav('main', 'Command')}
          ${nav('campaign', 'Campaign')}
          ${nav('armory', 'Armory')}
          ${nav('settings', 'Settings')}
          ${nav('credits', 'Credits')}
        </div>
        ${noticeHtml(usesInstall ? NOTICE_SHORT : NOTICE_SHORT_ORIGINAL)}
      </div>
      <div class="fe-right">${this.screen === 'credits' ? body : shownHtml(body)}</div>`;
    this.wire();
  }

  private mainScreen(): string {
    const p = this.profile;
    const next =
      MISSIONS.find((m) => m.act > 0 && unlocked(p, m) && playable(m) && !p.missions[m.id]?.completed) ??
      fallbackMission();
    return html`
      <div class="fe-main">
      <div class="fe-hero panel">
        <div class="kicker">Next operation</div>
        <h2>${next.title} <span class="planet">${next.planet}</span></h2>
        <p>${next.summary}</p>
        <div class="row">
          <button class="cta" data-launch="${next.id}">Continue</button>
          <button class="quiet" data-go="campaign">All missions</button>
        </div>
      </div>
      ${this.specialPanel()}
      <div class="fe-tiles">
        ${this.missionTiles()}
        <div class="tile panel" data-go="armory">
          <div class="kicker">Research</div>
          <h3>Armory</h3>
          <p>${p.credits.toLocaleString()} credits to spend on the militia's upgrades.</p>
        </div>
      </div>
      <div class="fe-stats">
        <span><b>${p.stats.missions}</b> missions</span>
        <span><b>${p.stats.kills.toLocaleString()}</b> kills</span>
        <span><b>${p.stats.shots ? Math.round((p.stats.hits / p.stats.shots) * 100) : 0}%</b> accuracy</span>
        <span><b>${Math.round(p.stats.playSeconds / 60)}</b> minutes in the field</span>
      </div>
      </div>`;
  }

  /** The modes beside the campaign that have a tile of their own (\`MissionDef.tile\`), unless taken off the menus (\`hidden\`). */
  private missionTiles(): string {
    return MISSIONS.filter((m) => m.tile && !m.hidden)
      .sort((a, b) => a.tile!.order - b.tile!.order)
      .map(
        (m) => html`
        <div class="tile panel${m.tile!.className ? ` ${m.tile!.className}` : ''}" data-launch="${m.id}">
          <div class="kicker">${m.tile!.kicker}</div>
          <h3>${m.tile!.title}</h3>
          <p>${m.tile!.text(this.profile)}</p>
        </div>`,
      )
      .join('');
  }

  /** Where the content comes from (a plugin's, the game's own), where this build has a plugin to choose. */
  private contentSetting(): string {
    return html`
        <h4>Content</h4>
        <label class="set"><span>Models, sounds and music</span><select data-content>${CONTENT.map((c) => `<option value="${c.mode}" ${c.mode === contentMode ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <div class="fine">Takes effect as the game restarts. On the game's own content, only what plays on its own battlefield (Hold the Line) can be played, and stand-ins are drawn where a model isn't made yet.</div>`;
  }

  /** The special operation: apart from the campaign, open from the start, on its own banner. */
  private specialPanel(): string {
    const m = MISSIONS.find((x) => x.kind === 'tide');
    if (!m) return '';
    const r = this.profile.missions[m.id];
    const best = r?.completed ? `<span class="best">Held: ${stars(r.stars)} · ${DIFFICULTY[Math.max(0, r.difficulty)].name}</span>` : '';
    const size = this.sizeOf(m);
    const chips =
      !size || size.scale === 1
        ? ['200 vs 200 supply', 'A swarm without end']
        : [`${size.name}: build from 200 to ${SUPPLY_CAP * size.scale} supply`, `A swarm ${size.scale === 2 ? 'twice' : 'half again'} as large`];
    return html`
      <div class="fe-special panel">
        <div class="kicker">Special operation · Outside the campaign</div>
        <h3>${m.title} <span class="planet">${m.planet}</span></h3>
        <p>${m.summary}</p>
        <div class="chips">${[...chips, 'Fall, and go again from the Barracks'].map((c) => `<span>${c}</span>`).join('')}</div>
        <div class="row">
          <button class="cta" data-launch="${m.id}">Deploy · ${DIFFICULTY[this.difficulty].name}${size ? ` · ${size.name}` : ''}</button>
          <button class="quiet" data-brief="${m.id}">Briefing, difficulty${size ? ' &amp; size' : ''}</button>
          ${best}
        </div>
      </div>`;
  }

  private campaignScreen(): string {
    const p = this.profile;
    const cards = MISSIONS.filter((m) => !m.hidden).map((m, i) => {
      const open = unlocked(p, m) && playable(m);
      const r = p.missions[m.id];
      return html`
        <div class="mcard panel${m.id === this.selected ? ' on' : ''}${open ? '' : ' locked'}" data-pick="${m.id}" data-i="${i}">
          <div class="mnum">${m.kind === 'practice' ? 'Practice' : m.experimental ? 'Experimental' : m.kind === 'tide' ? 'Special Operation' : m.kind === 'frontline' ? 'Frontline' : m.kind === 'survival' ? 'Survival' : m.id === 'hold-the-line' ? 'Skirmish' : `Mission ${campaignNumber(m)}${m.finale ? ' · Finale' : ''}`}</div>
          <div class="mtitle">${m.title}</div>
          <div class="mplanet">${m.planet}</div>
          <div class="mstars">${open ? stars(r?.stars ?? 0) + (m.kind === 'survival' && p.lastStandBest ? ` <span class="wave">wave ${p.lastStandBest}</span>` : '') : `<span class="lock">${playable(m) ? 'Locked' : 'Needs the StarCraft II loader'}</span>`}</div>
        </div>`;
    }).join('');
    const m = MISSIONS.find((x) => x.id === this.selected)!;
    const open = unlocked(p, m) && playable(m);
    const r = record(p, m.id);
    const diffs = DIFFICULTY.map((d, i) => `<button class="diff${i === this.difficulty ? ' on' : ''}" data-diff="${i}">${d.name}</button>`).join('');
    const size = this.sizeOf(m);
    const sizes = size
      ? html`
          <h4>Battle size</h4>
          <div class="diffs">${BATTLE_SIZES.map((s) => `<button class="diff${s.id === size.id ? ' on' : ''}" data-size="${s.id}">${s.name}</button>`).join('')}</div>
          <div class="fine">${sizeLine(size)}</div>`
      : '';
    const objectives = m.objectives
      .filter((o) => !o.hidden)
      .map((o) => `<li class="${o.bonus ? 'bonus' : ''}${r.bonus.includes(o.id) ? ' done' : ''}">${o.bonus ? '<b>Bonus</b> ' : ''}${o.text}</li>`)
      .join('');
    return html`
      <div class="fe-campaign">
        <div class="mlist">${cards}</div>
        <div class="mdetail panel">
          <div class="kicker">${m.planet} · ${m.kind === 'practice' ? 'Practice · Experimental' : m.experimental ? 'Experimental' : ({ defense: 'Defense', survival: 'Survival', training: 'Training', assault: 'Assault', frontline: 'Frontline', escort: 'Escort', daynight: 'Day & Night', tide: 'Special Operation', practice: 'Practice' } as const)[m.kind]}</div>
          <h2>${m.title}</h2>
          <div class="brief">
            <div class="speaker">${m.briefing.speaker}</div>
            ${m.briefing.lines.map((l) => `<p>“${l}”</p>`).join('')}
          </div>
          <h4>Objectives</h4>
          <ul class="objs">${objectives}</ul>
          <h4>Difficulty</h4>
          <div class="diffs">${diffs}</div>
          ${sizes}
          <div class="row">
            <button class="cta" data-launch="${m.id}" ${open ? '' : 'disabled'}>${open ? 'Launch mission' : !playable(m) ? 'Needs the StarCraft II loader (Settings · Content)' : `Complete ${MISSIONS.find((x) => x.id === m.requires)?.title} first`}</button>
            ${
              // Survival is never won: its record is how far it went.
              m.kind === 'survival'
                ? this.profile.lastStandBest
                  ? `<span class="best">Best: wave ${this.profile.lastStandBest} ${stars(r?.stars ?? 0)}</span>`
                  : ''
                : r?.completed
                  ? `<span class="best">Best: ${stars(r.stars)}${r.bestTime ? ` · ${Math.floor(r.bestTime / 60)}:${String(Math.floor(r.bestTime % 60)).padStart(2, '0')}` : ''}</span>`
                  : ''
            }
          </div>
          ${m.reward.credits ? `<div class="fine">Pays ${m.reward.xp} XP and ${m.reward.credits} credits, scaled by difficulty, plus what you earn in the field.</div>` : ''}
        </div>
      </div>`;
  }

  private armoryScreen(): string {
    const p = this.profile;
    const rank = rankOf(p.xp);
    const rows = UPGRADES.map((u) => {
      const level = p.upgrades[u.id] ?? 0;
      const max = u.cost.length;
      const cost = u.cost[level];
      const needRank = u.rank[level];
      const can = level < max && p.credits >= cost && rank >= needRank;
      const pips = Array.from({ length: max }, (_, i) => `<i class="pip${i < level ? ' on' : ''}"></i>`).join('');
      const action =
        level >= max
          ? '<span class="maxed">Researched</span>'
          : rank < needRank
            ? `<span class="need">Needs ${RANKS[needRank].name}</span>`
            : `<button class="buy" data-buy="${u.id}" ${can ? '' : 'disabled'}>${cost} credits</button>`;
      return html`
        <div class="upg panel">
          <div class="upg-head"><h3>${u.name}</h3><div class="pips">${pips}</div></div>
          <p>${u.desc}</p>
          <div class="upg-action">${action}</div>
        </div>`;
    }).join('');
    return html`
      <div class="fe-armory">
        <div class="kicker">The Armory · ${p.credits.toLocaleString()} credits</div>
        <h2>Research</h2>
        <p class="lead">The militia's own upgrades, each level a fixed step. Research applies to every unit on your side, in every mission.</p>
        <div class="upgs">${rows}</div>
      </div>`;
  }

  private settingsScreen(): string {
    const s = this.profile.settings;
    const slider = (id: string, label: string, value: number, min: number, max: number, step: number) =>
      html`<label class="set"><span>${label}</span><input type="range" data-set="${id}" min="${min}" max="${max}" step="${step}" value="${value}" /><output>${value}</output></label>`;
    const toggle = (id: string, label: string, on: boolean) => html`<label class="set"><span>${label}</span><input type="checkbox" data-set="${id}" ${on ? 'checked' : ''} /></label>`;
    const select = (id: string, label: string, value: number, options: readonly string[]) =>
      `<label class="set"><span>${label}</span><select data-set="${id}">${options.map((o, i) => `<option value="${i}" ${i === value ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    return html`
      <div class="fe-settings panel">
        <h2>Settings</h2>
        <h4>Controls</h4>
        ${slider('sensitivity', 'Mouse sensitivity', s.sensitivity, 0.2, 3, 0.05)}
        ${toggle('invertY', 'Invert mouse Y', s.invertY)}
        ${slider('fov', 'Field of view', s.fov, 60, 100, 1)}
        <h4>Audio</h4>
        ${slider('volume.master', 'Master', s.volume.master, 0, 1, 0.05)}
        ${slider('volume.music', 'Music', s.volume.music, 0, 1, 0.05)}
        ${slider('volume.sfx', 'Effects', s.volume.sfx, 0, 1, 0.05)}
        ${slider('volume.voice', 'Voices', s.volume.voice, 0, 1, 0.05)}
        ${slider('volume.ambience', 'Ambience', s.volume.ambience, 0, 1, 0.05)}
        <h4>Graphics</h4>
        ${select('quality', 'Quality', s.quality, [...QUALITY_PRESETS, 'Custom'])}
        ${select('graphics.shadows', 'Shadows', s.graphics.shadows, ['Off (soft ground shadows)', 'Low', 'Medium', 'High'])}
        ${select('graphics.particles', 'Particles', s.graphics.particles, ['Low', 'Medium', 'High'])}
        ${select('graphics.effects', 'Post effects', s.graphics.effects, ['Off', 'On (bloom, grade, multisampling)'])}
        ${select('graphics.resolution', 'Resolution', s.graphics.resolution, ['75%', '100%', 'High-density ×1.5', 'High-density ×2'])}
        <h4>Accessibility</h4>
        ${toggle('colorblind', 'Colorblind-safe hit markers', s.colorblind)}
        ${hasPlugins() ? this.contentSetting() : ''}
      </div>`;
  }

  private creditsScreen(): string {
    return html`
      <div class="fe-credits panel">
        <h2>Credits</h2>
        <h4>${NOTICE_TITLE}</h4>
        <p>${usesInstall ? NOTICE : NOTICE_ORIGINAL}</p>
        <p>${CREDITS_LINE[contentMode]}</p>
      </div>`;
  }

  private wire() {
    const el = this.el;
    el.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => (b.onclick = () => this.go(b.dataset.go as Screen)));
    el.querySelectorAll<HTMLElement>('[data-launch]').forEach((b) => {
      const def = MISSIONS.find((x) => x.id === b.dataset.launch);
      if (def && !playable(def)) {
        b.classList.add('locked');
        b.title = 'Needs the StarCraft II loader (Settings · Content)';
      }
      b.onclick = () => {
        const id = b.dataset.launch!;
        const m = MISSIONS.find((x) => x.id === id);
        if (!m || !unlocked(this.profile, m) || !playable(m)) return;
        this.hooks.sound('select');
        this.hooks.launch(id, this.difficulty, this.sizeOf(m)?.id);
      };
    });
    el.querySelectorAll<HTMLElement>('[data-brief]').forEach((b) => {
      b.onclick = () => {
        this.selected = b.dataset.brief!;
        this.go('campaign');
      };
    });
    el.querySelectorAll<HTMLElement>('[data-pick]').forEach((b) => {
      b.onclick = () => {
        this.selected = b.dataset.pick!;
        this.hooks.sound('click');
        this.render();
      };
    });
    el.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) => {
      b.onclick = () => {
        this.difficulty = Number(b.dataset.diff);
        this.hooks.sound('click');
        this.render();
      };
    });
    el.querySelectorAll<HTMLElement>('[data-size]').forEach((b) => {
      b.onclick = () => {
        this.size = b.dataset.size as BattleSizeId;
        this.hooks.sound('click');
        this.render();
      };
    });
    el.querySelectorAll<HTMLElement>('[data-buy]').forEach((b) => {
      b.onclick = () => {
        const u = UPGRADES.find((x) => x.id === b.dataset.buy)!;
        const p = this.profile;
        const level = p.upgrades[u.id] ?? 0;
        const cost = u.cost[level];
        if (level >= u.cost.length || p.credits < cost) return;
        p.credits -= cost;
        p.upgrades[u.id] = level + 1;
        saveProfile(p);
        this.hooks.sound('select');
        this.render();
      };
    });
    el.querySelectorAll<HTMLElement>('button, .tile, .mcard').forEach((b) => b.addEventListener('mouseenter', () => this.hooks.sound('hover')));
    const content = el.querySelector<HTMLSelectElement>('[data-content]');
    if (content) {
      content.onchange = () => {
        // Kept for next time and for the rest of the visit, and the game restarted on it (the address's own
        // choice let go).
        keepContentMode(content.value as ContentMode);
        keepVisit(content.value as ContentMode);
        const url = new URL(location.href);
        url.searchParams.delete('content');
        location.href = url.toString();
      };
    }
    const callsign = el.querySelector<HTMLInputElement>('#fe-callsign');
    if (callsign) {
      callsign.onchange = () => {
        this.profile.callsign = callsign.value.trim().slice(0, 18) || 'Holdout';
        saveProfile(this.profile);
      };
      callsign.onkeydown = (e) => e.stopPropagation();
    }
    el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((input) => {
      input.oninput = input.onchange = () => {
        const s = this.profile.settings;
        const key = input.dataset.set!;
        const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : Number(input.value);
        if (key.startsWith('volume.')) s.volume[key.slice(7) as keyof Settings['volume']] = value as number;
        else if (key.startsWith('graphics.')) {
          // A detail changed by hand: the preset becomes Custom.
          s.graphics[key.slice(9) as keyof Settings['graphics']] = value as number;
          s.quality = PRESETS.findIndex((p) => JSON.stringify(p) === JSON.stringify(s.graphics));
          if (s.quality < 0) s.quality = PRESETS.length;
        } else if (key === 'quality') {
          s.quality = value as number;
          if (PRESETS[s.quality]) s.graphics = { ...PRESETS[s.quality] };
        } else (s as unknown as Record<string, unknown>)[key] = value;
        const out = input.parentElement?.querySelector('output');
        if (out) out.textContent = String(value);
        saveProfile(this.profile);
        this.hooks.settingsChanged(s);
        // The preset and its details show each other's changes.
        if (key === 'quality' || key.startsWith('graphics.')) this.render();
      };
    });
  }
}
