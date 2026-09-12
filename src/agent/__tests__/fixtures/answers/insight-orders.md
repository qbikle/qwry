**Across 2,763 orders:**

- A prepaid basket averages ₹4,725, a COD basket ₹2,564.
- Failed payments are 22% of attempts, more than every refund and return combined.
- Collected ₹4,266,056 so far, and the COD still in transit would add another 23%.

```sql
SELECT payment_status, COUNT(*) AS orders, SUM(total_amount) AS amount
FROM order_v2
WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01'
GROUP BY 1 ORDER BY 2 DESC
```

Assumptions: Last month = August 2026; Orders = created_at
