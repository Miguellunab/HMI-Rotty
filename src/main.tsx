import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import "@google/model-viewer";
import { $primitivesList } from "@google/model-viewer/lib/features/scene-graph/model.js";
import { Group, MathUtils, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from "three";
import dmLogo from "./assets/brand/dm-logo.png";
import "./styles.css";

type AxisName = "X" | "Y" | "Z" | "W";
type BaudRate = 115200;
type View = "home" | "control" | "inverse";
type SendCommand = (command: string, waitsForStatus?: boolean) => void | Promise<void>;
type AxisPose = Record<AxisName, number>;
type GripperPose = "open" | "close";
type ElbowMode = "auto" | "positive" | "negative";
type SceneObject = Group;
type MarkerName = "origin" | "shoulder" | "elbow" | "wrist" | "effector";

interface ScaraGeometry {
  link1Mm: number;
  link2Mm: number;
  link1AngleDeg: number;
  link2AngleDeg: number;
  zOffsetMm: number;
  limits: AxisPose;
}

interface PointMm {
  x: number;
  y: number;
}

interface TargetMm extends PointMm {
  z: number;
}

interface InverseKinematicsResult {
  ok: boolean;
  reason?: string;
  pose: AxisPose;
  elbow: Exclude<ElbowMode, "auto">;
  commands: string[];
}

interface ForwardKinematics {
  valid: boolean;
  origin: PointMm;
  shoulder: PointMm;
  elbow: PointMm;
  wrist: PointMm;
  effector: PointMm;
  z: number;
}

type RobotViewer = HTMLElement & {
  model?: { [$primitivesList]?: { mesh: SceneObject }[] };
};

interface Rig {
  x: Group;
  y: Group;
  z: Group;
  w: Group;
  markers: Record<MarkerName, Mesh>;
  jaws: { part: SceneObject; open: Vector3; close: Vector3 }[];
}

interface AxisStatus {
  homed: boolean;
  steps: number;
  unit: "deg" | "mm";
  pos: number;
  speed_sps: number;
  speed_us?: number;
  limit_configured?: boolean;
  limit: boolean;
}

interface MachineStatus {
  ok: true;
  type: "status";
  axes: Record<AxisName, AxisStatus>;
  gripper?: {
    ready: boolean;
    state: "open" | "close" | "custom";
    user_angle: number;
    physical_angle: number;
    open_user_angle: number;
    close_user_angle: number;
  };
  drivers_enabled?: boolean;
}

interface SerialEvent {
  direction: "tx" | "rx" | "error";
  line: string;
  timestamp: number;
}

const axes: AxisName[] = ["X", "Y", "Z", "W"];
const robotPivots = {
  x: new Vector3(0.0425, 0, -0.0175),
  y: new Vector3(0.2645644849, -0.0008773029, -0.1530041905),
  w: new Vector3(0.4053553898, 0.0199586406, -0.1470041904),
};
const zAxisBaseOffsetMm = 40;
const xHomeDeg = 90;
const zAxisTravelMm = 170;
const yPreviewOffsetDeg = -8;
const wPreviewOffsetDeg = 50;
const previewPlasticBlack = 0x202426;
const previewMotorGray = 0x918981;
const gripperCloseTravelM = 0.02;
const radToDeg = 180 / Math.PI;
const markerOffsets = {
  origin: new Vector3(0, 0, 0.12),
  shoulder: new Vector3(0, 0, -0.25),
  elbow: new Vector3(0, 0, -0.053),
  wrist: new Vector3(0, 0, -0.06),
  effector: new Vector3(0, 0.015, 0.07),
};
const scaraGeometry: ScaraGeometry = {
  ...makeScaraGeometry(),
  limits: { X: 90, Y: 90, Z: zAxisTravelMm, W: 90 },
};
const robotRigs = new WeakMap<RobotViewer, Rig>();
const xOnlyParts = new Set([
  "J1 coupler_J1 coupler",
  "Z-axis Bottom Plate_Z-axis Bottom Plate",
  "Base cover_Base cover",
  "Top cover_Top cover",
  "Z-axis Top Plate_Z-axis Top Plate",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm001",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm002",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm003",
]);
const zAxisParts = new Set([
  "brazodelcontrapeso_Arm 1",
  "tapa_brazo_contrapeso_Arm 1 Cover",
  "Stepper NEMA 17 -  20mm shaft_Stepper NEMA 17 -  20mm shaft002",
  "Z-axis Mount Platform_Z-axis Mount Platform",
  "Arm 1_Arm 1",
  "Arm 1 Cover_Arm 1 Cover",
  "soporte_rodamiento_6mm",
  "flat head screw_am_B18.6.7M - M6 x 1.0 x 50 Type I Cross Recessed FHMS --50C",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm001",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm002",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm003",
]);
const yAxisParts = new Set([
  "J2 Coupler_J2 Coupler",
  "Arm 2_Arm 2",
  "Arm 2 Cover_Arm 2 Cover",
  "NEMA 17 Stepper L24mm - 20mm shaft_NEMA 17 Stepper L24mm - 20mm shaft",
]);
const wAxisParts = new Set([
  "J3 Coupler_J3 Coupler",
  "ba_glipper",
  "User Library-MG996R",
]);
const blackPreviewParts = new Set([
  "Base cover_Base cover",
  "Z-axis Bottom Plate_Z-axis Bottom Plate",
  "J1 coupler_J1 coupler",
  "Z-axis Mount Platform_Z-axis Mount Platform",
  "Arduino UNO case p1_Arduino UNO case p1",
  "Arduino UNO case p2_Arduino UNO case p2",
  "soporte_rodamiento_6mm",
  "brazodelcontrapeso_Arm 1",
  "tapa_brazo_contrapeso_Arm 1 Cover",
  "J2 Coupler_J2 Coupler",
  "J3 Coupler_J3 Coupler",
  "Arm 2_Arm 2",
  "Arm 2 Cover_Arm 2 Cover",
  "ba_glipper",
  "Base.step",
  "Rack.step",
  "Rack.step001",
  "SpurGear-14_teeth.step",
  "Jaw",
  "Jaw001",
]);
const oldNemaPreviewParts = new Set([
  "Stepper NEMA 17 -  20mm shaft_Stepper NEMA 17 -  20mm shaft",
  "Stepper NEMA 17 -  20mm shaft_Stepper NEMA 17 -  20mm shaft001",
  "Stepper NEMA 17 -  20mm shaft_Stepper NEMA 17 -  20mm shaft002",
]);
const normalizePartName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const xOnlyPartKeys = new Set([...xOnlyParts].map(normalizePartName));
const zAxisPartKeys = new Set([...zAxisParts].map(normalizePartName));
const yAxisPartKeys = new Set([...yAxisParts].map(normalizePartName));
const wAxisPartKeys = new Set([...wAxisParts].map(normalizePartName));
const blackPreviewPartKeys = new Set([...blackPreviewParts].map(normalizePartName));
const oldNemaPreviewPartKeys = new Set([...oldNemaPreviewParts].map(normalizePartName));
const fallbackStatus: MachineStatus = {
  ok: true,
  type: "status",
  axes: {
    X: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 714, limit: false },
    Y: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 714, limit: false },
    Z: { homed: false, steps: 0, unit: "mm", pos: 0, speed_sps: 714, limit: false },
    W: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 556, limit: false },
  },
  gripper: {
    ready: false,
    state: "open",
    user_angle: 80,
    physical_angle: 170,
    open_user_angle: 80,
    close_user_angle: -90,
  },
  drivers_enabled: false,
};

