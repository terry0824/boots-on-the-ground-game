import * as THREE from 'three';
import type { DamageStats } from './stats.ts';
import type { Entity } from './entity.ts';
import { SPLASH_METERS_PER_CELL } from './kinds.ts';
import type { World } from './world.ts';

/**
 * A Warhead Strike, the RTS way: a Seer paints the target with its laser and must hold
 * it there while the warhead falls (the game's 50 periods of 0.2 seconds); the Dispatch warns
 * everyone, "Warhead inbound". If the Seer dies or leaves its post, the strike is
 * lost. Then 300 damage (+200 against structures) in three rings, friend and foe alike.
 */
export class WarheadStrike {
  private t = 0;
  private marker: THREE.Mesh;
  private dropped = false;
  done = false;
  /** Called when it lands, with everything it killed. */
  onImpact: ((killed: Entity[]) => void) | null = null;
  /**
   * Where the laser leaves from, if not the painter's weapon as the world finds it: the player's
   * rifle as it shows (in first person, the rifle in the view).
   */
  origin: ((out: THREE.Vector3) => THREE.Vector3) | null = null;

  constructor(
    private world: World,
    readonly at: THREE.Vector3,
    private damage: DamageStats,
    /** Real seconds until impact. */
    readonly delay: number,
    readonly source: Entity | null,
    /** Where the Seer must stay (it may turn, not walk away). */
    private post: THREE.Vector3 | null,
  ) {
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.8, 40),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.copy(at).setY(world.terrain.heightAt(at.x, at.z) + 0.3);
    world.scene.add(this.marker);
    world.audio.play('warheadAlert', { bus: 'voice', volume: 1, priority: 10 });
    world.audio.play('warheadLaunch', { at, volume: 1, near: 30 });
  }

  /** Seconds left, for the HUD. */
  get remaining(): number {
    return Math.max(0, this.delay - this.t);
  }

  cancel() {
    if (this.done) return;
    this.done = true;
    this.world.scene.remove(this.marker);
  }

  update(dt: number) {
    if (this.done) return;
    this.t += dt;
    const s = this.source;
    if (s && (!s.alive || (this.post && Math.hypot(s.position.x - this.post.x, s.position.z - this.post.z) > 3))) {
      this.world.audio.play('shroudOff', { volume: 0.6 });
      this.cancel();
      return;
    }
    // The painting laser and the pulsing ring.
    const k = (this.t * 2) % 1;
    this.marker.scale.setScalar(1 + k * 1.5);
    (this.marker.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    if (s) {
      // From the rifle's muzzle, where it's held now.
      const from = this.origin ? this.origin(new THREE.Vector3()) : this.world.muzzle(s, new THREE.Vector3());
      this.world.effects.tracer(from, this.at, 0xff2010, 0.025, dt * 1.5 + 0.02);
      this.world.effects.flash(this.at, 0.8, 0xff3020, dt * 1.5 + 0.02);
    }
    if (!this.dropped && this.remaining < 2.2) {
      this.dropped = true;
      this.world.audio.play('warheadDrop', { at: this.at, volume: 1, near: 60 });
      this.world.audio.play('warheadIncoming', { at: this.at, volume: 0.9, near: 80 });
    }
    if (this.t >= this.delay) this.detonate();
  }

  private detonate() {
    this.cancel();
    const w = this.world;
    const rings = this.damage.splash.length ? this.damage.splash.map((r) => ({ ...r, radius: r.radius * SPLASH_METERS_PER_CELL })) : [{ radius: 16, fraction: 1, arc: 360 }, { radius: 24, fraction: 0.5, arc: 360 }, { radius: 32, fraction: 0.25, arc: 360 }];
    rings.sort((a, b) => a.radius - b.radius);
    const outer = rings[rings.length - 1].radius;
    const killed: Entity[] = [];
    for (const e of [...w.entities]) {
      if (!e.alive || e.stowed) continue;
      const d = Math.hypot(e.position.x - this.at.x, e.position.z - this.at.z) - e.radius;
      const ring = rings.find((r) => d <= r.radius);
      if (!ring) continue;
      const was = e.alive;
      e.hit(this.damage, this.source, ring.fraction, this.at, true);
      if (was && !e.alive) killed.push(e);
    }
    w.effects.warhead(this.at, outer * 0.5);
    w.effects.whiteout = 1;
    w.timed.push(new WarheadCloud(w.scene, this.at.clone().setY(w.terrain.heightAt(this.at.x, this.at.z)), outer * 0.7));
    w.audio.play('warheadImpact', { at: this.at, volume: 1.2, near: 120, priority: 10 });
    w.audio.play('warheadExplosion', { at: this.at, volume: 1.2, near: 150, priority: 10, delay: true });
    this.onImpact?.(killed);
  }
}

/** A soft round puff, for fire and smoke billboards. */
function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // A little noise so puffs read as cloud, not discs.
  const img = g.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] *= 0.75 + Math.random() * 0.25;
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let puff: THREE.Texture | null = null;

