import { describe, expect, it } from 'vitest';

import { buildExpenseButtonRow, buildExpenseModal } from './components.js';

describe('event-aware Discord components', () => {
  it('embeds the event id in the button and modal', () => {
    const button = buildExpenseButtonRow('event-1').toJSON();
    const modal = buildExpenseModal('event-1', '夏合宿').toJSON();

    const firstButton = button.components[0];
    expect(firstButton && 'custom_id' in firstButton ? firstButton.custom_id : null).toBe(
      'expense:open:event-1',
    );
    expect(modal.custom_id).toBe('expense:modal:event-1');
    expect(modal.title).toBe('夏合宿｜支出登録');
    expect(
      modal.components.map((component) =>
        component.type === 18 ? component.component.type : null,
      ),
    ).toEqual([5, 7, 4, 4, 19]);
    const receipt = modal.components[4];
    expect(receipt?.type === 18 ? receipt.component : null).toMatchObject({
      min_values: 0,
      max_values: 1,
      required: false,
    });
  });
});
