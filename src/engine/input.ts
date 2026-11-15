export interface PointerEvent2 {
  type: 'down' | 'up';
  button: number;
  x: number;
  y: number;
  /** A second click on the same spot within the double-click window. */
  double: boolean;
}

/**
 * Free-look's edge band (a fraction of the window from each side) and how fast the view turns
 * with the cursor held at the very edge, in mouse pixels a second.
 */
const EDGE_BAND = { x: 0.12, y: 0.08 };
const EDGE_SPEED = { x: 950, y: 420 };

/** Keyboard and mouse state: pointer-locked mouse look on the ground, a free cursor in command. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private buttons = new Set<number>();
  private clicked = new Set<number>();
  private events: PointerEvent2[] = [];
  private lastDown = { time: 0, x: 0, y: 0, button: -1 };
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  /** Cursor position in CSS pixels. */
  readonly cursor = { x: 0, y: 0 };
  /** The real mouse has moved at least once (automated tests never move it). */
  cursorActive = false;
  /** Player settings: a multiplier on mouse look, and an inverted vertical axis. */
  sensitivity = 1;
  invertY = false;
  /**
   * Set when the browser won't capture the mouse (an embedded browser view, a refused request):
   * the game runs anyway, turning with the mouse's movement while the cursor stays free.
   */
  freeLook = false;
  /** Called once when the browser refuses to capture the mouse. */
  onLockRefused: (() => void) | null = null;
  /** The cursor is over the page (in free-look, the game pauses when it leaves). */
  inside = true;
  /** Called when the cursor leaves the page. */
  onLeave: (() => void) | null = null;

  /** `alwaysLocked` treats the pointer as locked, for automated testing where lock isn't granted. */
  constructor(
    private readonly element: HTMLElement,
    private readonly alwaysLocked = false,
  ) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Tab', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
    });
    element.addEventListener('mousedown', (e) => {
      this.buttons.add(e.button);
      this.clicked.add(e.button);
      const now = performance.now();
      const d = this.lastDown;
      const double = d.button === e.button && now - d.time < 320 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8;
      this.lastDown = { time: double ? 0 : now, x: e.clientX, y: e.clientY, button: e.button };
      this.events.push({ type: 'down', button: e.button, x: e.clientX, y: e.clientY, double });
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
      this.events.push({ type: 'up', button: e.button, x: e.clientX, y: e.clientY, double: false });
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.cursor.x = e.clientX;
      this.cursor.y = e.clientY;
      if (e.isTrusted) this.cursorActive = true;
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    // Out of the window and back (only a free cursor can leave).
    const leave = () => {
      if (!this.inside) return;
      this.inside = false;
      this.onLeave?.();
    };
    document.documentElement.addEventListener('mouseleave', leave);
    window.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) leave();
    });
    document.documentElement.addEventListener('mouseenter', () => (this.inside = true));
    window.addEventListener('mouseover', () => (this.inside = true));
    document.addEventListener('pointerlockerror', () => this.refused());
    // A real capture after all (a later click in a browser that allows it): back to normal.
    document.addEventListener('pointerlockchange', () => {
      if (this.reallyLocked) this.freeLook = false;
    });
  }

  private refused() {
    if (this.freeLook) return;
    this.freeLook = true;
    this.onLockRefused?.();
  }

  get locked(): boolean {
    return this.alwaysLocked || this.freeLook || document.pointerLockElement === this.element;
  }

  /** True when the real pointer lock is held (always false in test mode). */
  get reallyLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /**
   * Asks for the mouse. A refusal drops to free-look so the game goes on, but every later
   * click asks again: a browser that refuses for a moment (Chrome won't re-lock for a second
   * after Esc) shouldn't leave the cursor free for the rest of the session.
   */
  lock() {
    if (this.reallyLocked) return;
    if (!this.element.requestPointerLock) {
      this.refused();
      return;
    }
    try {
      // Newer browsers return a promise that rejects when they refuse.
      const p = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.refused());
    } catch {
      this.refused();
    }
  }

  /**
   * Free-look's stand-in for a captured mouse, called each frame on the ground: the cursor
   * can't be held in the window, so held near an edge it keeps the view turning that way,
   * faster the closer it is.
   */
  edgeTurn(dt: number) {
    if (!this.freeLook || this.reallyLocked || !this.inside || !this.cursorActive) return;
    const band = (pos: number, size: number, frac: number) => {
      const b = size * frac;
      if (pos < b) return -(1 - Math.max(0, pos) / b);
      if (pos > size - b) return 1 - Math.max(0, size - pos) / b;
      return 0;
    };
    const kx = band(this.cursor.x, window.innerWidth, EDGE_BAND.x);
    const ky = band(this.cursor.y, window.innerHeight, EDGE_BAND.y);
    // Eased in, so brushing the band barely turns.
    this.dx += kx * Math.abs(kx) * EDGE_SPEED.x * dt;
    this.dy += ky * Math.abs(ky) * EDGE_SPEED.y * dt;
  }

  unlock() {
    if (this.reallyLocked) document.exitPointerLock();
  }

  /**
   * The keyboard is a panel's this frame (The Tide's requisition board, which reads it first):
   * every other reader sees no keys held or pressed. The mouse is unaffected.
   */
  muted = false;

  down(code: string): boolean {
    return !this.muted && this.keys.has(code);
  }

  /** True once per key press. */
  hit(code: string): boolean {
    return !this.muted && this.pressed.has(code);
  }

  /** Uses up this frame's press of a key, so later readers don't act on it too. */
  swallow(code: string) {
    this.pressed.delete(code);
  }

  mouse(button: number): boolean {
    return this.buttons.has(button);
  }

  mouseHit(button: number): boolean {
    return this.clicked.has(button);
  }

  /** Uses up this frame's press of a mouse button (and its events), so later readers don't act on it too. */
  swallowMouse(button: number) {
    this.clicked.delete(button);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].button === button) this.events.splice(i, 1);
  }

  /** Mouse buttons pressed and released since the last frame, with cursor positions. */
  pointerEvents(): readonly PointerEvent2[] {
    return this.events;
  }

  /** Mouse movement and wheel since the last frame. */
  consume(): { dx: number; dy: number; wheel: number } {
    const out = { dx: this.dx * this.sensitivity, dy: this.dy * this.sensitivity * (this.invertY ? -1 : 1), wheel: this.wheel };
    this.dx = this.dy = this.wheel = 0;
    return out;
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
    this.events.length = 0;
  }
}
