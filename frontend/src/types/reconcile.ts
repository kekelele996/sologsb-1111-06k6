/** 对账段状态 */
export type SegmentStatus =
  | 'matched' // 已对上：回次（换算垂深）与岩性编录共同覆盖
  | 'missingLitho' // 缺编录：该垂深段只有回次，无岩性编录
  | 'missingRun' // 缺回次：该垂深段只有岩性编录，无回次
  | 'pending' // 挂起：对不上，已摆出待班组长裁定，不阻塞其他段
  | 'resolved'; // 已裁定：班组长已给出定论口径

/** 班组长裁定口径（只记录结论，不改双方原始数据） */
export type ReconVerdict = '以回次（孔深）为准' | '以编录（垂深）为准' | '双方复核原始记录';

export const RECON_VERDICTS: ReconVerdict[] = ['以回次（孔深）为准', '以编录（垂深）为准', '双方复核原始记录'];

/**
 * 对账段：在垂深域上由回次（孔深换算）与岩性区间（垂深）的边界切分得到。
 * 换算垂深仅用于对照，回次表现场孔深原值。
 */
export interface ReconSegment {
  id: string;
  /** 所属钻孔 */
  holeId: string;
  /** 段签名（垂深区间），重跑对账时据此保留已比好的段与人工裁定 */
  signature: string;
  /** 段起垂深（m，换算值） */
  fromTvd: number;
  /** 段止垂深（m，换算值） */
  toTvd: number;
  status: SegmentStatus;
  /** 覆盖缺口小于容差，按换算残差处理（仍视为已对上） */
  residual?: boolean;
  /** 覆盖该段的回次 id（班组长侧） */
  runIds: string[];
  /** 覆盖该段的岩性区间 id（编录员侧） */
  lithoIds: string[];
  /** 裁定口径 */
  verdict?: ReconVerdict;
  /** 裁定人（班组长） */
  verdictBy?: string;
  /** 裁定时间 ISO */
  verdictAt?: string;
  /** 挂起/裁定备注 */
  note?: string;
  /** 最近更新时间 ISO */
  updatedAt: string;
}

/** 对账批次（每次对账留痕；对不上的段挂起不影响其他段入账） */
export interface ReconSession {
  id: string;
  holeId: string;
  /** 对账时间 ISO */
  createdAt: string;
  /** 对账操作人 */
  operator: string;
  /** 本次使用的容差（m） */
  tolerance: number;
  total: number;
  matched: number;
  missingLitho: number;
  missingRun: number;
  pending: number;
  resolved: number;
  /** 结果：balanced 全部对上（含已裁定）；unbalanced 仍有对不上的段 */
  result: 'balanced' | 'unbalanced';
}

export const SEGMENT_STATUS_TEXT: Record<SegmentStatus, { label: string; color: string }> = {
  matched: { label: '已对上', color: 'green' },
  missingLitho: { label: '缺编录', color: 'orange' },
  missingRun: { label: '缺回次', color: 'red' },
  pending: { label: '挂起待定', color: 'gold' },
  resolved: { label: '已裁定', color: 'blue' },
};
