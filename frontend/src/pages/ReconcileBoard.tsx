import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import RecoveryBadge from '../components/common/RecoveryBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useLithoStore } from '../stores/lithoStore';
import { useReconStore } from '../stores/reconcileStore';
import { LITHO_COLOR } from '../types/litho-log';
import { RECON_VERDICTS, SEGMENT_STATUS_TEXT, type ReconSegment, type ReconSession, type ReconVerdict } from '../types/reconcile';
import { RECON_TOLERANCE_M } from '../utils/reconcile';
import { tvdAt, tvdRangeOf } from '../utils/survey';

const { Title, Paragraph, Text } = Typography;

interface VerdictFormValues {
  verdict: ReconVerdict;
  verdictBy: string;
  note?: string;
}

/** 对账台：回次（孔深）按测斜换算垂深后与岩性编录（垂深）比段；只对照，不改双方原始数据 */
export default function ReconcileBoard() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const lithos = useLithoStore((s) => s.lithos);
  const segments = useReconStore((s) => s.segments);
  const sessions = useReconStore((s) => s.sessions);
  const runReconcile = useReconStore((s) => s.runReconcile);
  const retrySegment = useReconStore((s) => s.retrySegment);
  const pendSegment = useReconStore((s) => s.pendSegment);
  const resolveSegment = useReconStore((s) => s.resolveSegment);

  const [tolerance, setTolerance] = useState(RECON_TOLERANCE_M);
  const [operator, setOperator] = useState('地质组');
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<ReconSegment | null>(null);
  const [verdictForm] = Form.useForm<VerdictFormValues>();

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const activeHole = holes.find((h) => h.id === activeHoleId);

  const holeSegments = useMemo(
    () => segments.filter((seg) => seg.holeId === activeHoleId).sort((a, b) => a.fromTvd - b.fromTvd),
    [segments, activeHoleId],
  );
  const holeSessions = useMemo(
    () => sessions.filter((session) => session.holeId === activeHoleId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [sessions, activeHoleId],
  );
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const lithosById = useMemo(() => new Map(lithos.map((log) => [log.id, log])), [lithos]);
  /** 回次孔深 → 换算垂深（仅对照展示，现场孔深不动） */
  const tvdByRunId = useMemo(() => {
    if (!activeHole) return new Map<string, { fromTvd: number; toTvd: number }>();
    return new Map(
      runs.filter((run) => run.holeId === activeHole.id).map((run) => [run.id, tvdRangeOf(run.fromDepth, run.toDepth, activeHole.surveyData)]),
    );
  }, [runs, activeHole]);

  const counts = useMemo(() => {
    const of = (status: ReconSegment['status']) => holeSegments.filter((seg) => seg.status === status).length;
    return {
      total: holeSegments.length,
      matched: of('matched'),
      missingLitho: of('missingLitho'),
      missingRun: of('missingRun'),
      pending: of('pending'),
      resolved: of('resolved'),
    };
  }, [holeSegments]);

  const reachedDepth = useMemo(
    () => runs.filter((run) => run.holeId === activeHoleId).reduce((max, run) => Math.max(max, run.toDepth), 0),
    [runs, activeHoleId],
  );

  const doReconcile = async () => {
    if (!activeHole) return;
    setBusy(true);
    try {
      const session = await runReconcile({ hole: activeHole, runs, lithos, operator, tolerance });
      if (session.result === 'balanced') {
        message.success(`对账完成：${session.total} 段全部对上（含已裁定 ${session.resolved} 段）`);
      } else {
        const unsettled = session.missingLitho + session.missingRun + session.pending;
        message.warning(`对账完成：${unsettled} 段未对上已摆出，已比好的 ${session.matched} 段保留，可按段重试`);
      }
    } finally {
      setBusy(false);
    }
  };

  const doRetry = async (segment: ReconSegment) => {
    if (!activeHole) return;
    const status = await retrySegment(segment.id, { hole: activeHole, runs, lithos, tolerance });
    if (status === 'matched') {
      message.success(`垂深 ${segment.fromTvd}~${segment.toTvd}m 已对上了`);
    } else if (status) {
      message.warning(`垂深 ${segment.fromTvd}~${segment.toTvd}m 仍未对上（${SEGMENT_STATUS_TEXT[status].label}），可挂起待班组长定`);
    }
  };

  const openResolve = (segment: ReconSegment) => {
    setResolving(segment);
    verdictForm.setFieldsValue({ verdict: '以回次（孔深）为准', verdictBy: '班组长', note: segment.note } as VerdictFormValues);
  };

  const submitVerdict = async () => {
    if (!resolving) return;
    const values = await verdictForm.validateFields();
    await resolveSegment(resolving.id, values.verdict, values.verdictBy, values.note);
    message.success(`垂深 ${resolving.fromTvd}~${resolving.toTvd}m 已裁定：${values.verdict}`);
    setResolving(null);
  };

  const columns: TableColumnsType<ReconSegment> = [
    {
      title: '垂深段(m·换算)',
      width: 150,
      render: (_, seg) => (
        <Text strong>
          {seg.fromTvd}~{seg.toTvd}
          <Text type="secondary" style={{ marginLeft: 6, fontWeight: 400 }}>
            {Number((seg.toTvd - seg.fromTvd).toFixed(2))}m
          </Text>
        </Text>
      ),
    },
    {
      title: '状态',
      width: 110,
      render: (_, seg) => {
        const meta = SEGMENT_STATUS_TEXT[seg.status];
        const tag = <Tag color={meta.color}>{meta.label}</Tag>;
        return seg.status === 'matched' && seg.residual ? (
          <Tooltip title={`两侧覆盖缺口小于容差 ${tolerance}m，按换算残差处理`}>{tag}</Tooltip>
        ) : (
          tag
        );
      },
    },
    {
      title: '班组长侧 · 回次（现场孔深 → 换算垂深）',
      render: (_, seg) => {
        const segRuns = seg.runIds.map((id) => runsById.get(id)).filter((run): run is NonNullable<typeof run> => Boolean(run));
        if (!segRuns.length) return <Text type="secondary">无回次记录</Text>;
        return segRuns.map((run) => {
          const tvd = tvdByRunId.get(run.id);
          return (
            <div key={run.id} style={{ whiteSpace: 'nowrap' }}>
              <Text strong>{run.runNo}</Text>
              <span style={{ margin: '0 6px' }}>
                孔深 {run.fromDepth}~{run.toDepth}m → 垂深 {tvd ? `${tvd.fromTvd}~${tvd.toTvd}` : '-'}m
              </span>
              <RecoveryBadge recovery={run.recovery} />
            </div>
          );
        });
      },
    },
    {
      title: '编录员侧 · 岩性（垂深）',
      render: (_, seg) => {
        const segLithos = seg.lithoIds.map((id) => lithosById.get(id)).filter((log): log is NonNullable<typeof log> => Boolean(log));
        if (!segLithos.length) return <Text type="secondary">无岩性编录</Text>;
        return segLithos.map((log) => (
          <div key={log.id} style={{ whiteSpace: 'nowrap' }}>
            <Tag color={LITHO_COLOR[log.lithology]} style={{ color: '#2b3a46' }}>
              {log.lithology}
            </Tag>
            <span style={{ marginRight: 6 }}>
              垂深 {log.fromDepth}~{log.toDepth}m
            </span>
            <Text type="secondary">
              样品 {log.sampleNo || '-'} · RQD {log.rqd}%
            </Text>
          </div>
        ));
      },
    },
    {
      title: '裁定',
      width: 190,
      render: (_, seg) =>
        seg.status === 'resolved' ? (
          <span>
            <Tag color="blue">{seg.verdict}</Tag>
            <Text type="secondary">
              {seg.verdictBy} · {seg.verdictAt ? dayjs(seg.verdictAt).format('MM-DD HH:mm') : ''}
            </Text>
          </span>
        ) : seg.status === 'pending' ? (
          <Text type="warning">挂起待班组长定{seg.note ? `：${seg.note}` : ''}</Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '操作',
      width: 190,
      fixed: 'right',
      render: (_, seg) => {
        if (seg.status === 'matched') return <Text type="secondary">已入账</Text>;
        if (seg.status === 'resolved') return <Text type="secondary">已定论</Text>;
        return (
          <Space size={2}>
            <Button size="small" type="link" onClick={() => doRetry(seg)}>
              重试
            </Button>
            {seg.status !== 'pending' ? (
              <Popconfirm title="挂起该段待班组长裁定？不影响其他段入账" onConfirm={() => pendSegment(seg.id)}>
                <Button size="small" type="link">
                  挂起
                </Button>
              </Popconfirm>
            ) : null}
            <Button size="small" type="link" onClick={() => openResolve(seg)}>
              裁定
            </Button>
          </Space>
        );
      },
    },
  ];

  const sessionColumns: TableColumnsType<ReconSession> = [
    { title: '对账时间', dataIndex: 'createdAt', width: 160, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    { title: '操作人', dataIndex: 'operator', width: 100 },
    { title: '容差(m)', dataIndex: 'tolerance', width: 80, align: 'right' },
    { title: '总段数', dataIndex: 'total', width: 80, align: 'right' },
    { title: '已对上', dataIndex: 'matched', width: 80, align: 'right' },
    {
      title: '未对上',
      width: 90,
      align: 'right',
      render: (_, s) => s.missingLitho + s.missingRun,
    },
    { title: '挂起', dataIndex: 'pending', width: 70, align: 'right' },
    { title: '已裁定', dataIndex: 'resolved', width: 80, align: 'right' },
    {
      title: '结果',
      width: 100,
      render: (_, s) => (s.result === 'balanced' ? <Tag color="green">已对平</Tag> : <Tag color="red">未对平</Tag>),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        对账台
      </Title>
      <Paragraph type="secondary">
        班组长按孔深记回次（进尺、采取率、岩芯箱），编录员按垂深记岩性（岩性、样品号、RQD），两份各记各的。对账时按测斜把回次孔深换算成垂深再比段，换算值只拿来对照，现场孔深不动；对不上的段摆出待班组长定，不拖住其他段。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 200 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <span style={{ color: '#6b7a86' }}>容差</span>
        <InputNumber min={0.05} max={1} step={0.05} value={tolerance} onChange={(v) => setTolerance(Number(v) || RECON_TOLERANCE_M)} addonAfter="m" style={{ width: 110 }} />
        <span style={{ color: '#6b7a86' }}>操作人</span>
        <Input style={{ width: 120 }} value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={16} />
        <Button type="primary" loading={busy} disabled={!activeHole} onClick={doReconcile}>
          {holeSegments.length ? '重新对账' : '开始对账'}
        </Button>
        {activeHole ? (
          <Text type="secondary">
            测斜点 {activeHole.surveyData.length} 个{reachedDepth > 0 ? ` · 孔底 孔深 ${reachedDepth}m → 垂深 ${tvdAt(reachedDepth, activeHole.surveyData)}m（换算值）` : ''}
          </Text>
        ) : null}
      </Space>

      {counts.missingRun + counts.missingLitho > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`${counts.missingRun + counts.missingLitho} 段对不上，已摆出待处理，其余段不受影响`}
          description={
            <span>
              {counts.missingRun > 0 ? `缺回次 ${counts.missingRun} 段：班组长在「回次记录」补交班报，同一班报再交一次不会多出回次；` : ''}
              {counts.missingLitho > 0 ? `缺编录 ${counts.missingLitho} 段：编录员在「岩性编录」补录；` : ''}
              改完后点该段「重试」，或先「挂起」等班组长裁定。
            </span>
          }
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={4}>
          <StatBadge label="对账段数" value={counts.total} unit="段" />
        </Col>
        <Col xs={12} md={4}>
          <StatBadge label="已对上" value={counts.matched} unit="段" status="success" />
        </Col>
        <Col xs={12} md={4}>
          <StatBadge label="缺回次" value={counts.missingRun} unit="段" status={counts.missingRun ? 'error' : 'default'} />
        </Col>
        <Col xs={12} md={4}>
          <StatBadge label="缺编录" value={counts.missingLitho} unit="段" status={counts.missingLitho ? 'warning' : 'default'} />
        </Col>
        <Col xs={12} md={4}>
          <StatBadge label="挂起待定" value={counts.pending} unit="段" status={counts.pending ? 'warning' : 'default'} />
        </Col>
        <Col xs={12} md={4}>
          <StatBadge label="已裁定" value={counts.resolved} unit="段" />
        </Col>
      </Row>

      {holeSegments.length === 0 ? (
        <EmptyPanel description="该孔尚未对账：先按测斜把回次孔深换算成垂深，再与编录员的垂深区间比段" actionText="开始对账" onAction={doReconcile} />
      ) : (
        <Card size="small" title="对账段（垂深域）" style={{ marginBottom: 16 }}>
          <Table rowKey="id" size="small" columns={columns} dataSource={holeSegments} pagination={{ pageSize: 10 }} scroll={{ x: 1450 }} />
        </Card>
      )}

      {holeSessions.length > 0 ? (
        <Card size="small" title="对账批次留痕">
          <Table rowKey="id" size="small" columns={sessionColumns} dataSource={holeSessions.slice(0, 8)} pagination={false} scroll={{ x: 900 }} />
        </Card>
      ) : null}

      <Modal
        open={Boolean(resolving)}
        title={resolving ? `班组长裁定 · 垂深 ${resolving.fromTvd}~${resolving.toTvd}m` : '班组长裁定'}
        onCancel={() => setResolving(null)}
        onOk={submitVerdict}
        okText="记录裁定"
        cancelText="取消"
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="裁定只记录定论口径，双方原始记录（回次孔深、岩性垂深）都不改；需改数时各自回自己的页面改。"
        />
        <Form form={verdictForm} layout="vertical">
          <Form.Item name="verdict" label="裁定口径" rules={[{ required: true, message: '请选择裁定口径' }]}>
            <Select options={RECON_VERDICTS.map((v) => ({ label: v, value: v }))} />
          </Form.Item>
          <Form.Item name="verdictBy" label="裁定人（班组长）" rules={[{ required: true, message: '请输入裁定人' }]}>
            <Input maxLength={16} placeholder="班组长" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={60} placeholder="如：编录员按换算垂深补记该段" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
