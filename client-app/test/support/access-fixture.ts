/** Standalone policy evidence; it does not adopt access rules in the application. */
export const accessFixture = `// use prisma-8
/// @access(read: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR, READONLY])
/// @access(manageTeam: [OWNER, ADMIN])
/// @access(inviteMembers: [OWNER, ADMIN])
/// @access(changeMemberRoles: [OWNER, ADMIN])
/// @access(removeMembers: [OWNER, ADMIN])
/// @access(createProject: [OWNER, ADMIN])
/// @access(createChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR])
/// @access(acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER])
/// @access(answerQuestion: [OWNER, ADMIN, MANAGER, REVIEWER])
/// @access(setTaskStatus: [OWNER, ADMIN, MANAGER, REVIEWER])
/// @access(markReviewed: [OWNER, ADMIN, MANAGER, REVIEWER])
/// @access(uploadFiles: [OWNER, ADMIN, MANAGER])
enum ProjectRole {
  OWNER       = "OWNER" /// @access(protected)
  ADMIN       = "ADMIN"
  MANAGER     = "MANAGER"
  REVIEWER    = "REVIEWER"
  CONTRIBUTOR = "CONTRIBUTOR"
  READONLY    = "READONLY"
}
enum MemberStatus {
  ACTIVE = "ACTIVE"
  INVITED = "INVITED"
  REMOVED = "REMOVED"
}
enum InvitationStatus {
  PENDING = "PENDING"
  ACCEPTED = "ACCEPTED"
  DECLINED = "DECLINED"
  REVOKED = "REVOKED"
}
enum ProjectStatus {
  DRAFT = "DRAFT"
  ACTIVE = "ACTIVE"
}
enum PrivateStatus {
  INACTIVE = "INACTIVE"
  ACTIVE = "ACTIVE"
}
/// @access(read, update(firstName): isMe(id))
/// @access(read(id, email, firstName): memberships.read)
/// @access(fields(privateStatus), read: isMe(id), readonly)
model User {
  id String @id
  email String @unique
  firstName String
  privateStatus PrivateStatus @default(INACTIVE)
  memberships TeamMember[]
  notes Note[]
}
/// @access(roles: memberships[isMe(userId) && membershipStatus == ACTIVE].role)
model Team {
  id String @id
  memberships TeamMember[]
  invitations TeamInvitation[]
  projects Project[]
}
/// @access(read: team.member || isMe(userId))
model TeamMember {
  id String @id
  teamId String
  userId String
  role ProjectRole /// @access(write: team.changeMemberRoles && !isMe(userId) && membershipStatus == ACTIVE)
  membershipStatus MemberStatus
  team Team @relation(fields: [teamId], references: [id])
  user User @relation(fields: [userId], references: [id])
  @@unique([teamId, userId])
}
/// @access(read: email == auth.email || team.inviteMembers)
/// @access(create: team.inviteMembers && email != auth.email)
model TeamInvitation {
  id String @id
  teamId String
  email String
  role ProjectRole
  /// @access(PENDING -> ACCEPTED | DECLINED: email == auth.email)
  status InvitationStatus /// @access(PENDING -> REVOKED: team.inviteMembers)
  team Team @relation(fields: [teamId], references: [id])
}
/// @access(from: team, only: [read])
/// @access(deny read: status == DRAFT && !createProject)
/// @access(command saveProjectDraft, update(title): createProject && status == DRAFT)
model Project {
  id String @id
  teamId String
  title String
  status ProjectStatus /// @access(readonly)
  team Team @relation(fields: [teamId], references: [id])
  files ProjectFile[]
}
/// @access(from: project)
model ProjectFile {
  id String @id
  projectId String
  title String
  project Project @relation(fields: [projectId], references: [id])
}
/// @access(read: isMe(ownerId))
model Note {
  id String @id
  ownerId String
  name String
  owner User @relation(fields: [ownerId], references: [id])
}
`;
