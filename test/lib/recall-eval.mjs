/**
 * A small, fixed recall eval: 30 notes and 40 queries with a known right answer.
 *
 * It exists to turn "search feels worse/better" into a number. The queries are
 * deliberately not all winnable — plurals, tag-only terms, body-only terms and
 * synonyms are here so the baseline shows where search misses today, and any
 * later change to `src/search.mjs` can be judged against it. Nothing asserts on
 * the scores; `test/bench.mjs` prints them.
 */

const note = (n, title, desc, tags, body) => ({
  id: `n${String(n).padStart(2, '0')}`,
  title,
  desc,
  tags,
  body,
  kind: 'gotcha',
  scope: 'project',
  created: '2026-09-01T00:00:00.000Z',
  updated: '2026-09-01T00:00:00.000Z',
  reads: 0,
  pinned: false,
  archived: false,
});

export const NOTES = [
  note(1, 'Pagination is cursor-based, never offset', 'Offset pagination skips rows under concurrent writes', ['api', 'pagination'], 'The list endpoints return an opaque next cursor; passing page numbers returns 400.'),
  note(2, 'Windows CI runners check out CRLF', 'Frontmatter assertions on a newline fail only on windows', ['ci', 'windows'], 'core.autocrlf=true on windows-latest converts line endings; normalise before comparing.'),
  note(3, 'Run migrations before seeding the database', 'Seed scripts assume the schema exists', ['database', 'migrations'], 'npm run migrate then npm run seed; the other order fails with relation does not exist.'),
  note(4, 'Never import from dist in tests', 'Tests run against src through the loader', ['testing', 'build'], 'Importing dist hides type errors because dist is stale until the build runs.'),
  note(5, 'Rate limiter keys on API token, not IP', 'Office NAT shared one address and tripped the limit', ['api', 'ratelimit'], 'Use the token hash as the bucket key; fall back to IP only for anonymous routes.'),
  note(6, 'Feature flags live in config/flags.json', 'Flags are read at boot, restart to change', ['config', 'flags'], 'There is no hot reload. Flip the flag, redeploy, verify in staging first.'),
  note(7, 'Use pnpm, not npm, in the monorepo', 'The lockfile is pnpm-lock.yaml', ['tooling', 'monorepo'], 'npm install creates a second lockfile and breaks workspace linking.'),
  note(8, 'Stripe webhooks must verify the signature', 'Unsigned events were accepted in the first version', ['payments', 'security'], 'Use the raw request body for verification; parsed JSON changes the bytes.'),
  note(9, 'Cache invalidation happens on write, not read', 'Reads never evict; writes publish an invalidation message', ['cache', 'redis'], 'The channel cache:invalidate carries the key prefix.'),
  note(10, 'Dates are stored in UTC, rendered in the viewer zone', 'Never store local time', ['dates', 'i18n'], 'Convert at the edge with Intl.DateTimeFormat; the database column is timestamptz.'),
  note(11, 'Logging must never include request bodies', 'Bodies carry personal data', ['logging', 'privacy'], 'Log the route and the status; use the request id to correlate.'),
  note(12, 'The staging database is reset every night', 'Do not keep manual test data there', ['staging', 'database'], 'A cron job restores the snapshot at 03:00 UTC.'),
  note(13, 'Retry only idempotent requests', 'Retrying a POST charged customers twice', ['http', 'reliability'], 'Attach an idempotency key before enabling retries on anything that writes.'),
  note(14, 'Image uploads go straight to object storage', 'Presigned URLs keep large files off the API', ['uploads', 'storage'], 'The API only records the object key after the client confirms the upload.'),
  note(15, 'Websocket connections need a heartbeat', 'Idle proxies drop connections after sixty seconds', ['websocket', 'networking'], 'Send a ping every 25 seconds and reconnect with backoff.'),
  note(16, 'ESLint runs on staged files only', 'Full-repo lint takes four minutes', ['lint', 'hooks'], 'lint-staged is configured in package.json; --no-verify bypasses it.'),
  note(17, 'Docker builds must pin the base image digest', 'Latest tag broke the build twice', ['docker', 'ci'], 'Renovate bumps the digest weekly in a PR.'),
  note(18, 'Error messages are translation keys', 'Never concatenate user-facing strings', ['i18n', 'ui'], 'Keys live in locales/en.json; add the key before using it.'),
  note(19, 'Search results are capped at fifty', 'Larger pages timed out the database', ['search', 'performance'], 'The cap is enforced in the repository layer, not the controller.'),
  note(20, 'Auth tokens expire after fifteen minutes', 'Refresh tokens last thirty days', ['auth', 'security'], 'The client refreshes silently on a 401 and replays the request once.'),
  note(21, 'The mobile app pins the API version header', 'Old clients break on response shape changes', ['mobile', 'api'], 'Bump X-Api-Version only with a compatibility shim for the previous one.'),
  note(22, 'Background jobs must be safe to run twice', 'The queue delivers at least once', ['queue', 'reliability'], 'Guard side effects with a processed-ids table.'),
  note(23, 'Use the shared Button component', 'Raw button elements skip focus styling', ['ui', 'accessibility'], 'Import Button from @app/ui; it handles disabled and loading states.'),
  note(24, 'Secrets come from the vault, never the repo', 'Env files are for local development only', ['secrets', 'security'], 'Production reads from vault at boot using the workload identity.'),
  note(25, 'Database indexes are added concurrently', 'A blocking index build locked the orders table', ['database', 'performance'], 'Use CREATE INDEX CONCURRENTLY and run it outside a transaction.'),
  note(26, 'Snapshot tests are banned for components', 'They hid real regressions behind noise', ['testing', 'ui'], 'Assert on roles and text with testing-library instead.'),
  note(27, 'The monorepo builds with turbo caching', 'Remote cache is shared between CI and laptops', ['build', 'monorepo'], 'Clear it with turbo --force when a cache poisons a build.'),
  note(28, 'CORS origins are an allow list in config', 'Wildcard origins are rejected in production', ['cors', 'security'], 'Add new frontends to config/cors.json and redeploy.'),
  note(29, 'Email sending goes through the outbox table', 'Direct SMTP calls lost messages on crashes', ['email', 'reliability'], 'A worker drains the outbox every ten seconds.'),
  note(30, 'Currency amounts are integers in minor units', 'Floats rounded one tenth plus two tenths wrongly', ['payments', 'data'], 'Store cents as integers; format only at the display layer.'),
];

