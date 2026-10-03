"use client";

import { useState, type MouseEvent } from "react";
import { getPieSegmentAtPercent, type CategoryPieSegment } from "./budget";

export type ChartMode = "bar" | "pie";

/**
 * Transient view state for the dashboard: modal visibility, chart display
 * options, table filter/delete selection, and the feedback message shown
 * above the fixed-cost table.
 *
 * Kept separate from domain hooks (users / budget / server) so every piece of
 * "what is currently on screen" lives in one place.
 */
export function useUIState() {
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isCardModalOpen, setIsCardModalOpen] = useState(false);
  const [isDataModalOpen, setIsDataModalOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>("bar");
  const [activePieSegment, setActivePieSegment] = useState<CategoryPieSegment | null>(null);
  const [pieTooltipPosition, setPieTooltipPosition] = useState({ x: 0, y: 0 });
  const [categoryFilterId, setCategoryFilterId] = useState("all");
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<string[]>([]);
  const [importMessage, setImportMessage] = useState("");

  // Pie hover: map the pointer angle to a segment and track tooltip position.
  function handlePieMove(event: MouseEvent<HTMLDivElement>, pieSegments: CategoryPieSegment[]) {
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const angle = Math.atan2(x - centerX, centerY - y);
    const percent = ((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2)) * 100;

    setActivePieSegment(getPieSegmentAtPercent(pieSegments, percent));
    setPieTooltipPosition({ x, y });
  }

  // Category filter changes always clear any pending delete selections.
  function handleFilterChange(categoryId: string) {
    setCategoryFilterId(categoryId);
    setSelectedDeleteIds([]);
  }

  /**
   * Closes the management/data modals (NOT the auth modal). Used by local
   * logout, which historically left isAuthModalOpen untouched.
   */
  function closeDataAndManagementModals() {
    setIsCategoryModalOpen(false);
    setIsCardModalOpen(false);
    setIsDataModalOpen(false);
    setIsDeleteAccountModalOpen(false);
  }

  return {
    isCategoryModalOpen,
    setIsCategoryModalOpen,
    isCardModalOpen,
    setIsCardModalOpen,
    isDataModalOpen,
    setIsDataModalOpen,
    isAuthModalOpen,
    setIsAuthModalOpen,
    isDeleteAccountModalOpen,
    setIsDeleteAccountModalOpen,
    chartMode,
    setChartMode,
    activePieSegment,
    setActivePieSegment,
    pieTooltipPosition,
    handlePieMove,
    categoryFilterId,
    setCategoryFilterId,
    handleFilterChange,
    isDeleteMode,
    setIsDeleteMode,
    selectedDeleteIds,
    setSelectedDeleteIds,
    importMessage,
    setImportMessage,
    closeDataAndManagementModals
  };
}

export type UIStateApi = ReturnType<typeof useUIState>;
