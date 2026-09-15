I found the notification_history table which has a sent_at timestamp. Let me get the monthly breakdown.## Answer

Here are the notification histories added each month in 2026:

| month | notification_count |
|-------|-------------------:|
| 2026-01-01 | 491528 |
| 2026-02-01 | 3062 |
| 2026-08-01 | 2949786 |
| 2026-09-01 | 327759 |

Total: **4,647,023** notifications this year, with a large spike in August.

```sql
SELECT date_trunc('month', sent_at)::date AS month, COUNT(*) AS notification_count
FROM notification_history
WHERE sent_at >= '2026-01-01' AND sent_at < '2027-01-01'
GROUP BY 1
ORDER BY 1
```

Assumptions: "Added" was interpreted as the `sent_at` timestamp, the only timestamp column on the table; "This year" means calendar year 2026
