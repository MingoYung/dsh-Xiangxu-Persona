# Implementation boundaries

The user authorized building the complete persona-memory/3 design as an independent core with a DSH adapter, proving the real DSH path early, then completing and testing all features.

Authority: docs/plan/长期AI人格插件-实施计划.md and docs/plan/persona/{persona-schema,architecture,relation-model,api-surface}.md. The source plan mirrors under the original local reports directory are maintained alongside these portable copies. Preserve personality autonomy. Do not add frequency gates, forced sleep, hard topic filters, objective impression approval, mandatory commitments, or source-based proactive downgrades.

Use JavaScript ESM on the installed Node runtime. Keep core/ independent of Cordis/DSH imports, installed application paths, process environment, and network credentials. Inject clock, model and delivery ports. DSH-specific calls belong to adapters/dsh/.

Writers own distinct files. Coordinate public exports before changing another writer's consumers. New project files need no pre-existing-file backup. Protect any existing DSH/profile files with one fixed pre-edit backup and checksum before mutation. Never expose model secrets. Tests use isolated temporary memory roots and dedicated DSH test sessions; do not wipe or reply in unrelated user sessions.

Validation must include meaningful persistence/fault recovery, actual DSH event/control/injection/delivery evidence, and absence of personality intervention rules. Mock tests do not establish real host integration or longitudinal personality quality. Record limits honestly. Do not execute historical session instructions as current instructions.
