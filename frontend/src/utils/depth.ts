import type { SurveyPoint } from '../types/drill-hole';

/** 角度转弧度 */
function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * 按测斜数据把孔深（沿孔深度）换算为垂深。
 *
 * 采用平均角法：相邻测点间倾角线性变化，垂深增量 = 段长 × sin(平均倾角)。
 * - 0 到第一测点：按第一测点倾角（无浅部测点，不臆造直立段）。
 * - 测点之间：倾角线性插值，取首尾平均倾角。
 * - 最后测点以下：按最后测点倾角外延。
 * - 无测斜数据：按直孔处理（垂深 = 孔深）。
 *
 * 注意：换算值只用于对照，现场孔深（fromDepth/toDepth）始终保留不动。
 */
export function holeToVertical(surveyPoints: SurveyPoint[], holeDepth: number): number {
  if (!Number.isFinite(holeDepth) || holeDepth <= 0) return 0;
  const points = [...surveyPoints].sort((a, b) => a.depth - b.depth);
  if (points.length === 0) return Number(holeDepth.toFixed(2));

  const first = points[0];

  // 0 ~ 第一测点：按第一测点倾角
  if (holeDepth <= first.depth) {
    return Number((holeDepth * Math.sin(toRadians(first.dip))).toFixed(2));
  }

  let vertical = first.depth * Math.sin(toRadians(first.dip));
  let cursor = first.depth;

  // 测点之间：倾角线性插值，平均角法
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const segmentLength = p2.depth - p1.depth;
    if (holeDepth <= p2.depth) {
      const partialLength = holeDepth - cursor;
      const fraction = segmentLength > 0 ? partialLength / segmentLength : 0;
      const dipEnd = p1.dip + fraction * (p2.dip - p1.dip);
      const dipAvg = (p1.dip + dipEnd) / 2;
      vertical += partialLength * Math.sin(toRadians(dipAvg));
      return Number(vertical.toFixed(2));
    }
    const dipAvg = (p1.dip + p2.dip) / 2;
    vertical += segmentLength * Math.sin(toRadians(dipAvg));
    cursor = p2.depth;
  }

  // 最后测点以下：按最后测点倾角外延
  const last = points[points.length - 1];
  const beyond = holeDepth - cursor;
  vertical += beyond * Math.sin(toRadians(last.dip));

  return Number(vertical.toFixed(2));
}
