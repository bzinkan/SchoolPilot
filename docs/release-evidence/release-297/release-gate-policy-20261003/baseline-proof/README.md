# Production-image and synthetic baseline custody

All 481 freshly compiled runtime JS/JSON files match the actual captured production image. The pinned source synthetic schema has 44 migration identities and 121 forced tenant policies. A second native schema restore verifies all 140 base tables are empty. This proves local source/image/schema custody, not actual production catalog, adoption, capacity or backups. The failed first verifier attempt remains preserved. The original preparation script is retained outside the checkout and identified by hash.