interface Puff {
  sprite: THREE.Sprite;
  /** Where it drifts toward, relative to ground zero, and when. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  size0: number;
  size1: number;
  start: number;
  life: number;
  fire: boolean;
}

/**
 * The mushroom cloud: a fireball swelling out of ground zero, burning down to smoke while a
 * column climbs and the cap rolls outward at its top; a shockwave ring of dust racing across
 * the ground. Big, slow sprites, played out over a dozen seconds.
 */
export class WarheadCloud {
  done = false;
  private t = 0;
  private group = new THREE.Group();
  private puffs: Puff[] = [];
  private ring: THREE.Mesh;
  private light: THREE.PointLight;

  constructor(
    private scene: THREE.Scene,
    readonly at: THREE.Vector3,
    readonly radius: number,
  ) {
    puff ??= puffTexture();
    const R = radius;
    const add = (fire: boolean, from: THREE.Vector3, to: THREE.Vector3, size0: number, size1: number, start: number, life: number) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: puff, transparent: true, depthWrite: false, blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !fire, opacity: 0 }),
      );
      sprite.material.rotation = Math.random() * Math.PI * 2;
      sprite.renderOrder = fire ? 12 : 11;
      this.group.add(sprite);
      this.puffs.push({ sprite, from, to, size0, size1, start, life, fire });
    };
    const rnd = (k: number) => (Math.random() - 0.5) * k;
    // The fireball.
    for (let i = 0; i < 26; i++) {
      const dir = new THREE.Vector3(rnd(2), Math.random() * 0.9 + 0.1, rnd(2)).normalize();
      add(true, dir.clone().multiplyScalar(R * 0.1), dir.clone().multiplyScalar(R * (0.35 + Math.random() * 0.3)).add(new THREE.Vector3(0, R * 0.5, 0)), R * 0.3, R * (0.7 + Math.random() * 0.4), Math.random() * 0.15, 2.2 + Math.random() * 1.2);
    }
    // The column, climbing.
    for (let i = 0; i < 26; i++) {
      const h = i / 26;
      add(false, new THREE.Vector3(rnd(R * 0.2), R * 0.2, rnd(R * 0.2)), new THREE.Vector3(rnd(R * 0.25), R * (0.4 + h * 1.8), rnd(R * 0.25)), R * 0.35, R * (0.5 + h * 0.3), 0.4 + h * 1.2, 9 + Math.random() * 3);
    }
    // The cap, rolling outward at the top.
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const r = R * (0.5 + Math.random() * 0.5);
      add(false, new THREE.Vector3(0, R * 1.7, 0), new THREE.Vector3(Math.cos(a) * r, R * (2.1 + rnd(0.4)), Math.sin(a) * r), R * 0.5, R * (0.8 + Math.random() * 0.4), 1.2 + Math.random() * 0.8, 9 + Math.random() * 3);
    }
    // Fire in the cap's belly, early on.
    for (let i = 0; i < 10; i++) {
      add(true, new THREE.Vector3(rnd(R * 0.3), R * 1.2, rnd(R * 0.3)), new THREE.Vector3(rnd(R * 0.8), R * 2, rnd(R * 0.8)), R * 0.4, R * 0.7, 0.8 + Math.random() * 0.6, 2.5 + Math.random());
    }
    // The shockwave along the ground.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xd8c4a0, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(0, 1.5, 0);
    this.group.add(this.ring);
    this.light = new THREE.PointLight(0xffb070, 0, R * 12, 1.4);
    this.light.position.set(0, R * 0.8, 0);
    this.group.add(this.light);
    this.group.position.copy(at);
    scene.add(this.group);
  }

  update(dt: number) {
    if (this.done) return;
    this.t += dt;
    const t = this.t;
    for (const p of this.puffs) {
      const k = (t - p.start) / p.life;
      if (k < 0 || k > 1) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.visible = true;
      const e = 1 - Math.pow(1 - Math.min(1, k * 1.6), 3);
      p.sprite.position.lerpVectors(p.from, p.to, e);
      p.sprite.scale.setScalar(THREE.MathUtils.lerp(p.size0, p.size1, e));
      const m = p.sprite.material;
      if (p.fire) {
        // White-hot to orange to deep red, then out.
        m.color.setHSL(0.02 + 0.1 * (1 - k), 1, 0.85 - k * 0.55);
        m.opacity = Math.min(1, k * 10) * (1 - k) * 0.9;
      } else {
        // Dark smoke, lit orange from within by the fire at first.
        const glow = Math.max(0, 1 - t / 4) * (p.to.y < this.radius * 1.2 ? 1 : 0.6);
        m.color.setRGB(0.2 + glow * 0.75, 0.16 + glow * 0.32, 0.13 + glow * 0.06);
        m.opacity = Math.min(1, k * 5) * Math.pow(1 - k, 0.5) * 0.95;
      }
    }
    // The shockwave: fast, then slowing, fading as it spreads.
    const ringR = this.radius * 3.2 * (1 - Math.exp(-t * 1.2));
    this.ring.scale.setScalar(Math.max(0.01, ringR));
    (this.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 * (1 - t / 4));
    this.light.intensity = 4000 * Math.max(0, 1 - t / 2.5) ** 2;
    if (t > 15) {
      this.done = true;
      this.scene.remove(this.group);
      for (const p of this.puffs) p.sprite.material.dispose();
      (this.ring.material as THREE.Material).dispose();
    }
  }
}
