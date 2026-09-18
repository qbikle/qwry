The spike is one migration, not growth:

- 2,949,786 rows land on 2026-08-14 between 10:30 and 11:05, all from batch `t1-01`.
- Every one carries schema v2, so the writer was the backfill, not the app.
- Ordinary days sit near 12.4k rows, +3.5% month over month.
- The backfill cost 1,861.9 ms per 1k rows and ran 4.5x slower than the live path.
