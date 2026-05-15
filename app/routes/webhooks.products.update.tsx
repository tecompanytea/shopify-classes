import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mirrors the human-readable title on our ClassProduct row so the list view
// doesn't drift from Shopify after a rename.
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
      title,
      ...(status ? { status } : {}),
    },
  });

  return new Response();
};
