import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useLithoStore } from '../stores/lithoStore';
import { useReconcileStore } from '../stores/reconcileStore';
import { holeToVertical } from '../utils/depth';
import { MATCH_TYPE_TEXT, createReconcileRecord, reconcileHole } from '../utils/reconcile';
import type { ReconcileRecord, ReconcileStatus, SectionMatch } from '../types/reconcile';

const { Title, Paragraph, Text } = Typography;

const STATUS_TEXT: Record<ReconcileStatus, { label: string; color: string }> = {
  matched: { label: '全部匹配', color: 'green' },
  partial: { label: '部分匹配', color: 'orange' },
  failed: { label: '对账失败', color: 'red' },
};

/**
 * 对账：把机台班组长按孔深记的回次，按测斜换算成垂深，
 * 再与编录员按垂深记的岩性区间比段。换算值只拿来对照，现场孔深留着。
 * 对不上的段摆出来等组长定，不拖住别的段；已比好的段留着按段重试。
 */
export default function Reconcile() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const lithos = useLithoStore((s) => s.lithos);
  const records = useReconcileStore((s) => s.records);
  const saveRecord = useReconcileStore((s) => s.saveRecord);
  const removeRecord = useReconcileStore((s) => s.removeRecord);

  const [deciding, setDeciding] = useState<SectionMatch | null>(null);
  const [decisionText, setDecisionText] = useState('');
  const [submitter, setSubmitter] = useState('组长');

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const activeHole = holes.find((h) => h.id === activeHoleId);

  // 每次渲染都按当前数据重新比段（数据变了，段自然重算）
  const { sections, status } = useMemo(() => {
    if (!activeHole) return { sections: [] as SectionMatch[], status: 'failed' as ReconcileStatus };
    return reconcileHole(activeHole, runs, lithos);
  }, [activeHole, runs, lithos]);

  const latestRecord = useMemo(
    () =>
      records
        .filter((r) => r.holeId === activeHoleId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [records, activeHoleId],
  );

  const stats = useMemo(() => {
    const exact = sections.filter((s) => s.matchType === 'exact').length;
    const overlap = sections.filter((s) => s.matchType === 'overlap').length;
    const extraRun = sections.filter((s) => s.matchType === 'extra-run').length;
    const extraLitho = sections.filter((s) => s.matchType === 'extra-litho').length;
    const decided = sections.filter((s) => s.decided).length;
    return { exact, overlap, extraRun, extraLitho, decided, total: sections.length };
  }, [sections]);

  // 回次孔深→垂深换算预览
  const runDepthPreview = useMemo(() => {
    if (!activeHole) return [];
    return runs
      .filter((r) => r.holeId === activeHoleId)
      .map((run) => ({
        id: run.id,
        runNo: run.runNo,
        fromHole: run.fromDepth,
        toHole: run.toDepth,
        fromV: holeToVertical(activeHole.surveyData, run.fromDepth),
        toV: holeToVertical(activeHole.surveyData, run.toDepth),
      }))
      .sort((a, b) => a.fromHole - b.fromHole);
  }, [activeHole, runs]);

  const handleSubmit = async () => {
    if (!activeHole) return;
    const record = createReconcileRecord(activeHole.id, sections, status, submitter.trim() || '组长');
    await saveRecord(record);
    message.success(`已提交对账，状态：${STATUS_TEXT[status].label}，共 ${sections.length} 段`);
  };

  const handleRetrySection = (section: SectionMatch) => {
    // 数据已在 useMemo 中重算；这里仅提示该段当前比段结果
    const fresh = reconcileHole(activeHole!, runs, lithos);
    const updated = fresh.sections.find((s) => s.runId === section.runId && s.lithoId === section.lithoId);
    if (updated?.matchType === 'exact') {
      message.success(`段 ${section.runNo ?? section.lithology ?? ''} 已重新精确匹配`);
    } else {
      message.info(`段 ${section.runNo ?? section.lithology ?? ''} 仍为「${MATCH_TYPE_TEXT[updated?.matchType ?? section.matchType].label}」，请组长决定或调整深度`);
    }
  };

  const openDecision = (section: SectionMatch) => {
    setDeciding(section);
    setDecisionText(section.decision ?? '');
  };

  const submitDecision = async () => {
    if (!deciding || !latestRecord) return;
    const nextSections = latestRecord.sections.map((s) =>
      s.id === deciding.id ? { ...s, decided: true, decision: decisionText.trim() || undefined } : s,
    );
    const nextRecord: ReconcileRecord = { ...latestRecord, sections: nextSections };
    await saveRecord(nextRecord);
    setDeciding(null);
    message.success('已记录组长决定');
  };

  const columns: TableColumnsType<SectionMatch> = [
    {
      title: '回次号',
      dataIndex: 'runNo',
      width: 110,
      render: (v?: string) => (v ? <Text strong>{v}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: '现场孔深区间(m)',
      width: 150,
      render: (_, row) =>
        row.runFromHole != null ? (
          <span>
            {row.runFromHole}~{row.runToHole}
          </span>
        ) : (
          <Text type="secondary">无回次</Text>
        ),
    },
    {
      title: '换算垂深区间(m)',
      width: 150,
      render: (_, row) =>
        row.runFromV != null ? (
          <Text type="secondary">
            {row.runFromV}~{row.runToV}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '岩性垂深区间(m)',
      width: 150,
      render: (_, row) =>
        row.lithoFromV != null ? (
          <span>
            {row.lithoFromV}~{row.lithoToV}
          </span>
        ) : (
          <Text type="secondary">无岩性</Text>
        ),
    },
    {
      title: '岩性',
      dataIndex: 'lithology',
      width: 130,
      render: (v?: string) => v ?? <Text type="secondary">—</Text>,
    },
    {
      title: '匹配类型',
      width: 110,
      render: (_, row) => <Tag color={MATCH_TYPE_TEXT[row.matchType].color}>{MATCH_TYPE_TEXT[row.matchType].label}</Tag>,
    },
    {
      title: '组长决定',
      width: 120,
      render: (_, row) =>
        row.decided ? (
          <Tag color="blue" icon={<CheckCircleOutlined />}>
            已决定
          </Tag>
        ) : row.matchType === 'exact' ? (
          <Tag color="green">自动通过</Tag>
        ) : (
          <Tag color="default" icon={<ExclamationCircleOutlined />}>
            待决定
          </Tag>
        ),
    },
    {
      title: '操作',
      width: 200,
      fixed: 'right',
      render: (_, row) => (
        <Space size={2}>
          <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => handleRetrySection(row)}>
            重试本段
          </Button>
          {row.matchType !== 'exact' ? (
            <Button size="small" type="link" onClick={() => openDecision(row)}>
              标记决定
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        对账
      </Title>
      <Paragraph type="secondary">
        机台班组长按孔深记回次，编录员按垂深记岩性区间，两边深度对不上。对账前按测斜把孔深换算成垂深再比段——换算值只拿来对照，现场孔深留着。对不上的段摆出来等组长定，别拖住别的段。
      </Paragraph>

      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="换算值只拿来对照，现场孔深留着"
        description="回次的孔深（fromDepth/toDepth）是班组长的原始记录，对账时仅换算成垂深与岩性区间比段，不会覆盖或改写现场孔深。"
      />

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 220 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Input
          style={{ width: 140 }}
          value={submitter}
          onChange={(e) => setSubmitter(e.target.value)}
          placeholder="对账人"
          addonBefore="对账人"
        />
        <Button type="primary" icon={<SendOutlined />} onClick={handleSubmit} disabled={!activeHole || sections.length === 0}>
          提交对账
        </Button>
        <Text type="secondary">
          对账状态：
          <Tag color={STATUS_TEXT[status].color} icon={<SafetyCertificateOutlined />}>
            {STATUS_TEXT[status].label}
          </Tag>
        </Text>
        {latestRecord ? (
          <Text type="secondary">
            最近提交：{new Date(latestRecord.createdAt).toLocaleString('zh-CN')}（{latestRecord.createdBy}）
          </Text>
        ) : null}
      </Space>

      {!activeHole ? (
        <EmptyPanel description="请先选择一个钻孔" />
      ) : (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={4}>
              <StatBadge label="总段数" value={stats.total} unit="段" />
            </Col>
            <Col xs={12} md={4}>
              <StatBadge label="精确匹配" value={stats.exact} unit="段" status="success" />
            </Col>
            <Col xs={12} md={4}>
              <StatBadge label="部分重叠" value={stats.overlap} unit="段" status="warning" />
            </Col>
            <Col xs={12} md={4}>
              <StatBadge label="无岩性" value={stats.extraRun} unit="段" status={stats.extraRun ? 'error' : 'default'} />
            </Col>
            <Col xs={12} md={4}>
              <StatBadge label="无回次" value={stats.extraLitho} unit="段" status={stats.extraLitho ? 'error' : 'default'} />
            </Col>
            <Col xs={12} md={4}>
              <StatBadge label="组长已决定" value={stats.decided} unit="段" status="default" />
            </Col>
          </Row>

          {sections.length === 0 ? (
            <EmptyPanel description="该孔暂无回次或岩性区间，无法对账" actionText="去录入回次" onAction={() => navigate('/runs')} />
          ) : (
            <Card size="small" title="比段结果（回次孔深 → 垂深 vs 岩性垂深）" style={{ marginBottom: 16 }}>
              <Table
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={sections}
                pagination={{ pageSize: 10 }}
                scroll={{ x: 1200 }}
                rowClassName={(row) => (row.matchType === 'exact' ? '' : 'conflict-row')}
              />
            </Card>
          )}

          <Card size="small" title="回次孔深 → 垂深换算预览" style={{ marginBottom: 16 }}>
            <Table
              rowKey="id"
              size="small"
              columns={[
                { title: '回次号', dataIndex: 'runNo', width: 110, render: (v: string) => <Text strong>{v}</Text> },
                { title: '现场孔深(m)', width: 140, render: (_, row) => `${row.fromHole}~${row.toHole}` },
                { title: '换算垂深(m)', width: 140, render: (_, row) => <Text type="secondary">{row.fromV}~{row.toV}</Text> },
                {
                  title: '换算差值(m)',
                  width: 120,
                  render: (_, row) => {
                    const diff = Number(((row.fromHole + row.toHole) / 2 - (row.fromV + row.toV) / 2).toFixed(2));
                    return <Text type={diff > 0.5 ? 'warning' : 'secondary'}>{diff}</Text>;
                  },
                },
              ]}
              dataSource={runDepthPreview}
              pagination={{ pageSize: 8 }}
              scroll={{ x: 600 }}
            />
          </Card>

          {records.filter((r) => r.holeId === activeHoleId).length > 0 ? (
            <Card size="small" title="对账历史">
              <Timeline
                items={records
                  .filter((r) => r.holeId === activeHoleId)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((record) => ({
                    color: STATUS_TEXT[record.status].color,
                    children: (
                      <Space direction="vertical" size={2}>
                        <Space>
                          <Tag color={STATUS_TEXT[record.status].color}>{STATUS_TEXT[record.status].label}</Tag>
                          <Text strong>{record.createdBy}</Text>
                          <Text type="secondary">{new Date(record.createdAt).toLocaleString('zh-CN')}</Text>
                          <Text type="secondary">共 {record.sections.length} 段</Text>
                        </Space>
                        {record.note ? <Text type="secondary">{record.note}</Text> : null}
                        <Popconfirm
                          title="确认删除该次对账记录？"
                          onConfirm={() => {
                            removeRecord(record.id);
                            message.success('已删除对账记录');
                          }}
                        >
                          <Button size="small" type="link" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  }))}
              />
            </Card>
          ) : null}
        </>
      )}

      <Modal
        open={!!deciding}
        title="标记组长决定"
        onCancel={() => setDeciding(null)}
        onOk={submitDecision}
        okText="保存决定"
        cancelText="取消"
      >
        <Paragraph type="secondary">
          段 {deciding?.runNo ?? deciding?.lithology ?? ''}（
          {deciding?.runFromHole != null ? `孔深 ${deciding.runFromHole}~${deciding.runToHole}m` : ''}
          {deciding?.lithoFromV != null ? ` / 岩性垂深 ${deciding.lithoFromV}~${deciding.lithoToV}m` : ''}）
          为「{deciding ? MATCH_TYPE_TEXT[deciding.matchType].label : ''}」，请组长决定如何处理。
        </Paragraph>
        <Input.TextArea
          rows={3}
          value={decisionText}
          onChange={(e) => setDecisionText(e.target.value)}
          placeholder="如：边界偏差 0.8m，以岩性垂深为准，回次深度待班组长修正"
        />
      </Modal>
    </div>
  );
}
