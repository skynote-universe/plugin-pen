/**
 * @file bezier-geometry.ts
 * @description 纯几何数学库：三次贝塞尔与直线分段、精确投影距离、De Casteljau 分割、SVG Path 生成与相交精判
 *
 * 平台中立：零 DOM、Canvas 与渲染器依赖。
 */

import type { Point, RectBounds } from '@skynote/core';

export type AnchorMode = 'corner' | 'smooth' | 'symmetric';

/** 锚点数据结构 (局部坐标系) */
export interface PathAnchor {
  readonly id: string;
  readonly point: Point;
  /** 控制柄 In 相对点坐标 (例如从 point 指向入控制柄的向量) */
  readonly handleIn?: Point;
  /** 控制柄 Out 相对点坐标 (例如从 point 指向出控制柄的向量) */
  readonly handleOut?: Point;
  readonly mode?: AnchorMode;
}

/** 单一子路径 */
export interface Subpath {
  readonly anchors: readonly PathAnchor[];
  readonly closed: boolean;
}

/** 路径几何分段 */
export interface PathSegment {
  readonly kind: 'line' | 'cubic';
  readonly start: Point;
  readonly cp1?: Point;
  readonly cp2?: Point;
  readonly end: Point;
  readonly startIndex: number;
  readonly endIndex: number;
}

export function roundNum(val: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(val * factor) / factor;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** 构造子路径的平铺线段/曲线分段序列 */
export function buildSubpathSegments(subpath: Subpath): PathSegment[] {
  const anchors = subpath.anchors;
  if (anchors.length < 2) return [];

  const segments: PathSegment[] = [];
  const count = subpath.closed ? anchors.length : anchors.length - 1;

  for (let i = 0; i < count; i++) {
    const a0 = anchors[i];
    const nextIdx = (i + 1) % anchors.length;
    const a1 = anchors[nextIdx];

    const p0 = a0.point;
    const p3 = a1.point;

    const hasOut = Boolean(a0.handleOut && (a0.handleOut.x !== 0 || a0.handleOut.y !== 0));
    const hasIn = Boolean(a1.handleIn && (a1.handleIn.x !== 0 || a1.handleIn.y !== 0));

    if (!hasOut && !hasIn) {
      segments.push({
        kind: 'line',
        start: p0,
        end: p3,
        startIndex: i,
        endIndex: nextIdx
      });
    } else {
      const p1: Point = hasOut ? { x: p0.x + a0.handleOut!.x, y: p0.y + a0.handleOut!.y } : p0;
      const p2: Point = hasIn ? { x: p3.x + a1.handleIn!.x, y: p3.y + a1.handleIn!.y } : p3;
      segments.push({
        kind: 'cubic',
        start: p0,
        cp1: p1,
        cp2: p2,
        end: p3,
        startIndex: i,
        endIndex: nextIdx
      });
    }
  }

  return segments;
}

/** 三次贝塞尔曲线求值 (0 <= t <= 1) */
export function evaluateCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
  };
}

/** 三次贝塞尔一阶导数 */
export function cubicDerivative(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  return {
    x: 3 * mt2 * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t2 * (p3.x - p2.x),
    y: 3 * mt2 * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t2 * (p3.y - p2.y)
  };
}

/** 点到线段的最近点与距离 */
export function distancePointToLineSegment(
  p: Point,
  a: Point,
  b: Point
): { point: Point; t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const dist = Math.hypot(p.x - a.x, p.y - a.y);
    return { point: a, t: 0, distance: dist };
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const proj: Point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: proj, t, distance: Math.hypot(p.x - proj.x, p.y - proj.y) };
}

