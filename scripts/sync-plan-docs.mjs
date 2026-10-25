// Plans are authored and versioned together with runtime contracts.
// The original 0.1.0 one-off mutator is retired so it cannot overwrite later evidence.
// Keep this entry point as a read-only check of all current source-plan documents.
await import('./check-docs.mjs');
