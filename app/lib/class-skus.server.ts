import type { Prisma, PrismaClient } from "@prisma/client";

import {
  CLASS_SESSION_SKU_START,
  formatClassSessionSku,
  isClassSessionSku,
} from "./sku";

type PrismaSessionClient = PrismaClient | Prisma.TransactionClient;

type SkuRow = {
  sku: string | null;
};

export async function allocateClassSessionSkus(
  client: PrismaSessionClient,
  shop: string,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];

  const rows = await client.classSession.findMany({
    where: { shop, sku: { startsWith: "62" } },
    select: { sku: true },
  });

  return allocateUnusedSkus(rows, count);
}

function allocateUnusedSkus(rows: SkuRow[], count: number): string[] {
  const used = new Set(
    rows
      .map((row) => row.sku?.trim() ?? "")
      .filter((sku) => isClassSessionSku(sku)),
  );
  let next = CLASS_SESSION_SKU_START;
  const allocated: string[] = [];

  while (allocated.length < count) {
    const sku = nextUnusedSku(used, next);
    next = Number(sku) + 1;
    used.add(sku);
    allocated.push(sku);
  }

  return allocated;
}

function nextUnusedSku(used: Set<string>, startingAt: number): string {
  let value = startingAt;
  let sku = formatClassSessionSku(value);

  while (used.has(sku)) {
    value += 1;
    sku = formatClassSessionSku(value);
  }

  return sku;
}
