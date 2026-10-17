/**
 * @file index.ts
 * @description 商业钢笔工具插件 (@skynote-pro/plugin-pen) 统一入口
 */

import type { SkyNotePlugin } from '@skynote/core';
import {
  PenPlugin,
  PenDisplayPlugin,
  PEN_PLUGIN_ID,
  PEN_DISPLAY_PLUGIN_ID,
  PEN_TOOL,
  BRUSH_TOOL,
  isDrawingTool,
  type PenPluginOptions,
  type PenSettings
} from './pen-plugin';
import {
  PathNodeType,
  validatePathNode,
  DEFAULT_PATH_STROKE_WIDTH,
  type PathNodeFields,
  type PathCreateOptions
} from './path-node';
import {
  buildSubpathSegments,
  buildSvgPathData,
  evaluateCubic,
  cubicDerivative,
  distancePointToLineSegment,
  distancePointToCubicSegment,
  splitCubicBezier,
  hitTestPath,
  intersectsPathBounds,
  syncAnchorHandles,
  computeSubpathsTightBounds,
  type AnchorMode,
  type PathAnchor,
  type Subpath,
  type PathSegment
} from './bezier-geometry';

export {
  PenPlugin,
  PenDisplayPlugin,
  PathNodeType,
  validatePathNode,
  PEN_PLUGIN_ID,
  PEN_DISPLAY_PLUGIN_ID,
  PEN_TOOL,
  BRUSH_TOOL,
  isDrawingTool,
  DEFAULT_PATH_STROKE_WIDTH,
  buildSubpathSegments,
  buildSvgPathData,
  evaluateCubic,
  cubicDerivative,
  distancePointToLineSegment,
  distancePointToCubicSegment,
  splitCubicBezier,
  hitTestPath,
  intersectsPathBounds,
  syncAnchorHandles,
  computeSubpathsTightBounds
};

export type {
  PenPluginOptions,
  PenSettings,
  PathNodeFields,
  PathCreateOptions,
  AnchorMode,
  PathAnchor,
  Subpath,
  PathSegment
};

/** 宿主装配入口：完整商业钢笔插件 (节点定义 + 贝塞尔绘制/编辑交互) */
export function createPlugins(options?: PenPluginOptions): SkyNotePlugin[] {
  return [new PenPlugin(options)];
}

/** 宿主装配入口：仅节点展示插件 (无商业编辑授权 / View-Only 模式) */
export function createDisplayPlugins(): SkyNotePlugin[] {
  return [new PenDisplayPlugin()];
}