function statusPose(status: MachineStatus): AxisPose {
  return {
    X: status.axes.X.pos,
    Y: status.axes.Y.pos,
    Z: status.axes.Z.pos,
    W: status.axes.W.pos,
  };
}

function normalizeStatus(status: MachineStatus): MachineStatus {
  const x = status.axes.X;
  const z = status.axes.Z;
  return {
    ...status,
    axes: {
      ...status.axes,
      X: x.homed ? { ...x, pos: xHomeDeg + x.pos } : x,
      Z: z.homed ? { ...z, pos: zAxisTravelMm + z.pos } : z,
    },
  };
}

function horizontalDistanceMm(a: Vector3, b: Vector3) {
  return Math.hypot(b.x - a.x, b.y - a.y) * 1000;
}

function rotatePoint(point: PointMm, degrees: number): PointMm {
  const angle = MathUtils.degToRad(degrees);
  return {
    x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
  };
}

function addPoint(a: PointMm, b: PointMm): PointMm {
  return { x: a.x + b.x, y: a.y + b.y };
}

function vectorAngleDeg(point: PointMm) {
  return Math.atan2(point.y, point.x) * radToDeg;
}

function makeScaraGeometry() {
  const link1 = {
    x: (robotPivots.y.x - robotPivots.x.x) * 1000,
    y: (robotPivots.y.y - robotPivots.x.y) * 1000,
  };
  const link2 = {
    x: (robotPivots.w.x - robotPivots.y.x) * 1000,
    y: (robotPivots.w.y - robotPivots.y.y + markerOffsets.effector.y) * 1000,
  };
  const zOffsetMm = -(zAxisBaseOffsetMm / 1000 + (robotPivots.y.z - robotPivots.x.z) + (robotPivots.w.z - robotPivots.y.z) + markerOffsets.effector.z + 0.035 - 0.03) * 1000;
  return {
    link1Mm: Math.hypot(link1.x, link1.y),
    link2Mm: Math.hypot(link2.x, link2.y),
    link1AngleDeg: vectorAngleDeg(link1),
    link2AngleDeg: vectorAngleDeg(link2),
    zOffsetMm,
  };
}

function forwardKinematics(status: MachineStatus, geometry: ScaraGeometry, pose = statusPose(status)): ForwardKinematics {
  const link1 = rotatePoint({ x: geometry.link1Mm, y: 0 }, pose.X + geometry.link1AngleDeg);
  const link2 = rotatePoint({ x: geometry.link2Mm, y: 0 }, pose.X + pose.Y + geometry.link2AngleDeg);
  const elbow = {
    x: link1.x,
    y: link1.y,
  };
  const effector = addPoint(elbow, link2);

  return {
    valid: status.axes.X.homed && status.axes.Y.homed && status.axes.Z.homed,
    origin: { x: 0, y: 0 },
    shoulder: { x: 0, y: 0 },
    elbow,
    wrist: effector,
    effector,
    z: geometry.zOffsetMm + pose.Z,
  };
}

function clampAxis(name: AxisName, value: number, geometry = scaraGeometry) {
  return Math.min(geometry.limits[name], Math.max(name === "Z" ? 0 : -geometry.limits[name], value));
}

function roundAxis(value: number) {
  return Math.round(value);
}

function formatAxisValue(value: number) {
  return String(roundAxis(value));
}

function angleDelta(a: number, b: number) {
  return Math.abs(a - b);
}

function inverseKinematics(target: TargetMm, geometry: ScaraGeometry, currentPose: AxisPose, elbowMode: ElbowMode = "auto"): InverseKinematicsResult {
  const x = Number.isFinite(target.x) ? target.x : 0;
  const y = Number.isFinite(target.y) ? target.y : 0;
  const z = Number.isFinite(target.z) ? target.z : 0;
  const radius = Math.hypot(x, y);
  const minReach = Math.abs(geometry.link1Mm - geometry.link2Mm);
  const maxReach = geometry.link1Mm + geometry.link2Mm;
  const basePose = { ...currentPose, Z: clampAxis("Z", z - geometry.zOffsetMm, geometry) };

  if (z < geometry.zOffsetMm || basePose.Z !== z - geometry.zOffsetMm) {
    return { ok: false, reason: `Z fuera de limite: 0..${geometry.limits.Z} mm`, pose: basePose, elbow: "positive", commands: [] };
  }

  if (radius < minReach || radius > maxReach) {
    return { ok: false, reason: `Fuera de alcance XY: ${minReach.toFixed(1)}..${maxReach.toFixed(1)} mm`, pose: basePose, elbow: "positive", commands: [] };
  }

  const cosY = Math.min(1, Math.max(-1, (x * x + y * y - geometry.link1Mm ** 2 - geometry.link2Mm ** 2) / (2 * geometry.link1Mm * geometry.link2Mm)));
  const angleOffset = geometry.link2AngleDeg - geometry.link1AngleDeg;
  const solutions = ([1, -1] as const).map((sign) => {
    const gamma = sign * Math.acos(cosY);
    const phi = Math.atan2(y, x) - Math.atan2(geometry.link2Mm * Math.sin(gamma), geometry.link1Mm + geometry.link2Mm * Math.cos(gamma));
    const pose = {
      X: phi * radToDeg - geometry.link1AngleDeg,
      Y: gamma * radToDeg - angleOffset,
      Z: basePose.Z,
      W: currentPose.W,
    };
    return {
      elbow: (sign > 0 ? "positive" : "negative") as Exclude<ElbowMode, "auto">,
      pose,
      valid: pose.X === clampAxis("X", pose.X, geometry) && pose.Y === clampAxis("Y", pose.Y, geometry),
      distance: angleDelta(pose.X, currentPose.X) + angleDelta(pose.Y, currentPose.Y) + Math.abs(pose.Z - currentPose.Z),
    };
  });
  const selected = (elbowMode === "auto" ? solutions.filter((item) => item.valid).sort((a, b) => a.distance - b.distance)[0] : solutions.find((item) => item.elbow === elbowMode)) ?? solutions[0];
  const pose = { ...selected.pose, X: clampAxis("X", selected.pose.X, geometry), Y: clampAxis("Y", selected.pose.Y, geometry) };
  if (!selected.valid) {
    return { ok: false, reason: "La solucion requiere angulos fuera de -90..90 grados", pose, elbow: selected.elbow, commands: [] };
  }

  const xyCommands = [`MOVE X DEG ${formatAxisValue(pose.X - currentPose.X)}`, `MOVE Y DEG ${formatAxisValue(pose.Y - currentPose.Y)}`];
  const zCommand = `MOVE Z MM ${formatAxisValue(pose.Z - currentPose.Z)}`;
  const commands = pose.Z > currentPose.Z ? [zCommand, ...xyCommands] : [...xyCommands, zCommand];
  return { ok: true, pose, elbow: selected.elbow, commands, reason: undefined };
}

