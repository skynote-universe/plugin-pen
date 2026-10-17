/**
 * @file pen.test.ts
 * @description 商业钢笔工具插件 (@skynote-pro/plugin-pen) 单元与集成测试
 */

import { describe, expect, it } from 'vitest';
import {
  parseCanvasDocument,
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasCursor,
  type CanvasHost,
  type CanvasKeyboardEvent,
  type CanvasPointerSample,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type OverlayOptions,
  type Point,
  SELECT_TOOL,
  type RectBounds,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, ConnectorToolPlugin, SelectionPlugin, TransformPlugin } from '@skynote/plugins-basic';
import {
  buildSvgPathData,
  createDisplayPlugins,
  createPlugins,
  distancePointToCubicSegment,
  distancePointToLineSegment,
  evaluateCubic,
  hitTestPath,
  intersectsPathBounds,
  PathNodeType,
  PenDisplayPlugin,
  PenPlugin,
  PEN_TOOL,
  BRUSH_TOOL,
  splitCubicBezier,
  computeSubpathsTightBounds,
  type Subpath
} from '../src';

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, { primitives: readonly CanvasPrimitive[]; transient: boolean }>();
  readonly cursors: CanvasCursor[] = [];
  readonly captured = new Set<number>();

  get overlay(): OverlayChannel {
    return this;
  }

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { primitives, transient: options?.transient ?? false });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setCursor(cursor: CanvasCursor): void {
    this.cursors.push(cursor);
  }

  capturePointer(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

function setup(options = {}) {
  const host = new FakeHost();
  const pen = new PenPlugin(options);
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin())
    .use(pen);
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  return { engine, host, pen, store: engine.documentStore };
}

