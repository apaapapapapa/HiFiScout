# Database Schema

The database reference is generated from the same D1 migrations used by the application.

<a href="../db/index.html" target="_self">Open the generated SchemaSpy database documentation</a>

## How it is generated

1. Wrangler applies every migration to an isolated local D1 state directory created only for documentation generation.
2. HiFiScout identifies the migrated application database by its required tables and checkpoints committed WAL pages into the SQLite database file.
3. SchemaSpy analyzes a disposable copy through the Xerial SQLite JDBC driver and generates tables, columns, indexes, relationships, and diagrams.
4. VitePress copies the generated SchemaSpy site into the developer documentation artifact.

This keeps `migrations/*.sql` as the schema source of truth. No production D1 credentials, production data, or pre-existing local D1 state are required for documentation generation.

## Command

Docker is required for SchemaSpy generation.

```sh
npm run docs:db
```
