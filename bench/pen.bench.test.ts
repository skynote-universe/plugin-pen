/**
 * @file pen.bench.test.ts
 * @description 商业钢笔工具性能基准测试 (Stage C)
 *
 * 验证目标：
 * 1. 复杂贝塞尔曲线与长路径的投影精化与拾取耗时；
 * 2. 1000 个钢笔路径节点的密集画布下，缓存命中全量 compose 与精确空间拾取耗时。
 */

import { describe, it } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import { distancePointToCubicSegment, PathNodeType, PenPlugin, type PathAnchor } from '../src';

describe('商业钢笔性能基准 (Stage C)', () => {
  it('高阶贝塞尔最近点投影与牛顿精化 (10000 次查询)', () => {
    const p0 = { x: 10, y: 10 };
    const p1 = { x: 50, y: 150 };
    const p2 = { x: 150, y: 50 };
    const p3 = { x: 200, y: 180 };

    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      const qx = (i % 200) + 5;
      const qy = ((i * 7) % 200) + 5;
      distancePointToCubicSegment({ x: qx, y: qy }, p0, p1, p2, p3, 16);
    }
    const totalMs = performance.now() - t0;
    const avgUs = (totalMs / 10000) * 1000;

    console.info(`[bench:pen] 贝塞尔投影精化: 单次平均 ${avgUs.toFixed(2)}µs (10000 次耗时 ${totalMs.toFixed(2)}ms)`);
  });

  it('密集路径画布 (1000 个 path 节点)：缓存命中 compose 与精确空间拾取', () => {
    const pen = new PenPlugin();
    const engine = new SkyNoteEngine().use(pen);
    const store = engine.documentStore;

    // 批量创建 1000 个路径节点
    store.batch(() => {
      for (let i = 0; i < 1000; i++) {
        const col = i % 40;
        const row = Math.floor(i / 40);
        const x = col * 120;
        const y = row * 120;

        const anchors: PathAnchor[] = [
          { id: 'a1', point: { x: 0, y: 0 }, handleOut: { x: 30, y: 50 } },
          { id: 'a2', point: { x: 60, y: 60 }, handleIn: { x: -20, y: 0 }, handleOut: { x: 20, y: 0 } },
          { id: 'a3', point: { x: 100, y: 20 }, handleIn: { x: -30, y: -20 } }
        ];

        store.createNode({
          nodeType: PathNodeType.TYPE,
          x,
          y,
          width: 100,
          height: 60,
          options: {
            subpaths: [{ anchors, closed: i % 2 === 0 }]
          }
        });
      }
    }, '批量创建 1000 个钢笔路径');

    const nodes = Object.keys(store.getView().content.nodes).map((id) => store.getNode(id)!);

    // 预热 compose 缓存
    for (const node of nodes) {
      pen.nodeType.compose(node, { theme: engine.session.theme });
    }

    const tCompose0 = performance.now();
    for (const node of nodes) {
      pen.nodeType.compose(node, { theme: engine.session.theme });
    }
    const cachedComposeMs = performance.now() - tCompose0;

    const tHit0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const col = i % 40;
      const row = Math.floor(i / 40);
      if (engine.hitTestNode({ x: col * 120 + 60, y: row * 120 + 60 })) hits++;
    }
    const hitMs = (performance.now() - tHit0) / 200;

    console.info(
      `[bench:pen] 1000 个路径节点: 缓存命中全量 compose ${cachedComposeMs.toFixed(2)}ms, 单次精确拾取 ${(hitMs * 1000).toFixed(1)}µs (命中数: ${hits})`
    );
  });
});
