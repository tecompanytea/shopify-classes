import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productGid = `gid://shopify/Product/${(payload as { id: number }).id}`;
  await db.classProduct.deleteMany({ where: { shop, productGid } });

  return new Response();
};
