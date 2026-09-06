August had 2,763 orders, about 8% ahead of July.

```sql
SELECT COUNT(*) AS orders
FROM order_v2
WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01'
```

Assumptions: "Last month" means August 2026; "orders" counted by created_at
