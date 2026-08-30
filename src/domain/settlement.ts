import type { Aggregation, Expense, Person, SettlementTransfer } from './types.js';

type Balance = Person & { amountYen: number };

export function aggregateExpenses(expenses: Expense[]): Aggregation {
  const balances = new Map<string, Balance>();
  let operationsSpentYen = 0;

  for (const expense of expenses) {
    if (expense.target.type === 'operations') {
      operationsSpentYen += expense.amountYen;
      continue;
    }

    addBalance(balances, expense.payer, expense.amountYen);

    const members = [...expense.target.members].sort((a, b) => a.id.localeCompare(b.id));
    const baseShare = Math.floor(expense.amountYen / members.length);
    let remainder = expense.amountYen % members.length;

    for (const member of members) {
      const share = baseShare + (remainder > 0 ? 1 : 0);
      remainder -= remainder > 0 ? 1 : 0;
      addBalance(balances, member, -share);
    }
  }

  return {
    transfers: settleBalances([...balances.values()]),
    operationsSpentYen,
  };
}

function addBalance(balances: Map<string, Balance>, person: Person, deltaYen: number): void {
  const current = balances.get(person.id);
  balances.set(person.id, {
    id: person.id,
    name: person.name,
    amountYen: (current?.amountYen ?? 0) + deltaYen,
  });
}

function settleBalances(balances: Balance[]): SettlementTransfer[] {
  const debtors = balances
    .filter((balance) => balance.amountYen < 0)
    .map((balance) => ({ ...balance, amountYen: -balance.amountYen }))
    .sort(byAmountThenId);
  const creditors = balances
    .filter((balance) => balance.amountYen > 0)
    .map((balance) => ({ ...balance }))
    .sort(byAmountThenId);

  const transfers: SettlementTransfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    if (!debtor || !creditor) break;

    const amountYen = Math.min(debtor.amountYen, creditor.amountYen);
    transfers.push({
      from: { id: debtor.id, name: debtor.name },
      to: { id: creditor.id, name: creditor.name },
      amountYen,
    });

    debtor.amountYen -= amountYen;
    creditor.amountYen -= amountYen;
    if (debtor.amountYen === 0) debtorIndex += 1;
    if (creditor.amountYen === 0) creditorIndex += 1;
  }

  return transfers;
}

function byAmountThenId(a: Balance, b: Balance): number {
  return b.amountYen - a.amountYen || a.id.localeCompare(b.id);
}
