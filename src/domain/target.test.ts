import { describe, expect, it } from 'vitest';

import { classifyTargets } from './target.js';

const alice = { id: '1', name: 'Alice' };
const operationsRoleId = 'operations';

describe('classifyTargets', () => {
  it('treats members as a personal settlement target', () => {
    expect(classifyTargets([alice], [], operationsRoleId)).toEqual({
      type: 'members',
      members: [alice],
    });
  });

  it('treats the operations role as a shared-budget target', () => {
    expect(classifyTargets([], [operationsRoleId], operationsRoleId)).toEqual({
      type: 'operations',
    });
  });

  it('rejects mixing operations and members', () => {
    expect(() => classifyTargets([alice], [operationsRoleId], operationsRoleId)).toThrow(
      '@運営 と参加者は同時に選択できません',
    );
  });

  it('rejects roles other than operations', () => {
    expect(() => classifyTargets([], ['another-role'], operationsRoleId)).toThrow(
      '指定された @運営 ロールだけ',
    );
  });
});
