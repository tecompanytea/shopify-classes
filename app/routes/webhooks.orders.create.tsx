import type { ActionFunctionArgs } from "react-router";

import { upsertClassBookingsFromOrderWebhook } from "../lib/class-bookings.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await upsertClassBookingsFromOrderWebhook(shop, payload);

  return new Response();
};
