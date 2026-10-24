"use client";

/**
 * Top bar — date stepper + calendar modal (ported from bitcoin-history).
 * < DATE > arrows step the selected date by one trading day.
 * The selected date is used by the page to fetch PDHLM price lines.
 */

import React, { useEffect, useRef, useState } from "react";

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
  /** Called whenever the selected date changes. Page uses this to fetch PDHLM. */
  onDateChange: (date: string) => void;
}

export default function TopBar({ onDateChange }: Props) {
  const [date, setDate] = useState(todayStr);
  const [calOpen, setCalOpen] = useState(false);
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const boxRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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

      <div className="top-bar-spacer" />
    </header>
  );
}