Coupons sit inside `metadata`, in this shape:

```json
{"coupon": {"code": "FIRST10", "kind": "percent", "value": 10}}
```

1,096 of the August orders carry one.

```sql
SELECT COUNT(*) AS coupon_orders FROM order_v2 WHERE metadata->'coupon'->>'code' IS NOT NULL
```

Assumptions: August = created_at; Coupon = code set