/** [query, expected note id, what kind of match it is]. */
export const QUERIES = [
  // words that are in the title
  ['pagination cursor', 'n01', 'title'],
  ['migrations seeding', 'n03', 'title'],
  ['rate limiter', 'n05', 'title'],
  ['stripe webhooks signature', 'n08', 'title'],
  ['feature flags', 'n06', 'title'],
  ['pnpm monorepo', 'n07', 'title'],
  ['heartbeat websocket', 'n15', 'title'],
  ['idempotent retry', 'n13', 'title'],
  ['docker base image digest', 'n17', 'title'],
  ['currency integers', 'n30', 'title'],
  ['outbox email', 'n29', 'title'],
  ['cors allow list', 'n28', 'title'],
  ['turbo caching', 'n27', 'title'],
  ['utc viewer', 'n10', 'title'],
  // plurals, tenses and stems of title words
  ['cursors', 'n01', 'stem'],
  ['webhook', 'n08', 'stem'],
  ['migrating', 'n03', 'stem'],
  ['flag', 'n06', 'stem'],
  ['retries', 'n13', 'stem'],
  ['indexing', 'n25', 'stem'],
  ['snapshots', 'n26', 'stem'],
  ['tokens expire', 'n20', 'stem'],
  // only the tags say it
  ['tag:ratelimit', 'n05', 'tag'],
  ['redis', 'n09', 'tag'],
  ['tag:privacy', 'n11', 'tag'],
  ['accessibility', 'n23', 'tag'],
  ['queue', 'n22', 'tag'],
  // only the description says it
  ['NAT', 'n05', 'desc'],
  ['sixty seconds', 'n15', 'desc'],
  ['four minutes', 'n16', 'desc'],
  ['customers twice', 'n13', 'desc'],
  ['locked orders', 'n25', 'desc'],
  // only the body says it
  ['workload identity', 'n24', 'body'],
  ['03:00', 'n12', 'body'],
  ['testing-library', 'n26', 'body'],
  ['processed-ids', 'n22', 'body'],
  ['object key', 'n14', 'body'],
  // different words for the same idea
  ['throttling', 'n05', 'synonym'],
  ['timezone', 'n10', 'synonym'],
  ['websockets keepalive', 'n15', 'synonym'],
];
