import React, { useEffect, useState } from "react";

export type Tone = "neutral" | "active" | "done" | "attention" | "danger" | "primary";

export type PhaseItem = {
  id: string;
  label: string;
  tone?: Tone;
  complete?: boolean;
  current?: boolean;
  detail?: string;
};

export type ChecklistItem = {
  id: string;
  label: string;
  detail?: string;
  tone?: Tone;
  complete?: boolean;
};

export type EvidenceItem = {
  id: string;
  label: string;
  summary: string;
  meta?: string;
  tone?: Tone;
};

export function toneForStatus(status: string | undefined | null): Tone {
  const normalized = String(status || "").toLowerCase();
  if (["completed", "complete", "passed", "done", "applied", "merged", "success"].includes(normalized)) return "done";
  if (["running", "working", "active", "claimed", "reviewing", "validating", "merging"].includes(normalized)) return "active";
  if (["pending", "needs_continue", "rework", "ready_to_merge", "ready"].includes(normalized)) return "attention";
  if (["failed", "blocked", "cancelled", "error", "rejected"].includes(normalized)) return "danger";
  return "neutral";
}

export function StateDot({ tone = "neutral", label }: { tone?: Tone; label?: string }) {
  return <span className={`state-dot tone-${tone}`} aria-label={label} title={label} />;
}

export function PhaseRail({ items, compact = false }: { items: PhaseItem[]; compact?: boolean }) {
  return (
    <div className={`phase-rail ${compact ? "is-compact" : ""}`} aria-label="Progress phases">
      {items.map((item) => (
        <div
          key={item.id}
          className={`phase-step tone-${item.tone || "neutral"} ${item.complete ? "is-complete" : ""} ${item.current ? "is-current" : ""}`}
          title={item.detail || item.label}
        >
          <span />
          <strong>{item.label}</strong>
          {item.detail && !compact ? <small>{item.detail}</small> : null}
        </div>
      ))}
    </div>
  );
}

export function ChecklistRail({ items }: { items: ChecklistItem[] }) {
  return (
    <div className="checklist-rail">
      {items.map((item) => (
        <article key={item.id} className={`checklist-item tone-${item.tone || "neutral"} ${item.complete ? "is-complete" : ""}`}>
          <StateDot tone={item.complete ? "done" : item.tone || "neutral"} />
          <div>
            <strong>{item.label}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export function EvidenceRail({ items }: { items: EvidenceItem[] }) {
  return (
    <div className="evidence-rail">
      {items.map((item) => (
        <article key={item.id} className={`evidence-step tone-${item.tone || "neutral"}`}>
          <div className="evidence-step-head">
            <StateDot tone={item.tone || "neutral"} />
            <span>{item.label}</span>
          </div>
          <strong>{item.summary}</strong>
          {item.meta ? <small>{item.meta}</small> : null}
        </article>
      ))}
    </div>
  );
}

export function ActionDock({
  label,
  detail,
  disabled,
  busy,
  defaultOpen = false,
  children,
}: {
  label: string;
  detail?: string;
  disabled?: boolean;
  busy?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [label, detail, defaultOpen]);
  return (
    <div className={`action-dock ${open ? "is-open" : ""}`}>
      <button className="primary-button" type="button" disabled={disabled || busy} onClick={() => setOpen((value) => !value)}>
        {busy ? "Working..." : label}
      </button>
      {detail ? <span>{detail}</span> : null}
      {open ? <div className="action-dock-sheet">{children}</div> : null}
    </div>
  );
}

export function LogChip({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  if (!value) return null;
  return (
    <span className={`log-chip ${open ? "is-open" : ""}`}>
      <button type="button" onClick={() => setOpen((current) => !current)}>
        {label}
      </button>
      {open ? <code>{value}</code> : null}
    </span>
  );
}

export function StatusMeter({ items }: { items: Array<{ id: string; label: string; value: number; tone?: Tone }> }) {
  const total = Math.max(1, items.reduce((sum, item) => sum + item.value, 0));
  return (
    <div className="status-meter" aria-label="Status distribution">
      <div className="status-meter-bar">
        {items.map((item) => (
          <span
            key={item.id}
            className={`tone-${item.tone || "neutral"}`}
            style={{ flexBasis: `${(item.value / total) * 100}%` }}
            title={`${item.label}: ${item.value}`}
          />
        ))}
      </div>
      <div className="status-meter-legend">
        {items.map((item) => (
          <span key={item.id}>
            <StateDot tone={item.tone || "neutral"} />
            {item.label} {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}
