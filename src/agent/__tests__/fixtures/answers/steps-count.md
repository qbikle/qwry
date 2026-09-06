**Comment on `order_v2`:**

> One row per checkout attempt, failed included.

So a bare count is attempts, not orders. Counting the orders placed is two steps:

1. Drop the `failed` rows.
2. Bucket the rest by `created_at`. `paid_at` lands days later for COD.
