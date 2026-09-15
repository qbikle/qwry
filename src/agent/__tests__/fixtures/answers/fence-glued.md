The shape peek found is: ```json
{"tier": "signature", "since": "2026-04-02"}
```

An untagged fence still holds the query, so it belongs to the SQL row, not the text:

```
SELECT tier, COUNT(*) FROM customer GROUP BY 1
```

Signature is 3.1% of customers and 19% of revenue.
