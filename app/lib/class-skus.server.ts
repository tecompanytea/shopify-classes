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

type NormalizeRow = {
  id: string;
  sku: string | null;
  variantGid: string;
  classProduct: { productGid: string };
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

export function buildClassSessionSkuNormalizationPlan(
  rows: NormalizeRow[],
): Array<{
  id: string;
  productGid: string;
  variantGid: string;
  sku: string;
}> {
  const used = new Set<string>();
  let next = CLASS_SESSION_SKU_START;
  const updates: Array<{
    id: string;
    productGid: string;
    variantGid: string;
    sku: string;
  }> = [];

  for (const row of rows) {
    const current = row.sku?.trim() ?? "";
    if (isClassSessionSku(current) && !used.has(current)) {
      used.add(current);
      continue;
    }

    const sku = nextUnusedSku(used, next);
    next = Number(sku) + 1;
    used.add(sku);
    updates.push({
      id: row.id,
      productGid: row.classProduct.productGid,
      variantGid: row.variantGid,
      sku,
    });
  }

  return updates;
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
