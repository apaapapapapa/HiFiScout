# Database Schema

The database reference is generated from the same D1 migrations used by the application.

[Open the generated SchemaSpy database documentation](/db/index.html)

## How it is generated

1. `wrangler d1 migrations apply DB --local` applies every pending migration to the local D1 database.
2. HiFiScout locates Wrangler's resulting SQLite database.
3. SchemaSpy connects through the Xerial SQLite JDBC driver and generates tables, columns, indexes, relationships, and diagrams.
4. VitePress copies the generated SchemaSpy site into the developer documentation artifact.

This keeps `migrations/*.sql` as the schema source of truth. No production D1 credentials or production data are required for documentation generation.

## Command

Docker is required for SchemaSpy generation.

```sh
npm run docs:db
```
