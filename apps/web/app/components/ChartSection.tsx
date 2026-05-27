import type { MouseEvent } from "react";
import { getCategoryBuckets, type CategoryPieSegment } from "../lib/budget";
import { chartColors, formatWon } from "../lib/formatting";

type CategoryBucket = ReturnType<typeof getCategoryBuckets>[number];

interface ChartSectionProps {
  chartMode: "bar" | "pie";
  buckets: CategoryBucket[];
  pieSegments: CategoryPieSegment[];
  monthlyExpense: number;
  pieBackground: string;
  activePieSegment: CategoryPieSegment | null;
  pieTooltipPosition: { x: number; y: number };
  onChartModeChange: (mode: "bar" | "pie") => void;
  onPieMove: (event: MouseEvent<HTMLDivElement>) => void;
  onPieLeave: () => void;
}

export function ChartSection({
  chartMode,
  buckets,
  pieSegments,
  monthlyExpense,
  pieBackground,
  activePieSegment,
  pieTooltipPosition,
  onChartModeChange,
  onPieMove,
  onPieLeave
}: ChartSectionProps) {
  return (
    <aside className="diagram" aria-label="카테고리별 고정비 비중">
      <div className="section-heading">
        <div>
          <p className="section-label">도식화</p>
          <h2>카테고리별 비중</h2>
        </div>
        <div className="chart-toggle" aria-label="도식화 보기 방식">
          <button className={chartMode === "bar" ? "active" : undefined} type="button" onClick={() => onChartModeChange("bar")}>
            막대
          </button>
          <button className={chartMode === "pie" ? "active" : undefined} type="button" onClick={() => onChartModeChange("pie")}>
            원형
          </button>
        </div>
      </div>
      {chartMode === "bar" ? (
        <div className="bars">
          {buckets.map((bucket) => (
            <div className="bar-row" key={bucket.categoryId}>
              <div className="bar-meta">
                <span>{bucket.label}</span>
                <strong>{formatWon(bucket.amount)}</strong>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: monthlyExpense > 0 ? String((bucket.amount / monthlyExpense) * 100) + "%" : "0%" }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="pie-layout">
          <div
            className="pie-chart"
            style={{ background: pieBackground }}
            aria-label="카테고리별 원형 차트"
            onMouseLeave={onPieLeave}
            onMouseMove={onPieMove}
          >
            <span>{monthlyExpense > 0 ? "100%" : "0%"}</span>
            {activePieSegment ? (
              <div
                className="pie-tooltip"
                style={{ left: pieTooltipPosition.x, top: pieTooltipPosition.y }}
                role="tooltip"
              >
                <strong>{activePieSegment.label}</strong>
                <span>{formatWon(activePieSegment.amount)}</span>
                <small>{activePieSegment.percent}%</small>
              </div>
            ) : null}
          </div>
          <div className="pie-legend">
            {pieSegments.map((segment, index) => (
              <div
                className={activePieSegment?.categoryId === segment.categoryId ? "pie-legend-row active" : "pie-legend-row"}
                key={segment.categoryId}
              >
                <span className="legend-color" style={{ background: chartColors[index % chartColors.length] }} />
                <span>{segment.label}</span>
                <strong>{segment.percent}%</strong>
                <small>{formatWon(segment.amount)}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
