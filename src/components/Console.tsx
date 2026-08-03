import { useEffect, useRef } from "react";
import type { LogEvent } from "../api";

interface Props {
  lines: LogEvent[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function Console({ lines, open, onToggle, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, open]);

  return (
    <div className={`console${open ? " open" : ""}`}>
      <div className="console-head">
        <button className="link-button" onClick={onToggle}>
          {open ? "▾" : "▸"} Консоль игры {lines.length > 0 && `(${lines.length})`}
        </button>
        {open && (
          <button className="link-button" onClick={onClear}>
            Очистить
          </button>
        )}
      </div>
      {open && (
        <div className="console-body">
          {lines.length === 0 && <div className="muted">Пока пусто. Здесь появится вывод игры.</div>}
          {lines.map((line, index) => (
            <div key={index} className={line.error ? "log-line error" : "log-line"}>
              {line.line}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