function markerPointMm(rig: Rig, name: MarkerName, origin: Vector3) {
  rig.markers[name].updateWorldMatrix(true, false);
  const point = rig.markers[name].getWorldPosition(new Vector3()).sub(origin);
  return { x: point.x * 1000, y: point.y * 1000 };
}

function measuredKinematics(status: MachineStatus, rig: Rig): ForwardKinematics {
  rig.markers.origin.updateWorldMatrix(true, false);
  const origin = rig.markers.origin.getWorldPosition(new Vector3());
  rig.markers.effector.updateWorldMatrix(true, false);
  const effector = rig.markers.effector.getWorldPosition(new Vector3()).sub(origin);

  return {
    valid: status.axes.X.homed && status.axes.Y.homed && status.axes.Z.homed,
    origin: { x: 0, y: 0 },
    shoulder: markerPointMm(rig, "shoulder", origin),
    elbow: markerPointMm(rig, "elbow", origin),
    wrist: markerPointMm(rig, "wrist", origin),
    effector: { x: effector.x * 1000, y: effector.y * 1000 },
    z: -effector.z * 1000,
  };
}

function queueModelRender(viewer: RobotViewer) {
  const scene = Object.getOwnPropertySymbols(viewer)
    .map((symbol) => (viewer as unknown as Record<symbol, { queueRender?: () => void }>)[symbol])
    .find((value) => typeof value?.queueRender === "function");
  scene?.queueRender?.();
}

function localPivot(child: Vector3, parent: Vector3) {
  return new Vector3(child.x - parent.x, child.y - parent.y, child.z - parent.z);
}

function makeMarker(color: number, radius = 0.022) {
  const marker = new Mesh(
    new SphereGeometry(radius, 24, 16),
    new MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    }),
  );
  marker.renderOrder = 999;
  marker.visible = false;
  return marker;
}

function makeKinematicMarkers() {
  return {
    origin: makeMarker(0x0b7cff, 0.026),
    shoulder: makeMarker(0xffe033, 0.022),
    elbow: makeMarker(0x69d64b, 0.024),
    wrist: makeMarker(0xff4b36, 0.026),
    effector: makeMarker(0xffffff, 0.022),
  };
}

function paintPreviewPart(part: SceneObject, color: number, materialColors?: Record<string, number>) {
  (part as any).traverse((object: any) => {
    const mesh = object as Mesh & { material?: any };
    if (!mesh.material) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((material) => material.clone()) : mesh.material.clone();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!("color" in material)) continue;
      const materialColor = materialColors?.[material.name] ?? color;
      if (materialColors && !(material.name in materialColors)) continue;
      material.color.setHex(materialColor);
      if ("roughness" in material) material.roughness = 0.72;
      if ("metalness" in material) material.metalness = 0.05;
    }
  });
}

function applyMarkerOffsets(rig: Rig) {
  rig.markers.origin.position.copy(robotPivots.x.clone().add(new Vector3(0, 0, -0.09)).add(markerOffsets.origin));
  rig.markers.shoulder.position.copy(new Vector3(0, 0, 0.035).add(markerOffsets.shoulder));
  rig.markers.elbow.position.copy(new Vector3(0, 0, 0.035).add(markerOffsets.elbow));
  rig.markers.wrist.position.copy(new Vector3(0, 0, 0.035).add(markerOffsets.wrist));
  rig.markers.effector.position.copy(new Vector3(0, 0, 0.035).add(markerOffsets.effector));
}

