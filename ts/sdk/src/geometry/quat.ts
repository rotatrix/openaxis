import { Vec3 } from "./vec3.js";

/** Immutable quaternion in scalar-first (w, x, y, z) order. */
export class Quat {
  constructor(
    public readonly w: number,
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
  ) {}

  static readonly identity = new Quat(1, 0, 0, 0);

  multiply(other: Quat): Quat {
    return new Quat(
      this.w * other.w - this.x * other.x - this.y * other.y - this.z * other.z,
      this.w * other.x + this.x * other.w + this.y * other.z - this.z * other.y,
      this.w * other.y - this.x * other.z + this.y * other.w + this.z * other.x,
      this.w * other.z + this.x * other.y - this.y * other.x + this.z * other.w,
    );
  }

  normalize(): Quat {
    const length = Math.sqrt(this.w ** 2 + this.x ** 2 + this.y ** 2 + this.z ** 2);
    return length < 1e-12 ? Quat.identity : new Quat(this.w / length, this.x / length, this.y / length, this.z / length);
  }

  inverse(): Quat {
    const q = this.normalize();
    return new Quat(q.w, -q.x, -q.y, -q.z);
  }

  /** Spherical interpolation of unit quaternions along the shortest path. */
  slerp(other: Quat, t: number): Quat {
    let dot = this.w * other.w + this.x * other.x + this.y * other.y + this.z * other.z;
    if (dot < 0) {
      other = new Quat(-other.w, -other.x, -other.y, -other.z);
      dot = -dot;
    }
    if (dot > 0.9995) {
      return new Quat(
        this.w + t * (other.w - this.w),
        this.x + t * (other.x - this.x),
        this.y + t * (other.y - this.y),
        this.z + t * (other.z - this.z),
      ).normalize();
    }
    const theta = Math.acos(Math.min(dot, 1));
    const sinTheta = Math.sin(theta);
    const a = Math.sin((1 - t) * theta) / sinTheta;
    const b = Math.sin(t * theta) / sinTheta;
    return new Quat(a * this.w + b * other.w, a * this.x + b * other.x,
      a * this.y + b * other.y, a * this.z + b * other.z);
  }

  rotate(value: Vec3): Vec3 {
    const vector = new Vec3(this.x, this.y, this.z);
    const twiceCross = vector.cross(value).mul(2);
    return value.add(twiceCross.mul(this.w)).add(vector.cross(twiceCross));
  }

  toRotvec(): [number, number, number] {
    const q = this.w >= 0 ? this : new Quat(-this.w, -this.x, -this.y, -this.z);
    const vectorLength = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
    if (vectorLength < 1e-10) return [0, 0, 0];
    const scale = (2 * Math.atan2(vectorLength, q.w)) / vectorLength;
    return [q.x * scale, q.y * scale, q.z * scale];
  }

  static fromRotvec(wx: number, wy: number, wz: number): Quat {
    const theta = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (theta < 1e-10) return new Quat(1, wx * 0.5, wy * 0.5, wz * 0.5).normalize();
    const half = theta * 0.5;
    const scale = Math.sin(half) / theta;
    return new Quat(Math.cos(half), wx * scale, wy * scale, wz * scale);
  }

  static fromAxes(right: Vec3, up: Vec3, backward: Vec3): Quat {
    const m00 = right.x, m11 = up.y, m22 = backward.z;
    const m01 = up.x, m02 = backward.x;
    const m10 = right.y, m12 = backward.y;
    const m20 = right.z, m21 = up.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return new Quat(0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s);
    }
    if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return new Quat((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s);
    }
    if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return new Quat((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s);
    }
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return new Quat((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s);
  }
}
