/**
 * @file path-node.ts
 * @description 钢笔矢量路径节点定义 (nodeType = 'path')：具名强类型字段 node.path、专有结构校验、精确拾取、等比缩放与派生路径缓存
 *
 * 遵循架构规范：
 * 1. 具名字段 node.path (Subpath 容器) 作为单一事实源，不塞入通用 node.data；
 * 2. 派生 SVG Path 字符串在内存按 (node.path 引用, strokeWidth) 建立 O(1) 缓存，删除/替换/卸载时及时释放；
 * 3. 等比缩放支持零跨度安全守卫，严禁除以 0；
 * 4. 平台中立：零 DOM、Canvas 与渲染器依赖。
 */

import {
  resolveNodeStyle,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeResizeRequest,
  type NodeSizingPolicy,
  type NodeStyle,
  type NodeTypeDefinition,
  type Point,
  type RectBounds
} from '@skynote/core';
import {
  buildSvgPathData,
  hitTestPath,
  intersectsPathBounds,
  roundNum,
  type PathAnchor,
  type Subpath
} from './bezier-geometry';

export const PATH_NODE_TYPE = 'path';
export const DEFAULT_PATH_STROKE_WIDTH = 2;
export const MAX_SUBPATHS = 64;
export const MAX_ANCHORS_PER_SUBPATH = 1024;

/** 节点持久化专有字段 node.path */
export interface PathNodeFields {
  readonly subpaths: readonly Subpath[];
}

/** createNode({ nodeType: 'path', options }) 的新建选项 */
export interface PathCreateOptions {
  readonly subpaths?: readonly Subpath[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly strokeOpacity?: number;
  readonly fill?: string;
  readonly fillOpacity?: number;
  readonly opacity?: number;
  readonly strokeDashArray?: number[];
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    path?: PathNodeFields;
  }
  interface NodeCreateOptionsMap {
    path: PathCreateOptions;
  }
}

interface CachedPath {
  readonly path: PathNodeFields;
  readonly strokeWidth: number;
  readonly strokeDashArray?: number[];
  readonly d: string;
}

/** 校验 node.path 专有结构的完整性 (纯函数) */
export function validatePathNode(node: Readonly<NodeEntity>): string | null {
  if (!Number.isFinite(node.width) || node.width < 0 || !Number.isFinite(node.height) || node.height < 0) {
    return 'path 节点宽高必须为非负有限数值';
  }
  const path = node.path;
  if (!path || typeof path !== 'object' || Array.isArray(path)) {
    return '缺少合法的 node.path 专有字段';
  }
  if (!Array.isArray(path.subpaths) || path.subpaths.length === 0) {
    return 'path.subpaths 必须为非空数组';
  }
  if (path.subpaths.length > MAX_SUBPATHS) {
    return `path.subpaths 超出上限 (${MAX_SUBPATHS})`;
  }

  for (let sIdx = 0; sIdx < path.subpaths.length; sIdx++) {
    const sub = path.subpaths[sIdx];
    if (!sub || typeof sub !== 'object') {
      return `path.subpaths[${sIdx}] 非法`;
    }
    if (!Array.isArray(sub.anchors) || sub.anchors.length < 2) {
      return `path.subpaths[${sIdx}].anchors 至少需包含 2 个锚点`;
    }
    if (sub.anchors.length > MAX_ANCHORS_PER_SUBPATH) {
      return `path.subpaths[${sIdx}] 锚点数超出上限 (${MAX_ANCHORS_PER_SUBPATH})`;
    }
    for (let aIdx = 0; aIdx < sub.anchors.length; aIdx++) {
      const a = sub.anchors[aIdx];
      if (
        !a ||
        typeof a !== 'object' ||
        typeof a.id !== 'string' ||
        !a.id ||
        !a.point ||
        typeof a.point.x !== 'number' ||
        !Number.isFinite(a.point.x) ||
        typeof a.point.y !== 'number' ||
        !Number.isFinite(a.point.y)
      ) {
        return `path.subpaths[${sIdx}].anchors[${aIdx}] 坐标或标识非法`;
      }
      if (
        a.handleIn &&
        (typeof a.handleIn.x !== 'number' ||
          !Number.isFinite(a.handleIn.x) ||
          typeof a.handleIn.y !== 'number' ||
          !Number.isFinite(a.handleIn.y))
      ) {
        return `path.subpaths[${sIdx}].anchors[${aIdx}].handleIn 非法`;
      }
      if (
        a.handleOut &&
        (typeof a.handleOut.x !== 'number' ||
          !Number.isFinite(a.handleOut.x) ||
          typeof a.handleOut.y !== 'number' ||
          !Number.isFinite(a.handleOut.y))
      ) {
        return `path.subpaths[${sIdx}].anchors[${aIdx}].handleOut 非法`;
      }
    }
  }

  return null;
}

