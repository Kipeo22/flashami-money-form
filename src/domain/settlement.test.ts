import { describe, expect, it } from 'vitest';

import { aggregateExpenses } from './settlement.js';
import type { Expense, Person } from './types.js';

const alice = person('1', 'Alice');
const bob = person('2', 'Bob');
const carol = person('3', 'Carol');

describe('aggregateExpenses', () => {
  it('splits a personal expense equally and excludes the payer share', () => {
    const result = aggregateExpenses([expense('e1', alice, 300, [alice, bob, carol])]);

    expect(result.transfers).toEqual([
      { from: bob, to: alice, amountYen: 100 },
      { from: carol, to: alice, amountYen: 100 },
    ]);
  });

  it('assigns one-yen remainders in user id order', () => {
    const result = aggregateExpenses([expense('e1', alice, 100, [bob, carol, alice])]);

    expect(result.transfers.reduce((total, transfer) => total + transfer.amountYen, 0)).toBe(66);
    expect(result.transfers).toEqual([
      { from: bob, to: alice, amountYen: 33 },
      { from: carol, to: alice, amountYen: 33 },
    ]);
  });

  it('counts operations expenses without adding personal transfers', () => {
    const operationsExpense: Expense = {
      ...expense('e1', alice, 5_000, [bob]),
      target: { type: 'operations' },
    };

    expect(aggregateExpenses([operationsExpense])).toEqual({
      transfers: [],
      operationsSpentYen: 5_000,
    });
  });

  it('nets expenses before creating transfers', () => {
    const result = aggregateExpenses([
      expense('e1', alice, 1_000, [bob]),
      expense('e2', bob, 400, [alice]),
    ]);

    expect(result.transfers).toEqual([{ from: bob, to: alice, amountYen: 600 }]);
  });
});

function person(id: string, name: string): Person {
  return { id, name };
}

function expense(id: string, payer: Person, amountYen: number, targets: Person[]): Expense {
  return {
    id,
    event: { id: 'event', name: '旅行' },
    createdAt: '2026-08-29T00:00:00.000Z',
    guildId: 'guild',
    channelId: 'channel',
    submittedBy: payer,
    payer,
    target: { type: 'members', members: targets },
    item: 'test',
    amountYen,
    receiptFileId: 'file',
    receiptUrl: 'https://example.com/file',
    receiptName: 'receipt.jpg',
  };
}