function setupRobotRig(viewer: RobotViewer): Rig | null {
  const existing = robotRigs.get(viewer);
  if (existing) return existing;

  const firstMesh = viewer.model?.[$primitivesList]?.[0]?.mesh;
  const root = firstMesh?.parent?.parent ?? firstMesh?.parent;
  if (!root?.add || !viewer.model?.[$primitivesList]) return null;

  const x = new Group();
  const z = new Group();
  const y = new Group();
  const w = new Group();
  x.name = "sim_X_base";
  z.name = "sim_Z_lift";
  y.name = "sim_Y_link";
  w.name = "sim_W_wrist";
  x.position.copy(robotPivots.x);
  z.position.copy(new Vector3(0, 0, 0));
  y.position.copy(localPivot(robotPivots.y, robotPivots.x));
  w.position.copy(localPivot(robotPivots.w, robotPivots.y));

  root.add(x);
  x.add(z);
  z.add(y);
  y.add(w);
  const markers = makeKinematicMarkers();
  root.add(markers.origin);
  z.add(markers.shoulder);
  y.add(markers.elbow);
  w.add(markers.wrist);
  w.add(markers.effector);

  let xParts = 0;
  let zParts = 0;
  let yParts = 0;
  let wParts = 0;
  const attached = new Set();
  const jawParts: SceneObject[] = [];
  for (const { mesh } of viewer.model[$primitivesList]) {
    const part = mesh.parent ?? mesh;
    const name = part.name || "";
    const primitiveName = mesh.name || "";
    const normalizedNames = `${normalizePartName(name)} ${normalizePartName(primitiveName)}`;
    const key = normalizePartName(name);
    const primitiveKey = normalizePartName(primitiveName);
    const isJaw = key === "jaw" || key === "jaw001" || primitiveKey === "jaw" || primitiveKey === "jaw001";
    if (attached.has(part)) continue;
    if (blackPreviewPartKeys.has(key) || blackPreviewPartKeys.has(primitiveKey)) paintPreviewPart(part, previewPlasticBlack);
    if (oldNemaPreviewPartKeys.has(key) || oldNemaPreviewPartKeys.has(primitiveKey)) {
      paintPreviewPart(part, previewPlasticBlack, { mat_0: previewMotorGray, mat_1: previewMotorGray, mat_2: previewMotorGray, mat_3: previewPlasticBlack });
    }
    if (wAxisPartKeys.has(key) || wAxisPartKeys.has(primitiveKey) || /basestep|rackstep|spurgear|jaw/.test(normalizedNames)) {
      w.attach(part);
      wParts += 1;
    } else if (yAxisPartKeys.has(key) || yAxisPartKeys.has(primitiveKey)) {
      y.attach(part);
      yParts += 1;
    } else if (zAxisPartKeys.has(key) || zAxisPartKeys.has(primitiveKey)) {
      z.attach(part);
      zParts += 1;
    } else if (xOnlyPartKeys.has(key) || xOnlyPartKeys.has(primitiveKey)) {
      x.attach(part);
      xParts += 1;
    } else {
      continue;
    }
    attached.add(part);
    if (isJaw) jawParts.push(part);
  }

  const jawCenter = jawParts.reduce((center, part) => center.add(part.position), new Vector3()).multiplyScalar(jawParts.length ? 1 / jawParts.length : 0);
  const jaws = jawParts.map((part) => {
    const open = part.position.clone();
    const close = open.clone().add(jawCenter.clone().sub(open).setLength(gripperCloseTravelM));
    return { part, open, close };
  });
  viewer.dataset.rigged = "true";
  viewer.dataset.xParts = String(xParts);
  viewer.dataset.zParts = String(zParts);
  viewer.dataset.yParts = String(yParts);
  viewer.dataset.wParts = String(wParts);
  const rig = { x, y, z, w, markers, jaws };
  applyMarkerOffsets(rig);
  robotRigs.set(viewer, rig);
  return rig;
}

function applyRobotPose(viewer: RobotViewer | null, pose: AxisPose, gripper: GripperPose = "open", showKinematics = false) {
  if (!viewer) return null;
  const rig = setupRobotRig(viewer);
  if (!rig) return null;
  applyMarkerOffsets(rig);
  rig.x.rotation.z = MathUtils.degToRad(pose.X);
  rig.y.rotation.z = MathUtils.degToRad(pose.Y + yPreviewOffsetDeg);
  rig.z.position.z = (zAxisBaseOffsetMm - pose.Z) / 1000;
  rig.w.rotation.z = MathUtils.degToRad(pose.W + wPreviewOffsetDeg);
  for (const jaw of rig.jaws) jaw.part.position.copy(gripper === "close" ? jaw.close : jaw.open);
  updateKinematicMarkers(rig, showKinematics);
  viewer.dataset.poseX = String(pose.X);
  viewer.dataset.poseY = String(pose.Y);
  viewer.dataset.poseZ = String(pose.Z);
  viewer.dataset.poseW = String(pose.W);
  viewer.dataset.gripper = gripper;
  queueModelRender(viewer);
  return rig;
}

function updateKinematicMarkers(rig: Rig, visible: boolean) {
  for (const marker of Object.values(rig.markers)) marker.visible = visible;
}

function formatConnectionError(error: unknown) {
  const message = String(error);
  if (/access is denied|acceso denegado|os error 5/i.test(message)) {
    return "Acceso denegado al puerto serial. Cierra Arduino IDE/Serial Monitor/u otra HMI que este usando ese COM, desconecta y conecta el USB, y vuelve a intentar.";
  }
  return message;
}

function isStatus(value: unknown): value is MachineStatus {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === true &&
      (value as { type?: unknown }).type === "status" &&
      (value as { axes?: unknown }).axes,
  );
}

function isHeartbeatLog(entry: SerialEvent) {
  return (entry.direction === "tx" && entry.line === "PING") || (entry.direction === "rx" && entry.line === '{"ok":true,"type":"pong"}');
}

function moveAxisFromCommand(command: string): AxisName | null {
  const axis = command.match(/^MOVE\s+([XYZW])\b/i)?.[1]?.toUpperCase();
  return axis && axes.includes(axis as AxisName) ? axis as AxisName : null;
}

