// Section 3 — private forensic analysis (mock). Admin only.

import type { ReactNode } from 'react';
import { Card, ClassificationBadge, Notice, formatDate } from '../components/ui';
import type { ForensicAnalysis } from '../domain/types';

function List({ items, empty = 'None recorded.' }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return <ul className="bullets">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="arow">
      <h3 className="arow-label">{label}</h3>
      <div className="arow-body">{children}</div>
    </div>
  );
}

export function ForensicAnalysisView({ a, history }: { a: ForensicAnalysis; history: ForensicAnalysis[] }) {
  return (
    <Card title="Private Forensic Analysis" tone="private" aside={<span className="private-tag">Admin only · Mock</span>}>
      {a.note && <Notice tone={a.isPlaceholder ? 'warn' : 'info'}>{a.note}</Notice>}
      <div className="score-row">
        <div className="score">
          <span className="score-label">Mock AI Classification</span>
          <ClassificationBadge value={a.classification} />
        </div>
        <div className="score">
          <span className="score-label">Recovery Score</span>
          <span className="score-val">{a.recoveryScore === null ? 'Not scored' : `${a.recoveryScore} / 100`}</span>
        </div>
        <div className="score">
          <span className="score-label">Confidence</span>
          <span className="score-val">{a.confidence === null ? 'Not scored' : `${Math.round(a.confidence * 100)}%`}</span>
        </div>
      </div>
      <p className="muted small">Analysis v{a.version} · {formatDate(a.generatedAt, true)}{history.length > 0 && ` · previous: ${history.map((h) => `v${h.version} ${h.classification}`).join(', ')}`}</p>

      <div className="agroup">
        <Row label="Buying Intent"><p><strong>{a.buyingIntent.level}.</strong> {a.buyingIntent.evidence}</p></Row>
        <Row label="Financial Capability"><p><strong>{a.financialCapability.level}.</strong> {a.financialCapability.evidence}</p></Row>
        <Row label="Offer Fit"><p><strong>{a.offerFit.level}.</strong> {a.offerFit.evidence}</p></Row>
      </div>
      <div className="agroup">
        <Row label="Last Strong Buying Signal"><p>{a.lastStrongBuyingSignal}</p></Row>
        <Row label="Momentum Breakpoint"><p>{a.momentumBreakpoint}</p></Row>
      </div>
      <div className="agroup">
        <Row label="Primary Friction"><p>{a.primaryFriction}</p></Row>
        <Row label="Secondary Frictions"><List items={a.secondaryFrictions} /></Row>
        <Row label="Stated Objection"><p>{a.statedObjection}</p></Row>
        <Row label="Underlying Friction Hypothesis"><p>{a.underlyingFrictionHypothesis}</p></Row>
        <Row label="Structural Blocker"><p>{a.structuralBlocker}</p></Row>
      </div>
      <div className="agroup ledger">
        <Row label="Confirmed Facts"><List items={a.confirmedFacts} /></Row>
        <Row label="Inferences"><List items={a.inferences} empty="None — no inferences drawn." /></Row>
        <Row label="Unknowns"><List items={a.unknowns} /></Row>
      </div>
      <div className="agroup">
        <Row label="Alternative Hypotheses"><List items={a.alternativeHypotheses} /></Row>
        <Row label="Seller-Side Friction"><List items={a.sellerSideFriction} /></Row>
        <Row label="Safety Flags"><List items={a.safetyFlags} empty="No safety flags." /></Row>
      </div>
    </Card>
  );
}

export function StrategyView({ a }: { a: ForensicAnalysis }) {
  return (
    <Card title="Strategy" tone="private" aside={<span className="private-tag">Admin only · Mock</span>}>
      <Row label="Next Objective"><p>{a.nextObjective}</p></Row>
      <Row label="Mock Proposed Message">
        {a.mockAiProposedMessage ? (
          <blockquote className="message-card">{a.mockAiProposedMessage}</blockquote>
        ) : (
          <p className="muted">{a.classification === 'RED' ? 'No message — RED cases never receive a recovery message.' : 'No message proposed. Write one in the decision below if appropriate.'}</p>
        )}
      </Row>
    </Card>
  );
}
