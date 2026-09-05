import { describe, expect, it } from 'vitest';

import { commandDefinitions } from './commands.js';

describe('Discord commands', () => {
  it('allows participants to open the expense modal directly', () => {
    const command = commandDefinitions.find(({ name }) => name === '支出登録');

    expect(command).toMatchObject({
      name: '支出登録',
      description: '支出登録フォームを開きます',
    });
    expect(command?.default_member_permissions).toBeUndefined();
    expect(commandDefinitions.some(({ name }) => name === '支出フォーム')).toBe(false);
    expect(commandDefinitions.some(({ name }) => name === '集計更新')).toBe(false);
    expect(commandDefinitions).toHaveLength(1);
  });
});
