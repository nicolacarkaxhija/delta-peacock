export interface Item {
  name: string;
  price: number;
  quantity: number;
}

export function total(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function exportCsv(items: Item[]): string {
  return items.map((item) => `${item.name},${String(item.price)}`).join("\n");
}
