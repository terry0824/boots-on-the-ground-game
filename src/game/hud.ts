import * as THREE from 'three';
import type { AvatarHud } from './avatar.ts';
import type { CapturePoint } from './capture.ts';
import type { CallInState } from './callins.ts';
import { iconUrl, type IconName } from './icons.ts';
import { toMinimap, type MinimapFrame } from './minimap.ts';
import type { Phase } from './mission.ts';
import { NOTICE, NOTICE_ORIGINAL, TAGLINE, noticeHtml } from './notice.ts';
import { usesInstall } from '../content/mode.ts';
import { shown, shownHtml, shownLoading } from '../content/names.ts';
import type { World } from './world.ts';

export interface ObjectiveState {
  wave: number;
  totalWaves: number;
  enemies: number;
  /** The base's Holdfast, if the mission has one. */
  base: { hp: number; max: number; label?: string } | null;
  phase: Phase;
  countdown: number;
  /** Replaces the wave count (scripted missions say what to do next). */
  status?: string;
}

export type HudMode = 'title' | 'ground' | 'command' | 'menu';

export interface BriefingCard {
  kicker: string;
  title: string;
  speaker: string;
  lines: string[];
  objectives: { text: string; bonus?: boolean }[];
  /** The controls as this mission plays them: each key and what it does. */
  keys: [string, string][];
}

export interface Debrief {
  victory: boolean;
  /** Echo Squad's roll call: who came home. */
  squad?: { name: string; state: 'up' | 'down' | 'kia'; note: string }[];
  /** Citations earned this mission. */
  citations?: { name: string; why: string }[];
  /** A few lines of story after the mission, by who says them. */
  story?: { speaker: string; line: string }[];
  kicker: string;
  title: string;
  sub: string;
  stars: number;
  objectives: { text: string; state: 'active' | 'done' | 'failed'; bonus?: boolean }[];
  stats: [string, string][];
  rewards: [string, string][];
  xp: number;
  credits: number;
  rankName: string;
  promoted: boolean;
  /** Progress through the rank before and after, 0..1. */
  rankFrom: number;
  rankTo: number;
  next: boolean;
}

const html = String.raw;

export class Hud {
  private el: Record<string, HTMLElement> = {};
  private messageTimer = 0;
  private hitTimer = 0;
  private hurtLevel = 0;
  private minimap: CanvasRenderingContext2D;
  private mapTimer = 0;
  private txTimer = 0;
  private hintTimer = 0;
  /** Kill markers in amber rather than red. */
  colorblind = false;
  readonly overlay: HTMLCanvasElement;

