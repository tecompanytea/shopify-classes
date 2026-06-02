import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const hasEmbeddedContext =
    Boolean(url.searchParams.get("host")) ||
    url.searchParams.get("embedded") === "1" ||
    Boolean(url.searchParams.get("id_token")) ||
    Boolean(url.searchParams.get("shop"));

  if (hasEmbeddedContext) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.root}>
      <div className={styles.container}>
        <div className={styles.badge}>Internal</div>
        <h1 className={styles.heading}>
          Classes<br />by TE
        </h1>
        <p className={styles.tagline}>
          Turn Shopify products into bookable classes. Generate dated sessions, set capacity, and let Shopify handle checkout.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop.myshopify.com"
                autoComplete="on"
              />
              <button className={styles.button} type="submit">
                Log in
              </button>
            </div>
          </Form>
        )}
        <ul className={styles.features}>
          <li className={styles.feature}>
            <span className={styles.num}>01</span>
            <div>
              <strong>Class = product</strong>
              <span>Pick any existing Shopify product and turn it into a class with a single click.</span>
            </div>
          </li>
          <li className={styles.feature}>
            <span className={styles.num}>02</span>
            <div>
              <strong>Session = variant</strong>
              <span>Generate dated variants in bulk with a single SKU pattern, capacity, and price.</span>
            </div>
          </li>
          <li className={styles.feature}>
            <span className={styles.num}>03</span>
            <div>
              <strong>Checkout = Shopify</strong>
              <span>No separate booking engine. Inventory, orders, and refunds stay in Shopify.</span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}
