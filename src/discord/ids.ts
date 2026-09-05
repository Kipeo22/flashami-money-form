export const COMMANDS = {
  registerExpense: '支出登録',
} as const;

export const COMPONENTS = {
  openExpenseModalPrefix: 'expense:open:',
  expenseModalPrefix: 'expense:modal:',
  payer: 'expense:payer',
  targets: 'expense:targets',
  item: 'expense:item',
  amount: 'expense:amount',
  receipt: 'expense:receipt',
} as const;

export function expenseButtonId(eventId: string): string {
  return `${COMPONENTS.openExpenseModalPrefix}${eventId}`;
}

export function expenseModalId(eventId: string): string {
  return `${COMPONENTS.expenseModalPrefix}${eventId}`;
}

export function expenseModalChannelId(channelId: string): string {
  return `${COMPONENTS.expenseModalPrefix}channel:${channelId}`;
}

export type ExpenseModalContext =
  { type: 'event'; eventId: string } | { type: 'channel'; channelId: string };

export function expenseContextFromModal(customId: string): ExpenseModalContext | null {
  const value = eventIdFromComponent(customId, COMPONENTS.expenseModalPrefix);
  if (!value) return null;
  if (value.startsWith('channel:')) {
    const channelId = value.slice('channel:'.length);
    return channelId ? { type: 'channel', channelId } : null;
  }
  return { type: 'event', eventId: value };
}

export function eventIdFromComponent(customId: string, prefix: string): string | null {
  return customId.startsWith(prefix) ? customId.slice(prefix.length) || null : null;
}
