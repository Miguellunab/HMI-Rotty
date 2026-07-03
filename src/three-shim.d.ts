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
    updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
    getWorldPosition(target: Vector3): Vector3;
  }

  export class SphereGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number);
  }

  export class MeshBasicMaterial {
    depthTest: boolean;
    depthWrite: boolean;
    transparent: boolean;
    opacity: number;
    constructor(params?: Record<string, unknown>);
  }

  export class Mesh {
    name: string;
    position: Vector3;
    visible: boolean;
    renderOrder: number;
    material: MeshBasicMaterial;
    constructor(geometry?: unknown, material?: MeshBasicMaterial);
    updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
    getWorldPosition(target: Vector3): Vector3;
  }

  export const MathUtils: {
    degToRad(degrees: number): number;
  };
}
