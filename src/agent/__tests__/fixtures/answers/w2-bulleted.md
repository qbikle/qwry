Counted by `sent_at`, the only timestamp on the table. 4.65M this year, 2.95M of it in August.

```sql
SELECT count(*) FROM notification_history
```

**Assumptions:**
- "Added" refers to the sent_at column.
- Deleted users are excluded.
- "This year" means 2026.

---
## Notes
1. The August spike is real.
