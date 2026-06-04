const { pool } = require("../src/db/pool");
const {
  cleanupTestData,
  DEFAULT_TEST_CAMPAIGN_PATTERNS,
  DEFAULT_TEST_PHONES
} = require("../src/services/testDataCleanup");

const DRY_RUN = process.env.CONFIRM_CLEAN_TEST_DATA !== "true";

main()
  .then(() => pool.end())
  .catch(err => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    pool.end();
    process.exitCode = 1;
  });

async function main() {
  const tenantId = process.env.CLEANUP_TENANT_ID;
  if (!tenantId) {
    throw new Error("CLEANUP_TENANT_ID is required for script cleanup. Use the admin API endpoint when running in production.");
  }

  const result = await cleanupTestData({
    tenantId,
    confirm: !DRY_RUN,
    campaignNamePatterns: DEFAULT_TEST_CAMPAIGN_PATTERNS,
    phones: DEFAULT_TEST_PHONES
  });
  console.log(JSON.stringify(result, null, 2));
}
