"use client";

/**
 * Top bar — date stepper + calendar modal (ported from bitcoin-history).
 * < DATE > arrows step the selected date by one trading day.
 * The selected date is the reference day for drawing horizontal levels.
 * It does not freeze or jump the live chart period.
 */

import React, { useEffect, useRef, useState } from "react";
import type { CustomLevelColor, LineToggles } from "./Chart";

const CUSTOM_COLORS: Record<CustomLevelColor, string> = {
  red: "#ef5350",
  yellow: "#ffeb3b",
  green: "#26a69a",
};

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function dayName(dateStr: string): string {
  const [y,m,d] = dateStr.split("-").map(Number) as [number,number,number];
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** Step a YYYY-MM-DD date by +1 or -1 calendar days (no weekend skip — crypto trades every day). */
function stepDay(dateStr: string, delta: number): string | null {
  const [y,m,d] = dateStr.split("-").map(Number) as [number,number,number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const now = new Date();
  if (dt > now) return null; // don't go into the future
  const ry = dt.getUTCFullYear();
  const rm = String(dt.getUTCMonth() + 1).padStart(2,"0");
  const rd = String(dt.getUTCDate()).padStart(2,"0");
  return `${ry}-${rm}-${rd}`;
}

interface Props {
  /** Calendar date is the reference day for drawing levels — not the chart window. */
  onDateChange: (date: string) => void;
  toggles: LineToggles;
  onToggle: (key: keyof LineToggles) => void;
  onAddCustom: (price: number, color: CustomLevelColor) => void;
  onClearCustom: () => void;
}

export default function TopBar({ onDateChange, toggles, onToggle, onAddCustom, onClearCustom }: Props) {
  const [date, setDate] = useState(todayStr);
  const [calOpen, setCalOpen] = useState(false);
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const boxRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [customInput, setCustomInput] = useState("");
  const [customColor, setCustomColor] = useState<CustomLevelColor>("yellow");

  // Notify parent on mount and whenever date changes.
  useEffect(() => { onDateChange(date); }, [date, onDateChange]);

  // Update to today at midnight rollover.
  useEffect(() => {
    const now = new Date();
    const msUntilMidnight =
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const t = setTimeout(() => setDate(todayStr()), msUntilMidnight);
    return () => clearTimeout(t);
  }, []);

  // Close calendar on outside click.
  useEffect(() => {
    if (!calOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        modalRef.current && !modalRef.current.contains(e.target as Node) &&
        boxRef.current && !boxRef.current.contains(e.target as Node)
      ) setCalOpen(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [calOpen]);

  const changeDate = (newDate: string | null) => {
    if (!newDate) return;
    setDate(newDate);
  };

  const openCalendar = (e: React.MouseEvent) => {
    e.stopPropagation();
    const [y, m] = date.split("-").map(Number) as [number, number];
    setCalYear(y);
    setCalMonth(m - 1);
    setCalOpen((v) => !v);
  };

  // Modal position below the date box.
  const getModalStyle = (): React.CSSProperties => {
    if (!boxRef.current) return { top: 50, left: 8 };
    const r = boxRef.current.getBoundingClientRect();
    const modalW = 250;
    let left = r.left + r.width / 2 - modalW / 2;
    if (left + modalW > window.innerWidth - 8) left = window.innerWidth - modalW - 8;
    if (left < 8) left = 8;
    return { top: r.bottom + 6, left };
  };

  const renderCalGrid = () => {
    const today = new Date();
    const firstDay = new Date(Date.UTC(calYear, calMonth, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(calYear, calMonth + 1, 0)).getUTCDate();
    const cells: React.ReactNode[] = [];

    for (let i = 0; i < firstDay; i++) {
      cells.push(<div key={`e${i}`} className="cal-day-cell empty" />);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dayObj = new Date(Date.UTC(calYear, calMonth, day));
      const ds = `${calYear}-${String(calMonth + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const isFuture = dayObj > today;
      const isSelected = ds === date;
      let cls = "cal-day-cell";
      if (isFuture) cls += " disabled";
      else if (isSelected) cls += " selected";
      cells.push(
        <div
          key={ds}
          className={cls}
          onClick={isFuture ? undefined : (e) => { e.stopPropagation(); changeDate(ds); setCalOpen(false); }}
        >
          {day}
        </div>
      );
    }
    return cells;
  };

  const prevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCalMonth((m) => { if (m === 0) { setCalYear((y) => y - 1); return 11; } return m - 1; });
  };
  const nextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = new Date();
    if (calYear === now.getFullYear() && calMonth === now.getMonth()) return;
    setCalMonth((m) => { if (m === 11) { setCalYear((y) => y + 1); return 0; } return m + 1; });
  };
  const isNextDisabled = () => {
    const now = new Date();
    return calYear === now.getFullYear() && calMonth === now.getMonth();
  };

  const prevDate = stepDay(date, -1);
  const nextDate = stepDay(date, +1);

  return (
    <header className="top-bar">
      {/* Date stepper: < DATE > */}
      <div className="date-controls">
        <div className="date-stepper-container">
          <button
            className="date-stepper-btn"
            disabled={!prevDate}
            onClick={() => changeDate(prevDate)}
            title="Previous day"
          >{"<"}</button>

          <div
            className="date-box-wrapper"
            ref={boxRef}
            title="Click to open calendar"
            onClick={openCalendar}
          >
            <span className="date-dayname-text">{dayName(date)}</span>
            <span className="date-display-text">{date}</span>
          </div>

          <button
            className="date-stepper-btn"
            disabled={!nextDate}
            onClick={() => changeDate(nextDate)}
            title="Next day"
          >{">"}</button>
        </div>
      </div>

      {/* Calendar modal */}
      {calOpen && (
        <div
          className="calendar-modal"
          ref={modalRef}
          style={getModalStyle()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cal-header">
            <button className="cal-nav-btn" onClick={prevMonth}>{"<"}</button>
            <span className="cal-title">{MONTH_NAMES[calMonth]} {calYear}</span>
            <button className="cal-nav-btn" onClick={nextMonth} disabled={isNextDisabled()}>{">"}</button>
          </div>
          <div className="cal-weekdays">
            {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="cal-days-grid">
            {renderCalGrid()}
          </div>
        </div>
      )}

      <div className="header-divider" />

      <div className="level-toggles-group">
        <button
          type="button"
          className={`toggle-btn${toggles.weekly ? " active" : ""}`}
          title="Previous week high / low (purple)"
          onClick={() => onToggle("weekly")}
        >
          Weekly
        </button>
        <button
          type="button"
          className={`toggle-btn${toggles.monday ? " active" : ""}`}
          title="This week's Monday high / low (blue)"
          onClick={() => onToggle("monday")}
        >
          Monday
        </button>
        <button
          type="button"
          className={`toggle-btn${toggles.pdhlm ? " active" : ""}`}
          title="Previous day high / low (white) and mid (dashed)"
          onClick={() => onToggle("pdhlm")}
        >
          PDHLM
        </button>
        <button
          type="button"
          className={`toggle-btn${toggles.fibb ? " active" : ""}`}
          title="Prev 1D 75% / 25% (yellow dotted)"
          onClick={() => onToggle("fibb")}
        >
          25% / 75%
        </button>
      </div>

      <div className="top-bar-spacer" />

      <form
        className="custom-level-group"
        onSubmit={(e) => {
          e.preventDefault();
          const value = customInput.trim();
          if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) {
            setCustomInput("");
            return;
          }
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) {
            setCustomInput("");
            return;
          }
          onAddCustom(Math.round(n * 2) / 2, customColor);
          setCustomInput("");
        }}
      >
        <details className="custom-color-picker">
          <summary
            className="custom-color-trigger"
            title={`Custom line color: ${customColor}`}
            aria-label={`Custom line color: ${customColor}`}
          >
            <span style={{ backgroundColor: CUSTOM_COLORS[customColor] }} />
          </summary>
          <div className="custom-color-menu">
            {(["red", "yellow", "green"] as const).map((color) => (
              <button
                key={color}
                type="button"
                className="custom-color-option"
                onClick={(event) => {
                  setCustomColor(color);
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                <span style={{ backgroundColor: CUSTOM_COLORS[color] }} />
                {color.toUpperCase()}
              </button>
            ))}
          </div>
        </details>
        <input
          className="custom-level-input"
          value={customInput}
          onChange={(e) => {
            const value = e.target.value;
            setCustomInput(/^\d*\.?\d*$/.test(value) ? value : "");
          }}
          placeholder="CUSTOM"
          inputMode="decimal"
          title={`Add a custom price level (${customColor})`}
        />
        <button type="submit" className="toggle-btn custom-add-btn" title="Add custom level">
          Add
        </button>
        <button
          type="button"
          className="trash-btn"
          title="Remove all custom levels"
          onClick={onClearCustom}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </form>
    </header>
  );
}