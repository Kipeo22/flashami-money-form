export type Person = {
  id: string;
  name: string;
};

export type ExpenseTarget = { type: 'operations' } | { type: 'members'; members: Person[] };

export type Expense = {
  id: string;
  event: Pick<EventRecord, 'id' | 'name'>;
  createdAt: string;
  guildId: string;
  channelId: string;
  submittedBy: Person;
  payer: Person;
  target: ExpenseTarget;
  item: string;
  amountYen: number;
  receiptFileId: string;
  receiptUrl: string;
  receiptName: string;
};

export type EventRecord = {
  id: string;
  name: string;
  initialBudgetYen: number;
  discordGuildId: string;
  discordChannelId: string;
  operationsRoleId: string;
  driveFolderId: string;
  spreadsheetId: string;
  status: 'active' | 'archived';
  createdAt: string;
};

export type CreateEventInput = Pick<
  EventRecord,
  | 'name'
  | 'initialBudgetYen'
  | 'discordGuildId'
  | 'discordChannelId'
  | 'operationsRoleId'
  | 'spreadsheetId'
>;

export type SettlementTransfer = {
  from: Person;
  to: Person;
  amountYen: number;
};

export type Aggregation = {
  transfers: SettlementTransfer[];
  operationsSpentYen: number;
};