/** 点到三次贝塞尔曲线的最近距离与投影参数 t */
export function distancePointToCubicSegment(
  p: Point,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  steps = 16
): { point: Point; t: number; distance: number } {
  let bestDistSq = Infinity;
  let bestT = 0;
  let bestPoint = p0;

  // 1. 离散步进粗筛
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = evaluateCubic(p0, p1, p2, p3, t);
    const dSq = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestT = t;
      bestPoint = pt;
    }
  }

  // 2. 局部牛顿迭代精化
  const currentT = bestT;
  const dt = 1 / (steps * 2);
  let low = Math.max(0, currentT - dt);
  let high = Math.min(1, currentT + dt);

  for (let iter = 0; iter < 4; iter++) {
    const mid1 = low + (high - low) / 3;
    const mid2 = high - (high - low) / 3;
    const pt1 = evaluateCubic(p0, p1, p2, p3, mid1);
    const pt2 = evaluateCubic(p0, p1, p2, p3, mid2);
    const d1 = (p.x - pt1.x) ** 2 + (p.y - pt1.y) ** 2;
    const d2 = (p.x - pt2.x) ** 2 + (p.y - pt2.y) ** 2;
    if (d1 < d2) {
      high = mid2;
      bestT = mid1;
      bestPoint = pt1;
      bestDistSq = d1;
    } else {
      low = mid1;
      bestT = mid2;
      bestPoint = pt2;
      bestDistSq = d2;
    }
  }

  return { point: bestPoint, t: bestT, distance: Math.sqrt(bestDistSq) };
}

/** 使用 De Casteljau 算法在 t 处分割三次贝塞尔曲线 */
export function splitCubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number
): [{ p0: Point; p1: Point; p2: Point; p3: Point }, { p0: Point; p1: Point; p2: Point; p3: Point }] {
  const p01 = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  const p12 = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
  const p23 = { x: p2.x + (p3.x - p2.x) * t, y: p2.y + (p3.y - p2.y) * t };

  const p012 = { x: p01.x + (p12.x - p01.x) * t, y: p01.y + (p12.y - p01.y) * t };
  const p123 = { x: p12.x + (p23.x - p12.x) * t, y: p12.y + (p23.y - p12.y) * t };

  const splitPt = { x: p012.x + (p123.x - p012.x) * t, y: p012.y + (p123.y - p012.y) * t };

  return [
    { p0, p1: p01, p2: p012, p3: splitPt },
    { p0: splitPt, p1: p123, p2: p23, p3 }
  ];
}

/** 生成 SVG Path 字符串数据 */
export function buildSvgPathData(subpaths: readonly Subpath[]): string {
  const commands: string[] = [];

  for (const sub of subpaths) {
    const anchors = sub.anchors;
    if (anchors.length === 0) continue;

    const first = anchors[0];
    commands.push(`M ${roundNum(first.point.x)} ${roundNum(first.point.y)}`);

    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i - 1];
      const curr = anchors[i];
      const hasOut = Boolean(prev.handleOut && (prev.handleOut.x !== 0 || prev.handleOut.y !== 0));
      const hasIn = Boolean(curr.handleIn && (curr.handleIn.x !== 0 || curr.handleIn.y !== 0));

      if (!hasOut && !hasIn) {
        commands.push(`L ${roundNum(curr.point.x)} ${roundNum(curr.point.y)}`);
      } else {
        const cp1x = roundNum(prev.point.x + (prev.handleOut?.x ?? 0));
        const cp1y = roundNum(prev.point.y + (prev.handleOut?.y ?? 0));
        const cp2x = roundNum(curr.point.x + (curr.handleIn?.x ?? 0));
        const cp2y = roundNum(curr.point.y + (curr.handleIn?.y ?? 0));
        const p3x = roundNum(curr.point.x);
        const p3y = roundNum(curr.point.y);
        commands.push(`C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p3x} ${p3y}`);
      }
    }

    if (sub.closed && anchors.length >= 2) {
      const last = anchors[anchors.length - 1];
      const hasOut = Boolean(last.handleOut && (last.handleOut.x !== 0 || last.handleOut.y !== 0));
      const hasIn = Boolean(first.handleIn && (first.handleIn.x !== 0 || first.handleIn.y !== 0));

      if (!hasOut && !hasIn) {
        commands.push('Z');
      } else {
        const cp1x = roundNum(last.point.x + (last.handleOut?.x ?? 0));
        const cp1y = roundNum(last.point.y + (last.handleOut?.y ?? 0));
        const cp2x = roundNum(first.point.x + (first.handleIn?.x ?? 0));
        const cp2y = roundNum(first.point.y + (first.handleIn?.y ?? 0));
        const p3x = roundNum(first.point.x);
        const p3y = roundNum(first.point.y);
        commands.push(`C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p3x} ${p3y} Z`);
      }
    }
  }

  return commands.join(' ');
}

