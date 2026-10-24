/**
 * @file pen-plugin.ts
 * @description 商业钢笔工具插件：分离仅展示插件 (PenDisplayPlugin) 与完整矢量路径编辑插件 (PenPlugin)
 *
 * 核心架构规范：
 * 1. 展示与编辑装配解耦 (ADR-142)：无商业编辑授权时仅装配 PenDisplayPlugin，已有 path 节点正常渲染并可通用移动/缩放/复制/删除；
 * 2. 新建路径草稿：点击落点，拖拽拉出控制柄，Enter 或点击起点闭合单事务 createNode 提交；Esc/取消/失焦丢弃；
 * 3. 已有路径锚点与控制柄编辑：采用按下深拷贝快照 + 共享 groupId 实时提交更新模式 (与 TransformPlugin/ConnectorEditPlugin 一致)，
 *    松手折叠为单步撤销，中断时以相同 groupId 恢复快照；
 * 4. 平台中立：零 DOM、Canvas 与渲染器依赖。
 */

import {
  SELECT_TOOL,
  applyMatrix,
  applyMatrixToVector,
  clonePlainData,
  computeNodeLocalMatrix,
  generateId,
  invertMatrix,
  resolveThemeColor,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type Matrix2D,
  type NodeEntity,
  type PointerHooks,
  type Point,
  type SessionChange,
  type SkyNotePlugin
} from '@skynote/core';
import {
  buildSubpathSegments,
  buildSvgPathData,
  computeSubpathsTightBounds,
  distancePointToCubicSegment,
  distancePointToLineSegment,
  roundNum,
  splitCubicBezier,
  syncAnchorHandles,
  type PathAnchor,
  type Subpath
} from './bezier-geometry';
import { PathNodeType, DEFAULT_PATH_STROKE_WIDTH } from './path-node';

export const PEN_PLUGIN_ID = '@skynote-pro/plugin-pen';
export const PEN_DISPLAY_PLUGIN_ID = '@skynote-pro/plugin-pen/display';
export const PEN_TOOL = 'pen';

const PEN_TOOL_PRIORITY = 85;
const PEN_KEY_PRIORITY = 15;
const DRAFT_OVERLAY_SESSION = 'pen:draft';
const EDIT_OVERLAY_SESSION = 'pen:edit';

/** 锚点拾取容差 (屏幕像素) */
const ANCHOR_HIT_RADIUS_PX = 8;
/** 控制柄拾取容差 (屏幕像素) */
const HANDLE_HIT_RADIUS_PX = 6;
/** 曲线插入锚点拾取容差 (屏幕像素) */
const SEGMENT_INSERT_RADIUS_PX = 6;
/** 闭合吸附容差 (屏幕像素) */
const SNAP_CLOSE_RADIUS_PX = 14;
/** 新建时拉柄死区阈值：位移小于此值视为点击 corner 锚点，不产生微小伪控制柄 (屏幕像素) */
const DRAG_HANDLE_DEADZONE_PX = 5;
/** 控制柄拖回吸附折叠门限 (进入迟滞阈值)：拖回距离小于此值时吸附折叠消除 (屏幕像素) */
const HANDLE_COLLAPSE_ENTER_PX = 6;
/** 控制柄拖出反折叠门限 (脱离迟滞阈值)：拖出距离大于此值时方可重新激活 (屏幕像素) */
const HANDLE_COLLAPSE_LEAVE_PX = 10;
/** 控制柄最小可视距离：控制柄屏幕长度小于此值时不渲染多余图元，避免重叠粘连 (屏幕像素) */
const MIN_HANDLE_VISIBLE_PX = 5;

export interface PenSettings {
  readonly stroke?: string;
  readonly strokeWidth: number;
  readonly opacity: number;
  readonly strokeDashArray?: number[];
  readonly fill?: string;
}

export type PenPluginOptions = Partial<PenSettings>;

/** 新建路径草稿状态 */
interface ActivePenDraft {
  readonly subpaths: Subpath[];
  currentAnchorIndex: number;
  isDraggingHandle: boolean;
  dragStartPos: Point;
  hasDraggedHandle: boolean;
  lastPointerPos: Point;
  readonly frozenStyle: Readonly<PenSettings>;
  isSnappedToClose?: boolean;
}

/** 锚点编辑态悬停高亮目标 */
type EditHoverTarget =
  | { readonly type: 'handle'; readonly handle: 'handleIn' | 'handleOut'; readonly anchorIndex: number }
  | { readonly type: 'anchor'; readonly index: number }
  | { readonly type: 'segment'; readonly segStartIndex: number; readonly point: Point; readonly t: number };

function isEqualHoverTarget(a: EditHoverTarget | null, b: EditHoverTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'anchor' && b.type === 'anchor') {
    return a.index === b.index;
  }
  if (a.type === 'handle' && b.type === 'handle') {
    return a.handle === b.handle && a.anchorIndex === b.anchorIndex;
  }
  if (a.type === 'segment' && b.type === 'segment') {
    return Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < 1;
  }
  return false;
}

/** 锚点拖拽手势状态 */
interface ActiveAnchorDrag {
  readonly nodeId: string;
  readonly snapshot: NodeEntity;
  readonly groupId: string;
  readonly anchorIndex: number;
  readonly target: 'point' | 'handleIn' | 'handleOut' | 'pullHandle';
  readonly startLocalPos: Point;
  readonly initialAnchor?: PathAnchor;
  readonly initialAlt: boolean;
  hasActivatedPull?: boolean;
  isCollapsed?: boolean;
}

/**
 * 仅展示插件：只注册 path 节点类型并维护派生路径缓存，不提供钢笔绘制与锚点编辑工具
 */
export class PenDisplayPlugin implements SkyNotePlugin {
  readonly id = PEN_DISPLAY_PLUGIN_ID;
  readonly name = '钢笔路径展示';
  readonly version = '0.1.0';
  readonly nodeType = new PathNodeType();

  install(ctx: CanvasPluginContext): void {
    ctx.registerNodeType(this.nodeType);
    ctx.onDocumentChange((changes) => {
      if (changes.contentReplaced) {
        this.nodeType.clearCache();
        return;
      }
      for (const id of changes.nodes.removed) {
        this.nodeType.clearCache(id);
      }
    });
  }

  unmount(): void {
    this.nodeType.clearCache();
  }
}

/**
 * 完整商业钢笔插件：矢量贝塞尔曲线绘制 + 锚点与控制柄交互编辑
 */
