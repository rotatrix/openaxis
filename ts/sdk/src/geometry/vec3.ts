/** Immutable three-component vector in the caller's coordinate frame. */
export class Vec3 {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
  ) {}

  add(other: Vec3): Vec3 { return new Vec3(this.x + other.x, this.y + other.y, this.z + other.z) }
  sub(other: Vec3): Vec3 { return new Vec3(this.x - other.x, this.y - other.y, this.z - other.z) }
  mul(scale: number): Vec3 { return new Vec3(this.x * scale, this.y * scale, this.z * scale) }
  negated(): Vec3 { return new Vec3(-this.x, -this.y, -this.z) }
  dot(other: Vec3): number { return this.x * other.x + this.y * other.y + this.z * other.z }
  cross(other: Vec3): Vec3 {
    return new Vec3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }
  length(): number { return Math.sqrt(this.dot(this)) }
  normalized(): Vec3 {
    const length = this.length();
    return length > 1e-12 ? this.mul(1 / length) : new Vec3(0, 0, 0);
  }
  toArray(): [number, number, number] { return [this.x, this.y, this.z] }
  static fromArray(value: readonly [number, number, number]): Vec3 { return new Vec3(value[0], value[1], value[2]) }
}