  constructor(root: HTMLElement) {
    // In the game's own names where the content mode asks (content/names.ts), all but the notice,
    // which names StarCraft II on purpose.
    root.innerHTML = shownHtml(html`
      <canvas id="overlay2d"></canvas>
      <div id="slit" class="ground-only"><div class="port"></div></div>
      <div id="vignette"></div>
      <div id="fade"></div>
      <div id="joltfx"></div>
      <div id="crosshair" class="rifle">
        <i class="h" id="ch-l"></i><i class="h" id="ch-r"></i><i class="v" id="ch-t"></i><i class="v" id="ch-b"></i><i class="dot"></i><i class="ring"></i>
      </div>
      <div id="hitmarker"><i></i><i></i><i></i><i></i></div>
      <div id="aimnote" class="ground-only"></div>
      <div id="waypoint"><div class="wp-arrow"></div><div class="wp-diamond"></div><div class="wp-label" id="wp-label"></div><div class="wp-dist" id="wp-dist"></div></div>
      <div id="dmgdir" class="ground-only"></div>
      <div id="xpfeed" class="ground-only"></div>
      <div id="objective" class="panel">
        <div class="title" id="obj-title">Hold the Line · Calder</div>
        <div class="status" id="status"></div>
        <div class="hint" id="obj-hint"></div>
        <div class="bar"><div id="cc-bar"></div></div>
        <div class="cc" id="cc-label">COMMAND CENTER</div>
        <ul id="obj-list"></ul>
      </div>
      <div id="transmission" class="panel"><div class="portrait" id="tx-portrait"></div><div class="tx-text"><div class="tx-speaker" id="tx-speaker"></div><div class="tx-line" id="tx-line"></div></div></div>
      <div id="vitals" class="panel ground-only">
        <div class="label"><span id="avatar-title">Trooper</span><span class="hp-num" id="hp-num"></span></div>
        <div class="bar"><div id="hp-bar"></div></div>
        <div id="bars"></div>
      </div>
      <div id="prompt" class="ground-only"></div>
      <div id="radial" class="ground-only"><div class="rd-ring"></div><div id="rd-items"></div><div class="rd-center" id="rd-center"></div></div>
      <div id="callstrip" class="ground-only"><div class="cs-energy"><div id="cs-fill"></div><span id="cs-energy"></span></div><div id="cs-items"></div><div class="cs-hint" id="cs-hint"><b>T</b> call-ins</div></div>
      <div id="console" class="panel command-only">
        <div class="console-title">Command</div>
        <div id="selection">Nothing selected</div>
        <div class="classes small" id="console-classes"></div>
        <div class="deploys" id="console-deploys"></div>
        <div class="console-keys">
          <span><b>Drag</b> select</span><span><b>Right-click</b> move</span><span><b>Double-click / P</b> take control</span>
          <span><b>E</b> siege / unsiege</span><span><b>B</b> Warship</span><span><b>R</b> <span id="redeploy">redeploy a Trooper</span></span><span><b>WASD / edges</b> pan · <b>wheel</b> zoom (all the way in to dive)</span>
        </div>
      </div>
      <div id="minimap" class="panel"><canvas width="400" height="400"></canvas></div>
      <div id="echo" class="ground-only"><div class="ec-title">Echo Squad</div><div id="ec-rows"></div></div>
      <div id="capture"><div class="cap-name" id="cap-name"></div><div class="cap-bar"><div id="cap-fill"></div></div></div>
      <div id="warbar"><div class="wb-score"><span class="r" id="wb-r">0</span><div class="wb-bar"><div class="r" id="wb-rbar"></div><div class="d" id="wb-dbar"></div></div><span class="d" id="wb-d">0</span></div><div class="wb-bases" id="wb-bases"></div></div>
      <div id="meter"><div class="mt-label" id="mt-label"></div><div class="mt-bar"><div id="mt-fill"></div><div class="mt-ticks" id="mt-ticks"></div></div><div class="mt-text" id="mt-text"></div></div>
      <div id="boss"><div class="bs-name" id="bs-name"></div><div class="bs-bar"><div id="bs-fill"></div></div><div class="bs-sub" id="bs-sub"></div></div>
      <div id="killfeed"></div>
      <div id="message"><div class="big" id="msg-big"></div><div class="sub" id="msg-sub"></div></div>
      <div id="signal" class="overlay"><div class="static"></div><div class="card"><h1>SIGNAL LOST</h1><h2 id="killer">Rerouting to command</h2></div></div>
      <div id="title" class="overlay show"><div class="card panel wide">
        <div id="title-body">
          <h1>BOOTS ON THE GROUND</h1>
          <h2>${TAGLINE}</h2>
        </div>
        <div class="classes" id="title-classes"></div>
        <div class="progress"><div id="load-bar"></div></div>
        <div class="loading-label" id="load-label">Loading…</div>
        <button class="cta" id="deploy" disabled>Deploy</button>
        <div id="title-notice"></div>
      </div></div>
      <div id="pause" class="overlay"><div class="card panel">
        <h1>PAUSED</h1>
        <h2 id="pause-sub">Mission</h2>
        <p class="pause-note" id="pause-note"></p>
        <div class="col">
          <button class="cta" id="resume">Resume</button>
          <button class="quiet" id="restart">Restart mission</button>
          <button class="quiet" id="quit">Quit to menu</button>
        </div>
      </div></div>
      <div id="resumeHint"><b>Paused</b>Click to resume · <b>Esc</b> for the menu</div>
      <div id="end" class="overlay"><div class="card panel wide debrief" id="debrief"></div></div>
    `);
    // The notice goes in after the names are applied, as written (ownHtml would translate it). An element, not a
    // comment, marks its place: the web build's packer can't carry `<!--` inside a script (vite.standalone.config.ts).
    root.querySelector('#title-notice')!.outerHTML = noticeHtml(usesInstall ? NOTICE : NOTICE_ORIGINAL);
    for (const node of root.querySelectorAll<HTMLElement>('[id]')) this.el[node.id] = node;
    this.minimap = (root.querySelector('#minimap canvas') as HTMLCanvasElement).getContext('2d')!;
    this.overlay = this.el.overlay2d as HTMLCanvasElement;
  }

  get deployButton(): HTMLButtonElement {
    return this.el.deploy as HTMLButtonElement;
  }

  /**
   * The objective panel asks for attention: a flash, and a hint under the objective for a few
   * seconds (null flashes only, for a new objective).
   */
  nudge(hint: string | null) {
    const el = this.el.objective;
    el.classList.remove('nudge');
    // Restart the animation even if it's still running.
    void el.offsetWidth;
    el.classList.add('nudge');
    if (hint) {
      this.el['obj-hint'].textContent = shown(hint);
      this.el['obj-hint'].classList.add('show');
      this.hintTimer = 10;
    }
  }