export class PathNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'path';

  readonly type = PathNodeType.TYPE;
  readonly label = '钢笔路径';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly defaultAspectLocked = true;
  readonly scaleContentOnCorners = true;
  readonly defaultStyle: NodeStyle = {
    strokeWidth: DEFAULT_PATH_STROKE_WIDTH,
    strokeCap: 'round',
    strokeJoin: 'round'
  };

  /** 按节点 ID 缓存已生成的 SVG Path 字符串 */
  private readonly pathCache = new Map<string, CachedPath>();

  clearCache(nodeId?: string): void {
    if (nodeId !== undefined) this.pathCache.delete(nodeId);
    else this.pathCache.clear();
  }

  get cacheSize(): number {
    return this.pathCache.size;
  }

  validate(node: Readonly<NodeEntity>): string | null {
    return validatePathNode(node);
  }

  createContent(options: PathCreateOptions = {}): NodeCreateContent {
    let maxX = 0;
    let maxY = 0;

    const rawSubpaths = options.subpaths;
    const subpaths: readonly Subpath[] =
      Array.isArray(rawSubpaths) && rawSubpaths.length > 0
        ? rawSubpaths
        : [
            {
              anchors: [
                { id: 'a1', point: { x: 0, y: 0 } },
                { id: 'a2', point: { x: Math.max(1, options.width ?? 100), y: Math.max(1, options.height ?? 100) } }
              ],
              closed: false
            }
          ];

    for (const sub of subpaths) {
      for (const a of sub.anchors) {
        if (a.point.x > maxX) maxX = a.point.x;
        if (a.point.y > maxY) maxY = a.point.y;
        if (a.handleIn) {
          const hx = a.point.x + a.handleIn.x;
          const hy = a.point.y + a.handleIn.y;
          if (hx > maxX) maxX = hx;
          if (hy > maxY) maxY = hy;
        }
        if (a.handleOut) {
          const hx = a.point.x + a.handleOut.x;
          const hy = a.point.y + a.handleOut.y;
          if (hx > maxX) maxX = hx;
          if (hy > maxY) maxY = hy;
        }
      }
    }

    const width = options.width !== undefined ? roundNum(Math.max(0, options.width)) : roundNum(maxX);
    const height = options.height !== undefined ? roundNum(Math.max(0, options.height)) : roundNum(maxY);

    const style: NodeStyle = {
      strokeWidth: options.strokeWidth ?? DEFAULT_PATH_STROKE_WIDTH,
      ...(options.stroke !== undefined && { stroke: options.stroke }),
      ...(options.strokeOpacity !== undefined && { strokeOpacity: options.strokeOpacity }),
      ...(options.fill !== undefined && { fill: options.fill }),
      ...(options.fillOpacity !== undefined && { fillOpacity: options.fillOpacity }),
      ...(options.opacity !== undefined && { opacity: options.opacity }),
      ...(options.strokeDashArray !== undefined && { strokeDashArray: options.strokeDashArray })
    };

    return {
      width,
      height,
      style,
      path: {
        subpaths
      }
    };
  }

  extent(node: NodeEntity): RectBounds {
    const style = resolveNodeStyle(node, this);
    const strokeWidth =
      typeof style.strokeWidth === 'number' && Number.isFinite(style.strokeWidth) && style.strokeWidth > 0
        ? style.strokeWidth
        : DEFAULT_PATH_STROKE_WIDTH;
    const pad = Math.max(0.5, strokeWidth / 2);

    return {
      left: -pad,
      top: -pad,
      right: node.width + pad,
      bottom: node.height + pad
    };
  }

  hitTest(node: NodeEntity, localPoint: Point, tolerance: number): boolean {
    const path = node.path;
    if (!path || path.subpaths.length === 0) return false;
    const style = resolveNodeStyle(node, this);
    const strokeWidth =
      typeof style.strokeWidth === 'number' && Number.isFinite(style.strokeWidth) && style.strokeWidth > 0
        ? style.strokeWidth
        : DEFAULT_PATH_STROKE_WIDTH;

    return hitTestPath(path.subpaths, strokeWidth, localPoint, tolerance);
  }

  intersectsBounds(node: NodeEntity, localBounds: RectBounds): boolean {
    const path = node.path;
    if (!path || path.subpaths.length === 0) return false;
    const style = resolveNodeStyle(node, this);
    const strokeWidth =
      typeof style.strokeWidth === 'number' && Number.isFinite(style.strokeWidth) && style.strokeWidth > 0
        ? style.strokeWidth
        : DEFAULT_PATH_STROKE_WIDTH;

    return intersectsPathBounds(path.subpaths, strokeWidth, localBounds);
  }

  applyResize(node: NodeEntity, request: NodeResizeRequest): Partial<NodeEntity> {
    const path = node.path;
    if (!path) return {};

    const sx = node.width > 0 ? request.width / node.width : request.scale;
    const sy = node.height > 0 ? request.height / node.height : request.scale;
    const widthScale =
      request.scale !== 1
        ? request.scale
        : node.width > 0 && node.height > 0
          ? Math.hypot(sx, sy) / Math.SQRT2
          : node.width > 0
            ? sx
            : node.height > 0
              ? sy
              : 1;

    const baseWidth = resolveNodeStyle(node, this).strokeWidth ?? DEFAULT_PATH_STROKE_WIDTH;
    const nextStrokeWidth = Math.max(0.5, roundNum(baseWidth * widthScale));

    const nextSubpaths: Subpath[] = path.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((a) => {
        const nextAnchor: PathAnchor = {
          id: a.id,
          point: { x: roundNum(a.point.x * sx), y: roundNum(a.point.y * sy) },
          ...(a.mode && { mode: a.mode }),
          ...(a.handleIn && {
            handleIn: { x: roundNum(a.handleIn.x * sx), y: roundNum(a.handleIn.y * sy) }
          }),
          ...(a.handleOut && {
            handleOut: { x: roundNum(a.handleOut.x * sx), y: roundNum(a.handleOut.y * sy) }
          })
        };
        return nextAnchor;
      })
    }));

    return {
      style: {
        ...node.style,
        strokeWidth: nextStrokeWidth
      },
      path: {
        subpaths: nextSubpaths
      }
    };
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const path = node.path;
    if (!path || path.subpaths.length === 0) return [];

    const style = resolveNodeStyle(node, this);
    const strokeWidth =
      typeof style.strokeWidth === 'number' && Number.isFinite(style.strokeWidth) && style.strokeWidth > 0
        ? style.strokeWidth
        : DEFAULT_PATH_STROKE_WIDTH;

    const strokeDashArray = style.strokeDashArray;
    let cached = this.pathCache.get(node.id);
    if (
      !cached ||
      cached.path !== path ||
      cached.strokeWidth !== strokeWidth ||
      cached.strokeDashArray !== strokeDashArray
    ) {
      const d = buildSvgPathData(path.subpaths);
      cached = { path, strokeWidth, strokeDashArray, d };
      this.pathCache.set(node.id, cached);
    }

    const strokeColor = style.stroke ?? theme.textColor;
    const strokeOpacity = style.strokeOpacity ?? style.opacity;
    const hasClosed = path.subpaths.some((s) => s.closed);
    const fillColor = hasClosed && typeof style.fill === 'string' ? style.fill : undefined;
    const fillOpacity = style.fillOpacity ?? style.opacity;

    return [
      {
        kind: 'path',
        d: cached.d,
        stroke: strokeColor,
        strokeWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        ...(strokeDashArray !== undefined && { strokeDashArray }),
        ...(strokeOpacity !== undefined && { strokeOpacity }),
        ...(fillColor !== undefined && { fill: fillColor }),
        ...(fillOpacity !== undefined && fillColor !== undefined && { fillOpacity })
      }
    ];
  }
}
