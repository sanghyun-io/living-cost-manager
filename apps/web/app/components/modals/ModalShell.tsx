import type { ReactNode } from "react";
import { Modal, Stack, Text } from "@mantine/core";

interface ModalShellProps {
  opened: boolean;
  /** Small uppercase label above the title (e.g. "관리", "클라우드"). */
  sectionLabel: string;
  title: string;
  /** Wider modals (e.g. data management) pass "lg". Default "md". */
  size?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared modal chrome built on Mantine <Modal>. Esc / backdrop click / close
 * button are handled by Mantine itself — the Home component no longer needs a
 * keydown effect.
 */
export function ModalShell({ opened, sectionLabel, title, size = "md", onClose, children }: ModalShellProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={size}
      centered
      radius="md"
      title={
        <div>
          <Text className="section-label" size="xs">
            {sectionLabel}
          </Text>
          <Text fw={700} size="lg">
            {title}
          </Text>
        </div>
      }
    >
      <Stack gap="md">{children}</Stack>
    </Modal>
  );
}
