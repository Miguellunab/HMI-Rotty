declare module "three" {
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    copy(value: Vector3): this;
    clone(): Vector3;
    add(value: Vector3): this;
    sub(value: Vector3): this;
    setLength(length: number): this;
    multiplyScalar(value: number): this;
  }

  export class Group {
    name: string;
    parent?: Group | null;
    position: Vector3;
    rotation: { z: number };
    add(...objects: unknown[]): void;
    attach(object: unknown): void;
  }

  export const MathUtils: {
    degToRad(degrees: number): number;
  };
}
