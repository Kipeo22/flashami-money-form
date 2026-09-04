import { COMPONENTS, expenseButtonId, expenseModalChannelId, expenseModalId } from './ids.js';

type JsonComponent = Record<string, unknown>;

type JsonBuilder<T extends JsonComponent> = {
  toJSON(): T;
};

export function buildExpenseButtonRow(eventId: string) {
  return builder({
    type: 1,
    components: [
      {
        type: 2,
        custom_id: expenseButtonId(eventId),
        label: '支出を登録',
        emoji: { name: '🧾' },
        style: 1,
      },
    ],
  });
}

export function buildExpenseModal(eventId: string, eventName: string) {
  return buildExpenseModalWithId(expenseModalId(eventId), `${eventName.slice(0, 36)}｜支出登録`);
}

export function buildChannelExpenseModal(channelId: string) {
  return buildExpenseModalWithId(expenseModalChannelId(channelId), '支出登録');
}

function buildExpenseModalWithId(customId: string, title: string) {
  return builder({
    custom_id: customId,
    title,
    components: [
      label('誰が？', '実際に支払いをした人を選択してください', {
        type: 5,
        custom_id: COMPONENTS.payer,
        min_values: 1,
        max_values: 1,
        required: true,
      }),
      label('誰の分？', '参加者、または共通予算から出す場合は @運営 のみを選択', {
        type: 7,
        custom_id: COMPONENTS.targets,
        min_values: 1,
        max_values: 25,
        required: true,
      }),
      label('なにを？', undefined, {
        type: 4,
        custom_id: COMPONENTS.item,
        style: 1,
        placeholder: '例: ガソリン代',
        min_length: 1,
        max_length: 100,
        required: true,
      }),
      label('金額', '日本円の税込総額を入力してください', {
        type: 4,
        custom_id: COMPONENTS.amount,
        style: 1,
        placeholder: '例: 12500',
        min_length: 1,
        max_length: 20,
        required: true,
      }),
      label('レシート（任意）', '画像は最大20 MB、PDFは最大8 MiBまで', {
        type: 19,
        custom_id: COMPONENTS.receipt,
        min_values: 0,
        max_values: 1,
        required: false,
      }),
    ],
  });
}

function label(labelText: string, description: string | undefined, component: JsonComponent) {
  return {
    type: 18,
    label: labelText,
    ...(description ? { description } : {}),
    component,
  };
}

function builder<T extends JsonComponent>(value: T): JsonBuilder<T> {
  return { toJSON: () => value };
}