function App() {
  const [view, setView] = useState<View>("home");
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<MachineStatus>(fallbackStatus);
  const [previewPose, setPreviewPose] = useState<AxisPose>(() => statusPose(fallbackStatus));
  const [previewGripper, setPreviewGripper] = useState<GripperPose>("open");
  const [logs, setLogs] = useState<SerialEvent[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logoHidden, setLogoHidden] = useState(false);
  const [baudRate, setBaudRate] = useState<BaudRate>(115200);
  const [manualCommand, setManualCommand] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const connectedRef = useRef(false);
  const lastRxAt = useRef(Date.now());
  const commandQueueRef = useRef<string[]>([]);

  const disabled = !connected || busy;

  function logError(error: unknown) {
    const message = formatConnectionError(error);
    setConnectionError(message);
    setLogs((items) => [{ direction: "error", line: message, timestamp: Date.now() }, ...items]);
  }

  async function refreshPorts() {
    setConnectionError("");
    if (!("__TAURI_INTERNALS__" in window)) {
      throw new Error("Abre la app de Tauri, no la pagina de Vite en el navegador.");
    }
    const names = await invoke<string[]>("list_ports");
    setPorts(names);
    setPort((current) => (names.includes(current) ? current : names[0] || current));
    if (names.length === 0) {
      setConnectionError("No se detectaron puertos. Si Arduino IDE muestra uno, escribelo manualmente, por ejemplo COM4.");
    }
  }

  async function sendCommand(command: string, waitsForStatus = true) {
    if (!connected || busy) return;
    const moveAxis = moveAxisFromCommand(command);
    if (moveAxis && !status.axes[moveAxis].homed) {
      setConnectionError(`Haz HOME ${moveAxis} antes de mover el eje ${moveAxis}.`);
      return;
    }
    if (waitsForStatus) setBusy(true);
    try {
      await invoke("send_command", { command });
    } catch (error) {
      setBusy(false);
      logError(error);
    }
  }

  async function sendNextQueuedCommand() {
    const command = commandQueueRef.current.shift();
    if (!command) {
      setBusy(false);
      return;
    }
    try {
      await invoke("send_command", { command });
    } catch (error) {
      commandQueueRef.current = [];
      setBusy(false);
      logError(error);
    }
  }

  function sendCommandSequence(commands: string[]) {
    if (!connected || busy || commands.length === 0) return;
    const moveAxis = commands.map(moveAxisFromCommand).find((axis) => axis && !status.axes[axis].homed);
    if (moveAxis) {
      setConnectionError(`Haz HOME ${moveAxis} antes de mover el eje ${moveAxis}.`);
      return;
    }
    commandQueueRef.current = [...commands];
    setBusy(true);
    sendNextQueuedCommand();
  }

  async function connect() {
    if (!port) return;
    setConnectionError("");
    await invoke("connect", { portName: port, baudRate }).catch((error) => {
      throw new Error(formatConnectionError(error));
    });
    lastRxAt.current = Date.now();
    connectedRef.current = true;
    setConnected(true);
    await invoke("send_command", { command: "PING" });
    await invoke("send_command", { command: "STATUS" });
  }

  async function disconnect() {
    await invoke("disconnect");
    commandQueueRef.current = [];
    connectedRef.current = false;
    setConnected(false);
    setBusy(false);
  }

  async function checkForUpdate() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      setUpdate(await check());
    } catch {
      setUpdate(null);
    }
  }

  async function installUpdate() {
    if (!update) return;
    setUpdateBusy(true);
    setUpdateMessage("Preparando actualizacion...");
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength || 0;
          downloadedBytes = 0;
          setUpdateMessage("Descargando actualizacion...");
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdateMessage(totalBytes ? `Descargando ${Math.round((downloadedBytes / totalBytes) * 100)}%...` : "Descargando actualizacion...");
        } else {
          setUpdateMessage("Instalando y reiniciando...");
        }
      });
      await relaunch();
    } catch (error) {
      setUpdateBusy(false);
      setUpdateMessage("No se pudo instalar la actualizacion.");
      logError(error);
    }
  }

  useEffect(() => {
    const isTauri = "__TAURI_INTERNALS__" in window;
    if (isTauri) refreshPorts().catch(logError);
    checkForUpdate();

    const unlisten = isTauri ? listen<SerialEvent>("serial-event", (event) => {
      const entry = event.payload;
      if (!isHeartbeatLog(entry)) {
        setLogs((items) => [entry, ...items].slice(0, 300));
      }

      if (entry.direction === "error" && connectedRef.current) {
        commandQueueRef.current = [];
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError(`Conexion serial perdida: ${entry.line}`);
        return;
      }

      if (entry.direction !== "rx") return;
      lastRxAt.current = Date.now();

      try {
        const parsed: unknown = JSON.parse(entry.line);
        if (isStatus(parsed)) {
          const status = normalizeStatus(parsed);
          setStatus(status);
          setPreviewPose(statusPose(status));
          setPreviewGripper(status.gripper?.state === "close" ? "open" : "close");
          if (commandQueueRef.current.length > 0) {
            sendNextQueuedCommand();
          } else {
            setBusy(false);
          }
        } else if ((parsed as { ok?: boolean }).ok === false) {
          commandQueueRef.current = [];
          setBusy(false);
        }
      } catch {
        setLogs((items) => [{ direction: "error" as const, line: `JSON invalido: ${entry.line}`, timestamp: Date.now() }, ...items].slice(0, 300));
      }
    }) : Promise.resolve(() => undefined);

    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
    if (!connected) return;

    const timer = window.setInterval(async () => {
      if (busy) return;

      if (Date.now() - lastRxAt.current > 6000) {
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError("Conexion serial perdida: no responde PING.");
        await invoke("disconnect").catch(() => undefined);
        return;
      }

      try {
        await invoke("send_command", { command: "PING" });
      } catch (error) {
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError(`Conexion serial perdida: ${String(error)}`);
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [connected, busy]);

  const serialConsole = (
    <SerialConsole
      open={consoleOpen}
      logs={logs}
      command={manualCommand}
      disabled={disabled}
      onToggle={() => setConsoleOpen((value) => !value)}
      onCommandChange={setManualCommand}
      onSubmit={() => {
        const command = manualCommand.trim().toUpperCase();
        if (command) sendCommand(command);
        setManualCommand("");
      }}
    />
  );

  return (
    <main className="appShell">
      <aside className="sideRail">
        <div className="appBrand">
          <p><span>HMI</span> <strong>Rotty</strong></p>
          <small>BRAZO SCADA</small>
        </div>

        <nav className="navTabs" aria-label="Menu principal">
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
            <span className="navIcon">⌂</span>
            <span>Home</span>
          </button>
          <button className={view === "control" ? "active" : ""} onClick={() => setView("control")}>
            <span className="navIcon">⚙</span>
            <span>Control</span>
          </button>
          <button className={view === "inverse" ? "active" : ""} onClick={() => setView("inverse")}>
            <span className="navIcon">IK</span>
            <span>Inversa</span>
          </button>
          <button disabled><span className="navIcon">⤴</span><span>Trayectorias</span></button>
        </nav>

        <LogoBlock hidden={logoHidden} onToggle={() => setLogoHidden((value) => !value)} />
      </aside>

      <section className="screen">
        <header className="topBar">
          <div>
            <p className="sectionKicker">{view === "home" ? "Panel principal" : view === "control" ? "Movimiento manual" : "Banco de pruebas"}</p>
            <h2>{view === "home" ? "Home" : view === "control" ? "Control" : "Inversa"}</h2>
          </div>
          <div className="topActions">
            {connectionError && (
              <div className="systemNotice" role="alert" aria-live="polite">
                <strong>Aviso</strong>
                <span>{connectionError}</span>
              </div>
            )}
            {update && (
              <div className="updateBox" role="status" aria-live="polite">
                <button
                  className="updateButton"
                  onClick={installUpdate}
                  disabled={updateBusy}
                  title={`Actualizacion disponible: ${update.version}. Descargar e instalar.`}
                  aria-label={`Descargar e instalar actualizacion ${update.version}`}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3v11" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 20h14" />
                  </svg>
                  <span>{updateBusy ? "Actualizando" : `Actualizar ${update.version}`}</span>
                </button>
                {updateMessage && <small>{updateMessage}</small>}
              </div>
            )}
          </div>
        </header>

        {view === "home" ? (
          <HomeView
            port={port}
            ports={ports}
            connected={connected}
            busy={busy}
            status={status}
            baudRate={baudRate}
            onPortChange={setPort}
            onBaudRateChange={setBaudRate}
            onRefreshPorts={() => refreshPorts().catch(logError)}
            onConnect={() => connect().catch(logError)}
            onDisconnect={() => disconnect().catch(logError)}
            onCommand={sendCommand}
            pose={previewPose}
            gripper={previewGripper}
          />
        ) : view === "control" ? (
          <ControlView
            status={status}
            connected={connected}
            disabled={disabled}
            pose={previewPose}
            gripper={previewGripper}
            onPoseChange={setPreviewPose}
            onGripperChange={setPreviewGripper}
            onCommand={sendCommand}
            onZero={() => setPreviewPose({ X: 0, Y: 0, Z: 0, W: 0 })}
            consolePanel={serialConsole}
          />
        ) : (
          <InverseView
            status={status}
            connected={connected}
            disabled={disabled}
            pose={previewPose}
            onPoseChange={setPreviewPose}
            onCommandSequence={sendCommandSequence}
            consolePanel={serialConsole}
          />
        )}

        {view === "home" && serialConsole}
      </section>
    </main>
  );
}

function HomeView({
  port,
  ports,
  connected,
  busy,
  status,
  pose,
  gripper,
  baudRate,
  onPortChange,
  onBaudRateChange,
  onRefreshPorts,
  onConnect,
  onDisconnect,
  onCommand,
}: {
  port: string;
  ports: string[];
  connected: boolean;
  busy: boolean;
  status: MachineStatus;
  pose: AxisPose;
  gripper: GripperPose;
  baudRate: BaudRate;
  onPortChange: (value: string) => void;
  onBaudRateChange: (value: BaudRate) => void;
  onRefreshPorts: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onCommand: SendCommand;
}) {
  const disabled = !connected || busy;

  return (
    <div className="homeGrid">
      <aside className="leftStack">
        <section className="quickPanel homeCommands">
          <button className="heroAction" onClick={() => onCommand("HOME ALL")} disabled={disabled}>
            HOME ALL
          </button>
          <button onClick={() => onCommand("STATUS")} disabled={disabled}>
            STATUS
          </button>
        </section>
        <SystemPanel status={status} />
      </aside>

      <RobotStage status={status} pose={pose} gripper={gripper} />

      <aside className="rightStack">
        <ConnectionPanel
          port={port}
          ports={ports}
          connected={connected}
          busy={busy}
          baudRate={baudRate}
          onPortChange={onPortChange}
          onBaudRateChange={onBaudRateChange}
          onRefreshPorts={onRefreshPorts}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        <section className="quickPanel">
          <h3>Acciones rapidas</h3>
          <Metric label="Drivers" value={status.drivers_enabled ? "Habilitados" : "Deshabilitados"} />
          <button className="motorLock" onClick={() => onCommand("ENABLE")} disabled={disabled}>
            Habilitar Motores
          </button>
          <button className="enable" onClick={() => onCommand("DISABLE")} disabled={disabled}>
            Deshabilitar Motores
          </button>
        </section>
      </aside>
    </div>
  );
}

function ControlView({
  status,
  connected,
  disabled,
  pose,
  gripper,
  onPoseChange,
  onGripperChange,
  onCommand,
  onZero,
  consolePanel,
}: {
  status: MachineStatus;
  connected: boolean;
  disabled: boolean;
  pose: AxisPose;
  gripper: GripperPose;
  onPoseChange: (pose: AxisPose) => void;
  onGripperChange: (gripper: GripperPose) => void;
  onCommand: SendCommand;
  onZero: () => void;
  consolePanel: ReactNode;
}) {
  const [markersVisible, setMarkersVisible] = useState(false);

  function previewGripper(next: GripperPose) {
    onGripperChange(next);
    if (!disabled) onCommand(`GRIPPER ${next === "open" ? "CLOSE" : "OPEN"}`);
  }

  return (
    <div className="controlGrid">
      <div className="controlCenter">
        <RobotStage status={status} pose={pose} gripper={gripper} compact showKinematics showMarkers={markersVisible} />
        <div className="controlTopTools">
          <div className={`controlStatePill ${connected ? "online" : ""}`}>
            <span />
            {connected ? "Conectado" : "Desconectado"}
          </div>
          <button
            className={markersVisible ? "markerToggle active" : "markerToggle"}
            type="button"
            onClick={() => setMarkersVisible((visible) => !visible)}
          >
            Puntos
          </button>
        </div>
        {consolePanel}
      </div>
      <aside className="controlSide">
        <section className="axisStack">
          {axes.map((name) => (
            <AxisCard
              key={name}
              name={name}
              axis={status.axes[name]}
              previewValue={pose[name]}
              disabled={disabled}
              onPreviewChange={(value) => onPoseChange({ ...pose, [name]: roundAxis(value) })}
              onCommand={onCommand}
            />
          ))}
        </section>
        <GripperCard onPreview={previewGripper} />
        <div className="controlBulkButtons splitButtons">
          <button onClick={() => onCommand("HOME ALL")} disabled={disabled}>
            HOME ALL
          </button>
          <button className="primary" onClick={onZero}>
            ZERO
          </button>
        </div>
      </aside>
    </div>
  );
}

function InverseView({
  status,
  connected,
  disabled,
  pose,
  onPoseChange,
  onCommandSequence,
  consolePanel,
}: {
  status: MachineStatus;
  connected: boolean;
  disabled: boolean;
  pose: AxisPose;
  onPoseChange: (pose: AxisPose) => void;
  onCommandSequence: (commands: string[]) => void;
  consolePanel: ReactNode;
}) {
  const currentPose = pose;
  const currentFk = forwardKinematics(status, scaraGeometry, currentPose);
  const [markersVisible, setMarkersVisible] = useState(true);
  const [target, setTarget] = useState(() => ({
    x: currentFk.effector.x.toFixed(1),
    y: currentFk.effector.y.toFixed(1),
    z: currentFk.z.toFixed(1),
  }));
  const [elbowMode, setElbowMode] = useState<ElbowMode>("auto");
  const parsedTarget = {
    x: Number(target.x),
    y: Number(target.y),
    z: Number(target.z),
  };
  const result = inverseKinematics(parsedTarget, scaraGeometry, currentPose, elbowMode);
  const previewPose = result.ok ? result.pose : currentPose;
  const displayCommands = result.ok ? [...result.commands].sort((a, b) => "XYZW".indexOf(a.split(" ")[1] ?? "") - "XYZW".indexOf(b.split(" ")[1] ?? "")) : ["Sin comandos"];

  function updateTarget(name: keyof typeof target, value: string) {
    setTarget((current) => ({ ...current, [name]: value }));
  }

  return (
    <div className="inverseGrid">
      <div className="controlCenter">
        <RobotStage status={status} pose={previewPose} compact showKinematics showMarkers={markersVisible} />
        <div className="controlTopTools">
          <div className={`controlStatePill ${connected ? "online" : ""}`}>
            <span />
            {connected ? "Conectado" : "Desconectado"}
          </div>
          <button
            className={markersVisible ? "markerToggle active" : "markerToggle"}
            type="button"
            onClick={() => setMarkersVisible((visible) => !visible)}
          >
            Puntos
          </button>
        </div>
        {consolePanel}
      </div>

      <aside className="inverseSide">
        <section className="axisCard inversePanel">
          <div className="axisHeader">
            <div>
              <p>Target efector</p>
              <h3>XYZ mm</h3>
            </div>
            <span className={result.ok ? "badge good" : "badge warn"}>{result.ok ? "OK" : "No valido"}</span>
          </div>

          <div className="ikInputs">
            <label>
              X mm
              <input type="number" value={target.x} onChange={(event) => updateTarget("x", event.target.value)} />
            </label>
            <label>
              Y mm
              <input type="number" value={target.y} onChange={(event) => updateTarget("y", event.target.value)} />
            </label>
            <label>
              Z mm
              <input min={0} max={scaraGeometry.limits.Z} type="number" value={target.z} onChange={(event) => updateTarget("z", event.target.value)} />
            </label>
            <label>
              Codo
              <select value={elbowMode} onChange={(event) => setElbowMode(event.target.value as ElbowMode)}>
                <option value="auto">Auto closest</option>
                <option value="positive">Codo +</option>
                <option value="negative">Codo -</option>
              </select>
            </label>
          </div>

        </section>

        <section className="axisCard inversePanel">
          <div className="axisHeader">
            <div>
              <p>Preview</p>
              <h3>{result.ok ? `Codo ${result.elbow === "positive" ? "+" : "-"}` : result.reason}</h3>
            </div>
          </div>
          <div className="ikMetrics">
            <Metric label="X" value={`${formatAxisValue(result.pose.X)} deg`} />
            <Metric label="Y" value={`${formatAxisValue(result.pose.Y)} deg`} />
            <Metric label="Z" value={`${formatAxisValue(result.pose.Z)} mm`} />
            <Metric label="W" value={`${formatAxisValue(result.pose.W)} deg`} />
          </div>
          <div className="commandList">
            {displayCommands.map((command) => (
              <code key={command}>{command}</code>
            ))}
          </div>
          <button
            className="primary"
            onClick={() => {
              onPoseChange({
                X: roundAxis(result.pose.X),
                Y: roundAxis(result.pose.Y),
                Z: roundAxis(result.pose.Z),
                W: roundAxis(result.pose.W),
              });
              onCommandSequence(result.commands);
            }}
            disabled={disabled || !result.ok}
          >
            Enviar preview
          </button>
        </section>
      </aside>
    </div>
  );
}

function ConnectionPanel({
  port,
  ports,
  connected,
  busy,
  baudRate,
  onPortChange,
  onBaudRateChange,
  onRefreshPorts,
  onConnect,
  onDisconnect,
}: {
  port: string;
  ports: string[];
  connected: boolean;
  busy: boolean;
  baudRate: BaudRate;
  onPortChange: (value: string) => void;
  onBaudRateChange: (value: BaudRate) => void;
  onRefreshPorts: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const machineState = !connected ? "Desconectado" : busy ? "Ejecutando" : "Conectado";
  const selectedPort = ports.includes(port) ? port : "__manual";

  return (
    <section className="panel connectionPanel">
      <div className={`statusPill ${connected ? "online" : ""}`}>
        <span />
        {machineState}
      </div>
      <h3>Conexion</h3>
      <label>
        Puerto serial
        <select value={selectedPort} onChange={(event) => event.target.value !== "__manual" && onPortChange(event.target.value)} disabled={connected}>
          {ports.length === 0 && <option value="__manual">Sin puertos detectados</option>}
          {ports.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value="__manual">Escribir manualmente</option>
        </select>
      </label>
      {selectedPort === "__manual" && (
        <label>
          COM manual
          <input value={port} onChange={(event) => onPortChange(event.target.value.toUpperCase())} disabled={connected} placeholder="COM4" />
        </label>
      )}
      <div className="splitButtons">
        <button onClick={onRefreshPorts} disabled={connected}>
          Actualizar
        </button>
        <button className="primary" onClick={connected ? onDisconnect : onConnect} disabled={!connected && !port}>
          {connected ? "Desconectar" : "Conectar"}
        </button>
      </div>
      <label>
        BaudRate
        <select
          value={baudRate}
          onChange={(event) => onBaudRateChange(Number(event.target.value) as BaudRate)}
          disabled={connected}
        >
          <option value={115200}>115200</option>
        </select>
      </label>
    </section>
  );
}

function SystemPanel({ status }: { status: MachineStatus }) {
  const rows = [
    ["Eje X", status.axes.X.limit],
    ["Eje Y", status.axes.Y.limit],
    ["Eje Z", status.axes.Z.limit],
    ["Muneca", status.axes.W.limit],
  ] as const;

  return (
    <section className="panel">
      <h3>Estado del sistema</h3>
      <div className="axisLights">
        {rows.map(([label, limit]) => (
          <div key={label}>
            <span>{label}</span>
            <b className={limit ? "bad" : "ok"} />
          </div>
        ))}
      </div>
    </section>
  );
}

function RobotStage({
  status,
  pose = statusPose(status),
  gripper = status.gripper?.state === "close" ? "close" : "open",
  compact = false,
  showKinematics = false,
  showMarkers = showKinematics,
  children,
}: {
  status: MachineStatus;
  pose?: AxisPose;
  gripper?: GripperPose;
  compact?: boolean;
  showKinematics?: boolean;
  showMarkers?: boolean;
  children?: ReactNode;
}) {
  const viewerRef = useRef<RobotViewer | null>(null);
  const [measuredFk, setMeasuredFk] = useState<ForwardKinematics | null>(null);
  const fk = measuredFk ?? forwardKinematics(status, scaraGeometry, pose);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const applyPose = () => {
      if (cancelled) return;
      const rig = applyRobotPose(viewerRef.current, pose, gripper, showMarkers);
      setMeasuredFk(rig && showKinematics ? measuredKinematics(status, rig) : null);
      if (!rig && attempts < 20) {
        attempts += 1;
        window.setTimeout(applyPose, 50);
      }
    };
    applyPose();
    return () => {
      cancelled = true;
    };
  }, [status, pose, gripper, showKinematics, showMarkers]);

  return (
    <section className={compact ? "robotStage compact" : "robotStage"} aria-label="Vista 3D del brazo">
      <model-viewer
        ref={viewerRef}
        className="modelSlot"
        src="/robot.gltf?v=20260702-v3"
        onLoad={() => {
          const rig = applyRobotPose(viewerRef.current, pose, gripper, showMarkers);
          setMeasuredFk(rig && showKinematics ? measuredKinematics(status, rig) : null);
        }}
        camera-controls
        disable-zoom
        disable-tap
        interaction-prompt="none"
        orientation="0deg 90deg 0deg"
        camera-orbit="35deg 68deg 92%"
        min-camera-orbit="auto auto 92%"
        max-camera-orbit="auto auto 92%"
        camera-target="0m 0m 0m"
        field-of-view="24deg"
        min-field-of-view="24deg"
        max-field-of-view="24deg"
        shadow-intensity="0.7"
        exposure="1"
        alt="Modelo 3D del brazo SCARA"
      />
      <div className={showKinematics ? "positionPanel coordinatePanel" : "positionPanel"}>
        <h3>Posicion actual</h3>
        {showKinematics ? (
          <>
            <Metric label="X mm" value={`${fk.effector.x.toFixed(1)} mm`} />
            <Metric label="Y mm" value={`${fk.effector.y.toFixed(1)} mm`} />
            <Metric label="Z mm" value={`${fk.z.toFixed(1)} mm`} />
          </>
        ) : (
          <>
            <Metric label="X" value={`${pose.X.toFixed(2)} deg`} />
            <Metric label="Y" value={`${pose.Y.toFixed(2)} deg`} />
            <Metric label="Z" value={`${pose.Z.toFixed(2)} mm`} />
            <Metric label="W" value={`${pose.W.toFixed(2)} deg`} />
          </>
        )}
        {children && <div className="positionActions">{children}</div>}
      </div>
    </section>
  );
}

function AxisCard({
  name,
  axis,
  previewValue,
  disabled,
  onPreviewChange,
  onCommand,
}: {
  name: AxisName;
  axis: AxisStatus;
  previewValue: number;
  disabled: boolean;
  onPreviewChange: (value: number) => void;
  onCommand: SendCommand;
}) {
  const [value, setValue] = useState(formatAxisValue(previewValue));
  const unit = name === "Z" ? "MM" : "DEG";
  const speedSps = axis.speed_sps || axis.speed_us || 700;
  const min = name === "Z" ? 0 : -90;
  const max = name === "Z" ? zAxisTravelMm : name === "W" ? 0 : 90;
  const step = name === "W" ? 90 : 1;
  const clampValue = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    return name === "W" ? (clamped <= -45 ? -90 : 0) : clamped;
  };
  const clampedValue = clampValue(Number(value) || 0);

  useEffect(() => {
    setValue(formatAxisValue(previewValue));
  }, [previewValue]);

  function updateValue(next: string) {
    const normalized = next.replace(",", ".");
    const nextValue = clampValue(Number(normalized) || 0);
    setValue(formatAxisValue(nextValue));
    onPreviewChange(nextValue);
  }

  function moveAxis() {
    onCommand(`MOVE ${name} ${unit} ${formatAxisValue(clampedValue - axis.pos)}`);
  }

  return (
    <article className={`axisCard ${name === "W" ? "axisCardCompact" : ""}`}>
      <div className="axisHeader">
        <div>
          <p>Eje {name}</p>
          <h3>
            {axis.pos.toFixed(2)} {axis.unit}
          </h3>
        </div>
        <span className={axis.homed ? "badge good" : "badge warn"}>{axis.homed ? "Homed" : "Sin home"}</span>
      </div>
      <p className="axisSpeed">Velocidad {speedSps} pasos/s</p>

      <input
        aria-label={`Movimiento eje ${name}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={clampedValue}
        onChange={(event) => updateValue(event.target.value)}
      />

      <div className="axisInputs">
        <label>
          {name === "Z" ? "Altura mm" : "Grados"}
          <input min={min} max={max} step={step} type="number" value={value} onChange={(event) => updateValue(event.target.value)} />
        </label>
      </div>

      <div className="splitButtons">
        <button onClick={() => {
          onCommand(`HOME ${name}`);
        }} disabled={disabled}>
          HOME
        </button>
        <button
          className="primary"
          onClick={moveAxis}
          disabled={disabled}
        >
          MOVE
        </button>
      </div>
    </article>
  );
}

function GripperCard({
  onPreview,
}: {
  onPreview: (state: GripperPose) => void;
}) {
  return (
    <article className="axisCard gripperCard">
      <div className="axisHeader">
        <div>
          <p>Pinza</p>
        </div>
      </div>
      <div className="splitButtons">
        <button className="primary" onClick={() => onPreview("open")}>
          Abrir
        </button>
        <button onClick={() => onPreview("close")}>
          Cerrar
        </button>
      </div>
    </article>
  );
}

function SerialConsole({
  open,
  logs,
  command,
  disabled,
  onToggle,
  onCommandChange,
  onSubmit,
}: {
  open: boolean;
  logs: SerialEvent[];
  command: string;
  disabled: boolean;
  onToggle: () => void;
  onCommandChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="consolePanel">
      <button className="consoleToggle" onClick={onToggle}>
        Consola serial {open ? "ocultar" : "mostrar"}
      </button>
      {open && (
        <>
          <form
            className="manual"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <input
              value={command}
              onChange={(event) => onCommandChange(event.target.value)}
              placeholder="PING, STATUS, MOVE X DEG 10..."
              disabled={disabled}
            />
            <button disabled={disabled}>Enviar</button>
          </form>
          <div className="console" aria-live="polite">
            {logs.map((entry, index) => (
              <code key={`${entry.timestamp}-${index}`} className={entry.direction}>
                {new Date(entry.timestamp).toLocaleTimeString()} [{entry.direction}] {entry.line}
              </code>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LogoBlock({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <div className={hidden ? "brandMark hidden" : "brandMark"}>
      {!hidden && (
        <>
          <img src={dmLogo} alt="D&M Robotics" />
        </>
      )}
      <button onClick={onToggle}>{hidden ? "Mostrar logo" : "Ocultar logo"}</button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
