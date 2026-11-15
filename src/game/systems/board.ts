import * as THREE from 'three';
import { shown, shownHtml } from '../../content/names.ts';
import type { KindName } from '../kinds.ts';
import type { StructureOffer } from './construction.ts';
import type { Treasury } from './economy.ts';
import type { Stance } from './lines.ts';
import type { Offer, Producer, Requisition } from './production.ts';

/**
 * The commander's screens, for a mode with an economy: what the base has to spend (always up,
 * top right); the requisition board (G opens it and frees the cursor; always open in the command
 * view): the squads by building, what each costs and how long it takes, the structures a worker
 * can be sent to build, where new squads are sent and what that means, what's being built and
 * where it's headed, and each line's stance. Over the battlefield, while the board is open, a
 * marker on every place squads can be sent (click one to send them there); and always, a tag over
 * every new squad on its way, so they can be found.
 */

const PRODUCERS: { id: Producer; name: string }[] = [
  { id: 'barracks', name: 'Barracks' },
  { id: 'motorPool', name: 'Motor Pool' },
  { id: 'airfield', name: 'Airfield' },
];
/** What the board's number keys pick, in order: the buildings, then Construction. */
export type BoardGroup = Producer | 'construction';
export const BOARD_GROUPS: BoardGroup[] = ['barracks', 'motorPool', 'airfield', 'construction'];
const STANCES: { id: Stance; name: string }[] = [
  { id: 'auto', name: 'Sergeant' },
  { id: 'hold', name: 'Hold' },
  { id: 'advance', name: 'Push' },
  { id: 'fallback', name: 'Fall back' },
];
/** How far in from the screen's edge a marker for somewhere off screen is held. */
const EDGE = 28;
/** Orders shown in a building's queue; the rest are counted. */
const SHOWN = 4;

export interface LineView {
  name: string;
  stance: Stance;
  strength: number;
  broken: boolean;
  /** Evacuation by air: null where the mode has none, '' when Dustoffs can go, otherwise why not (the wait). */
  evac: string | null;
}

/** Somewhere new squads can be sent. */
export interface Destination {
  /** What orders name it by: "Auto", a line's name, "With me", "Base". */
  id: string;
  label: string;
  /** Its state at a glance: a line's strength, how pressed it is. */
  detail: string;
  /** What sending a squad there does, in a line. */
  explain: string;
  /** Where it is on the battlefield, for its marker (none for "Auto"). */
  at: THREE.Vector3 | null;
  /** In trouble: a line overrun or about to be, the swarm in the base. */
  alert: boolean;
}

export interface BoardView {
  open: boolean;
  /** The cursor is free to click it (the board opened on the ground, or the command view). */
  interactive: boolean;
  /** What the number keys pick, in order, and the one picked (its letters order). */
  groups: BoardGroup[];
  group: BoardGroup;
  /** Its keys order now (open on foot, or a building picked in the command view). */
  keyed: boolean;
  /** Shown in the command view (where it's always up, and has no ✕). */
  command: boolean;
  offers: Offer[];
  req: Requisition;
  treasury: Treasury;
  supply: number;
  destination: string;
  destinations: Destination[];
  lines: LineView[];
  /** The structures a worker can be sent to build, and why each can't be right now (or null). */
  structures: StructureOffer[];
  /** Structures going up: what, how far along (0 while the worker walks out). */
  works: { label: string; progress: number }[];
  /** The structure being placed, if any. */
  placing: KindName | null;
  /** The supply cap. */
  cap: number;
  /** A bounty streak: the multiplier, and kills to the next step (null at the top). */
  streak: { multiplier: number; toNext: number | null } | null;
  note: string;
  /** Why each squad (by key) can't be ordered right now, or null where it can. */
  blocked: Record<string, string | null>;
  /**
   * The Holdfast replacing lost Riggers, where the mode does: how many work, how many it
   * keeps, seconds to the next (null: none due) and a whole one's seconds.
   */
  workers: { have: number; want: number; next: number | null; cycle: number } | null;
}

/** A squad on its way to where it was sent. */
export interface Marching {
  id: number;
  label: string;
  where: string;
  at: THREE.Vector3;
}

const money = (o: { ore: number; gas: number }) => `<i class="m"></i>${o.ore}${o.gas ? ` <i class="g"></i>${o.gas}` : ''}`;

