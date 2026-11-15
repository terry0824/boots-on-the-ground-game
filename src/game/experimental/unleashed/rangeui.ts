import { shownHtml } from '../../../content/names.ts';
import type { PracticeRules } from '../../systems/rules.ts';

/**
 * The Practice Range's screens (practice.ts): a strip always up on the ground (the damage you're
 * doing, the keys), and the range's panel (G opens it and frees the cursor): every unit to take,
 * with its ultimate; the targets and allies to call up and what they do; the range's rules; and
 * what you've dealt.
 */

/** A unit on offer. */
export interface BodyOption {
  kind: string;
  label: string;
  /** Its ultimate's name, and the color its bar wears. */
  ultimate: string;
  color: string;
  /** What the ultimate needs to be any use here, if anything. */
  hint: string;
}

/** Something to call up: a group of targets, or of allies. */
export interface CallOption {
  id: string;
  label: string;
  count: number;
  air?: boolean;
}

export interface RangeView {
  open: boolean;
  /** The unit the player is in now (its kind), if any. */
  body: string | null;
  bodies: { group: string; items: BodyOption[] }[];
  targets: CallOption[];
  allies: CallOption[];
  settings: PracticeRules;
  /** The Lodestar's state, in a word or two. */
  ship: string;
  shipReady: boolean;
  stats: { dps: number; total: number; kills: number; last: string };
  /** Crawl and allies on the field. */
  field: { crawl: number; allies: number };
}

/** A panel option's choices: its key in the settings, its label, and each value with its name. */
const OPTIONS: { key: keyof PracticeRules; label: string; values: [string | number | boolean, string][] }[] = [
  { key: 'distance', label: 'Distance', values: [[15, '15 m'], [30, '30 m'], [60, '60 m'], [100, '100 m']] },
  { key: 'targets', label: 'They', values: [['still', 'Stand still'], ['fight', 'Fight back'], ['charge', 'Charge you']] },
  { key: 'respawn', label: 'Respawn', values: [[true, 'On'], [false, 'Off']] },
];
const SWARM: [PracticeRules['swarm'], string][] = [['off', 'Off'], ['steady', 'Steady'], ['flood', 'Flood']];
const CHARGING: [PracticeRules['ultimate'], string][] = [['instant', 'Instant'], ['fast', 'Fast · 10 s'], ['normal', 'Normal']];
const GUARD: [boolean, string][] = [[true, 'On'], [false, 'Off']];

const num = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString());

