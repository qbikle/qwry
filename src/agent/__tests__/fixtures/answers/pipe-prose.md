The status column is a free-text field: values arrive as `paid | pending | failed` and nothing enforces the set.

Nine values appear, and 12 rows hold a string no code writes.

```sql
SELECT DISTINCT payment_status FROM order_v2
```
