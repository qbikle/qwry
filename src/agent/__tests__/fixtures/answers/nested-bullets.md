Three tables carry a customer id, and only one of them is authoritative:

- `order_v2.customer_id` is the id at checkout, never null.
  - It is a FK to `customer.id`.
- `payment.customer_id` is copied at capture and can drift for guest checkouts,
  which is why 41 payments point at a customer that no longer exists.
* `refund.customer_id` is filled by hand and is null for 63% of rows.
