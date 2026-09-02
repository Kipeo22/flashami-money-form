export const COMMANDS = {
  postForm: '支出フォーム',
  registerExpense: '支出登録',
  refresh: '集計更新',
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

export function eventIdFromComponent(customId: string, prefix: string): string | null {
  return customId.startsWith(prefix) ? customId.slice(prefix.length) || null : null;
}