export class PenPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = PEN_PLUGIN_ID;
  readonly name = '商业钢笔';
  readonly version = '0.1.0';
  readonly nodeType = new PathNodeType();

  private ctx!: CanvasPluginContext;
  private settings: PenSettings;
  private draft: ActivePenDraft | null = null;
  private editingNodeId: string | null = null;
  private selectedAnchorIndex: number | null = null;
  private hoverTarget: EditHoverTarget | null = null;
  private dragSession: ActiveAnchorDrag | null = null;
  private nextAnchorIdCounter = 1;
  private readonly settingsListeners = new Set<(settings: Readonly<PenSettings>) => void>();
  /** 二次编辑前所处的工具模式 (例如 'select', 'hand', 'brush', 'pen') */
  private previousToolBeforeEdit: string | null = null;
  private isExitingEditMode = false;

  constructor(options: PenPluginOptions = {}) {
    this.settings = {
      stroke: options.stroke,
      strokeWidth: Math.max(0.5, options.strokeWidth ?? DEFAULT_PATH_STROKE_WIDTH),
      opacity: Math.max(0, Math.min(1, options.opacity ?? 1)),
      strokeDashArray: options.strokeDashArray,
      fill: options.fill
    };
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerNodeType(this.nodeType);
    ctx.registerPointerHooks(this, PEN_TOOL_PRIORITY);
    ctx.registerInputScope({
      id: 'canvas:pen-tool',
      priority: PEN_KEY_PRIORITY,
      onKeyDown: (e) => this.onKeyDown(e),
      onBlur: () => this.cancelActiveDraft()
    });
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.cancelActiveDraft();
    this.exitEditMode({ restoreTool: false });
    this.nodeType.clearCache();
    this.settingsListeners.clear();
  }

  get active(): boolean {
    return this.ctx?.session.tool === PEN_TOOL;
  }

  get hasActiveDraft(): boolean {
    return this.draft !== null;
  }

  get editingId(): string | null {
    return this.editingNodeId;
  }

  activateTool(): void {
    this.ctx.session.setTool(PEN_TOOL);
    this.ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
  }

  getSettings(): Readonly<PenSettings> {
    return this.settings;
  }

  setSettings(partial: Partial<PenSettings>): void {
    this.settings = {
      stroke: 'stroke' in partial ? partial.stroke : this.settings.stroke,
      strokeWidth: partial.strokeWidth !== undefined ? Math.max(0.5, partial.strokeWidth) : this.settings.strokeWidth,
      opacity: partial.opacity !== undefined ? Math.max(0, Math.min(1, partial.opacity)) : this.settings.opacity,
      strokeDashArray: 'strokeDashArray' in partial ? partial.strokeDashArray : this.settings.strokeDashArray,
      fill: 'fill' in partial ? partial.fill : this.settings.fill
    };
    for (const listener of this.settingsListeners) {
      listener(this.settings);
    }
  }

  /** 订阅钢笔设置变更 */
  onSettingsChange(listener: (settings: Readonly<PenSettings>) => void): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  /** 取消并丢弃新建路径草稿 */
  cancelActiveDraft(): void {
    if (!this.draft) return;
    this.draft = null;
    this.ctx.host.overlay.clear(DRAFT_OVERLAY_SESSION);
  }

  /** 读取节点的世界变换矩阵 (兼容顶层节点与被拖入容器/导图的子节点) */
  private getNodeWorldTransform(node: Readonly<NodeEntity>): Matrix2D {
    return this.ctx.entities.getWorldTransform(node.id) ?? computeNodeLocalMatrix(node);
  }

  /** 将世界坐标转换为节点局部坐标 */
  private worldToNodeLocal(node: Readonly<NodeEntity>, worldPoint: Point): Point {
    const worldMatrix = this.getNodeWorldTransform(node);
    const inv = invertMatrix(worldMatrix);
    return applyMatrix(inv, worldPoint.x, worldPoint.y);
  }

  /** 将节点局部坐标转换为世界坐标 */
  private nodeLocalToWorld(node: Readonly<NodeEntity>, localPoint: Point): Point {
    const worldMatrix = this.getNodeWorldTransform(node);
    return applyMatrix(worldMatrix, localPoint.x, localPoint.y);
  }

  /** 将节点局部向量 (如控制柄相对位移) 转换为世界向量 */
  private nodeVectorToWorld(node: Readonly<NodeEntity>, localVector: Point): Point {
    const worldMatrix = this.getNodeWorldTransform(node);
    return applyMatrixToVector(worldMatrix, localVector.x, localVector.y);
  }

  /** 退出已有路径的锚点编辑模式；没有在编辑时不做任何事 (维护态等防御性调用不得改动别的插件的工具) */
  exitEditMode(options: { restoreTool?: boolean } = {}): void {
    const { restoreTool = true } = options;
    if (this.isExitingEditMode || this.editingNodeId === null) return;
    this.isExitingEditMode = true;

    try {
      if (this.dragSession) {
        this.revertDragSession();
      }
      this.normalizePathNode(this.editingNodeId);
      const previousTool = this.previousToolBeforeEdit;

      this.editingNodeId = null;
      this.selectedAnchorIndex = null;
      this.hoverTarget = null;
      this.dragSession = null;
      this.previousToolBeforeEdit = null;
      this.ctx?.host.overlay.clear(EDIT_OVERLAY_SESSION);

      if (this.ctx) {
        // 进入编辑时总会记下原工具：回到进入前的工具 (钢笔、画笔或选择等一视同仁)，钢笔不必认识其他插件的工具
        if (restoreTool && previousTool && this.ctx.session.tool !== previousTool) {
          this.ctx.session.setTool(previousTool);
        }
        this.ctx.host.setCursor(this.active ? 'crosshair' : 'default');
      }
    } finally {
      this.isExitingEditMode = false;
    }
  }

  /** 进入指定路径节点的锚点编辑模式 */
  enterEditMode(nodeId: string, fromTool?: string): void {
    const node = this.ctx.document.getNode(nodeId);
    if (!node || node.nodeType !== PathNodeType.TYPE || !node.path) return;

    if (this.editingNodeId && this.editingNodeId !== nodeId) {
      this.exitEditMode({ restoreTool: false });
    }

    // 记录进入二次编辑前的模式 (优先使用显式传递的原工具，其次使用当前会话工具)
    if (this.previousToolBeforeEdit === null) {
      this.previousToolBeforeEdit = fromTool ?? this.ctx.session.tool;
    }

    // 激活钢笔工具上下文以支持快捷键与编辑光标
    if (this.ctx.session.tool !== PEN_TOOL) {
      this.ctx.session.setTool(PEN_TOOL);
    }

    this.cancelActiveDraft();
    this.normalizePathNode(nodeId);
    this.ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
    this.editingNodeId = nodeId;
    this.selectedAnchorIndex = 0;
    this.hoverTarget = null;
    this.ctx.host.setCursor('default');
    this.updateEditOverlay();
  }

  private generateAnchorId(): string {
    return `a${this.nextAnchorIdCounter++}`;
  }

  /** 右键：丢弃新建路径草稿或撤回进行中的锚点拖动并消费右键，不弹出菜单，也不退出钢笔工具 */
  onContextMenu(e: CanvasPointerEvent): void {
    if (this.draft) {
      e.stopPropagation();
      this.cancelActiveDraft();
    } else if (this.dragSession) {
      e.stopPropagation();
      this.revertDragSession();
      this.dragSession = null;
    }
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || e.button !== 0 || this.ctx.session.inMaintenance) {
      return;
    }

    // 1. 如果处于已有路径的编辑模式
    if (this.editingNodeId) {
      const node = this.ctx.document.getNode(this.editingNodeId);
      if (!node || node.nodeType !== PathNodeType.TYPE || !node.path) {
        this.exitEditMode();
        return;
      }

      const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
      const localPoint = this.worldToNodeLocal(node, e.point);
      const subpath = node.path.subpaths[0];
      if (!subpath) return;

      // 检查点击位置：仲裁判断是点中控制柄还是锚点 (当控制柄较短或重叠时，以距离最近者胜出，防止交界处闪烁)
      let candidateHandle: { target: 'handleIn' | 'handleOut'; dist: number } | null = null;
      if (this.selectedAnchorIndex !== null && this.selectedAnchorIndex < subpath.anchors.length) {
        const anchor = subpath.anchors[this.selectedAnchorIndex];
        if (anchor.handleIn && Math.hypot(anchor.handleIn.x, anchor.handleIn.y) * zoom >= MIN_HANDLE_VISIBLE_PX) {
          const hin = { x: anchor.point.x + anchor.handleIn.x, y: anchor.point.y + anchor.handleIn.y };
          const d = Math.hypot(localPoint.x - hin.x, localPoint.y - hin.y);
          if (d <= HANDLE_HIT_RADIUS_PX / zoom) {
            candidateHandle = { target: 'handleIn', dist: d };
          }
        }
        if (anchor.handleOut && Math.hypot(anchor.handleOut.x, anchor.handleOut.y) * zoom >= MIN_HANDLE_VISIBLE_PX) {
          const hout = { x: anchor.point.x + anchor.handleOut.x, y: anchor.point.y + anchor.handleOut.y };
          const d = Math.hypot(localPoint.x - hout.x, localPoint.y - hout.y);
          if (d <= HANDLE_HIT_RADIUS_PX / zoom && (!candidateHandle || d < candidateHandle.dist)) {
            candidateHandle = { target: 'handleOut', dist: d };
          }
        }
      }

      // 检查是否点中锚点
      let candidateAnchor: { index: number; dist: number } | null = null;
      for (let i = 0; i < subpath.anchors.length; i++) {
        const a = subpath.anchors[i];
        const d = Math.hypot(localPoint.x - a.point.x, localPoint.y - a.point.y);
        if (d <= ANCHOR_HIT_RADIUS_PX / zoom) {
          if (!candidateAnchor || d < candidateAnchor.dist) {
            candidateAnchor = { index: i, dist: d };
          }
        }
      }

      // 仲裁：如果同时命中控制柄与锚点，以距离更近者为准
      if (candidateHandle && (!candidateAnchor || candidateHandle.dist <= candidateAnchor.dist)) {
        this.hoverTarget = null;
        this.claimDrag(e, node, this.selectedAnchorIndex!, candidateHandle.target, localPoint);
        return;
      }

      if (candidateAnchor) {
        const i = candidateAnchor.index;
        // 双击锚点：一键在角点 (无控制柄) 与平滑点之间切换
        if (e.clickCount === 2) {
          e.claimPointer(PEN_PLUGIN_ID);
          e.stopPropagation();
          this.selectedAnchorIndex = i;
          this.hoverTarget = null;
          this.toggleAnchorSmoothCorner(node, i);
          return;
        }
        this.selectedAnchorIndex = i;
        this.hoverTarget = null;
        // 按住 Alt 键拖拽锚点：从锚点拔出控制柄 (Figma / Illustrator 规范)
        const dragTarget = e.modifiers.alt ? 'pullHandle' : 'point';
        this.claimDrag(e, node, i, dragTarget, localPoint);
        this.updateEditOverlay();
        return;
      }

      // 检查是否点中曲线并在曲线上插入锚点
      const segments = buildSubpathSegments(subpath);
      for (const seg of segments) {
        const hit =
          seg.kind === 'line'
            ? distancePointToLineSegment(localPoint, seg.start, seg.end)
            : distancePointToCubicSegment(localPoint, seg.start, seg.cp1!, seg.cp2!, seg.end);

        if (hit.distance <= SEGMENT_INSERT_RADIUS_PX / zoom) {
          e.claimPointer(PEN_PLUGIN_ID);
          e.stopPropagation();
          this.hoverTarget = null;
          this.insertAnchorOnSegment(node, seg.startIndex, hit.t, hit.point);
          return;
        }
      }

      // 点击空白处退出编辑模式
      this.exitEditMode();
      return;
    }

    // 2. 双击画布上的路径节点：直接进入该路径节点的二次编辑模式 (Figma / Illustrator 交互标准)
    if (e.clickCount === 2 && !this.draft) {
      const hit = this.ctx.hitTest(e.point);
      if (hit?.kind === 'node' && hit.node.nodeType === PathNodeType.TYPE) {
        e.claimPointer(PEN_PLUGIN_ID);
        e.stopPropagation();
        this.enterEditMode(hit.node.id);
        return;
      }
    }

    // 3. 如果钢笔工具未激活，不处理绘制
    if (!this.active) {
      return;
    }

    e.claimPointer(PEN_PLUGIN_ID);
    e.stopPropagation();
    this.ctx.host.capturePointer(e.pointerId);

    const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
    const pt = { x: roundNum(e.point.x), y: roundNum(e.point.y) };

    if (!this.draft) {
      // 开始新建路径草稿前，确保选区清空
      this.ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
      this.draft = {
        subpaths: [
          {
            anchors: [{ id: this.generateAnchorId(), point: pt, mode: 'symmetric' }],
            closed: false
          }
        ],
        currentAnchorIndex: 0,
        isDraggingHandle: true,
        dragStartPos: pt,
        hasDraggedHandle: false,
        lastPointerPos: pt,
        frozenStyle: { ...this.settings }
      };
      this.renderDraftOverlay();
    } else {
      const subpath = this.draft.subpaths[0];
      const startAnchor = subpath.anchors[0];

      // 检查是否点击了起始锚点或处于吸附起点状态 -> 闭合并提交
      const isClosing =
        subpath.anchors.length >= 2 &&
        (this.draft.isSnappedToClose ||
          Math.hypot(pt.x - startAnchor.point.x, pt.y - startAnchor.point.y) <= SNAP_CLOSE_RADIUS_PX / zoom);

      if (isClosing) {
        this.draft.subpaths[0] = { ...subpath, closed: true };
        this.commitDraft();
        return;
      }

      // 添加新锚点
      const nextIdx = subpath.anchors.length;
      const nextAnchor: PathAnchor = {
        id: this.generateAnchorId(),
        point: pt,
        mode: 'symmetric'
      };
      this.draft.subpaths[0] = {
        ...subpath,
        anchors: [...subpath.anchors, nextAnchor]
      };
      this.draft.currentAnchorIndex = nextIdx;
      this.draft.isDraggingHandle = true;
      this.draft.dragStartPos = pt;
      this.draft.hasDraggedHandle = false;
      this.draft.lastPointerPos = pt;
      this.draft.isSnappedToClose = false;
      this.renderDraftOverlay();
    }
  }

  onPointerMove(e: CanvasPointerEvent): void {
    // 1. 处理已有节点的锚点/控制柄拖拽
    if (this.dragSession) {
      e.stopPropagation();
      const node = this.ctx.document.getNode(this.dragSession.nodeId);
      if (!node || !node.path) return;

      const sub = node.path.subpaths[0];
      if (!sub) return;
      const localPoint = this.worldToNodeLocal(node, e.point);
      const { anchorIndex, target } = this.dragSession;
      const anchor = sub.anchors[anchorIndex];
      if (!anchor) return;
      const baseAnchor = this.dragSession.initialAnchor ?? anchor;

      let nextAnchor = anchor;
      if (target === 'point') {
        const dx = localPoint.x - this.dragSession.startLocalPos.x;
        const dy = localPoint.y - this.dragSession.startLocalPos.y;
        nextAnchor = {
          ...anchor,
          point: { x: roundNum(anchor.point.x + dx), y: roundNum(anchor.point.y + dy) }
        };
        this.dragSession = { ...this.dragSession, startLocalPos: localPoint };
      } else if (target === 'pullHandle') {
        // Alt 键从锚点拔出控制柄 (恢复平滑曲线或重构缺失单柄)
        const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
        const offset = {
          x: roundNum(localPoint.x - baseAnchor.point.x),
          y: roundNum(localPoint.y - baseAnchor.point.y)
        };
        const dist = Math.hypot(offset.x, offset.y);

        // 防抖门限：一旦激活拔出即锁定激活态，避免鼠标在 3px 边界微颤导致反复在 corner/pull 间切换闪烁
        if (this.dragSession.hasActivatedPull || dist * zoom >= 3) {
          this.dragSession.hasActivatedPull = true;
          const hx = offset.x;
          const hy = offset.y;
          const invX = -hx === 0 ? 0 : -hx;
          const invY = -hy === 0 ? 0 : -hy;

          const hasIn = Boolean(baseAnchor.handleIn && (baseAnchor.handleIn.x !== 0 || baseAnchor.handleIn.y !== 0));
          const hasOut = Boolean(
            baseAnchor.handleOut && (baseAnchor.handleOut.x !== 0 || baseAnchor.handleOut.y !== 0)
          );

          if (hasIn && !hasOut) {
            // 原本只有 handleIn (handleOut 被收起)：专一拔出缺失的 handleOut，360° 任意旋转绝不破坏或漂移到 handleIn
            nextAnchor = {
              ...baseAnchor,
              handleOut: { x: hx, y: hy },
              mode: 'corner'
            };
          } else if (hasOut && !hasIn) {
            // 原本只有 handleOut (handleIn 被收起)：专一拔出缺失的 handleIn，360° 任意旋转绝不破坏或漂移到 handleOut
            nextAnchor = {
              ...baseAnchor,
              handleIn: { x: hx, y: hy },
              mode: 'corner'
            };
          } else {
            // 原本无柄 (角点) 或对称性被打断：从锚点拔出一对崭新的 180° 对称控制柄，恢复对称平滑
            nextAnchor = {
              ...baseAnchor,
              mode: 'symmetric',
              handleOut: { x: hx, y: hy },
              handleIn: { x: invX, y: invY }
            };
          }
        }
      } else {
        const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
        let handleOffset = {
          x: roundNum(localPoint.x - anchor.point.x),
          y: roundNum(localPoint.y - anchor.point.y)
        };
        const handleDist = Math.hypot(handleOffset.x, handleOffset.y);
        // 双门限迟滞滤波 (Hysteresis)：
        // 拖回距离小于 HANDLE_COLLAPSE_ENTER_PX (6px) 时吸附折叠消除；
        // 必须拉出大于 HANDLE_COLLAPSE_LEAVE_PX (10px) 才会脱离折叠状态，避免在 8px 边界微抖闪烁
        const wasCollapsed = Boolean(this.dragSession.isCollapsed);
        const shouldCollapse = wasCollapsed
          ? handleDist * zoom <= HANDLE_COLLAPSE_LEAVE_PX
          : handleDist * zoom <= HANDLE_COLLAPSE_ENTER_PX;

        this.dragSession.isCollapsed = shouldCollapse;
        if (shouldCollapse) {
          handleOffset = { x: 0, y: 0 };
        }

        // 保持单次拖拽期间的 Alt 状态连贯性 (若启动拖拽时按住了 Alt，拖拽全程保持打断，避免丢帧造成对称性突变)
        const isAlt = this.dragSession.initialAlt || e.modifiers.alt;
        const breakSymmetry = isAlt || shouldCollapse;
        nextAnchor = syncAnchorHandles(anchor, target === 'handleIn' ? 'in' : 'out', handleOffset, breakSymmetry);
      }

      const nextAnchors = [...sub.anchors];
      nextAnchors[anchorIndex] = nextAnchor;
      const nextSubpaths: Subpath[] = [{ ...sub, anchors: nextAnchors }];

      this.ctx.document.updateNode(
        node.id,
        {
          path: { subpaths: nextSubpaths }
        },
        { groupId: this.dragSession.groupId }
      );
      this.updateEditOverlay();
      return;
    }

    // 2. 处理已有节点的悬停反馈 (编辑态)
    if (this.editingNodeId) {
      e.stopPropagation();
      const node = this.ctx.document.getNode(this.editingNodeId);
      if (!node || !node.path || node.path.subpaths.length === 0) {
        this.exitEditMode();
        return;
      }

      const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
      const localPoint = this.worldToNodeLocal(node, e.point);
      const subpath = node.path.subpaths[0];

      let newHover: EditHoverTarget | null = null;

      // 检查当前选中锚点的控制柄 (优先于锚点，且仅在控制柄达到最小可视距离时可悬停)
      if (this.selectedAnchorIndex !== null && this.selectedAnchorIndex < subpath.anchors.length) {
        const anchor = subpath.anchors[this.selectedAnchorIndex];
        if (anchor.handleIn && Math.hypot(anchor.handleIn.x, anchor.handleIn.y) * zoom >= MIN_HANDLE_VISIBLE_PX) {
          const hin = { x: anchor.point.x + anchor.handleIn.x, y: anchor.point.y + anchor.handleIn.y };
          if (Math.hypot(localPoint.x - hin.x, localPoint.y - hin.y) <= HANDLE_HIT_RADIUS_PX / zoom) {
            newHover = { type: 'handle', handle: 'handleIn', anchorIndex: this.selectedAnchorIndex };
          }
        }
        if (
          !newHover &&
          anchor.handleOut &&
          Math.hypot(anchor.handleOut.x, anchor.handleOut.y) * zoom >= MIN_HANDLE_VISIBLE_PX
        ) {
          const hout = { x: anchor.point.x + anchor.handleOut.x, y: anchor.point.y + anchor.handleOut.y };
          if (Math.hypot(localPoint.x - hout.x, localPoint.y - hout.y) <= HANDLE_HIT_RADIUS_PX / zoom) {
            newHover = { type: 'handle', handle: 'handleOut', anchorIndex: this.selectedAnchorIndex };
          }
        }
      }

      // 检查锚点
      if (!newHover) {
        for (let i = 0; i < subpath.anchors.length; i++) {
          const a = subpath.anchors[i];
          if (Math.hypot(localPoint.x - a.point.x, localPoint.y - a.point.y) <= ANCHOR_HIT_RADIUS_PX / zoom) {
            newHover = { type: 'anchor', index: i };
            break;
          }
        }
      }

      // 检查曲线分段 (可插入新锚点)
      if (!newHover) {
        const segments = buildSubpathSegments(subpath);
        for (const seg of segments) {
          const hit =
            seg.kind === 'line'
              ? distancePointToLineSegment(localPoint, seg.start, seg.end)
              : distancePointToCubicSegment(localPoint, seg.start, seg.cp1!, seg.cp2!, seg.end);

          if (hit.distance <= SEGMENT_INSERT_RADIUS_PX / zoom) {
            newHover = {
              type: 'segment',
              segStartIndex: seg.startIndex,
              point: hit.point,
              t: hit.t
            };
            break;
          }
        }
      }

      // 二次编辑态：统一使用框架自带的箭头光标 ('default')，突出点完全交由高亮图元表达，避免使用原生浏览器光标
      this.ctx.host.setCursor('default');

      if (!isEqualHoverTarget(this.hoverTarget, newHover)) {
        this.hoverTarget = newHover;
        this.updateEditOverlay();
      }
      return;
    }

    // 3. 处理新建路径草稿
    if (this.draft) {
      e.stopPropagation();
      const pt = { x: roundNum(e.point.x), y: roundNum(e.point.y) };

      if (this.draft.isDraggingHandle) {
        const sub = this.draft.subpaths[0];
        const a = sub.anchors[this.draft.currentAnchorIndex];
        const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
        const dragDist = Math.hypot(pt.x - this.draft.dragStartPos.x, pt.y - this.draft.dragStartPos.y);

        // 当拖拽位移超出死区时，正式拉出控制柄并实时联动调整
        if (dragDist * zoom >= DRAG_HANDLE_DEADZONE_PX) {
          this.draft.hasDraggedHandle = true;
          const hOffset = { x: roundNum(pt.x - a.point.x), y: roundNum(pt.y - a.point.y) };
          // 新建拉柄时若按住 Alt，仅拉出当前端 handleOut，不产生反向 handleIn 干扰已确认线段
          const updatedAnchor = syncAnchorHandles(
            { ...a, mode: e.modifiers.alt ? 'corner' : 'symmetric' },
            'out',
            hOffset,
            e.modifiers.alt
          );
          const nextAnchors = [...sub.anchors];
          nextAnchors[this.draft.currentAnchorIndex] = updatedAnchor;
          this.draft.subpaths[0] = { ...sub, anchors: nextAnchors };
        }
        this.draft.lastPointerPos = pt;
        this.draft.isSnappedToClose = false;
      } else {
        const sub = this.draft.subpaths[0];
        const startAnchor = sub?.anchors[0];
        const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
        let snapped = false;

        if (sub && sub.anchors.length >= 2 && startAnchor) {
          const dist = Math.hypot(pt.x - startAnchor.point.x, pt.y - startAnchor.point.y);
          if (dist <= SNAP_CLOSE_RADIUS_PX / zoom) {
            snapped = true;
            this.draft.lastPointerPos = { ...startAnchor.point };
            this.draft.isSnappedToClose = true;
          }
        }

        if (!snapped) {
          this.draft.lastPointerPos = pt;
          this.draft.isSnappedToClose = false;
        }

        // 新建时，吸附时不改变鼠标样式，始终保持 crosshair，仅突出吸附点
        this.ctx.host.setCursor('crosshair');
      }

      this.renderDraftOverlay();
      return;
    }

    if (this.active) {
      e.stopPropagation();
      this.ctx.host.setCursor('crosshair');
    }
  }

  onPointerUp(e: CanvasPointerEvent): void {
    if (this.dragSession) {
      e.stopPropagation();
      this.ctx.host.releasePointer(e.pointerId);
      const { nodeId, groupId } = this.dragSession;
      this.dragSession = null;
      this.normalizePathNode(nodeId, groupId);
      this.ctx.host.setCursor('default');
      this.updateEditOverlay();
      return;
    }

    if (this.draft) {
      e.stopPropagation();
      if (this.draft.isDraggingHandle) {
        if (!this.draft.hasDraggedHandle) {
          // 单击位移在微颤死区以内，确定为纯粹的尖锐角点 (直线锚点)，清除微小伪控制柄
          const sub = this.draft.subpaths[0];
          const nextAnchors = [...sub.anchors];
          const cur = nextAnchors[this.draft.currentAnchorIndex];
          if (cur) {
            nextAnchors[this.draft.currentAnchorIndex] = {
              ...cur,
              handleIn: undefined,
              handleOut: undefined,
              mode: 'corner'
            };
            this.draft.subpaths[0] = { ...sub, anchors: nextAnchors };
          }
        }
        this.draft.isDraggingHandle = false;
      }
      this.renderDraftOverlay();
    }
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.dragSession) {
      this.ctx.host.releasePointer(e.pointerId);
      this.revertDragSession();
      this.dragSession = null;
      this.hoverTarget = null;
      this.updateEditOverlay();
    }
    if (this.draft) {
      this.cancelActiveDraft();
    }
  }

  /** 完成新建路径草稿并提交事务 */
  commitDraft(): void {
    if (!this.draft) return;
    const { subpaths, frozenStyle } = this.draft;
    const sub = subpaths[0];
    this.cancelActiveDraft();

    if (!sub || sub.anchors.length < 2) return;

    // 计算包围盒与局部坐标归一化
    const bounds = computeSubpathsTightBounds([sub]);
    if (!bounds) return;

    const minX = bounds.left;
    const minY = bounds.top;
    const maxX = bounds.right;
    const maxY = bounds.bottom;
    const width = roundNum(Math.max(0, maxX - minX));
    const height = roundNum(Math.max(0, maxY - minY));

    const localAnchors: PathAnchor[] = sub.anchors.map((a) => {
      const hasIn = Boolean(a.handleIn && Math.hypot(a.handleIn.x, a.handleIn.y) >= 0.5);
      const hasOut = Boolean(a.handleOut && Math.hypot(a.handleOut.x, a.handleOut.y) >= 0.5);
      const hasBoth = hasIn && hasOut;
      return {
        id: a.id,
        point: { x: roundNum(a.point.x - minX), y: roundNum(a.point.y - minY) },
        mode: hasBoth ? (a.mode ?? 'symmetric') : 'corner',
        ...(hasIn && a.handleIn ? { handleIn: a.handleIn } : {}),
        ...(hasOut && a.handleOut ? { handleOut: a.handleOut } : {})
      };
    });

    this.ctx.document.createNode({
      nodeType: PathNodeType.TYPE,
      x: roundNum(minX),
      y: roundNum(minY),
      width,
      height,
      options: {
        subpaths: [{ anchors: localAnchors, closed: sub.closed }],
        stroke: frozenStyle.stroke,
        strokeWidth: frozenStyle.strokeWidth,
        strokeOpacity: frozenStyle.opacity,
        ...(frozenStyle.strokeDashArray && { strokeDashArray: frozenStyle.strokeDashArray }),
        ...(sub.closed && frozenStyle.fill && { fill: frozenStyle.fill })
      },
      label: '绘制钢笔路径'
    });
  }

  /** 双击锚点：一键在角点 (无控制柄) 与平滑点之间切换 */
  private toggleAnchorSmoothCorner(node: NodeEntity, anchorIndex: number): void {
    if (!node.path || node.path.subpaths.length === 0) return;
    const sub = node.path.subpaths[0];
    const a = sub.anchors[anchorIndex];
    if (!a) return;

    const hasHandles = Boolean(
      (a.handleIn && (a.handleIn.x !== 0 || a.handleIn.y !== 0)) ||
      (a.handleOut && (a.handleOut.x !== 0 || a.handleOut.y !== 0))
    );

    let nextAnchor: PathAnchor;
    if (hasHandles) {
      // 当前已有控制柄：一键全部清除，转为纯净尖锐角点 (直线性质)
      nextAnchor = {
        ...a,
        handleIn: undefined,
        handleOut: undefined,
        mode: 'corner'
      };
    } else {
      // 当前为角点：根据前后相邻点方向自动平滑展开对称控制柄 (约为相邻跨度的 1/3)
      const prevAnchor = sub.anchors[(anchorIndex - 1 + sub.anchors.length) % sub.anchors.length];
      const nextA = sub.anchors[(anchorIndex + 1) % sub.anchors.length];
      const prevPt = prevAnchor && (sub.closed || anchorIndex > 0) ? prevAnchor.point : a.point;
      const nextPt = nextA && (sub.closed || anchorIndex < sub.anchors.length - 1) ? nextA.point : a.point;

      const tangentX = nextPt.x - prevPt.x;
      const tangentY = nextPt.y - prevPt.y;
      const len = Math.hypot(tangentX, tangentY);
      const handleLen = len > 0 ? Math.min(len / 3, 50) : 30;

      const normX = len > 0 ? (tangentX / len) * handleLen : 30;
      const normY = len > 0 ? (tangentY / len) * handleLen : 0;

      nextAnchor = {
        ...a,
        mode: 'symmetric',
        handleIn: { x: roundNum(-normX), y: roundNum(-normY) },
        handleOut: { x: roundNum(normX), y: roundNum(normY) }
      };
    }

    const nextAnchors = [...sub.anchors];
    nextAnchors[anchorIndex] = nextAnchor;
    this.ctx.document.updateNode(
      node.id,
      { path: { subpaths: [{ ...sub, anchors: nextAnchors }] } },
      { label: '切换锚点类型' }
    );
    this.updateEditOverlay();
  }

  private claimDrag(
    e: CanvasPointerEvent,
    node: NodeEntity,
    anchorIndex: number,
    target: 'point' | 'handleIn' | 'handleOut' | 'pullHandle',
    startLocalPos: Point
  ): void {
    e.claimPointer(PEN_PLUGIN_ID);
    e.stopPropagation();
    this.ctx.host.capturePointer(e.pointerId);

    this.ctx.host.setCursor('default');
    const sub = node.path?.subpaths[0];
    const initialAnchor = sub?.anchors[anchorIndex];
    this.dragSession = {
      nodeId: node.id,
      snapshot: clonePlainData(node),
      groupId: generateId('pen-drag'),
      anchorIndex,
      target,
      startLocalPos,
      initialAnchor: initialAnchor && clonePlainData(initialAnchor),
      initialAlt: Boolean(e.modifiers.alt),
      hasActivatedPull: false,
      isCollapsed: false
    };
    this.updateEditOverlay();
  }

  private revertDragSession(): void {
    if (!this.dragSession) return;
    const { nodeId, snapshot, groupId } = this.dragSession;
    this.ctx.document.updateNode(
      nodeId,
      {
        x: snapshot.x,
        y: snapshot.y,
        width: snapshot.width,
        height: snapshot.height,
        path: snapshot.path,
        style: snapshot.style
      },
      { groupId }
    );
  }

  /**
   * 归一化路径节点：将子路径坐标平移至以自身紧密包围盒为基准的原点 (0, 0)，
   * 同步更新 node.x、node.y、node.width、node.height，保持在世界画布中的位置绝对不变。
   */
  private normalizePathNode(nodeId: string, groupId?: string): void {
    const node = this.ctx.document.getNode(nodeId);
    if (!node || node.nodeType !== PathNodeType.TYPE || !node.path) return;
    const subpaths = node.path.subpaths;
    if (subpaths.length === 0) return;

    const bounds = computeSubpathsTightBounds(subpaths);
    if (!bounds) return;

    const minX = bounds.left;
    const minY = bounds.top;
    const maxX = bounds.right;
    const maxY = bounds.bottom;
    const newWidth = roundNum(Math.max(0, maxX - minX));
    const newHeight = roundNum(Math.max(0, maxY - minY));

    // 如果局部坐标原点已在 (0, 0) 且宽高与当前一致，无需更新
    if (minX === 0 && minY === 0 && newWidth === node.width && newHeight === node.height) {
      return;
    }

    // 将全部锚点平移 -minX, -minY (handleIn/handleOut 为相对向量，保持不变)
    const normalizedSubpaths: Subpath[] = subpaths.map((sub) => ({
      ...sub,
      anchors: sub.anchors.map((a) => ({
        ...a,
        point: { x: roundNum(a.point.x - minX), y: roundNum(a.point.y - minY) }
      }))
    }));

    // 计算新的世界位置 (兼容未旋转与带角度旋转的节点)
    let newX: number;
    let newY: number;

    const angle = node.rotation ?? 0;
    if (angle === 0) {
      newX = roundNum(node.x + minX);
      newY = roundNum(node.y + minY);
    } else {
      const oldMatrix = computeNodeLocalMatrix(node);
      const worldOrigin = applyMatrix(oldMatrix, minX, minY);
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = newWidth / 2;
      const cy = newHeight / 2;
      newX = roundNum(worldOrigin.x - cx + cos * cx - sin * cy);
      newY = roundNum(worldOrigin.y - cy + sin * cx + cos * cy);
    }

    this.ctx.document.updateNode(
      node.id,
      {
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight,
        path: { subpaths: normalizedSubpaths }
      },
      groupId ? { groupId } : undefined
    );
  }

  /** 在曲线分段上插入新锚点 */
  private insertAnchorOnSegment(node: NodeEntity, segStartIndex: number, t: number, splitPoint: Point): void {
    if (!node.path || node.path.subpaths.length === 0) return;
    const sub = node.path.subpaths[0];
    const a0 = sub.anchors[segStartIndex];
    const nextIdx = (segStartIndex + 1) % sub.anchors.length;
    const a1 = sub.anchors[nextIdx];

    const p0 = a0.point;
    const p1 = a0.handleOut ? { x: p0.x + a0.handleOut.x, y: p0.y + a0.handleOut.y } : p0;
    const p3 = a1.point;
    const p2 = a1.handleIn ? { x: p3.x + a1.handleIn.x, y: p3.y + a1.handleIn.y } : p3;

    const [leftCurve, rightCurve] = splitCubicBezier(p0, p1, p2, p3, t);

    const newAnchor: PathAnchor = {
      id: this.generateAnchorId(),
      point: { x: roundNum(splitPoint.x), y: roundNum(splitPoint.y) },
      handleIn: { x: roundNum(leftCurve.p2.x - splitPoint.x), y: roundNum(leftCurve.p2.y - splitPoint.y) },
      handleOut: { x: roundNum(rightCurve.p1.x - splitPoint.x), y: roundNum(rightCurve.p1.y - splitPoint.y) },
      mode: 'smooth'
    };

    const updatedA0: PathAnchor = {
      ...a0,
      handleOut: { x: roundNum(leftCurve.p1.x - p0.x), y: roundNum(leftCurve.p1.y - p0.y) }
    };
    const updatedA1: PathAnchor = {
      ...a1,
      handleIn: { x: roundNum(rightCurve.p2.x - p3.x), y: roundNum(rightCurve.p2.y - p3.y) }
    };

    const nextAnchors = [...sub.anchors];
    nextAnchors[segStartIndex] = updatedA0;
    nextAnchors[nextIdx] = updatedA1;
    nextAnchors.splice(segStartIndex + 1, 0, newAnchor);

    this.ctx.document.updateNode(
      node.id,
      {
        path: { subpaths: [{ ...sub, anchors: nextAnchors }] }
      },
      { label: '插入路径锚点' }
    );
    this.normalizePathNode(node.id);
    this.selectedAnchorIndex = segStartIndex + 1;
    this.hoverTarget = null;
    this.updateEditOverlay();
  }

  /** 删除当前选中的锚点 */
  deleteSelectedAnchor(): void {
    if (!this.editingNodeId || this.selectedAnchorIndex === null) return;
    const node = this.ctx.document.getNode(this.editingNodeId);
    if (!node || !node.path || node.path.subpaths.length === 0) return;

    const sub = node.path.subpaths[0];
    if (sub.anchors.length <= 2) return; // 至少保留 2 个点

    const nextAnchors = sub.anchors.filter((_, idx) => idx !== this.selectedAnchorIndex);
    this.ctx.document.updateNode(
      node.id,
      {
        path: { subpaths: [{ ...sub, anchors: nextAnchors }] }
      },
      { label: '删除路径锚点' }
    );
    this.normalizePathNode(node.id);
    this.selectedAnchorIndex = Math.max(0, this.selectedAnchorIndex - 1);
    this.hoverTarget = null;
    this.updateEditOverlay();
  }

  private renderDraftOverlay(): void {
    if (!this.draft) return;
    const sub = this.draft.subpaths[0];
    if (sub.anchors.length === 0) return;

    const primitives: CanvasPrimitive[] = [];
    const theme = this.ctx.session.theme;
    const color = resolveThemeColor(this.draft.frozenStyle.stroke, theme, theme.textColor)!;
    const strokeWidth = this.draft.frozenStyle.strokeWidth;

    // 绘制已确认的路径线段
    if (sub.anchors.length >= 2) {
      const d = buildSvgPathData([sub]);
      primitives.push({
        kind: 'path',
        d,
        stroke: color,
        strokeWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        strokeDashArray: this.draft.frozenStyle.strokeDashArray
      });
    }

    // 绘制起始锚点闭合吸附提示光圈 (紧凑精细的吸附外环)
    if (this.draft.isSnappedToClose && sub.anchors.length >= 2) {
      const start = sub.anchors[0].point;
      primitives.push({
        kind: 'circle',
        cx: start.x,
        cy: start.y,
        r: 6.5,
        fill: 'transparent',
        stroke: theme.accent,
        strokeWidth: 1.5
      });
    }

    // 绘制从最后锚点到当前光标的橡皮筋虚线 / 贝塞尔预测线
    if (!this.draft.isDraggingHandle && sub.anchors.length >= 1) {
      const last = sub.anchors[sub.anchors.length - 1];
      const targetPt = this.draft.lastPointerPos;
      const startAnchor = sub.anchors[0];
      const isClosing = this.draft.isSnappedToClose && sub.anchors.length >= 2;

      const hasCp1 = Boolean(last.handleOut && (last.handleOut.x !== 0 || last.handleOut.y !== 0));
      const hasCp2 = Boolean(
        isClosing && startAnchor?.handleIn && (startAnchor.handleIn.x !== 0 || startAnchor.handleIn.y !== 0)
      );

      if (hasCp1 || hasCp2) {
        const cp1x = hasCp1 ? roundNum(last.point.x + last.handleOut!.x) : last.point.x;
        const cp1y = hasCp1 ? roundNum(last.point.y + last.handleOut!.y) : last.point.y;
        const cp2x = hasCp2 ? roundNum(targetPt.x + startAnchor.handleIn!.x) : targetPt.x;
        const cp2y = hasCp2 ? roundNum(targetPt.y + startAnchor.handleIn!.y) : targetPt.y;
        const d = `M ${last.point.x} ${last.point.y} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${targetPt.x} ${targetPt.y}`;
        primitives.push({
          kind: 'path',
          d,
          stroke: this.draft.isSnappedToClose ? theme.accent : color,
          strokeWidth: this.draft.isSnappedToClose ? 1.5 : 1,
          strokeDashArray: [4, 4]
        });
      } else {
        primitives.push({
          kind: 'line',
          points: [last.point.x, last.point.y, targetPt.x, targetPt.y],
          stroke: this.draft.isSnappedToClose ? theme.accent : color,
          strokeWidth: this.draft.isSnappedToClose ? 1.5 : 1,
          strokeDashArray: [4, 4]
        });
      }
    }

    // 绘制控制点 (锚点与当前控制柄，统一使用圆形样式)
    for (let i = 0; i < sub.anchors.length; i++) {
      const a = sub.anchors[i];
      const isStartAndSnapped = i === 0 && this.draft.isSnappedToClose;
      // 锚点控制点 (圆形)
      primitives.push({
        kind: 'circle',
        cx: a.point.x,
        cy: a.point.y,
        r: isStartAndSnapped ? 4.5 : 3.5,
        fill: i === 0 ? theme.accent : theme.background,
        stroke: i === 0 ? theme.accent : theme.selectionStroke,
        strokeWidth: 1.5
      });

      const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
      // 拖拽中的控制柄线段 (当长度小于最小可视距离时不渲染，防止与锚点重叠粘连)
      if (a.handleOut && (a.handleOut.x !== 0 || a.handleOut.y !== 0)) {
        const outLen = Math.hypot(a.handleOut.x, a.handleOut.y);
        if (outLen * zoom >= MIN_HANDLE_VISIBLE_PX) {
          const hx = a.point.x + a.handleOut.x;
          const hy = a.point.y + a.handleOut.y;
          primitives.push({
            kind: 'line',
            points: [a.point.x, a.point.y, hx, hy],
            stroke: theme.selectionStroke,
            strokeWidth: 1
          });
          primitives.push({
            kind: 'circle',
            cx: hx,
            cy: hy,
            r: 3.5,
            fill: theme.background,
            stroke: theme.selectionStroke,
            strokeWidth: 1.5
          });
        }
      }
      if (a.handleIn && (a.handleIn.x !== 0 || a.handleIn.y !== 0)) {
        const inLen = Math.hypot(a.handleIn.x, a.handleIn.y);
        if (inLen * zoom >= MIN_HANDLE_VISIBLE_PX) {
          const hx = a.point.x + a.handleIn.x;
          const hy = a.point.y + a.handleIn.y;
          primitives.push({
            kind: 'line',
            points: [a.point.x, a.point.y, hx, hy],
            stroke: theme.selectionStroke,
            strokeWidth: 1
          });
          primitives.push({
            kind: 'circle',
            cx: hx,
            cy: hy,
            r: 3.5,
            fill: theme.background,
            stroke: theme.selectionStroke,
            strokeWidth: 1.5
          });
        }
      }
    }

    this.ctx.host.overlay.setPrimitives(DRAFT_OVERLAY_SESSION, primitives, { transient: true });
  }

  private updateEditOverlay(): void {
    if (!this.editingNodeId) {
      this.ctx.host.overlay.clear(EDIT_OVERLAY_SESSION);
      return;
    }

    const node = this.ctx.document.getNode(this.editingNodeId);
    if (!node || !node.path || node.path.subpaths.length === 0) {
      this.ctx.host.overlay.clear(EDIT_OVERLAY_SESSION);
      return;
    }

    const sub = node.path.subpaths[0];
    const primitives: CanvasPrimitive[] = [];
    const theme = this.ctx.session.theme;

    // 1. 如果悬停在曲线上，绘制插入新锚点预览圆点
    if (!this.dragSession && this.hoverTarget?.type === 'segment') {
      const spWorld = this.nodeLocalToWorld(node, this.hoverTarget.point);
      primitives.push({
        kind: 'circle',
        cx: spWorld.x,
        cy: spWorld.y,
        r: 4.5,
        fill: theme.accent,
        stroke: theme.background,
        strokeWidth: 1.5
      });
    }

    for (let i = 0; i < sub.anchors.length; i++) {
      const a = sub.anchors[i];
      const anchorWorld = this.nodeLocalToWorld(node, a.point);
      const wx = anchorWorld.x;
      const wy = anchorWorld.y;
      const isSelected = i === this.selectedAnchorIndex;
      const isAnchorDragging =
        (this.dragSession?.target === 'point' || this.dragSession?.target === 'pullHandle') &&
        this.dragSession.anchorIndex === i;
      const isAnchorHovered = !this.dragSession && this.hoverTarget?.type === 'anchor' && this.hoverTarget.index === i;
      const isAnchorActive = isAnchorHovered || isAnchorDragging;

      // 锚点控制点 (统一采用圆形样式，悬停与拖拽中统一高亮与微放大反馈)
      if (isAnchorActive) {
        primitives.push({
          kind: 'circle',
          cx: wx,
          cy: wy,
          r: 5.5,
          fill: isSelected ? theme.accent : theme.background,
          stroke: theme.accent,
          strokeWidth: 2
        });
      } else {
        primitives.push({
          kind: 'circle',
          cx: wx,
          cy: wy,
          r: 3.5,
          fill: isSelected ? theme.selectionStroke : theme.background,
          stroke: theme.selectionStroke,
          strokeWidth: 1.5
        });
      }

      // 控制柄 (悬停与拖拽中统一保持强调高亮与放大微反馈，微小控制柄小于最小可视距离时不渲染，防止与锚点重叠粘连)
      if (isSelected) {
        const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
        if (a.handleIn && (a.handleIn.x !== 0 || a.handleIn.y !== 0)) {
          const inLen = Math.hypot(a.handleIn.x, a.handleIn.y);
          if (inLen * zoom >= MIN_HANDLE_VISIBLE_PX) {
            const hVecWorld = this.nodeVectorToWorld(node, a.handleIn);
            const hx = wx + hVecWorld.x;
            const hy = wy + hVecWorld.y;
            const isHandleInHovered =
              !this.dragSession && this.hoverTarget?.type === 'handle' && this.hoverTarget.handle === 'handleIn';
            const isHandleInDragging = this.dragSession?.target === 'handleIn' && this.dragSession.anchorIndex === i;
            const isHandleInActive = isHandleInHovered || isHandleInDragging;
            primitives.push({ kind: 'line', points: [wx, wy, hx, hy], stroke: theme.selectionStroke, strokeWidth: 1 });
            primitives.push({
              kind: 'circle',
              cx: hx,
              cy: hy,
              r: isHandleInActive ? 5.5 : 3.5,
              fill: isHandleInActive ? theme.accent : theme.background,
              stroke: isHandleInActive ? theme.background : theme.selectionStroke,
              strokeWidth: isHandleInActive ? 2 : 1.5
            });
          }
        }
        if (a.handleOut && (a.handleOut.x !== 0 || a.handleOut.y !== 0)) {
          const outLen = Math.hypot(a.handleOut.x, a.handleOut.y);
          if (outLen * zoom >= MIN_HANDLE_VISIBLE_PX) {
            const hVecWorld = this.nodeVectorToWorld(node, a.handleOut);
            const hx = wx + hVecWorld.x;
            const hy = wy + hVecWorld.y;
            const isHandleOutHovered =
              !this.dragSession && this.hoverTarget?.type === 'handle' && this.hoverTarget.handle === 'handleOut';
            const isHandleOutDragging = this.dragSession?.target === 'handleOut' && this.dragSession.anchorIndex === i;
            const isHandleOutActive = isHandleOutHovered || isHandleOutDragging;
            primitives.push({ kind: 'line', points: [wx, wy, hx, hy], stroke: theme.selectionStroke, strokeWidth: 1 });
            primitives.push({
              kind: 'circle',
              cx: hx,
              cy: hy,
              r: isHandleOutActive ? 5.5 : 3.5,
              fill: isHandleOutActive ? theme.accent : theme.background,
              stroke: isHandleOutActive ? theme.background : theme.selectionStroke,
              strokeWidth: isHandleOutActive ? 2 : 1.5
            });
          }
        }
      }
    }

    this.ctx.host.overlay.setPrimitives(EDIT_OVERLAY_SESSION, primitives, { transient: true });
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey || e.altKey;

    if (!mod && !e.shiftKey && e.code === 'KeyP' && !this.active) {
      this.ctx.session.setTool(PEN_TOOL);
      return true;
    }

    if (e.key === 'Enter') {
      if (this.draft) {
        this.commitDraft();
        return true;
      }
      if (this.editingNodeId) {
        const exitedId = this.editingNodeId;
        this.exitEditMode();
        if (exitedId && this.ctx.session.tool === SELECT_TOOL) {
          this.ctx.session.setSelection({ nodeIds: [exitedId], connectorIds: [] });
        }
        return true;
      }
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.draft) {
        const sub = this.draft.subpaths[0];
        if (sub.anchors.length > 1) {
          this.draft.subpaths[0] = { ...sub, anchors: sub.anchors.slice(0, -1) };
          this.draft.currentAnchorIndex = this.draft.subpaths[0].anchors.length - 1;
          this.renderDraftOverlay();
        } else {
          this.cancelActiveDraft();
        }
        return true;
      }
      if (this.editingNodeId && this.selectedAnchorIndex !== null) {
        this.deleteSelectedAnchor();
        return true;
      }
    }

    if (e.key === 'Escape') {
      if (this.draft) {
        this.cancelActiveDraft();
        return true;
      }
      if (this.editingNodeId) {
        const exitedId = this.editingNodeId;
        this.exitEditMode();
        if (exitedId && this.ctx.session.tool === SELECT_TOOL) {
          this.ctx.session.setSelection({ nodeIds: [exitedId], connectorIds: [] });
        }
        return true;
      }
      if (this.active) {
        this.ctx.session.setTool(SELECT_TOOL);
        return true;
      }
    }

    return false;
  }

  private onSessionChange(change: SessionChange): void {
    if (change.maintenanceChanged && this.ctx.session.inMaintenance) {
      this.cancelActiveDraft();
      this.exitEditMode();
    }
    if (change.toolChanged) {
      if (this.active) {
        this.ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
        this.ctx.host.setCursor(this.editingNodeId ? 'default' : 'crosshair');
      } else {
        this.cancelActiveDraft();
        // 外部主动切换工具时，退出编辑态但不覆盖用户新切换的目标工具
        this.exitEditMode({ restoreTool: false });
        if (change.previousTool === PEN_TOOL) this.ctx.host.setCursor('default');
      }
    }
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    if (changes.contentReplaced) {
      this.cancelActiveDraft();
      this.exitEditMode();
      this.nodeType.clearCache();
      return;
    }

    for (const id of changes.nodes.removed) {
      this.nodeType.clearCache(id);
      if (this.editingNodeId === id) {
        this.exitEditMode();
      }
    }

    if (this.editingNodeId && !this.dragSession) {
      const isSelfChanged =
        changes.nodes.data.has(this.editingNodeId) || changes.nodes.geometry.has(this.editingNodeId);
      const isAncestorChanged =
        changes.nodes.geometry.size > 0 &&
        this.ctx.entities
          .getAncestorIds(this.editingNodeId)
          .some((ancestorId) => changes.nodes.geometry.has(ancestorId));

      if (isSelfChanged || isAncestorChanged) {
        this.updateEditOverlay();
      }
    }
  }
}