  /** Why the game paused itself (the mouse left the window), or null for an ordinary pause. */
  pauseNote(text: string | null) {
    this.el['pause-note'].textContent = shown(text ?? '');
    this.el['pause-note'].style.display = text ? 'block' : 'none';
  }

  button(id: 'resume' | 'restart' | 'quit'): HTMLButtonElement {
    return this.el[id] as HTMLButtonElement;
  }

  /** The loading card as the mission's briefing: where, who, what, and how to play. */
  briefing(b: BriefingCard) {
    this.el['title-body'].innerHTML = shownHtml(html`
      <div class="kicker">${b.kicker}</div>
      <h1 class="mission">${b.title}</h1>
      <div class="brief-cols">
        <div class="brief-left">
          <div class="speaker">${b.speaker}</div>
          ${b.lines.map((l) => `<p class="quote">“${l}”</p>`).join('')}
          <h4>Objectives</h4>
          <ul class="objs">${b.objectives.map((o) => `<li class="${o.bonus ? 'bonus' : ''}">${o.bonus ? '<b>Bonus</b> ' : ''}${o.text}</li>`).join('')}</ul>
        </div>
        <div class="keys">${b.keys.map(([k, what]) => `<b>${k}</b><span>${what}</span>`).join('')}</div>
      </div>`);
  }

  /** The objectives in the corner, each active, done or failed. */
  objectives(title: string, list: { text: string; state: 'active' | 'done' | 'failed'; bonus?: boolean }[]) {
    this.el['obj-title'].textContent = shown(title);
    const key = list.map((o) => o.text + o.state).join('|');
    if (this.el['obj-list'].dataset.key === key) return;
    this.el['obj-list'].dataset.key = key;
    this.el['obj-list'].innerHTML = list.map((o) => `<li class="${o.state}${o.bonus ? ' bonus' : ''}">${shown(o.text)}</li>`).join('');
  }

  /** Frontline's war: both armies' scores toward the target, and every base's state. Null hides it. */
  warbar(s: { raiders: number; directorate: number; target: number; bases: { letter: string; owner: string | null; contested: boolean; capturing: string | null }[] } | null) {
    const el = this.el.warbar;
    el.classList.toggle('show', !!s);
    if (!s) return;
    this.el['wb-r'].textContent = String(Math.floor(s.raiders));
    this.el['wb-d'].textContent = String(Math.floor(s.directorate));
    this.el['wb-rbar'].style.width = `${(s.raiders / s.target) * 50}%`;
    this.el['wb-dbar'].style.width = `${(s.directorate / s.target) * 50}%`;
    const key = s.bases.map((b) => `${b.letter}${b.owner}${b.contested}${b.capturing}`).join('');
    if (this.el['wb-bases'].dataset.key !== key) {
      this.el['wb-bases'].dataset.key = key;
      this.el['wb-bases'].innerHTML = s.bases.map((b) => `<span class="wb-base ${b.owner ?? 'neutral'}${b.contested || b.capturing ? ' hot' : ''}">${b.letter}</span>`).join('');
    }
  }

  /** A mission-wide meter across the top (the artifact's charge); null hides it. */
  meter(m: { label: string; value: number; text: string; ticks?: number[] } | null) {
    this.el.meter.classList.toggle('show', !!m);
    if (!m) return;
    this.el['mt-label'].textContent = shown(m.label);
    this.el['mt-fill'].style.width = `${THREE.MathUtils.clamp(m.value, 0, 1) * 100}%`;
    this.el['mt-text'].textContent = shown(m.text);
    const key = (m.ticks ?? []).join(',');
    if (this.el['mt-ticks'].dataset.key !== key) {
      this.el['mt-ticks'].dataset.key = key;
      this.el['mt-ticks'].innerHTML = (m.ticks ?? []).map((t) => `<i style="left:${t * 100}%"></i>`).join('');
    }
  }

  private iconCache = new Map<string, string>();

  /** A command-card icon's image, once it has loaded. */
  private icon(name: IconName): string {
    const hit = this.iconCache.get(name);
    if (hit !== undefined) return hit;
    this.iconCache.set(name, '');
    void iconUrl(name).then((url) => {
      this.iconCache.set(name, url ?? '');
      // Redraw with the picture.
      this.el['cs-items'].dataset.key = '';
      this.el['rd-items'].dataset.key = '';
    });
    return '';
  }