/** 精确拾取判定 */
export function hitTestPath(
  subpaths: readonly Subpath[],
  strokeWidth: number,
  localPoint: Point,
  tolerance: number
): boolean {
  const maxDist = Math.max(0.5, strokeWidth / 2) + tolerance;

  for (const sub of subpaths) {
    const segments = buildSubpathSegments(sub);
    for (const seg of segments) {
      if (seg.kind === 'line') {
        const res = distancePointToLineSegment(localPoint, seg.start, seg.end);
        if (res.distance <= maxDist) return true;
      } else {
        const res = distancePointToCubicSegment(localPoint, seg.start, seg.cp1!, seg.cp2!, seg.end);
        if (res.distance <= maxDist) return true;
      }
    }
  }

  return false;
}

/** 框选相交精判 */
export function intersectsPathBounds(subpaths: readonly Subpath[], strokeWidth: number, bounds: RectBounds): boolean {
  const pad = Math.max(0.5, strokeWidth / 2);
  const left = bounds.left - pad;
  const top = bounds.top - pad;
  const right = bounds.right + pad;
  const bottom = bounds.bottom + pad;

  for (const sub of subpaths) {
    const segments = buildSubpathSegments(sub);
    for (const seg of segments) {
      // 采样分段点
      const sampleCount = seg.kind === 'line' ? 2 : 10;
      for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const pt =
          seg.kind === 'line'
            ? { x: seg.start.x + (seg.end.x - seg.start.x) * t, y: seg.start.y + (seg.end.y - seg.start.y) * t }
            : evaluateCubic(seg.start, seg.cp1!, seg.cp2!, seg.end, t);

        if (pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom) {
          return true;
        }
      }
    }
  }

  return false;
}