function dispatchPointer(
  engine: SkyNoteEngine,
  phase: 'down' | 'move' | 'up' | 'cancel',
  point: Point,
  init: Partial<{
    pointerId: number;
    pointerType: 'mouse' | 'pen' | 'touch';
    pressure: number;
    samples: readonly CanvasPointerSample[];
    button: number;
    clickCount: number;
    modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean };
  }> = {}
) {
  const { x, y, zoom } = engine.session.viewport;
  const clientPoint = { x: point.x * zoom + x, y: point.y * zoom + y };
  const event = new SyntheticPointerEvent({
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    point,
    clientPoint,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    button: init.button ?? 0,
    pressure: init.pressure ?? 0.5,
    samples: init.samples,
    clickCount: init.clickCount ?? 1,
    modifiers: { shift: false, alt: false, ...init.modifiers }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else if (phase === 'up') engine.pointer.dispatchPointerUp(event);
  else engine.pointer.dispatchPointerCancel(event);
}

function dispatchKey(engine: SkyNoteEngine, code: string, init: Partial<CanvasKeyboardEvent> = {}) {
  const event: CanvasKeyboardEvent = {
    key: init.key ?? code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...init
  };
  return engine.inputScopes.dispatchKeyDown(event);
}

describe('商业钢笔工具插件 (@skynote-pro/plugin-pen)', () => {
  it('纯几何：三次贝塞尔求值、求导与点到曲线距离计算', () => {
    const p0: Point = { x: 0, y: 0 };
    const p1: Point = { x: 0, y: 100 };
    const p2: Point = { x: 100, y: 100 };
    const p3: Point = { x: 100, y: 0 };

    const start = evaluateCubic(p0, p1, p2, p3, 0);
    const end = evaluateCubic(p0, p1, p2, p3, 1);
    const mid = evaluateCubic(p0, p1, p2, p3, 0.5);

    expect(start).toEqual({ x: 0, y: 0 });
    expect(end).toEqual({ x: 100, y: 0 });
    expect(mid.x).toBeCloseTo(50, 1);
    expect(mid.y).toBeCloseTo(75, 1);

    // 点到贝塞尔曲线投影
    const hitNearMid = distancePointToCubicSegment({ x: 50, y: 75 }, p0, p1, p2, p3);
    expect(hitNearMid.distance).toBeLessThan(1);
    expect(hitNearMid.t).toBeCloseTo(0.5, 1);

    // 点到直线段投影
    const hitLine = distancePointToLineSegment({ x: 50, y: 20 }, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(hitLine.distance).toBeCloseTo(20);
    expect(hitLine.t).toBeCloseTo(0.5);
  });

  it('纯几何：De Casteljau 分割三次贝塞尔曲线保持几何一致', () => {
    const p0: Point = { x: 0, y: 0 };
    const p1: Point = { x: 20, y: 80 };
    const p2: Point = { x: 80, y: 80 };
    const p3: Point = { x: 100, y: 0 };

    const [c1, c2] = splitCubicBezier(p0, p1, p2, p3, 0.5);
    expect(c1.p0).toEqual(p0);
    expect(c2.p3).toEqual(p3);
    expect(c1.p3).toEqual(c2.p0);

    const origPt = evaluateCubic(p0, p1, p2, p3, 0.25);
    const splitPt = evaluateCubic(c1.p0, c1.p1, c1.p2, c1.p3, 0.5);
    expect(splitPt.x).toBeCloseTo(origPt.x, 2);
    expect(splitPt.y).toBeCloseTo(origPt.y, 2);
  });

  it('生成 SVG Path 字符串与精确拾取/框选精判', () => {
    const subpath: Subpath = {
      closed: true,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 }, handleOut: { x: 50, y: 0 } },
        { id: 'a2', point: { x: 100, y: 100 }, handleIn: { x: 0, y: -50 } }
      ]
    };

    const d = buildSvgPathData([subpath]);
    expect(d).toContain('M 0 0');
    expect(d).toContain('C 50 0 100 50 100 100');
    expect(d).toContain('Z');

    expect(hitTestPath([subpath], 2, { x: 0, y: 0 }, 5)).toBe(true);
    expect(hitTestPath([subpath], 2, { x: 500, y: 500 }, 5)).toBe(false);

    const boxIn: RectBounds = { left: 40, top: 20, right: 80, bottom: 60 };
    expect(intersectsPathBounds([subpath], 2, boxIn)).toBe(true);

    const boxOut: RectBounds = { left: 200, top: 200, right: 300, bottom: 300 };
    expect(intersectsPathBounds([subpath], 2, boxOut)).toBe(false);
  });

  it('新建开放路径：点击添加锚点，Enter 单事务提交', () => {
    const { engine, host, pen, store } = setup({ stroke: '#ff0000', strokeWidth: 4 });
    pen.activateTool();
    expect(pen.active).toBe(true);

    // 点 1
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });
    expect(pen.hasActiveDraft).toBe(true);
    expect(host.sessions.has('pen:draft')).toBe(true);

    // 点 2
    dispatchPointer(engine, 'down', { x: 200, y: 150 });
    dispatchPointer(engine, 'up', { x: 200, y: 150 });

    // 点 3
    dispatchPointer(engine, 'down', { x: 300, y: 100 });
    dispatchPointer(engine, 'up', { x: 300, y: 100 });

    // Enter 完成
    dispatchKey(engine, 'Enter');

    expect(pen.hasActiveDraft).toBe(false);
    expect(host.sessions.has('pen:draft')).toBe(false);

    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.nodeType).toBe(PathNodeType.TYPE);
    expect(node.path?.subpaths[0].anchors).toHaveLength(3);
    expect(node.path?.subpaths[0].closed).toBe(false);
    expect(node.style?.stroke).toBe('#ff0000');
    expect(node.style?.strokeWidth).toBe(4);

    // 单步撤销完全移除该节点
    store.undo();
    expect(Object.values(store.getView().content.nodes)).toHaveLength(0);
  });

  it('新建闭合路径：点击起始锚点自动闭合并提交', () => {
    const { engine, pen, store } = setup();
    pen.activateTool();

    // 点 1 (100, 100)
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });

    // 点 2 (200, 100)
    dispatchPointer(engine, 'down', { x: 200, y: 100 });
    dispatchPointer(engine, 'up', { x: 200, y: 100 });

    // 点 3 (150, 200)
    dispatchPointer(engine, 'down', { x: 150, y: 200 });
    dispatchPointer(engine, 'up', { x: 150, y: 200 });

    // 点 4 点击回起始锚点 (100, 100) 附近 (闭合)
    dispatchPointer(engine, 'down', { x: 102, y: 99 });

    expect(pen.hasActiveDraft).toBe(false);
    const [node] = Object.values(store.getView().content.nodes);
    expect(node.path?.subpaths[0].closed).toBe(true);
    expect(node.path?.subpaths[0].anchors).toHaveLength(3);
  });

  it('草稿中断：Backspace 删点、Esc 取消与维护冻结清理', () => {
    const { engine, host, pen, store } = setup();
    pen.activateTool();

    // 点 1
    dispatchPointer(engine, 'down', { x: 50, y: 50 });
    dispatchPointer(engine, 'up', { x: 50, y: 50 });
    // 点 2
    dispatchPointer(engine, 'down', { x: 100, y: 50 });
    dispatchPointer(engine, 'up', { x: 100, y: 50 });

    // Backspace 删点 2，草稿保留点 1
    dispatchKey(engine, 'Backspace');
    expect(pen.hasActiveDraft).toBe(true);

    // Esc 取消
    dispatchKey(engine, 'Escape');
    expect(pen.hasActiveDraft).toBe(false);
    expect(host.sessions.has('pen:draft')).toBe(false);
    expect(Object.values(store.getView().content.nodes)).toHaveLength(0);

    // 维护冻结时丢弃草稿
    dispatchPointer(engine, 'down', { x: 60, y: 60 });
    expect(pen.hasActiveDraft).toBe(true);
    const lease = engine.beginMaintenance();
    expect(pen.hasActiveDraft).toBe(false);
    lease.resume();
  });

  it('已有路径锚点编辑：拖动锚点与控制柄通过 groupId 实时更新与单步撤销', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 }, mode: 'symmetric' },
        { id: 'a2', point: { x: 100, y: 0 }, mode: 'symmetric' }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 100,
      height: 0,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    const nodeId = initNode.id;

    pen.enterEditMode(nodeId);
    expect(pen.editingId).toBe(nodeId);

    // 拖动锚点 0 (世界坐标 100, 100 -> 局部坐标 0, 0)
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'move', { x: 110, y: 120 });
    dispatchPointer(engine, 'move', { x: 120, y: 140 });
    dispatchPointer(engine, 'up', { x: 120, y: 140 });

    const updatedNode = store.getNode(nodeId)!;
    // 拖动锚点后节点包围盒紧密贴合新几何范围：
    // 世界 X 范围 [120, 200] -> x: 120, width: 80
    // 世界 Y 范围 [100, 140] -> y: 100, height: 40
    expect(updatedNode.x).toBe(120);
    expect(updatedNode.y).toBe(100);
    expect(updatedNode.width).toBe(80);
    expect(updatedNode.height).toBe(40);
    const a0 = updatedNode.path!.subpaths[0].anchors[0];
    const a1 = updatedNode.path!.subpaths[0].anchors[1];
    expect(a0.point).toEqual({ x: 0, y: 40 });
    expect(a1.point).toEqual({ x: 80, y: 0 });

    // 撤销一步折叠回初始包围盒与坐标
    store.undo();
    const revertedNode = store.getNode(nodeId)!;
    expect(revertedNode.x).toBe(100);
    expect(revertedNode.y).toBe(100);
    expect(revertedNode.width).toBe(100);
    expect(revertedNode.height).toBe(0);
    expect(revertedNode.path!.subpaths[0].anchors[0].point).toEqual({ x: 0, y: 0 });
    expect(revertedNode.path!.subpaths[0].anchors[1].point).toEqual({ x: 100, y: 0 });
  });

  it('曲线上插入新锚点与删除选中锚点', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        { id: 'a2', point: { x: 200, y: 0 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 50,
      y: 50,
      width: 200,
      height: 0,
      options: { subpaths: [subpath] }
    });
    const [insertedNode] = Object.values(store.getView().content.nodes);
    const nodeId = insertedNode.id;

    pen.enterEditMode(nodeId);
    // 点击线段中点 (世界坐标 150, 50 -> 局部坐标 100, 0)
    dispatchPointer(engine, 'down', { x: 150, y: 50 });

    const withInserted = store.getNode(nodeId)!;
    expect(withInserted.path!.subpaths[0].anchors).toHaveLength(3);
    const middleAnchor = withInserted.path!.subpaths[0].anchors[1];
    expect(middleAnchor.point.x).toBeCloseTo(100, 1);
    expect(middleAnchor.point.y).toBeCloseTo(0, 1);

    // 按 Delete 键删除刚才选中的中点
    dispatchKey(engine, 'Delete');

    const afterDelete = store.getNode(nodeId)!;
    expect(afterDelete.path!.subpaths[0].anchors).toHaveLength(2);
  });

  it('节点类型：零跨度等比缩放、路径缓存与专有结构校验', () => {
    const def = new PathNodeType();

    const validNode = {
      id: 'p1',
      type: 'node',
      nodeType: 'path',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      path: {
        subpaths: [
          {
            closed: false,
            anchors: [
              { id: 'a1', point: { x: 0, y: 0 } },
              { id: 'a2', point: { x: 100, y: 50 } }
            ]
          }
        ]
      }
    } as unknown as NodeEntity;
    expect(def.validate(validNode)).toBeNull();

    const brokenNode = {
      ...validNode,
      path: { subpaths: [{ closed: false, anchors: [] }] }
    } as unknown as NodeEntity;
    expect(def.validate(brokenNode)).toContain('至少需包含 2 个锚点');

    const zeroHNode = {
      ...validNode,
      height: 0
    } as unknown as NodeEntity;
    const resized = def.applyResize(zeroHNode, {
      handle: 'se',
      width: 200,
      height: 0,
      scale: 2
    });
    const newAnchors = resized.path!.subpaths[0].anchors;
    expect(Number.isFinite(newAnchors[1].point.x)).toBe(true);
    expect(Number.isFinite(newAnchors[1].point.y)).toBe(true);
    expect(newAnchors[1].point.x).toBe(200);

    const dummyEngine = new SkyNoteEngine();
    const p1 = def.compose(validNode, { theme: dummyEngine.session.theme });
    expect(p1).toHaveLength(1);
    expect(def.cacheSize).toBe(1);
    def.clearCache('p1');
    expect(def.cacheSize).toBe(0);
  });

  it('仅展示模式 (PenDisplayPlugin) 与无插件环境往返保留', () => {
    const engine = new SkyNoteEngine()
      .use(new BasicNodesPlugin())
      .use(new SelectionPlugin())
      .use(new TransformPlugin());
    for (const plugin of createDisplayPlugins()) {
      expect(plugin).toBeInstanceOf(PenDisplayPlugin);
      engine.use(plugin);
    }
    for (const plugin of createPlugins()) expect(plugin).toBeInstanceOf(PenPlugin);

    const host = new FakeHost();
    engine.attachHost(host);

    const store = engine.documentStore;
    const subpath: Subpath = {
      closed: true,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        { id: 'a2', point: { x: 100, y: 0 } },
        { id: 'a3', point: { x: 50, y: 100 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      options: { subpaths: [subpath] }
    });

    const [orig] = Object.values(store.getView().content.nodes);
    expect(orig).toBeDefined();
    const raw = JSON.stringify(store.getView());

    const bareEngine = new SkyNoteEngine();
    const parsed = parseCanvasDocument(JSON.parse(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    bareEngine.documentStore.replaceContent(parsed.value.content, undefined, parsed.value.assets);
    const bareRaw = JSON.stringify(bareEngine.documentStore.getView());

    const reloaded = parseCanvasDocument(JSON.parse(bareRaw));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    const reloadedNode = reloaded.value.content.nodes[orig.id];
    expect(reloadedNode.path).toEqual(orig.path);
  });

  it('computeSubpathsTightBounds 精确计算贝塞尔弧线向外膨胀的紧密包围盒', () => {
    // 两个水平锚点 (0, 0) -> (100, 0)，控制柄向上拔起至 (0, -100) 与 (100, -100)
    // 曲线向上隆起至 y = -75
    const arch: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 }, handleOut: { x: 0, y: -100 } },
        { id: 'a2', point: { x: 100, y: 0 }, handleIn: { x: 0, y: -100 } }
      ]
    };
    const bounds = computeSubpathsTightBounds([arch]);
    expect(bounds).not.toBeNull();
    expect(bounds!.left).toBe(0);
    expect(bounds!.right).toBe(100);
    expect(bounds!.top).toBe(-75);
    expect(bounds!.bottom).toBe(0);
  });

  it('二次编辑向负方向拖拽锚点后，节点包围盒准确扩展且画布中世界位置不漂移', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: true,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        { id: 'a2', point: { x: 100, y: 0 } },
        { id: 'a3', point: { x: 100, y: 100 } },
        { id: 'a4', point: { x: 0, y: 100 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 200,
      y: 200,
      width: 100,
      height: 100,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    const nodeId = initNode.id;

    pen.enterEditMode(nodeId);

    // 拖拽左上角锚点 a1 (世界 200, 200) 向左上移动 50px (世界 150, 150)
    dispatchPointer(engine, 'down', { x: 200, y: 200 });
    dispatchPointer(engine, 'move', { x: 150, y: 150 });
    dispatchPointer(engine, 'up', { x: 150, y: 150 });

    const editedNode = store.getNode(nodeId)!;
    // 节点世界原点应自动调整为新包围盒左上角 (150, 150)
    expect(editedNode.x).toBe(150);
    expect(editedNode.y).toBe(150);
    // 宽高准确扩展为 150 x 150
    expect(editedNode.width).toBe(150);
    expect(editedNode.height).toBe(150);

    // 锚点局部坐标归一化，首点在 (0, 0)，原点依旧在世界 (150, 150)
    const anchors = editedNode.path!.subpaths[0].anchors;
    expect(anchors[0].point).toEqual({ x: 0, y: 0 });
    expect(anchors[1].point).toEqual({ x: 150, y: 50 }); // 世界 (300, 200) -> 局部 (150, 50)
    expect(anchors[2].point).toEqual({ x: 150, y: 150 }); // 世界 (300, 300) -> 局部 (150, 150)
    expect(anchors[3].point).toEqual({ x: 50, y: 150 }); // 世界 (200, 300) -> 局部 (50, 150)

    // 退出编辑模式
    pen.exitEditMode();
    const finalNode = store.getNode(nodeId)!;
    expect(finalNode.x).toBe(150);
    expect(finalNode.y).toBe(150);
    expect(finalNode.width).toBe(150);
    expect(finalNode.height).toBe(150);
  });

  it('绘制模式：光标靠近起始锚点时产生磁吸效果、高亮提示光圈，点击完成闭合提交', () => {
    const { engine, host, pen, store } = setup();
    pen.activateTool();

    // 绘制前两个锚点 (100, 100), (200, 100)
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });
    dispatchPointer(engine, 'down', { x: 200, y: 100 });
    dispatchPointer(engine, 'up', { x: 200, y: 100 });

    // 移动光标靠近起始锚点 (100, 100)，在磁吸容差范围内 (如 106, 106，距离 ~8.5px <= 14px)
    dispatchPointer(engine, 'move', { x: 106, y: 106 });

    // 新建时吸附不改变鼠标样式，依然保持 crosshair
    expect(host.cursors[host.cursors.length - 1]).toBe('crosshair');

    // 检查草稿覆盖层是否有吸附提示光圈 (紧凑半径 r = 6.5)
    const draftSession = host.sessions.get('pen:draft');
    expect(draftSession).toBeDefined();
    const snapCircle = draftSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 100 && (p as any).cy === 100 && (p as any).r === 6.5
    );
    expect(snapCircle).toBeDefined();

    // 橡皮筋虚线端点应吸附到起始点 (100, 100)
    const rubberband = draftSession!.primitives.find(
      (p) => p.kind === 'line' && (p as any).strokeDashArray !== undefined
    ) as any;
    expect(rubberband).toBeDefined();
    expect(rubberband.points[2]).toBe(100);
    expect(rubberband.points[3]).toBe(100);

    // 点击吸附位置，应该自动闭合路径并提交创建节点
    dispatchPointer(engine, 'down', { x: 106, y: 106 });

    expect(pen.hasActiveDraft).toBe(false);
    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes.length).toBe(1);
    const createdNode = nodes[0];
    expect(createdNode.path).toBeDefined();
    expect(createdNode.path!.subpaths[0].closed).toBe(true);
  });

  it('编辑模式：鼠标悬停在锚点、控制柄与曲线上时提供视觉高亮与光标反馈', () => {
    const { engine, host, pen, store } = setup();

    // 建立一个由 2 个锚点组成的带控制柄水平贝塞尔曲线
    // a1: (100, 100), handleOut: (50, 0) -> 控制柄世界坐标 (150, 100)
    // a2: (300, 100), handleIn: (-50, 0)
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 }, handleOut: { x: 50, y: 0 } },
        { id: 'a2', point: { x: 200, y: 0 }, handleIn: { x: -50, y: 0 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 200,
      height: 1,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    const nodeId = initNode.id;

    // 进入编辑态，默认选中第 0 个锚点 a1 (世界 100, 100)，光标为框架内置箭头 ('default')
    pen.enterEditMode(nodeId);
    expect(host.cursors[host.cursors.length - 1]).toBe('default');

    // 1. 悬停在锚点 a2 (世界 300, 100) 附近，光标保持框架箭头 'default'
    dispatchPointer(engine, 'move', { x: 300, y: 100 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    let editSession = host.sessions.get('pen:edit');
    expect(editSession).toBeDefined();
    // 悬停锚点应放大为圆形 r: 5.5
    const hoveredAnchorCircle = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 300 && (p as any).cy === 100 && (p as any).r === 5.5
    );
    expect(hoveredAnchorCircle).toBeDefined();

    // 2. 悬停在选中的 a1 控制柄 handleOut (世界 150, 100) 附近，光标保持框架箭头 'default'
    dispatchPointer(engine, 'move', { x: 150, y: 100 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    editSession = host.sessions.get('pen:edit');
    // 悬停控制柄圆点应放大为 r: 5.5
    const hoveredHandleCircle = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 150 && (p as any).cy === 100 && (p as any).r === 5.5
    );
    expect(hoveredHandleCircle).toBeDefined();

    // 3. 悬停在曲线段中部 (如世界 200, 100)，光标保持框架箭头 'default'
    dispatchPointer(engine, 'move', { x: 200, y: 100 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    editSession = host.sessions.get('pen:edit');
    // 悬停在曲线段上应显示插入预览圆点 (r: 4.5)
    const insertPreviewCircle = editSession!.primitives.find((p) => p.kind === 'circle' && (p as any).r === 4.5);
    expect(insertPreviewCircle).toBeDefined();

    // 4. 拖拽锚点 a2 (从世界 300, 100 拖拽到 320, 120)，拖拽过程中光标保持箭头 'default'
    dispatchPointer(engine, 'down', { x: 300, y: 100 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    dispatchPointer(engine, 'move', { x: 320, y: 120 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    dispatchPointer(engine, 'up', { x: 320, y: 120 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');

    // 5. 移动到远离交互点的空白区域 (世界 500, 500)，光标保持 'default'
    dispatchPointer(engine, 'move', { x: 500, y: 500 });
    expect(host.cursors[host.cursors.length - 1]).toBe('default');
    editSession = host.sessions.get('pen:edit');
    // 不再有放大的锚点、控制柄或插入圆点
    const anyHoveredAnchor = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 300 && (p as any).cy === 100 && (p as any).r === 5.5
    );
    const anyHoveredHandle = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 150 && (p as any).cy === 100 && (p as any).r === 5.5
    );
    const anyInsertPreview = editSession!.primitives.find((p) => p.kind === 'circle' && (p as any).r === 4.5);
    expect(anyHoveredAnchor).toBeUndefined();
    expect(anyHoveredHandle).toBeUndefined();
    expect(anyInsertPreview).toBeUndefined();
    expect(anyInsertPreview).toBeUndefined();

    // 退出编辑态，清除所有覆盖层
    pen.exitEditMode();
    expect(host.sessions.get('pen:edit')).toBeUndefined();
  });

  it('控制柄拖拽过程中保持放大与强调高亮激活样式 (r: 5.5)', () => {
    const { engine, host, pen, store } = setup();
    const nodeId = store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      options: {
        subpaths: [
          {
            anchors: [
              { id: 'a1', point: { x: 0, y: 0 }, handleOut: { x: 50, y: 0 }, mode: 'symmetric' },
              { id: 'a2', point: { x: 200, y: 0 }, mode: 'symmetric' }
            ],
            closed: false
          }
        ]
      }
    })!;

    pen.activateTool();
    pen.enterEditMode(nodeId);

    // 悬停在 a1 的 handleOut (世界 150, 100)
    dispatchPointer(engine, 'move', { x: 150, y: 100 });
    let editSession = host.sessions.get('pen:edit');
    expect(
      editSession!.primitives.some(
        (p) => p.kind === 'circle' && (p as any).cx === 150 && (p as any).cy === 100 && (p as any).r === 5.5
      )
    ).toBe(true);

    // 按下并拖拽该控制柄至 (160, 110)
    dispatchPointer(engine, 'down', { x: 150, y: 100 });
    dispatchPointer(engine, 'move', { x: 160, y: 110 });
    editSession = host.sessions.get('pen:edit');
    // 拖拽中控制柄圆点必须保持 r: 5.5 的放大与高亮激活样式，不可缩回 3.5
    const draggingHandle = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 160 && (p as any).cy === 110
    );
    expect(draggingHandle).toBeDefined();
    expect((draggingHandle as any).r).toBe(5.5);

    dispatchPointer(engine, 'up', { x: 160, y: 110 });
    pen.exitEditMode();
  });

  it('新建草稿中右键点击立即取消并丢弃当前草稿，切换工具或开始新建自动清空选区', () => {
    const { engine, host, pen } = setup();

    // 预设选区
    engine.session.setSelection({ nodeIds: ['prev-node'] });
    expect(engine.session.selectedNodeIds.has('prev-node')).toBe(true);

    // 激活工具自动清空
    pen.activateTool();
    expect(engine.session.selectedNodeIds.size).toBe(0);

    // 开始草稿
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });
    expect(pen.hasActiveDraft).toBe(true);
    expect(host.sessions.get('pen:draft')).toBeDefined();

    // 右键点击 (button: 2) -> 取消正在创建的钢笔路径，但不退出绘画工具
    dispatchPointer(engine, 'down', { x: 150, y: 150 }, { button: 2 });
    expect(pen.hasActiveDraft).toBe(false);
    expect(host.sessions.get('pen:draft')).toBeUndefined();
    expect(pen.active).toBe(true);
    expect(engine.session.tool).toBe('pen');
    expect(pen.consumeRightClickCancel()).toBe(true);
    expect(pen.consumeRightClickCancel()).toBe(false);
  });

  it('直线与曲线连接点优化：控制柄拖回锚点吸附折叠消除为纯直线，Alt 打破联动对称转换为单柄角点', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        {
          id: 'a2',
          point: { x: 100, y: 100 },
          handleIn: { x: -20, y: 0 },
          handleOut: { x: 20, y: 0 },
          mode: 'symmetric'
        },
        { id: 'a3', point: { x: 200, y: 100 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    pen.enterEditMode(initNode.id);

    // 选中锚点 1 (100, 100)
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });

    // 1. 测试控制柄拖回锚点吸附折叠：把 handleIn (原本在 80, 100) 拖回到距离锚点 3px 的位置 (97, 100)
    dispatchPointer(engine, 'down', { x: 80, y: 100 });
    dispatchPointer(engine, 'move', { x: 97, y: 100 });
    dispatchPointer(engine, 'up', { x: 97, y: 100 });

    const afterCollapse = store.getNode(initNode.id)!;
    const a2Collapsed = afterCollapse.path!.subpaths[0].anchors[1];
    // handleIn 吸附归零折叠消除为 undefined，变成 corner 模式，而 handleOut 仍保留！
    expect(a2Collapsed.handleIn).toBeUndefined();
    expect(a2Collapsed.handleOut).toBeDefined();
    expect(a2Collapsed.mode).toBe('corner');

    // 2. 测试 Alt 键拖拽控制柄：打破对称，仅移动 handleOut
    dispatchPointer(engine, 'down', { x: 120, y: 100 });
    dispatchPointer(engine, 'move', { x: 140, y: 120 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'up', { x: 140, y: 120 }, { modifiers: { alt: true } });

    const afterAlt = store.getNode(initNode.id)!;
    const a2Alt = afterAlt.path!.subpaths[0].anchors[1];
    expect(a2Alt.handleIn).toBeUndefined();
    expect(a2Alt.handleOut).toEqual({ x: 40, y: 20 });
    expect(a2Alt.mode).toBe('corner');
  });

  it('二次编辑态双击锚点在纯净角点与平滑点之间一键切换', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        {
          id: 'a2',
          point: { x: 100, y: 100 },
          handleIn: { x: -20, y: 0 },
          handleOut: { x: 20, y: 0 },
          mode: 'symmetric'
        },
        { id: 'a3', point: { x: 200, y: 100 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    pen.enterEditMode(initNode.id);

    // 双击锚点 1 (100, 100)：原本有 handles -> 一键清除转换为尖锐角点
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { clickCount: 2 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 }, { clickCount: 2 });

    const afterCorner = store.getNode(initNode.id)!;
    const a2Corner = afterCorner.path!.subpaths[0].anchors[1];
    expect(a2Corner.handleIn).toBeUndefined();
    expect(a2Corner.handleOut).toBeUndefined();
    expect(a2Corner.mode).toBe('corner');

    // 再次双击锚点 1 -> 自动生成平滑手柄
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { clickCount: 2 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 }, { clickCount: 2 });

    const afterSmooth = store.getNode(initNode.id)!;
    const a2Smooth = afterSmooth.path!.subpaths[0].anchors[1];
    expect(a2Smooth.handleIn).toBeDefined();
    expect(a2Smooth.handleOut).toBeDefined();
    expect(a2Smooth.mode).toBe('symmetric');
  });

  it('新建路径时微小位移死区保护，防止鼠标抖动产生微小伪手柄', () => {
    const { engine, pen, store } = setup();
    pen.activateTool();

    // 点 1
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });

    // 点 2: 按下并在 2px 内轻微抖动，然后抬起
    dispatchPointer(engine, 'down', { x: 200, y: 100 });
    dispatchPointer(engine, 'move', { x: 202, y: 101 });
    dispatchPointer(engine, 'up', { x: 202, y: 101 });

    // Enter 提交
    dispatchKey(engine, 'Enter');

    const [node] = Object.values(store.getView().content.nodes);
    expect(node).toBeDefined();
    const a1 = node.path!.subpaths[0].anchors[1];
    // 死区内轻微抖动被保护为纯净角点，未生成畸变伪控制柄
    expect(a1.handleIn).toBeUndefined();
    expect(a1.handleOut).toBeUndefined();
    expect(a1.mode).toBe('corner');
  });

  it('新建路径时点击并拖拽：实时拉出控制柄并调整线段曲率，橡皮筋平滑延伸贝塞尔预测线', () => {
    const { engine, host, pen, store } = setup();
    pen.activateTool();

    // 点 1：纯单击 (100, 100)
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });

    // 点 2：在 (200, 100) 按下，经轻微抖动 (201, 100) 后持续拖拽到 (200, 150)
    dispatchPointer(engine, 'down', { x: 200, y: 100 });
    dispatchPointer(engine, 'move', { x: 201, y: 100 }); // 1px 微颤
    dispatchPointer(engine, 'move', { x: 200, y: 150 }); // 明显拖拽 50px

    // 检查草稿覆盖层：因拖拽产生了 handleIn / handleOut，确认路径线段已动态弯曲调整为贝塞尔三次曲线
    const draftSessionDuringDrag = host.sessions.get('pen:draft');
    expect(draftSessionDuringDrag).toBeDefined();
    const pathPrimDuringDrag = draftSessionDuringDrag!.primitives.find((p) => p.kind === 'path') as any;
    expect(pathPrimDuringDrag).toBeDefined();
    expect(pathPrimDuringDrag.d).toContain('C'); // 包含贝塞尔三次曲线指令，实时跟着拖拽调整

    // 抬起鼠标完成点 2 的拖拽创建
    dispatchPointer(engine, 'up', { x: 200, y: 150 });

    // 移动鼠标至 (300, 200) 准备定位点 3
    dispatchPointer(engine, 'move', { x: 300, y: 200 });

    // 检查橡皮筋预测线：因上一个锚点有 handleOut，橡皮筋应当按三次贝塞尔曲线虚线预测延伸，而非死板直线
    const draftSessionPreview = host.sessions.get('pen:draft');
    expect(draftSessionPreview).toBeDefined();
    const rubberbandBezier = draftSessionPreview!.primitives.find(
      (p) => p.kind === 'path' && (p as any).strokeDashArray !== undefined
    ) as any;
    expect(rubberbandBezier).toBeDefined();
    expect(rubberbandBezier.d).toContain('C');

    // Enter 提交
    dispatchKey(engine, 'Enter');

    const [node] = Object.values(store.getView().content.nodes);
    expect(node).toBeDefined();
    const anchors = node.path!.subpaths[0].anchors;
    expect(anchors).toHaveLength(2);
    // 点 1 为尖锐角点 (直线侧)
    expect(anchors[0].handleIn).toBeUndefined();
    expect(anchors[0].handleOut).toBeUndefined();
    expect(anchors[0].mode).toBe('corner');
    // 点 2 成功保留拖拽产生的控制柄与对称模式
    expect(anchors[1].handleIn).toEqual({ x: 0, y: -50 });
    expect(anchors[1].handleOut).toEqual({ x: 0, y: 50 });
    expect(anchors[1].mode).toBe('symmetric');
  });

  it('二次编辑：按住 Alt 键拖拽锚点直接拔出控制柄，恢复单侧手柄与 180 度平滑对称', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        { id: 'a2', point: { x: 100, y: 100 } }, // 纯角点，无手柄
        { id: 'a3', point: { x: 200, y: 100 } }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    pen.enterEditMode(initNode.id);

    // 1. 从无手柄的角点 a2 (100, 100) 按住 Alt 向 (120, 110) 拖拽：直接拔出一对 180° 对称平滑控制柄
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'move', { x: 120, y: 110 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'up', { x: 120, y: 110 }, { modifiers: { alt: true } });

    let node = store.getNode(initNode.id)!;
    let a2 = node.path!.subpaths[0].anchors[1];
    expect(a2.handleOut).toEqual({ x: 20, y: 10 });
    expect(a2.handleIn).toEqual({ x: -20, y: -10 });
    expect(a2.mode).toBe('symmetric');

    // 2. 模拟场景 2：将 handleIn 拖回锚点吸附折叠消除 (单侧拉直)
    dispatchPointer(engine, 'down', { x: 80, y: 90 });
    dispatchPointer(engine, 'move', { x: 98, y: 100 });
    dispatchPointer(engine, 'up', { x: 98, y: 100 });

    node = store.getNode(initNode.id)!;
    a2 = node.path!.subpaths[0].anchors[1];
    expect(a2.handleIn).toBeUndefined();
    expect(a2.handleOut).toBeDefined();

    // 3. 测试场景 2 切回：按住 Alt 从锚点 (100, 100) 拔出 handleIn，即使鼠标大角度旋转至 handleOut 所在侧，也专一更新 handleIn，绝不篡改 handleOut
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'move', { x: 80, y: 90 }, { modifiers: { alt: true } });
    // 大角度旋转至 handleOut 所在侧 (世界坐标 130, 80，即相对锚点 +30, -20)
    dispatchPointer(engine, 'move', { x: 130, y: 80 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'up', { x: 130, y: 80 }, { modifiers: { alt: true } });

    node = store.getNode(initNode.id)!;
    a2 = node.path!.subpaths[0].anchors[1];
    // handleIn 成功跟随鼠标自由旋转到 (30, -20)
    expect(a2.handleIn).toEqual({ x: 30, y: -20 });
    // handleOut 绝对保持不变 (20, 10)，绝未被篡改或破坏
    expect(a2.handleOut).toEqual({ x: 20, y: 10 });
    expect(a2.mode).toBe('corner');

    // 4. 模拟场景 3：按住 Alt 拖动 handleOut 打破对称 (转为角点非共线)
    dispatchPointer(engine, 'down', { x: 120, y: 110 });
    dispatchPointer(engine, 'move', { x: 130, y: 130 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'up', { x: 130, y: 130 }, { modifiers: { alt: true } });

    node = store.getNode(initNode.id)!;
    a2 = node.path!.subpaths[0].anchors[1];
    expect(a2.mode).toBe('corner');

    // 5. 测试场景 3 切回：按住 Alt 从锚点 (100, 100) 向 (120, 100) 拖拽，重新重置拔出 180° 对称平滑手柄
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'move', { x: 120, y: 100 }, { modifiers: { alt: true } });
    dispatchPointer(engine, 'up', { x: 120, y: 100 }, { modifiers: { alt: true } });

    node = store.getNode(initNode.id)!;
    a2 = node.path!.subpaths[0].anchors[1];
    expect(a2.handleOut).toEqual({ x: 20, y: 0 });
    expect(a2.handleIn).toEqual({ x: -20, y: 0 });
    expect(a2.mode).toBe('symmetric');
  });

  it('编辑模式：双门限迟滞滤波与防抖锁定，避免在折叠/拔出临界点产生抖动闪烁', () => {
    const { engine, pen, store } = setup();
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        {
          id: 'a2',
          point: { x: 100, y: 100 },
          handleIn: { x: -20, y: 0 },
          handleOut: { x: 20, y: 0 },
          mode: 'symmetric'
        }
      ]
    };
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      options: { subpaths: [subpath] }
    });
    const [initNode] = Object.values(store.getView().content.nodes);
    pen.enterEditMode(initNode.id);

    // 选中锚点 1 (100, 100) 以显示其控制柄
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'up', { x: 100, y: 100 });

    // 1. 拖拽控制柄接近锚点：距离为 7px (介于 enter 6px 与 leave 10px 之间)
    // 尚未触发折叠 (因为还未进入 <= 6px)
    dispatchPointer(engine, 'down', { x: 120, y: 100 });
    dispatchPointer(engine, 'move', { x: 107, y: 100 });
    let node = store.getNode(initNode.id)!;
    let a = node.path!.subpaths[0].anchors[1];
    expect(a.handleOut).toBeDefined();
    expect(a.handleOut?.x).toBe(7);

    // 2. 继续拖近至 5px (进入 <= 6px)，触发吸附折叠消除
    dispatchPointer(engine, 'move', { x: 105, y: 100 });
    node = store.getNode(initNode.id)!;
    a = node.path!.subpaths[0].anchors[1];
    expect(a.handleOut).toBeUndefined();

    // 3. 鼠标在 7px 处微抖：由于迟滞特性，只有大于 10px 才会脱离折叠，因此 7px 依然保持折叠，不发生闪烁
    dispatchPointer(engine, 'move', { x: 107, y: 100 });
    node = store.getNode(initNode.id)!;
    a = node.path!.subpaths[0].anchors[1];
    expect(a.handleOut).toBeUndefined();

    // 4. 拉远至 12px (脱离 > 10px 门限)，重新激活拉出控制柄
    dispatchPointer(engine, 'move', { x: 112, y: 100 });
    node = store.getNode(initNode.id)!;
    a = node.path!.subpaths[0].anchors[1];
    expect(a.handleOut).toBeDefined();
    expect(a.handleOut?.x).toBe(12);

    dispatchPointer(engine, 'up', { x: 112, y: 100 });
  });

  it('编辑模式：路径节点作为子节点 (如挂载在导图/画框/父容器下) 时，控制点与控制柄坐标准确映射，支持交互编辑', () => {
    const { engine, host, pen, store } = setup();

    // 1. 创建父节点 (例如导图或容器节点，位于世界坐标 500, 300)
    const parentId = store.createNode({
      nodeType: 'shape',
      x: 500,
      y: 300,
      width: 200,
      height: 100
    })!;

    // 2. 创建路径子节点，挂载在 parentId 下，局部坐标为 (50, 40)
    // 对应世界坐标原点为 (550, 340)
    const subpath: Subpath = {
      closed: false,
      anchors: [
        { id: 'a1', point: { x: 0, y: 0 } },
        {
          id: 'a2',
          point: { x: 100, y: 50 },
          handleIn: { x: -30, y: 0 },
          handleOut: { x: 30, y: 0 },
          mode: 'symmetric'
        }
      ]
    };
    const pathNodeId = store.createNode({
      nodeType: PathNodeType.TYPE,
      parentId,
      x: 50,
      y: 40,
      width: 100,
      height: 50,
      options: { subpaths: [subpath] }
    })!;

    // 3. 进入路径编辑模式
    pen.enterEditMode(pathNodeId);
    expect(pen.editingId).toBe(pathNodeId);

    // 检查覆盖层控制点世界坐标：
    // a1 锚点局部 (0, 0) -> 世界坐标应为 (550, 340)
    // a2 锚点局部 (100, 50) -> 世界坐标应为 (650, 390)
    // a2 handleOut 局部 (30, 0) -> 世界坐标应为 (680, 390)
    // a2 handleIn 局部 (-30, 0) -> 世界坐标应为 (620, 390)
    const editSession = host.sessions.get('pen:edit');
    expect(editSession).toBeDefined();

    const a1Circle = editSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 550 && (p as any).cy === 340
    );
    expect(a1Circle).toBeDefined();

    // 4. 选中 a2 锚点 (点击世界 650, 390)
    dispatchPointer(engine, 'down', { x: 650, y: 390 });
    dispatchPointer(engine, 'up', { x: 650, y: 390 });

    const updatedSession = host.sessions.get('pen:edit');
    const a2HandleOut = updatedSession!.primitives.find(
      (p) => p.kind === 'circle' && (p as any).cx === 680 && (p as any).cy === 390
    );
    expect(a2HandleOut).toBeDefined();

    // 5. 拖拽 a2 的 handleOut (从世界 680, 390 拖到世界 680, 410)
    // 对应局部偏移从 (30, 0) 变为 (30, 20)
    dispatchPointer(engine, 'down', { x: 680, y: 390 });
    dispatchPointer(engine, 'move', { x: 680, y: 410 });
    dispatchPointer(engine, 'up', { x: 680, y: 410 });

    const editedPathNode = store.getNode(pathNodeId)!;
    const a2Anchor = editedPathNode.path!.subpaths[0].anchors[1];
    expect(a2Anchor.handleOut).toEqual({ x: 30, y: 20 });
    expect(a2Anchor.handleIn).toEqual({ x: -30, y: -20 });

    // 退出编辑模式
    pen.exitEditMode();
    expect(pen.editingId).toBeNull();
  });

  it('二次编辑：从选择模式或其他非绘图模式进入二次编辑，点击空白、Esc 或 Enter 退出后恢复之前的模式，不留在绘图模式', () => {
    const { engine, pen, store } = setup();

    // 创建一个已有的路径节点
    engine.session.setTool(SELECT_TOOL);
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      options: {
        subpaths: [
          {
            anchors: [
              { id: 'p1', point: { x: 0, y: 0 } },
              { id: 'p2', point: { x: 100, y: 100 } }
            ],
            closed: false
          }
        ]
      }
    });
    const [pathNode] = Object.values(store.getView().content.nodes);

    // 1. 从选择模式进入二次编辑
    expect(engine.session.tool).toBe(SELECT_TOOL);
    pen.enterEditMode(pathNode.id, SELECT_TOOL);
    expect(pen.editingId).toBe(pathNode.id);
    expect(engine.session.tool).toBe(PEN_TOOL);

    // 点击空白处退出二次编辑 -> 恢复为 SELECT_TOOL，不留在绘图模式
    dispatchPointer(engine, 'down', { x: 999, y: 999 });
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(SELECT_TOOL);

    // 2. 再次从 SELECT_TOOL 进入二次编辑，按 Escape 退出
    pen.enterEditMode(pathNode.id, SELECT_TOOL);
    expect(pen.editingId).toBe(pathNode.id);
    expect(engine.session.tool).toBe(PEN_TOOL);

    dispatchKey(engine, 'Escape');
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(SELECT_TOOL);
    // Escape 退出后自动选中该节点方便查看/移动
    expect(Array.from(engine.session.selectedNodeIds)).toEqual([pathNode.id]);

    // 3. 再次从 SELECT_TOOL 进入二次编辑，按 Enter 退出
    pen.enterEditMode(pathNode.id, SELECT_TOOL);
    expect(pen.editingId).toBe(pathNode.id);
    expect(engine.session.tool).toBe(PEN_TOOL);

    dispatchKey(engine, 'Enter');
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(SELECT_TOOL);
    expect(Array.from(engine.session.selectedNodeIds)).toEqual([pathNode.id]);
  });

  it('二次编辑：正处于绘图模式 (钢笔或画笔) 进入二次编辑，编辑退出后仍保持之前的绘图模式', () => {
    const { engine, pen, store } = setup();

    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      options: {
        subpaths: [
          {
            anchors: [
              { id: 'p1', point: { x: 0, y: 0 } },
              { id: 'p2', point: { x: 100, y: 100 } }
            ],
            closed: false
          }
        ]
      }
    });
    const [pathNode] = Object.values(store.getView().content.nodes);

    // 1. 原本处于钢笔绘图模式
    pen.activateTool();
    expect(engine.session.tool).toBe(PEN_TOOL);

    pen.enterEditMode(pathNode.id);
    expect(pen.editingId).toBe(pathNode.id);

    // 点击空白退出 -> 仍然保持 PEN_TOOL (绘图模式)
    dispatchPointer(engine, 'down', { x: 999, y: 999 });
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(PEN_TOOL);

    // 2. 原本处于画笔绘图模式
    engine.session.setTool(BRUSH_TOOL);
    expect(engine.session.tool).toBe(BRUSH_TOOL);

    pen.enterEditMode(pathNode.id, BRUSH_TOOL);
    expect(pen.editingId).toBe(pathNode.id);

    // 按 Escape 退出 -> 恢复为 BRUSH_TOOL (绘图模式)
    dispatchKey(engine, 'Escape');
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(BRUSH_TOOL);
  });

  it('交互增强：双击画布上的路径节点直接进入该节点的二次编辑模式', () => {
    const { engine, pen, store } = setup();

    engine.session.setTool(SELECT_TOOL);
    store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      options: {
        subpaths: [
          {
            anchors: [
              { id: 'p1', point: { x: 0, y: 0 } },
              { id: 'p2', point: { x: 100, y: 100 } }
            ],
            closed: false
          }
        ]
      }
    });
    const [pathNode] = Object.values(store.getView().content.nodes);

    // 双击路径节点 (世界坐标 150, 150 处于路径对角线上)
    dispatchPointer(engine, 'down', { x: 150, y: 150 }, { clickCount: 2 });
    expect(pen.editingId).toBe(pathNode.id);
    expect(engine.session.tool).toBe(PEN_TOOL);

    // 点击空白退出 -> 恢复进入前的 SELECT_TOOL
    dispatchPointer(engine, 'down', { x: 999, y: 999 });
    expect(pen.editingId).toBeNull();
    expect(engine.session.tool).toBe(SELECT_TOOL);
  });

  it('防崩与连线兼容：createContent 在缺省 options 时安全提供有效默认值；四周加号快速连接克隆路径不报错', () => {
    const nodeType = new PathNodeType();
    // 1. 无参或空对象调用 createContent 不报 TypeError
    const fallbackContent = nodeType.createContent({});
    expect(fallbackContent.path?.subpaths.length).toBeGreaterThan(0);
    expect(fallbackContent.width).toBeGreaterThanOrEqual(0);
    expect(fallbackContent.height).toBeGreaterThanOrEqual(0);

    // 2. 宿主装配钢笔与连线插件，选中钢笔路径节点并点击右侧快速连接「+」
    const engine = new SkyNoteEngine()
      .use(new BasicNodesPlugin())
      .use(new SelectionPlugin())
      .use(new ConnectorToolPlugin())
      .use(new PenPlugin());
    const host = new FakeHost();
    engine.attachHost(host);
    const store = engine.documentStore;

    const pathId = store.createNode({
      nodeType: PathNodeType.TYPE,
      x: 100,
      y: 100,
      options: {
        subpaths: [
          {
            anchors: [
              { id: 'a1', point: { x: 0, y: 0 } },
              { id: 'a2', point: { x: 80, y: 80 } }
            ],
            closed: false
          }
        ],
        strokeWidth: 2
      }
    })!;

    engine.session.setSelection({ nodeIds: [pathId] });
    // 四周加号快速连接点存在
    const plusSession = host.sessions.get('connector-tool:plus');
    expect(plusSession).toBeDefined();

    // 模拟点击右侧加号 (外框右边缘中点外侧：x = 100 + 80 + 12 = 192, y = 100 + 40 = 140)
    dispatchPointer(engine, 'down', { x: 192, y: 140 });
    dispatchPointer(engine, 'up', { x: 192, y: 140 });

    // 成功新建连线节点，且不抛异常
    const allNodes = Object.values(store.getView().content.nodes);
    expect(allNodes.length).toBe(2);
    const clonedNode = allNodes.find((n) => n.id !== pathId)!;
    expect(clonedNode.nodeType).toBe(PathNodeType.TYPE);
    expect(clonedNode.path?.subpaths.length).toBe(1);

    const connectors = Object.values(store.getView().content.connectors);
    expect(connectors.length).toBe(1);
    expect(connectors[0].from).toEqual({ nodeId: pathId });
    expect(connectors[0].to).toEqual({ nodeId: clonedNode.id });
  });
});
