import type { ExpenseTarget, Person } from './types.js';

export function classifyTargets(
  users: Person[],
  roleIds: string[],
  operationsRoleId: string,
): ExpenseTarget {
  const unexpectedRoles = roleIds.filter((id) => id !== operationsRoleId);
  if (unexpectedRoles.length > 0) {
    throw new TargetSelectionError(
      '対象者には参加者、または指定された @運営 ロールだけを選択してください。',
    );
  }
  if (roleIds.includes(operationsRoleId)) {
    if (users.length > 0) {
      throw new TargetSelectionError(
        '@運営 と参加者は同時に選択できません。どちらか一方にしてください。',
      );
    }
    return { type: 'operations' };
  }
  if (users.length === 0) {
    throw new TargetSelectionError('対象者を1人以上選択してください。');
  }
  return { type: 'members', members: users };
}

export class TargetSelectionError extends Error {}