/** 锚点控制柄联动同步 */
export function syncAnchorHandles(
  anchor: PathAnchor,
  activeHandle: 'in' | 'out',
  newHandlePos: Point,
  breakSymmetry = false
): PathAnchor {
  const isZero = Math.hypot(newHandlePos.x, newHandlePos.y) < 0.001;
  const mode = breakSymmetry ? 'corner' : (anchor.mode ?? 'corner');

  if (mode === 'corner') {
    return {
      ...anchor,
      mode: 'corner',
      ...(activeHandle === 'in'
        ? { handleIn: isZero ? undefined : newHandlePos }
        : { handleOut: isZero ? undefined : newHandlePos })
    };
  }

  if (activeHandle === 'out') {
    if (isZero) {
      // 仅折叠当前拖拽端控制柄，保留对侧既有控制柄，转为 corner
      return { ...anchor, handleOut: undefined, mode: 'corner' };
    }
    if (mode === 'symmetric') {
      const hx = -newHandlePos.x === 0 ? 0 : -newHandlePos.x;
      const hy = -newHandlePos.y === 0 ? 0 : -newHandlePos.y;
      return {
        ...anchor,
        handleOut: newHandlePos,
        handleIn: { x: hx, y: hy }
      };
    }
    // smooth 模式：保持 handleIn 原有长度，反向共线
    const oldLen = anchor.handleIn
      ? Math.hypot(anchor.handleIn.x, anchor.handleIn.y)
      : Math.hypot(newHandlePos.x, newHandlePos.y);
    const newLen = Math.hypot(newHandlePos.x, newHandlePos.y);
    const ratio = newLen > 0 ? oldLen / newLen : 1;
    const hx = -newHandlePos.x * ratio === 0 ? 0 : -newHandlePos.x * ratio;
    const hy = -newHandlePos.y * ratio === 0 ? 0 : -newHandlePos.y * ratio;
    return {
      ...anchor,
      handleOut: newHandlePos,
      handleIn: { x: roundNum(hx), y: roundNum(hy) }
    };
  }

  // activeHandle === 'in'
  if (isZero) {
    // 仅折叠当前拖拽端控制柄，保留对侧既有控制柄，转为 corner
    return { ...anchor, handleIn: undefined, mode: 'corner' };
  }
  if (mode === 'symmetric') {
    const hx = -newHandlePos.x === 0 ? 0 : -newHandlePos.x;
    const hy = -newHandlePos.y === 0 ? 0 : -newHandlePos.y;
    return {
      ...anchor,
      handleIn: newHandlePos,
      handleOut: { x: hx, y: hy }
    };
  }
  // smooth 模式：保持 handleOut 原有长度，反向共线
  const oldLen = anchor.handleOut
    ? Math.hypot(anchor.handleOut.x, anchor.handleOut.y)
    : Math.hypot(newHandlePos.x, newHandlePos.y);
  const newLen = Math.hypot(newHandlePos.x, newHandlePos.y);
  const ratio = newLen > 0 ? oldLen / newLen : 1;
  const hx = -newHandlePos.x * ratio === 0 ? 0 : -newHandlePos.x * ratio;
  const hy = -newHandlePos.y * ratio === 0 ? 0 : -newHandlePos.y * ratio;
  return {
    ...anchor,
    handleIn: newHandlePos,
    handleOut: { x: roundNum(hx), y: roundNum(hy) }
  };
}

/** 求解三次贝塞尔一阶导数在 (0, 1) 区间内的极值点参数 t */
function findCubicExtremaT(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];

  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) {
      const t = -c / b;
      if (t > 0 && t < 1) roots.push(t);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      const t1 = (-b - r) / (2 * a);
      const t2 = (-b + r) / (2 * a);
      if (t1 > 0 && t1 < 1) roots.push(t1);
      if (t2 > 0 && t2 < 1) roots.push(t2);
    }
  }

  return roots;
}

/**
 * 计算多条子路径的紧密几何包围盒 (计算三阶贝塞尔曲线精确极值点与端点，不含线宽外扩)
 * 若无有效点返回 null
 */
export function computeSubpathsTightBounds(subpaths: readonly Subpath[]): RectBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasPoints = false;

  const update = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    hasPoints = true;
  };

  for (const sub of subpaths) {
    for (const a of sub.anchors) {
      update(a.point.x, a.point.y);
    }

    const segments = buildSubpathSegments(sub);
    for (const seg of segments) {
      update(seg.start.x, seg.start.y);
      update(seg.end.x, seg.end.y);

      if (seg.kind === 'cubic' && seg.cp1 && seg.cp2) {
        const p0 = seg.start;
        const p1 = seg.cp1;
        const p2 = seg.cp2;
        const p3 = seg.end;

        for (const t of findCubicExtremaT(p0.x, p1.x, p2.x, p3.x)) {
          const pt = evaluateCubic(p0, p1, p2, p3, t);
          update(pt.x, pt.y);
        }

        for (const t of findCubicExtremaT(p0.y, p1.y, p2.y, p3.y)) {
          const pt = evaluateCubic(p0, p1, p2, p3, t);
          update(pt.x, pt.y);
        }
      }
    }
  }

  if (!hasPoints) return null;

  return {
    left: roundNum(minX),
    top: roundNum(minY),
    right: roundNum(maxX),
    bottom: roundNum(maxY)
  };
}
