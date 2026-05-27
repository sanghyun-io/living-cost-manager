import type { WorkspaceMemberDto, InvitationRole } from "@living-cost-manager/shared";
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
        <section className="sharing-block">
          <div>
            <p className="section-label">받은 초대</p>
            <h4>대기 중인 초대</h4>
          </div>
          <div className="sharing-list">
            {invitations.map((invitation) => (
              <div className="invitation-row" key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <small>{invitationRoleLabels[invitation.role]} · {invitation.id}</small>
                </div>
                <input
                  aria-label="초대 토큰"
                  placeholder="초대 토큰"
                  type="text"
                  value={acceptTokens[invitation.id] ?? ""}
                  onChange={(event) => onAcceptTokenChange(invitation.id, event.target.value)}
                />
                <button className="secondary-button" disabled={isServerBusy} type="button" onClick={() => onAcceptInvitation(invitation.id)}>
                  수락
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {serverSession?.workspace ? (
        <section className="sharing-block" aria-label="공유 관리">
          <div className="server-panel-header">
            <div>
              <p className="section-label">공유 관리</p>
              <h4>멤버와 초대</h4>
            </div>
            <button className="secondary-button" disabled={isServerBusy} type="button" onClick={onRefreshSharing}>
              새로고침
            </button>
          </div>

          <div className="sharing-list">
            {members.map((member) => (
              <div className="member-row" key={member.id}>
                <div>
                  <strong>{member.name}</strong>
                  <small>{member.email}</small>
                </div>
                {canManageCurrentWorkspace ? (
                  <select
                    aria-label="멤버 권한"
                    value={member.role}
                    onChange={(event) => onUpdateMemberRole(member.id, event.target.value as WorkspaceMemberDto["role"])}
                  >
                    {(["owner", "editor", "viewer"] as const).map((role) => (
                      <option key={role} value={role}>
                        {workspaceRoleLabels[role]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="role-pill">{workspaceRoleLabels[member.role]}</span>
                )}
                {canManageCurrentWorkspace ? (
                  <button className="ghost-button" disabled={isServerBusy} type="button" onClick={() => onDeleteMember(member.id)}>
                    제거
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          {canManageCurrentWorkspace ? (
            <div className="invite-panel">
              <div className="form-field">
                <label htmlFor="invite-email">초대 이메일</label>
                <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => onInviteEmailChange(event.target.value)} />
              </div>
              <div className="form-field">
                <label htmlFor="invite-role">권한</label>
                <select id="invite-role" value={inviteRole} onChange={(event) => onInviteRoleChange(event.target.value as InvitationRole)}>
                  {(["viewer", "editor"] as const).map((role) => (
                    <option key={role} value={role}>
                      {invitationRoleLabels[role]}
                    </option>
                  ))}
                </select>
              </div>
              <button className="secondary-button" disabled={isServerBusy} type="button" onClick={onCreateInvitation}>
                초대 생성
              </button>
            </div>
          ) : (
            <p className="local-note">공유 변경은 소유자만 할 수 있습니다.</p>
          )}

          {visibleCreatedInvitation?.token ? (
            <div className="created-token">
              <div className="form-field">
                <label htmlFor="created-invitation-token">방금 만든 초대 토큰</label>
                <input id="created-invitation-token" readOnly type="text" value={visibleCreatedInvitation.token} />
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(visibleCreatedInvitation.token ?? "")}
              >
                토큰 복사
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
