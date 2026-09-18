Use `created_at`. The three timestamps mark three different moments, and only one of them is the customer's:

| column | set by | null for |
|---|---|---|
| created_at | checkout | never |
| paid_at | payment webhook | COD in transit |
| shipped_at | warehouse | unshipped |

`created_at` is a `timestamptz`, so a month bucket follows the session time zone: [`date_trunc`](https://www.postgresql.org/docs/current/functions-datetime.html) has the rule.
