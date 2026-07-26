require("dotenv").config();
const bcrypt = require("bcryptjs");
const { query, pool } = require("./pool");

async function seed() {
  const email = process.env.ADMIN_EMAIL || "admin@loanconnect.ai";
  const password = process.env.ADMIN_PASSWORD || "Admin@123";

  // The default password is public knowledge (it's in this repo). Never seed it into a
  // production database — require an explicit ADMIN_PASSWORD instead.
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
    console.error("Refusing to seed default admin password in production. Set ADMIN_PASSWORD and re-run.");
    process.exit(1);
  }

  const existing = await query(`SELECT id FROM users WHERE email=$1`, [email]);
  if (existing.rows.length) {
    console.log("Admin already exists");
    return;
  }

  const tenant = await query(
    `INSERT INTO tenants (name, plan_type) VALUES ($1,$2) RETURNING *`,
    ["LoanConnect Admin", "enterprise"]
  );

  const hash = bcrypt.hashSync(password, 10);

  await query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.rows[0].id, "Platform Admin", email, hash, "platform_admin"]
  );

  await query(
    `INSERT INTO campaigns (tenant_id, name, description, campaign_type, playbook_type, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenant.rows[0].id, "KYC Retargeting Demo", "Demo campaign", "RETARGETING", "UNAPPROVED_USERS", "draft"]
  );

  console.log(`Seeded admin: ${email} / ${password}`);
}

seed().then(() => pool.end()).catch(err => {
  console.error(err);
  pool.end();
  process.exit(1);
});
