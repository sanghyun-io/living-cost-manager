import type { WorkspaceMemberDto, InvitationRole } from "@living-cost-manager/shared";
import { Badge, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { invitationRoleLabels, workspaceRoleLabels } from "../../lib/sharing";
import type { SharingProps } from "../../lib/pageTypes";

export function SharingPanel({
  serverSession,
  members,
  invitations,
  sentInvitations,
  acceptTokens,
  inviteEmail,
  inviteRole,
  visibleCreatedInvitation,
  canManageCurrentWorkspace,
  isServerBusy,
  onAcceptTokenChange,
  onAcceptInvitation,
  onRefreshSharing,
  onCreateInvitation,
  onInviteEmailChange,
  onInviteRoleChange,
  onUpdateMemberRole,
  onDeleteMember,
  onRevokeInvitation
}: SharingProps) {
  const hasPendingInvitations = invitations.length > 0;

  return (
    <>
      {serverSession && hasPendingInvitations ? (
        <Stack gap="xs" mt="md">
          <Text className="section-label" size="xs">받은 초대</Text>
          {invitations.map((invitation) => (
            <Group key={invitation.id} gap="xs" align="flex-end" wrap="nowrap">
              <div style={{ flex: 1 }}>
                <Text fw={700} size="sm">{invitation.email}</Text>
                <Text size="xs" c="dimmed">{invitationRoleLabels[invitation.role]}</Text>
              </div>
              <TextInput
                aria-label="초대 토큰"
                placeholder="토큰"
                size="xs"
                value={acceptTokens[invitation.id] ?? ""}
                onChange={(event) => onAcceptTokenChange(invitation.id, event.currentTarget.value)}
              />
              <Button variant="default" size="xs" disabled={isServerBusy} onClick={() => onAcceptInvitation(invitation.id)}>수락</Button>
            </Group>
          ))}
        </Stack>
      ) : null}

      {serverSession?.workspace ? (
        <details style={{ marginTop: 16 }} open={hasPendingInvitations}>
          <summary style={{ cursor: "pointer", fontSize: "0.875rem", fontWeight: 600, padding: "8px 0" }}>
            공유 관리
          </summary>
          <Stack gap="xs" mt="xs" aria-label="공유 관리">
            <Group justify="space-between">
              <Text size="xs" c="dimmed">멤버와 초대</Text>
              <Button variant="subtle" size="xs" disabled={isServerBusy} onClick={onRefreshSharing}>새로고침</Button>
            </Group>

            {members.map((member) => (
              <Group key={member.id} gap="xs" align="flex-end" wrap="nowrap">
                <div style={{ flex: 1 }}>
                  <Text fw={700} size="sm">{member.name}</Text>
                  <Text size="xs" c="dimmed">{member.email}</Text>
                </div>
                {canManageCurrentWorkspace ? (
                  <Select
                    aria-label="멤버 권한"
                    size="xs"
                    w={100}
                    allowDeselect={false}
                    value={member.role}
                    data={(["owner", "editor", "viewer"] as const).map((role) => ({ value: role, label: workspaceRoleLabels[role] }))}
                    onChange={(value) => onUpdateMemberRole(member.id, (value ?? member.role) as WorkspaceMemberDto["role"])}
                  />
                ) : (
                  <Badge variant="light" size="sm">{workspaceRoleLabels[member.role]}</Badge>
                )}
                {canManageCurrentWorkspace ? (
                  <Button variant="subtle" color="rose" size="xs" disabled={isServerBusy} onClick={() => onDeleteMember(member.id)}>제거</Button>
                ) : null}
              </Group>
            ))}

            {canManageCurrentWorkspace && sentInvitations.length > 0 ? (
              <Stack gap="xs" aria-label="보낸 초대">
                <Text className="section-label" size="xs">보낸 초대</Text>
                {sentInvitations.map((invitation) => (
                  <Group key={invitation.id} gap="xs" align="flex-end" wrap="nowrap">
                    <div style={{ flex: 1 }}>
                      <Text fw={700} size="sm">{invitation.email}</Text>
                      <Text size="xs" c="dimmed">{invitationRoleLabels[invitation.role]} · 대기</Text>
                    </div>
                    <Button variant="subtle" color="rose" size="xs" disabled={isServerBusy} onClick={() => onRevokeInvitation(invitation.id)}>취소</Button>
                  </Group>
                ))}
              </Stack>
            ) : null}

            {canManageCurrentWorkspace ? (
              <Group gap="xs" align="flex-end" mt="xs">
                <TextInput
                  label="초대 이메일"
                  type="email"
                  size="xs"
                  style={{ flex: 1 }}
                  value={inviteEmail}
                  onChange={(event) => onInviteEmailChange(event.currentTarget.value)}
                />
                <Select
                  label="권한"
                  size="xs"
                  w={100}
                  allowDeselect={false}
                  value={inviteRole}
                  data={(["viewer", "editor"] as const).map((role) => ({ value: role, label: invitationRoleLabels[role] }))}
                  onChange={(value) => onInviteRoleChange((value ?? inviteRole) as InvitationRole)}
                />
                <Button variant="default" size="xs" disabled={isServerBusy} onClick={onCreateInvitation}>초대</Button>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">변경은 소유자만 할 수 있습니다.</Text>
            )}

            {visibleCreatedInvitation?.token ? (
              <Group gap="xs" align="flex-end" mt="xs">
                <TextInput
                  label="초대 토큰"
                  readOnly
                  size="xs"
                  style={{ flex: 1 }}
                  value={visibleCreatedInvitation.token}
                />
                <Button variant="default" size="xs" onClick={() => void navigator.clipboard?.writeText(visibleCreatedInvitation.token ?? "")}>복사</Button>
              </Group>
            ) : null}
          </Stack>
        </details>
      ) : null}
    </>
  );
}