export class TideUI {
  private res: HTMLElement;
  private board: HTMLElement;
  private marks: HTMLElement;
  private place: HTMLElement;
  private last = '';
  private lastPlace = '';
  private lastBoard = '';
  private markEls = new Map<string, HTMLElement>();
  private v = new THREE.Vector3();
  onOrder: ((key: string) => void) | null = null;
  /** Right-click on an order in a building's queue: takes it back (refunded). */
  onWithdraw: ((producer: Producer, index: number) => void) | null = null;
  onBuild: ((kind: KindName) => void) | null = null;
  onDestination: ((id: string) => void) | null = null;
  onStance: ((line: string, stance: Stance) => void) | null = null;
  onEvacuate: ((line: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    const root = document.getElementById('hud') ?? document.body;
    this.res = document.createElement('div');
    this.res.id = 'tide-res';
    this.board = document.createElement('div');
    this.board.id = 'tide-board';
    this.marks = document.createElement('div');
    this.marks.id = 'tide-marks';
    this.place = document.createElement('div');
    this.place.id = 'tide-place';
    root.append(this.marks, this.res, this.board, this.place);
    // On the press, not the click: the board redraws as money and supply change, and a redraw
    // between press and release would lose a click.
    const click = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-order],[data-build],[data-dest],[data-stance],[data-evac],[data-close]');
      if (!el) return;
      e.stopPropagation();
      e.preventDefault();
      if (el.dataset.order) this.onOrder?.(el.dataset.order);
      else if (el.dataset.build) this.onBuild?.(el.dataset.build as KindName);
      else if (el.dataset.evac) this.onEvacuate?.(el.dataset.evac);
      else if (el.dataset.dest) this.onDestination?.(el.dataset.dest);
      else if (el.dataset.close !== undefined) this.onClose?.();
      else if (el.dataset.stance) {
        const [line, stance] = el.dataset.stance.split(':');
        this.onStance?.(line, stance as Stance);
      }
    };
    const withdraw = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-job]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const [producer, index] = el.dataset.job!.split(':');
      this.onWithdraw?.(producer as Producer, Number(index));
    };
    this.board.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      click(e);
    });
    this.board.addEventListener('contextmenu', withdraw);
    this.marks.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      click(e);
    });
  }

  /**
   * A structure being placed (null: none): its name and how to place it, and why it can't go
   * where it's pointed (null: it can).
   */
  showPlacing(label: string | null, why: string | null, onFoot: boolean) {
    const key = label ? `${label}|${why}|${onFoot}` : '';
    if (key === this.lastPlace) return;
    this.lastPlace = key;
    this.place.classList.toggle('show', !!label);
    this.place.classList.toggle('no', !!why);
    if (!label) return;
    const how = `${onFoot ? 'Aim' : 'Point'} and click to build · Shift keeps placing · right-click cancels`;
    // Each of the board's screens in the game's own names where the content mode asks (content/names.ts).
    this.place.innerHTML = shownHtml(`Placing <b>${label}</b><em>${why ?? how}</em>`);
  }

  dispose() {
    this.res.remove();
    this.board.remove();
    this.marks.remove();
    this.place.remove();
  }

  /** The treasury on screen. (The swarm's director paces the battle unseen: its phase isn't shown.) */
  resources(t: Treasury, supply: number, cap: number, rate: number, streak: { multiplier: number; toNext: number | null } | null, visible: boolean) {
    this.res.classList.toggle('show', visible);
    const bounty = streak ? `×${streak.multiplier.toFixed(1)}${streak.toNext !== null ? ` · ${streak.toNext} to ×${(streak.multiplier + 0.1).toFixed(1)}` : ' · top'}` : '';
    const key = `${Math.floor(t.ore)}|${Math.floor(t.gas)}|${Math.round(supply)}|${cap}|${Math.round(rate / 10)}|${bounty}`;
    if (key === this.last) return;
    this.last = key;
    this.res.innerHTML = shownHtml(`
      <span class="tr-m" title="Ore"><i></i>${Math.floor(t.ore)}</span>
      <span class="tr-g" title="Fuel gas"><i></i>${Math.floor(t.gas)}</span>
      <span class="tr-s" title="Supply">${Math.round(supply)}/${cap}</span>
      <span class="tr-r">+${Math.round(rate)}/min</span>
      ${streak ? `<span class="tr-b" title="Bounty streak: kills since you last died raise what each kill pays. Dying resets it.">Bounty ${bounty}</span>` : ''}
      <span class="tr-k"><b>G</b> requisition</span>`);
  }

  /** The board. */
  showBoard(b: BoardView) {
    this.board.classList.toggle('show', b.open);
    this.board.classList.toggle('interactive', b.interactive);
    if (!b.open) return;
    // What changes every frame (progress, seconds left) is written into the board as it stands;
    // the board itself is redrawn only when what's on it changes.
    // The number each building is picked by, and which is picked: its letters order.
    const number = (g: BoardGroup) => b.groups.indexOf(g) + 1;
    const picked = (g: BoardGroup) => (b.keyed && b.group === g ? ' on' : b.keyed ? ' off' : '');
    const columns = PRODUCERS.map((p) => {
      const jobs = b.req.jobs(p.id);
      const queue =
        jobs
          .slice(0, SHOWN)
          .map((j, i) => `<div class="tb-q${j.active ? '' : ' wait'}" data-job="${p.id}:${i}" title="Right-click to cancel (refunded)"><div></div><span>${j.offer.label} → ${j.destination}</span><em></em></div>`)
          .join('') + (jobs.length > SHOWN ? `<div class="tb-more">+${jobs.length - SHOWN} more waiting</div>` : '');
      const items = b.offers
        .filter((o) => o.producer === p.id)
        .map((o) => {
          const count = o.units.reduce((a, [, n]) => a + n, 0);
          const why = b.blocked[o.key] ?? null;
          return `<button class="tb-o${why ? ' no' : ''}" data-order="${o.key}"${why ? ` title="${why}"` : ''}><b>${o.hotkey}</b><span class="tb-n">${o.label}${count > 1 ? ` ×${count}` : ''}</span><span class="tb-c">${money(o)}${o.supply ? ` · ${o.supply} supply` : ''}${why ? ` · <em>${why}</em>` : ''}</span><span class="tb-t">${Math.round(o.seconds)}s</span></button>`;
        })
        .join('');
      const bays = b.req.bays[p.id];
      return `<div class="tb-col${picked(p.id)}"><h5><b class="tb-k">${number(p.id)}</b>${p.name}<em>${bays} at a time</em></h5>${queue || '<div class="tb-q idle"><span>Idle</span></div>'}${items}</div>`;
    }).join('');
    // What a worker can be sent to build: click one, then the spot (the cursor in the command
    // view, the crosshair on foot).
    const workers = b.workers
      ? `<div class="tb-q tb-w${b.workers.next === null ? ' idle' : ''}" data-workers><div></div><span>Riggers ${b.workers.have} of ${b.workers.want}${b.workers.next === null ? '' : ' · training'}</span><em></em></div>`
      : '';
    const building = b.structures.length
      ? `<div class="tb-col${picked('construction')}"><h5><b class="tb-k">${number('construction')}</b>Construction</h5>${workers}${
          b.works.map((w, i) => `<div class="tb-q" data-work="${i}"><div></div><span>${w.progress > 0 ? w.label : `Rigger on the way: ${w.label}`}</span><em></em></div>`).join('') || '<div class="tb-q idle"><span>No Riggers out</span></div>'
        }${b.structures
          .map((s) => `<button class="tb-o${s.blocked ? ' no' : ''}${b.placing === s.def.kind ? ' on' : ''}" data-build="${s.def.kind}" title="${s.blocked ?? 'Click (or its key), then click where it goes'}"><b>${s.def.hotkey}</b><span class="tb-n">${s.def.label}</span><span class="tb-c">${money(s)}${s.blocked ? ` · <em>${s.blocked}</em>` : ''}</span><span class="tb-t">${Math.round(s.seconds)}s</span></button>`)
          .join('')}</div>`
      : '';
    const chosen = b.destinations.find((d) => d.id === b.destination) ?? b.destinations[0];
    const dests = b.destinations
      .map((d) => `<button class="tb-d${d.id === b.destination ? ' on' : ''}${d.alert ? ' alert' : ''}" data-dest="${d.id}"><span>${d.label}</span>${d.detail ? `<em>${d.detail}</em>` : ''}</button>`)
      .join('');
    const lineRows = b.lines
      .map(
        (l) =>
          `<div class="tb-l${l.broken ? ' broken' : ''}"><span class="tb-ln">${l.name}<em>${l.broken ? 'broken' : `${Math.round(l.strength)} supply`}</em></span>${STANCES.map((s) => `<button class="tb-s${s.id === l.stance ? ' on' : ''}" data-stance="${l.name}:${s.id}">${s.name}</button>`).join('')}${
            l.evac === null ? '' : `<button class="tb-s tb-ev${l.evac ? ' no' : ''}" data-evac="${l.name}" title="${l.evac || 'Dustoffs fly in, take its soldiers aboard and set them down at its fallback'}">${l.evac || 'Evacuate'}</button>`
          }</div>`,
      )
      .join('');
    const keys = `<b>1</b>–<b>${b.groups.length}</b> picks a building, its letters order`;
    const hint = b.command
      ? `${keys} · <b>Esc</b> lets go · click to order · right button cancels an order`
      : `${keys} · <b>Tab</b> where they go · click to order · right button cancels · <b>G</b> or <b>Esc</b> closes`;
    const key = columns + building + dests + lineRows + b.note + hint + (chosen?.explain ?? '');
    if (key !== this.lastBoard) {
      this.lastBoard = key;
      this.board.innerHTML = shownHtml(`
      <div class="tb-head">Requisition<span>${hint}</span>${b.interactive && !b.command ? '<button class="tb-x" data-close>✕</button>' : ''}</div>
      <div class="tb-send"><h5>Send new squads to</h5><div class="tb-dests">${dests}</div><div class="tb-explain">${chosen?.explain ?? ''}</div></div>
      <div class="tb-cols">${columns}${building}</div>
      <div class="tb-lines"><h5>Lines</h5>${lineRows}</div>
      ${b.note ? `<div class="tb-note">${b.note}</div>` : ''}`);
    }
    const bar = (el: Element | null, progress: number, text: string) => {
      if (!el) return;
      (el.firstElementChild as HTMLElement).style.width = `${(Math.min(1, Math.max(0, progress)) * 100).toFixed(1)}%`;
      const em = el.querySelector('em');
      const label = shown(text);
      if (em && em.textContent !== label) em.textContent = label;
    };
    for (const p of PRODUCERS) {
      b.req.jobs(p.id)
        .slice(0, SHOWN)
        .forEach((j, i) => bar(this.board.querySelector(`[data-job="${p.id}:${i}"]`), j.active ? j.progress : 0, j.active ? `${Math.ceil(j.left)}s` : 'next free bay'));
    }
    b.works.forEach((w, i) => bar(this.board.querySelector(`[data-work="${i}"]`), w.progress, w.progress > 0 ? `${Math.round(w.progress * 100)}%` : ''));
    if (b.workers) bar(this.board.querySelector('[data-workers]'), b.workers.next === null ? 0 : 1 - b.workers.next / Math.max(1, b.workers.cycle), b.workers.next === null ? '' : `${Math.ceil(b.workers.next)}s`);
  }

  /**
   * Markers over the battlefield: where squads can be sent (while the board is open; clickable
   * when it takes clicks), and a tag over each squad on its way. Off screen, a marker waits at
   * the edge in its direction.
   */
  showMarks(camera: THREE.Camera, board: BoardView | null, marching: Marching[], from: THREE.Vector3 | null) {
    const seen = new Set<string>();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const place = (id: string, at: THREE.Vector3, lift: number, html: string, cls: string) => {
      seen.add(id);
      let el = this.markEls.get(id);
      if (!el) {
        el = document.createElement('div');
        this.marks.append(el);
        this.markEls.set(id, el);
      }
      if (el.dataset.html !== html) {
        el.dataset.html = html;
        el.innerHTML = shownHtml(html);
      }
      if (el.className !== cls) el.className = cls;
      const v = this.v.copy(at);
      v.y += lift;
      v.project(camera);
      // Behind the camera: mirrored, and pushed to the edge it's off.
      let x = v.x;
      let y = v.y;
      const behind = v.z > 1;
      if (behind) {
        x = -x;
        y = -Math.abs(y) - 1;
      }
      let sx = ((x + 1) / 2) * w;
      let sy = ((1 - y) / 2) * h;
      const off = behind || sx < EDGE || sx > w - EDGE || sy < EDGE || sy > h - EDGE;
      sx = THREE.MathUtils.clamp(sx, EDGE, w - EDGE);
      sy = THREE.MathUtils.clamp(sy, EDGE + 40, h - EDGE - 60);
      el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      el.classList.toggle('edge', off);
    };
    if (board?.open) {
      for (const d of board.destinations) {
        if (!d.at) continue;
        const cls = `tm dest${d.id === board.destination ? ' on' : ''}${d.alert ? ' alert' : ''}${board.interactive ? ' click' : ''}`;
        place(`d:${d.id}`, d.at, 9, `<div data-dest="${d.id}"><b>${d.label}</b>${d.detail ? `<span>${d.detail}</span>` : ''}</div>`, cls);
      }
    }
    for (const m of marching) {
      const far = from ? Math.round(m.at.distanceTo(from)) : null;
      place(`s:${m.id}`, m.at, 5, `<div><b>${m.label}</b><span>→ ${m.where}${far !== null && far > 25 ? ` · ${far} m` : ''}</span></div>`, 'tm squad');
    }
    for (const [id, el] of this.markEls) {
      if (seen.has(id)) continue;
      el.remove();
      this.markEls.delete(id);
    }
  }
}