  /** The call-ins: the strip at the bottom (energy, each one's state) and the radial menu on T. */
  callins(s: CallInState | null) {
    this.el.callstrip.classList.toggle('show', !!s);
    this.el.radial.classList.toggle('show', !!s?.menu);
    if (!s) return;
    this.el['cs-fill'].style.width = `${(s.energy / s.energyMax) * 100}%`;
    this.el['cs-energy'].textContent = `ORBITAL ${Math.floor(s.energy)}`;
    const strip = s.items.map((i) => `${i.def.id}${i.ready}${i.wait}${this.icon(i.def.icon)}`).join('|');
    if (this.el['cs-items'].dataset.key !== strip) {
      this.el['cs-items'].dataset.key = strip;
      this.el['cs-items'].innerHTML = s.items
        .map((i, k) => {
          const img = this.icon(i.def.icon);
          return `<div class="cs-item${i.ready ? ' ready' : ''}${i.locked ? ' locked' : ''}" title="${shown(i.def.name)}">${img ? `<img src="${img}">` : ''}<b>${k + 1}</b>${i.ready ? '' : `<span>${shown(i.wait)}</span>`}</div>`;
        })
        .join('');
    }
    this.el['cs-hint'].innerHTML = s.armed ? `<b>Click</b> to call <em>${shown(s.armed.name)}</em> · <b>Right-click</b> cancels` : '<b>Hold T</b> call-ins';
    this.el.callstrip.classList.toggle('armed', !!s.armed);
    if (!s.menu) return;
    const menu = s.items.map((i, k) => `${i.def.id}${i.ready}${i.wait}${k === s.selected}${this.icon(i.def.icon)}`).join('|');
    if (this.el['rd-items'].dataset.key !== menu) {
      this.el['rd-items'].dataset.key = menu;
      const at = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ];
      this.el['rd-items'].innerHTML = s.items
        .map((i, k) => {
          const [x, y] = at[k];
          const img = this.icon(i.def.icon);
          return `<div class="rd-item${k === s.selected ? ' on' : ''}${i.ready ? '' : ' off'}" style="left:calc(50% + ${x * 118}px);top:calc(50% + ${y * 118}px)">${img ? `<img src="${img}">` : ''}<div class="rd-name">${shown(i.def.name)}</div><div class="rd-cost">${i.locked ? 'Locked' : i.ready ? (i.def.energy ? `${i.def.energy} energy` : 'Ready') : shown(i.wait)}</div></div>`;
        })
        .join('');
      const sel = s.items[s.selected];
      this.el['rd-center'].innerHTML = sel ? `<div class="rd-title">${shown(sel.def.name)}</div><div class="rd-desc">${shown(sel.def.desc)}</div>` : '<div class="rd-desc">Flick the mouse toward a call-in, then let go of T</div>';
    }
  }

  /** Echo Squad by name: each one's life, or down and bleeding out, or lost. Null hides it. */
  echo(rows: { name: string; role: string; state: 'up' | 'down' | 'kia'; hp: number; bleed: number }[] | null) {
    this.el.echo.classList.toggle('show', !!rows?.length);
    if (!rows?.length) return;
    const key = rows.map((r) => `${r.name}${r.state}${Math.round(r.hp * 20)}${r.bleed}`).join('|');
    if (this.el['ec-rows'].dataset.key === key) return;
    this.el['ec-rows'].dataset.key = key;
    this.el['ec-rows'].innerHTML = rows
      .map((r) => {
        const state = r.state === 'down' ? `<em>DOWN ${r.bleed}s</em>` : r.state === 'kia' ? '<em>KIA</em>' : `<span class="ec-bar"><i style="width:${(r.hp * 100).toFixed(0)}%"></i></span>`;
        return `<div class="ec-row ${r.state}"><b>${shown(r.name)}</b><span class="ec-role">${shown(r.role)}</span>${state}</div>`;
      })
      .join('');
  }

  /** A boss's life across the top, while one is on the field; null hides it. */
  boss(b: { name: string; sub: string; hp: number; max: number } | null) {
    this.el.boss.classList.toggle('show', !!b);
    if (!b) return;
    this.el['bs-name'].textContent = shown(b.name);
    this.el['bs-sub'].textContent = shown(b.sub);
    this.el['bs-fill'].style.width = `${THREE.MathUtils.clamp(b.hp / b.max, 0, 1) * 100}%`;
  }

  /** Called with a base id when the player chooses where to deploy. */
  onPickDeploy: ((id: string) => void) | null = null;

  /** The command console's deploy choices: every base the Holdouts hold that's safe. */
  deployOptions(list: { id: string; label: string }[], selected: string) {
    const el = this.el['console-deploys'];
    const key = JSON.stringify([list, selected]);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = list.length ? `<span class="dl">Deploy at</span>` + list.map((o) => `<button class="dp${o.id === selected ? ' on' : ''}" data-dp="${o.id}">${shown(o.label)}</button>`).join('') : '';
    el.querySelectorAll<HTMLElement>('[data-dp]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        this.onPickDeploy?.(b.dataset.dp!);
      };
    });
  }

  /** Called when the player picks a class on the deploy screen or the command console. */
  onPickClass: ((id: string) => void) | null = null;

  /**
   * The class picker, PlanetSide's deploy screen in miniature: each class's command-card
   * icon, locked ones showing the rank they need. Drawn on the briefing card and in the
   * command console (keys 1-6 there).
   */
  /** The classes to deploy as, and the one picked. `numbered`: the command console shows the number key that picks each. */
  classes(list: { id: string; name: string; role: string; icon?: string; locked: string | null; keys: [string, string][] }[], selected: string, numbered = true) {
    const render = (el: HTMLElement, small: boolean) => {
      const key = JSON.stringify([list.map((c) => [c.id, c.locked, !!c.icon]), selected, small, numbered]);
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.innerHTML = list
        .map((c, i) => {
          const on = c.id === selected;
          const name = shown(c.name);
          const img = c.icon ? `<img src="${c.icon}" alt="" />` : `<span class="noicon">${name[0]}</span>`;
          const tip = shown(c.keys.map(([k, v]) => `${k}: ${v}`).join(' · '));
          return html`<button class="cls${on ? ' on' : ''}${c.locked ? ' locked' : ''}" data-cls="${c.id}" title="${c.locked ? `Unlocks at ${c.locked}` : tip}">
            ${img}<span class="cls-name">${small && numbered ? `${i + 1} · ` : ''}${name}</span>${small ? '' : `<span class="cls-role">${c.locked ? c.locked : shown(c.role)}</span>`}
          </button>`;
        })
        .join('');
      el.querySelectorAll<HTMLElement>('[data-cls]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          if (!b.classList.contains('locked')) this.onPickClass?.(b.dataset.cls!);
        };
      });
    };
    render(this.el['title-classes'], false);
    render(this.el['console-classes'], true);
  }

  /**
   * The waypoint marker: at its point on screen, or pinned to the edge with an arrow when
   * it's off screen. Null hides it.
   */
  waypoint(at: { x: number; y: number; onScreen: boolean; angle: number } | null, label = '', distance = 0) {
    const el = this.el.waypoint;
    el.classList.toggle('show', !!at);
    if (!at) return;
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    el.classList.toggle('edge', !at.onScreen);
    (el.firstElementChild as HTMLElement).style.transform = `rotate(${at.angle}rad)`;
    this.el['wp-label'].textContent = shown(label);
    this.el['wp-dist'].textContent = `${Math.round(distance)} m`;
  }

  /** A radio transmission: the speaker's portrait and a subtitle line, for `seconds`. */
  transmit(speaker: string, line: string, seconds: number) {
    this.el['tx-speaker'].textContent = shown(speaker);
    this.el['tx-line'].textContent = shown(line);
    this.el.transmission.classList.add('show');
    this.txTimer = seconds;
  }

  /** Where the portrait goes, in CSS pixels, for drawing a talking head into it. */
  get portraitRect(): DOMRect | null {
    return this.el.transmission.classList.contains('show') ? this.el['tx-portrait'].getBoundingClientRect() : null;
  }

  /** The end-of-mission debrief. Buttons are wired by the caller (data-act attributes). */
  debrief(d: Debrief) {
    const row = (label: string, value: string, cls = '') => `<div class="rw ${cls}"><span>${label}</span><b>${value}</b></div>`;
    const stars = [0, 1, 2].map((i) => `<i class="star${i < d.stars ? ' on' : ''}" style="animation-delay:${0.6 + i * 0.35}s">★</i>`).join('');
    this.el.debrief.innerHTML = shownHtml(html`
      <div class="kicker">${d.kicker}</div>
      <h1 style="color:${d.victory ? 'var(--life)' : 'var(--danger)'}">${d.title}</h1>
      <h2>${d.sub}</h2>
      <div class="dstars">${stars}</div>
      <div class="dcols">
        <div>
          <h4>Objectives</h4>
          <ul class="objs">${d.objectives.map((o) => `<li class="${o.state}${o.bonus ? ' bonus' : ''}">${o.text}</li>`).join('')}</ul>
          <h4>Service record</h4>
          <div class="stats">${d.stats.map(([v, l]) => `<div><b>${v}</b>${l}</div>`).join('')}</div>
          ${
            d.squad?.length
              ? `<h4>Echo Squad</h4><ul class="roll">${d.squad.map((m) => `<li class="${m.state}"><b>${m.name}</b><span>${m.note}</span></li>`).join('')}</ul>`
              : ''
          }
        </div>
        <div>
          <h4>Rewards</h4>
          ${d.rewards.map(([l, v]) => row(l, v)).join('')}
          ${row('Experience', `+${d.xp.toLocaleString()} XP`, 'total')}
          ${row('Credits', `+${d.credits.toLocaleString()}`, 'total')}
          <div class="rankline"><span>${d.rankName}</span>${d.promoted ? '<em>PROMOTED</em>' : ''}</div>
          <div class="xpbar"><div style="width:${(d.rankFrom * 100).toFixed(1)}%" data-to="${(d.rankTo * 100).toFixed(1)}"></div></div>
          ${
            d.citations?.length
              ? `<h4>Citations</h4><ul class="cites">${d.citations.map((c) => `<li><b>${c.name}</b><span>${c.why}</span></li>`).join('')}</ul>`
              : ''
          }
        </div>
      </div>
      ${d.story?.length ? `<div class="dstory">${d.story.map((l) => `<p><b>${l.speaker}</b>“${l.line}”</p>`).join('')}</div>` : ''}
      <div class="row center">
        ${d.next ? '<button class="cta" data-act="next">Next mission</button>' : ''}
        <button class="${d.next ? 'quiet' : 'cta'}" data-act="menu">Continue</button>
        <button class="quiet" data-act="retry">Retry</button>
      </div>`);
    this.show('end', true);
    // The experience bar fills from where it was to where it is now.
    const bar = this.el.debrief.querySelector<HTMLElement>('.xpbar > div')!;
    setTimeout(() => (bar.style.width = `${bar.dataset.to}%`), 900);
  }

  setLoading(progress: number, label: string) {
    this.el['load-bar'].style.width = `${Math.round(progress * 100)}%`;
    this.el['load-label'].textContent = shownLoading(label);
  }

  ready() {
    this.setLoading(1, 'Ready.');
    this.deployButton.disabled = false;
  }

  show(id: 'title' | 'pause' | 'end' | 'signal' | 'resumeHint', on: boolean) {
    this.el[id].classList.toggle('show', on);
  }

  /** Dips to black and back: a cut. */
  fade(seconds = 0.6) {
    const f = this.el.fade;
    f.style.transition = 'none';
    f.style.opacity = '1';
    void f.offsetWidth;
    f.style.transition = `opacity ${seconds}s ease-out`;
    f.style.opacity = '0';
  }

  setMode(mode: HudMode) {
    document.body.dataset.mode = mode;
  }

  message(big: string, sub = '', seconds = 4) {
    this.el['msg-big'].textContent = shown(big);
    this.el['msg-sub'].textContent = shown(sub);
    this.el.message.classList.add('show');
    this.messageTimer = seconds;
  }

  /** A hit marker: white for a clean hit, gold for a weak spot, slate when armor took most of it, red on a kill. */
  hitmarker(kind: 'hit' | 'armor' | 'kill' | 'weak') {
    const m = this.el.hitmarker;
    m.style.color = kind === 'kill' ? (this.colorblind ? '#ffb000' : '#ff4a3a') : kind === 'armor' ? '#8fa6bc' : kind === 'weak' ? '#ffd24a' : '#ffffff';
    // Restart the pop on every hit, so a burst that lands reads as a burst.
    m.className = '';
    void m.offsetWidth;
    m.className = kind === 'kill' ? 'show kill' : kind === 'weak' ? 'show weak' : 'show pop';
    this.hitTimer = kind === 'kill' ? 0.26 : 0.08;
  }

  /**
   * Damage from a direction: `angle` is radians clockwise from straight ahead (0 in front,
   * pi behind). An arc around the crosshair points at the attacker and fades.
   */
  damageFrom(angle: number, amount: number) {
    const d = document.createElement('div');
    d.className = 'arc';
    d.style.transform = `rotate(${angle}rad)`;
    d.style.setProperty('--strength', String(Math.min(1, 0.45 + amount / 20)));
    this.el.dmgdir.appendChild(d);
    while (this.el.dmgdir.children.length > 6) this.el.dmgdir.firstChild!.remove();
    setTimeout(() => d.remove(), 1300);
  }

  /** PlanetSide-style experience ticks, stacking beside the crosshair. */
  xp(amount: number, label: string, kind: 'kill' | 'assist' | 'objective' = 'kill') {
    const d = document.createElement('div');
    d.className = `tick ${kind}`;
    d.innerHTML = html`<b>+${amount}</b> ${shown(label)}`;
    this.el.xpfeed.prepend(d);
    while (this.el.xpfeed.children.length > 5) this.el.xpfeed.lastChild!.remove();
    setTimeout(() => d.remove(), 2200);
  }

  /** The signal-lost card's second line: who got you. */
  killedBy(text: string) {
    this.el.killer.textContent = shown(text);
  }

  hurt(amount: number) {
    this.hurtLevel = Math.min(1, this.hurtLevel + amount / 25);
  }

  feed(text: string) {
    const d = document.createElement('div');
    d.textContent = shown(text);
    this.el.killfeed.prepend(d);
    while (this.el.killfeed.children.length > 6) this.el.killfeed.lastChild!.remove();
    setTimeout(() => d.remove(), 4000);
  }

  /** The body the player is in: title, life, ability bars, context prompt, crosshair. */
  avatar(h: AvatarHud, fov: number, jolted: boolean) {
    this.el['avatar-title'].textContent = shown(h.title);
    const f = h.maxHp ? h.hp / h.maxHp : 0;
    this.el['hp-bar'].style.width = `${f * 100}%`;
    this.el['hp-bar'].style.background = f > 0.6 ? 'var(--life)' : f > 0.3 ? 'var(--warn)' : 'var(--danger)';
    this.el['hp-num'].textContent = `${Math.ceil(h.hp)} / ${h.maxHp}`;
    const bars = this.el.bars;
    while (bars.children.length < h.bars.length) {
      const d = document.createElement('div');
      d.innerHTML = html`<div class="label"><span></span><span></span></div><div class="bar"><div></div></div>`;
      bars.appendChild(d);
    }
    while (bars.children.length > h.bars.length) bars.lastChild!.remove();
    h.bars.forEach((b, i) => {
      const row = bars.children[i] as HTMLElement;
      const [name, text] = row.querySelectorAll<HTMLElement>('.label span');
      name.innerHTML = b.key ? `${shown(b.label)} <b>[${b.key}]</b>` : shown(b.label);
      text.textContent = shown(b.text);
      const fill = row.querySelector<HTMLElement>('.bar > div')!;
      fill.style.width = `${THREE.MathUtils.clamp(b.value, 0, 1) * 100}%`;
      if (b.color) fill.style.background = b.color;
    });
    this.el.prompt.textContent = shown(h.prompt ?? '');
    this.el.prompt.style.opacity = h.prompt ? '1' : '0';
    const note = shown(h.aimNote ?? '');
    if (this.el.aimnote.textContent !== note) this.el.aimnote.textContent = note;
    this.el.aimnote.classList.toggle('show', !!h.aimNote);
    this.el.crosshair.className = h.crosshair;
    this.el.slit.classList.toggle('show', !!h.slit);
    // The crosshair gap follows the weapon's spread at the current field of view.
    const px = (h.spread / ((fov * Math.PI) / 180)) * window.innerHeight + 5;
    this.el['ch-l'].style.left = `${-px - 9}px`;
    this.el['ch-r'].style.left = `${px}px`;
    this.el['ch-t'].style.top = `${-px - 9}px`;
    this.el['ch-b'].style.top = `${px}px`;
    const lowHp = 1 - f;
    this.el.vignette.style.opacity = String(Math.min(1, this.hurtLevel + Math.max(0, lowHp - 0.5) * 0.8));
    this.el.joltfx.style.opacity = jolted ? '1' : '0';
  }

  /** `gated`: the wait holds for taking over a soldier too (a mission's rules). */
  command(summary: string, redeployIn: number, gated = false) {
    this.el.selection.textContent = shown(summary);
    this.el.redeploy.textContent = shown(
      redeployIn > 0 ? (gated ? `back in the fight in ${Math.ceil(redeployIn)}s` : `redeploy a Trooper in ${Math.ceil(redeployIn)}s`) : 'redeploy a Trooper at the Barracks',
    );
  }

  objective(s: ObjectiveState) {
    let status = '';
    const of = Number.isFinite(s.totalWaves) ? ` of ${s.totalWaves}` : '';
    if (s.phase === 'countdown') status = `Wave ${s.wave + 1}${of} in ${Math.ceil(s.countdown)}s`;
    else if (s.phase === 'wave') status = `Wave ${s.wave + 1}${of} · ${s.enemies} hostiles`;
    else if (s.phase === 'victory') status = 'All waves repelled';
    else if (s.phase === 'defeat') status = 'Holdfast destroyed';
    else status = 'Awaiting deployment';
    if (s.status && s.phase !== 'victory' && s.phase !== 'defeat') status = s.status;
    status = shown(status);
    // A new objective takes the old one's hint with it.
    if (this.el.status.textContent !== status) {
      this.el.status.textContent = status;
      this.hintTimer = 0;
      this.el['obj-hint'].classList.remove('show');
    }
    const bar = this.el['cc-bar'].parentElement!;
    bar.style.display = s.base ? '' : 'none';
    this.el['cc-label'].style.display = s.base ? '' : 'none';
    if (s.base) {
      this.el['cc-bar'].style.width = `${(s.base.hp / s.base.max) * 100}%`;
      this.el['cc-label'].textContent = `${shown(s.base.label ?? 'HOLDFAST')}  ${Math.ceil(s.base.hp)} / ${s.base.max}`;
    }
  }

  update(dt: number) {
    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.el.message.classList.remove('show');
    this.hitTimer -= dt;
    if (this.hitTimer <= 0) this.el.hitmarker.classList.remove('show');
    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 0.9);
    this.txTimer -= dt;
    if (this.txTimer <= 0) this.el.transmission.classList.remove('show');
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.el['obj-hint'].classList.remove('show');
    }
  }

  /**
   * The minimap: the ground, capture points, units, the Warship, the waypoint, and
   * where the player is (or is looking), north up.
   */
  drawMinimap(dt: number, world: World, frame: MinimapFrame, ship: THREE.Vector3, view: THREE.Vector3, yaw: number | null, extras: { points?: readonly CapturePoint[]; waypoint?: THREE.Vector3 | null } = {}) {
    this.mapTimer -= dt;
    if (this.mapTimer > 0) return;
    this.mapTimer = 0.1;
    const g = this.minimap;
    const size = 400;
    const map = (x: number, z: number) => toMinimap(frame, x, z, size);
    g.clearRect(0, 0, size, size);
    g.globalAlpha = 0.92;
    g.drawImage(frame.image, 0, 0, size, size);
    g.globalAlpha = 1;
    for (const p of extras.points ?? []) {
      const [x, y] = map(p.position.x, p.position.z);
      const r = Math.max(10, (p.radius / (frame.x1 - frame.x0)) * size);
      g.strokeStyle = `#${p.color.getHexString()}`;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#fff';
      g.font = 'bold 22px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(p.letter, x, y);
    }
    for (const e of world.entities) {
      if (!e.targetable) continue;
      const [x, y] = map(e.position.x, e.position.z);
      const color = e.team === 'crawl' ? '#e04aff' : e.team === 'directorate' ? '#ff4a3a' : '#59b0ff';
      if (e.isBuilding) {
        const r = Math.max(4, (e.radius / (frame.x1 - frame.x0)) * size);
        g.fillStyle = color;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      } else {
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, e.radius > 2 ? 6 : 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (extras.waypoint) {
      const [x, y] = map(extras.waypoint.x, extras.waypoint.z);
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.strokeStyle = '#ffd24a';
      g.lineWidth = 4;
      g.strokeRect(-9, -9, 18, 18);
      g.restore();
    }
    const [bx, by] = map(ship.x, ship.z);
    g.strokeStyle = '#9fd0ff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(bx, by, 11, 0, Math.PI * 2);
    g.stroke();
    const [vx, vy] = map(view.x, view.z);
    g.save();
    g.translate(vx, vy);
    if (yaw !== null) {
      // Our yaw 0 faces +Z, which is down on this map.
      g.rotate(Math.PI - yaw);
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, -14);
      g.lineTo(9, 10);
      g.lineTo(-9, 10);
      g.closePath();
      g.stroke();
      g.fill();
    } else {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.strokeRect(-26, -18, 52, 36);
    }
    g.restore();
  }

  /** The capture bar: shown while the player stands in a point. */
  capture(state: { name: string; letter: string; progress: number; contested: boolean; mine: boolean; color: string } | null) {
    const el = this.el.capture;
    el.classList.toggle('show', !!state);
    if (!state) return;
    this.el['cap-name'].textContent = shown(state.contested ? `${state.letter} · ${state.name} · CONTESTED` : state.mine ? `${state.letter} · ${state.name} · HELD` : `${state.letter} · SECURING ${state.name}`);
    const fill = this.el['cap-fill'];
    fill.style.width = `${(state.mine ? 1 : state.progress) * 100}%`;
    fill.style.background = state.contested ? 'var(--warn)' : state.color;
  }
}
