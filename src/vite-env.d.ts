/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from "react";

type ModelViewerElement = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  alt?: string;
  "camera-controls"?: boolean;
  "auto-rotate"?: boolean;
  "disable-zoom"?: boolean;
  "disable-tap"?: boolean;
  "interaction-prompt"?: string;
  orientation?: string;
  "camera-orbit"?: string;
  "min-camera-orbit"?: string;
  "max-camera-orbit"?: string;
  "camera-target"?: string;
  "field-of-view"?: string;
  "min-field-of-view"?: string;
  "max-field-of-view"?: string;
  "shadow-intensity"?: string;
  exposure?: string;
};

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerElement;
    }
  }
}