export class RangeUI {
  private panel: HTMLElement;
  private strip: HTMLElement;
  private lastPanel = '';
  private lastStrip = '';
  onBody: ((kind: string) => void) | null = null;
  onCall: ((id: string) => void) | null = null;
  onOption: ((key: keyof PracticeRules, value: string | number | boolean) => void) | null = null;
  onAct: ((act: 'clear' | 'recharge' | 'ship' | 'reset') => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    const root = document.getElementById('hud') ?? document.body;
    this.strip = document.createElement('div');
    this.strip.id = 'range-strip';
    this.panel = document.createElement('div');
    this.panel.id = 'range-panel';
    root.append(this.strip, this.panel);
    // On the press, not the click: the panel redraws as the field changes, and a redraw between
    // press and release would lose a click (as The Tide's board).
    this.panel.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-body],[data-call],[data-opt],[data-act],[data-close]');
      if (!el) return;
      e.preventDefault();
      if (el.dataset.body) this.onBody?.(el.dataset.body);
      else if (el.dataset.call) this.onCall?.(el.dataset.call);
      else if (el.dataset.act) this.onAct?.(el.dataset.act as 'clear' | 'recharge' | 'ship' | 'reset');
      else if (el.dataset.close !== undefined) this.onClose?.();
      else if (el.dataset.opt) {
        const [key, raw] = el.dataset.opt.split(':');
        const value = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
        this.onOption?.(key as keyof PracticeRules, value);
      }
    });
  }

  dispose() {
    this.panel.remove();
    this.strip.remove();
  }

  /** The strip: up whenever the player is on the ground. */
  showStrip(v: RangeView | null) {
    this.strip.classList.toggle('show', !!v);
    if (!v) return;
    const key = `${Math.round(v.stats.dps)}|${v.field.crawl}|${v.open}`;
    if (key === this.lastStrip) return;
    this.lastStrip = key;
    this.strip.innerHTML = shownHtml(`<b>Practice Range</b><span>${num(v.stats.dps)} damage/s</span><span>${v.field.crawl} Crawl on the field</span><span class="rk"><b>G</b> ${v.open ? 'close' : 'range panel'}</span><span class="rk"><b>Z</b> recharge</span>`);
  }

  show(v: RangeView) {
    this.panel.classList.toggle('show', v.open);
    if (!v.open) return;
    const option = (key: keyof PracticeRules, value: string | number | boolean, label: string) =>
      `<button class="rp-o${v.settings[key] === value ? ' on' : ''}" data-opt="${key}:${value}">${label}</button>`;
    const bodies = v.bodies
      .map(
        (g) =>
          `<div class="rp-group"><span class="rp-gl">${g.group}</span><div class="rp-bodies">${g.items
            .map(
              (b) =>
                `<button class="rp-b${b.kind === v.body ? ' on' : ''}" data-body="${b.kind}" title="${b.ultimate}${b.hint ? ` · ${b.hint}` : ''}"><b>${b.label}</b><em><i style="background:${b.color}"></i>${b.ultimate}</em></button>`,
            )
            .join('')}</div></div>`,
      )
      .join('');
    const calls = (list: CallOption[]) => list.map((c) => `<button class="rp-c${c.air ? ' air' : ''}" data-call="${c.id}">${c.label}${c.count > 1 ? ` ×${c.count}` : ''}</button>`).join('');
    const html = `
      <div class="rp-head">Practice Range<span>Click to choose · <b>G</b> or <b>Esc</b> closes</span><button class="rp-x" data-close>✕</button></div>
      <div class="rp-sec">
        <h5>Take a unit<em>Q: its ultimate · X: the Lodestar · E: its own ability</em></h5>
        ${bodies}
      </div>
      <div class="rp-sec">
        <h5>Call up targets<em>where you're looking</em></h5>
        <div class="rp-row">${OPTIONS.map((o) => `<span class="rp-ol">${o.label}</span>${o.values.map(([value, label]) => option(o.key, value, label)).join('')}`).join('')}</div>
        <div class="rp-calls">${calls(v.targets)}</div>
        <div class="rp-row"><span class="rp-ol">Allies</span>${calls(v.allies)}<span class="rp-ol">Crawl</span>${SWARM.map(([value, label]) => option('swarm', value, label)).join('')}<button class="rp-o rp-clear" data-act="clear">Clear the range</button></div>
      </div>
      <div class="rp-sec">
        <h5>Rules</h5>
        <div class="rp-row"><span class="rp-ol">Ultimate</span>${CHARGING.map(([value, label]) => option('ultimate', value, label)).join('')}<button class="rp-o rp-go" data-act="recharge">Recharge now · Z</button></div>
        <div class="rp-row"><span class="rp-ol">Invulnerable</span>${GUARD.map(([value, label]) => option('invulnerable', value, label)).join('')}<span class="rp-ol">Lodestar</span><span class="rp-ship" data-st="ship"></span><button class="rp-o rp-go" data-act="ship">Ready now</button></div>
      </div>
      <div class="rp-sec rp-stats">
        <h5>Your damage<button class="rp-o" data-act="reset">Reset</button></h5>
        <div class="rp-st"><b data-st="dps"></b><span>a second, the last 5 s</span></div>
        <div class="rp-st"><b data-st="total"></b><span>dealt</span></div>
        <div class="rp-st"><b data-st="kills"></b><span>kills</span></div>
        <div class="rp-last" data-st="last"></div>
      </div>`;
    if (html !== this.lastPanel) {
      this.lastPanel = html;
      this.panel.innerHTML = shownHtml(html);
    }
    // What changes every frame is written into the panel as it stands.
    const put = (id: string, text: string) => {
      const el = this.panel.querySelector(`[data-st="${id}"]`);
      if (el && el.textContent !== text) el.textContent = text;
    };
    put('dps', num(v.stats.dps));
    put('total', num(v.stats.total));
    put('kills', String(v.stats.kills));
    put('last', v.stats.last);
    put('ship', v.ship);
    this.panel.querySelector('[data-act="ship"]')?.classList.toggle('dim', v.shipReady);
  }
}
