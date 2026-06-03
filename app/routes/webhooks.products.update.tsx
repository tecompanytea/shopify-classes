import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mirrors Shopify product metadata without changing the internal event name.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productGid = `gid://shopify/Product/${(payload as { id: number }).id}`;
  const title = (payload as { title?: string }).title;
  const status = (payload as { status?: string }).status?.toLowerCase();

  if (!title) return new Response();

  await db.classProduct.updateMany({
    where: { shop, productGid },
    data: {
      productTitle: title,
      ...(status ? { status } : {}),
    },
  });

  return new Response();
};
