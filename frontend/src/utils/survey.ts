import type { SurveyPoint } from '../types/drill-hole';

/** 两位小数（cm），与现场记录精度一致；对账段签名也按此精度 */
export const round2 = (v: number): number => Number(v.toFixed(2));

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 孔深 → 垂深换算（平均角法）：相邻两测点间取倾角均值，
 * 垂深增量 = 段长 × sin(平均倾角)。倾角自水平面起算，90° 为直孔。
 * 孔口至第一测点按第一测点倾角，末测点以下沿用末点倾角；无测斜数据时按直孔处理。
 * 仅用于对账对照，不回写现场孔深。
 */
export function tvdAt(depth: number, survey: SurveyPoint[]): number {
  const target = Math.max(0, Number(depth) || 0);
  if (!survey.length) return round2(target);
  const points = [...survey].sort((a, b) => a.depth - b.depth);

  let tvd = 0;
  let prevDepth = 0;
  let prevDip = points[0].dip;
  for (const point of points) {
    const stationDepth = Math.max(0, Number(point.depth) || 0);
    if (target <= stationDepth) {
      tvd += (target - prevDepth) * Math.sin(rad((prevDip + point.dip) / 2));
      return round2(tvd);
    }
    tvd += (stationDepth - prevDepth) * Math.sin(rad((prevDip + point.dip) / 2));
    prevDepth = stationDepth;
    prevDip = point.dip;
  }
  tvd += (target - prevDepth) * Math.sin(rad(prevDip));
  return round2(tvd);
}

/** 孔深区间 → 垂深区间（换算值，仅对照用） */
export function tvdRangeOf(fromDepth: number, toDepth: number, survey: SurveyPoint[]): { fromTvd: number; toTvd: number } {
  return { fromTvd: tvdAt(fromDepth, survey), toTvd: tvdAt(toDepth, survey) };
}
