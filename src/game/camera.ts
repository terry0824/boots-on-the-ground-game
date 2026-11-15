import * as THREE from 'three';

export interface CameraPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

/** The player's chosen field of view for on-foot views (vehicles narrow it a little). */
export const view = { fov: 74 };

const helper = new THREE.Object3D();

/** A pose at `position` looking toward `target`. */
export function lookAtPose(position: THREE.Vector3, target: THREE.Vector3, fov: number): CameraPose {
  helper.position.copy(position);
  helper.up.set(0, 1, 0);
  helper.lookAt(target);
  // Object3D.lookAt points +Z at the target; cameras look down -Z, so turn around.
  helper.rotateY(Math.PI);
  return { position: position.clone(), quaternion: helper.quaternion.clone(), fov };
}

/** A pose at `position` looking along yaw (0 = +Z) and pitch (positive = up). */
export function yawPitchPose(position: THREE.Vector3, yaw: number, pitch: number, fov: number): CameraPose {
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  return lookAtPose(position, position.clone().add(dir), fov);
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Owns the one camera. Each frame the active mode (a unit's view or the command view) says
 * where it wants the camera; when the mode changes, the director sweeps from the old view to
 * the new one: the zoom out from a Trooper's shoulder up to the battlefield, and the dive back in.
 */
export class CameraDirector {
  private from: CameraPose | null = null;
  private t = 1;
  private duration = 1;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Sweeps from wherever the camera is now to the poses that follow, over `seconds`. */
  transition(seconds: number) {
    this.from = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov };
    this.t = 0;
    this.duration = seconds;
  }

  get transitioning(): boolean {
    return this.t < 1;
  }

  apply(dt: number, pose: CameraPose, shake = 0) {
    const cam = this.camera;
    if (this.from && this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.duration);
      const k = ease(this.t);
      // Rise first, then travel: arc the path upward so a long sweep reads as a zoom, not a slide.
      cam.position.lerpVectors(this.from.position, pose.position, k);
      cam.position.y += Math.sin(Math.PI * k) * this.from.position.distanceTo(pose.position) * 0.15;
      cam.quaternion.slerpQuaternions(this.from.quaternion, pose.quaternion, k);
      cam.fov = THREE.MathUtils.lerp(this.from.fov, pose.fov, k);
    } else {
      cam.position.copy(pose.position);
      cam.quaternion.copy(pose.quaternion);
      cam.fov = pose.fov;
    }
    if (shake > 0) cam.position.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shake * 0.35));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
