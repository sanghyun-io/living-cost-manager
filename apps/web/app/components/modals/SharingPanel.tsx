import type { WorkspaceMemberDto, InvitationRole } from "@living-cost-manager/shared";
import { Badge, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { invitationRoleLabels, workspaceRoleLabels } from "../../lib/sharing";
import type { SharingProps } from "../../lib/pageTypes";

export function SharingPanel({
  serverSession,
  members,
  invitations,
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
  onDeleteMember
}: SharingProps) {
  return (
    <>
      {serverSession && invitations.length > 0 ? (
        <Stack gap="xs" mt="md">
          <Text className="section-label" size="xs">받은 초대</Text>
          <Text fw={700} size="sm">대기 중인 초대</Text>
          {invitations.map((invitation) => (
            <Group key={invitation.id} gap="xs" align="flex-end" wrap="nowrap">
              <div style={{ flex: 1 }}>
                <Text fw={700} size="sm">{invitation.email}</Text>
                <Text size="xs" c="dimmed">{invitationRoleLabels[invitation.role]} · {invitation.id}</Text>
              </div>
              <TextInput
                aria-label="초대 토큰"
                placeholder="초대 토큰"
                value={acceptTokens[invitation.id] ?? ""}
                onChange={(event) => onAcceptTokenChange(invitation.id, event.currentTarget.value)}
              />
              <Button variant="default" size="xs" disabled={isServerBusy} onClick={() => onAcceptInvitation(invitation.id)}>
                수락
              </Button>
            </Group>
          ))}
        </Stack>
      ) : null}

      {serverSession?.workspace ? (
        <Stack gap="xs" mt="md" aria-label="공유 관리">
          <Group justify="space-between">
            <div>
              <Text className="section-label" size="xs">공유 관리</Text>
              <Text fw={700} size="sm">멤버와 초대</Text>
            </div>
            <Button variant="default" size="xs" disabled={isServerBusy} onClick={onRefreshSharing}>
              새로고침
            </Button>
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
                  w={110}
                  allowDeselect={false}
                  value={member.role}
                  data={(["owner", "editor", "viewer"] as const).map((role) => ({ value: role, label: workspaceRoleLabels[role] }))}
                  onChange={(value) => onUpdateMemberRole(member.id, (value ?? member.role) as WorkspaceMemberDto["role"])}
                />
              ) : (
                <Badge variant="light">{workspaceRoleLabels[member.role]}</Badge>
              )}
              {canManageCurrentWorkspace ? (
                <Button variant="subtle" color="rose" size="xs" disabled={isServerBusy} onClick={() => onDeleteMember(member.id)}>
                  제거
                </Button>
              ) : null}
            </Group>
          ))}

          {canManageCurrentWorkspace ? (
            <Group gap="xs" align="flex-end">
              <TextInput
                label="초대 이메일"
                type="email"
                style={{ flex: 1 }}
                value={inviteEmail}
                onChange={(event) => onInviteEmailChange(event.currentTarget.value)}
              />
              <Select
                label="권한"
                w={110}
                allowDeselect={false}
                value={inviteRole}
                data={(["viewer", "editor"] as const).map((role) => ({ value: role, label: invitationRoleLabels[role] }))}
                onChange={(value) => onInviteRoleChange((value ?? inviteRole) as InvitationRole)}
              />
              <Button variant="default" disabled={isServerBusy} onClick={onCreateInvitation}>
                초대 생성
              </Button>
            </Group>
          ) : (
            <Text size="xs" c="dimmed">공유 변경은 소유자만 할 수 있습니다.</Text>
          )}

          {visibleCreatedInvitation?.token ? (
            <Group gap="xs" align="flex-end">
              <TextInput
                label="방금 만든 초대 토큰"
                readOnly
                style={{ flex: 1 }}
                value={visibleCreatedInvitation.token}
              />
              <Button
                variant="default"
                onClick={() => void navigator.clipboard?.writeText(visibleCreatedInvitation.token ?? "")}
              >
                토큰 복사
              </Button>
            </Group>
          ) : null}
        </Stack>
      ) : null}
    </>
  );
}
