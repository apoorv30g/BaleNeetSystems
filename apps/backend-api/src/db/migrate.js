require("dotenv").config();
const { query, pool } = require("./pool");

async function migrate() {
  await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      plan_type TEXT DEFAULT 'starter',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      campaign_type TEXT DEFAULT 'RETARGETING',
      playbook_type TEXT DEFAULT 'UNAPPROVED_USERS',
      status TEXT DEFAULT 'draft',
      daily_limit INTEGER DEFAULT 200,
      max_attempts INTEGER DEFAULT 3,
      language TEXT DEFAULT 'Hinglish',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

  // Back-fill any rows that pre-date the column (no-op on fresh installs).
  await query(`UPDATE campaigns SET updated_at = created_at WHERE updated_at IS NULL;`);

  // Trigger function that stamps updated_at on every UPDATE (shared across tables).
  await query(
    "CREATE OR REPLACE FUNCTION set_updated_at()" +
    " RETURNS TRIGGER LANGUAGE plpgsql AS" +
    " $func$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $func$"
  );

  // Attach the trigger to campaigns (idempotent via DROP IF EXISTS).
  await query(`DROP TRIGGER IF EXISTS campaigns_set_updated_at ON campaigns;`);
  await query(`
    CREATE TRIGGER campaigns_set_updated_at
      BEFORE UPDATE ON campaigns
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
      external_lead_id TEXT,
      name TEXT,
      phone TEXT NOT NULL,
      campaign_type TEXT,
      playbook_type TEXT,
      drop_stage TEXT,
      due_date TEXT,
      loan_amount NUMERIC,
      offer_amount NUMERIC,
      language TEXT DEFAULT 'Hinglish',
      source_status TEXT,
      source_reject_reason TEXT,
      source_metadata JSONB DEFAULT '{}'::jsonb,
      status TEXT DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      last_called_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(campaign_id, phone)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
      lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
      call_sid TEXT,
      status TEXT DEFAULT 'queued',
      outcome TEXT,
      summary TEXT,
      duration_seconds INTEGER DEFAULT 0,
      cost_estimate NUMERIC DEFAULT 0,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_lead_id TEXT;`);
  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_status TEXT;`);
  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_reject_reason TEXT;`);
  await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_metadata JSONB DEFAULT '{}'::jsonb;`);

  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS tts_chars_dynamic INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS tts_chars_cached INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS tts_cache_hits INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS tts_cache_misses INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS stt_audio_ms_sent INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS stt_audio_ms_wall INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS llm_calls_count INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS llm_input_tokens INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS llm_output_tokens INTEGER DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS cache_hit_ratio NUMERIC DEFAULT 0;`);
  await query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_breakdown JSONB DEFAULT '{}'::jsonb;`);

  await query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS dnc_list (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      reason TEXT DEFAULT 'opted_out',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(tenant_id, phone)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID,
      user_id UUID,
      action TEXT NOT NULL,
      details JSONB,
      ip TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS compliance_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID,
      lead_id UUID,
      rule TEXT NOT NULL,
      result TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      call_window_start INTEGER DEFAULT 9,
      call_window_end INTEGER DEFAULT 20,
      max_call_attempts INTEGER DEFAULT 3,
      retry_delay_minutes INTEGER DEFAULT 360,
      ai_disclosure TEXT DEFAULT 'This is Sneha calling from TezCredit about your loan application.',
      sms_webhook_url TEXT,
      whatsapp_webhook_url TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      task TEXT,
      trigger TEXT,
      cadence TEXT,
      goal TEXT,
      steps JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(tenant_id, key)
    );
  `);

  await query(`DROP TRIGGER IF EXISTS playbooks_set_updated_at ON playbooks;`);
  await query(`
    CREATE TRIGGER playbooks_set_updated_at
      BEFORE UPDATE ON playbooks
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS call_audio_cache (
      token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      audio_base64 TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      payload JSONB,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS call_stt_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      audio_url TEXT,
      transcript TEXT,
      confidence NUMERIC,
      status TEXT DEFAULT 'completed',
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS voice_audio_cache (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cache_key TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      language_code TEXT NOT NULL,
      speaker TEXT NOT NULL,
      model TEXT NOT NULL,
      sample_rate INTEGER NOT NULL,
      volume NUMERIC NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'audio/pcm',
      pcm_base64 TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      source TEXT DEFAULT 'dynamic_tts',
      hit_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS voice_response_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      playbook_type TEXT NOT NULL,
      state_name TEXT NOT NULL,
      trigger_intent TEXT DEFAULT '',
      language TEXT DEFAULT 'Hinglish',
      fragments JSONB NOT NULL DEFAULT '[]'::jsonb,
      next_state TEXT,
      is_terminal BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(tenant_id, playbook_type, state_name, trigger_intent, language)
    );
  `);

  await query(`DROP TRIGGER IF EXISTS voice_audio_cache_set_updated_at ON voice_audio_cache;`);
  await query(`
    CREATE TRIGGER voice_audio_cache_set_updated_at
      BEFORE UPDATE ON voice_audio_cache
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  await query(`DROP TRIGGER IF EXISTS voice_response_templates_set_updated_at ON voice_response_templates;`);
  await query(`
    CREATE TRIGGER voice_response_templates_set_updated_at
      BEFORE UPDATE ON voice_response_templates
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS voicebot_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_sid TEXT,
      lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
      campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(
    `UPDATE users
     SET role='platform_admin'
     WHERE email=LOWER($1) AND role='admin'`,
    [process.env.ADMIN_EMAIL || "admin@loanconnect.ai"]
  );

  await query(`
    INSERT INTO tenant_settings (tenant_id)
    SELECT id FROM tenants
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_leads_campaign_status ON leads(campaign_id, status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_drop_stage ON leads(campaign_id, drop_stage);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_external_id ON leads(tenant_id, external_lead_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calls_tenant_created ON calls(tenant_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dnc_phone ON dnc_list(tenant_id, phone);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_playbooks_tenant_key ON playbooks(tenant_id, key);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_audio_expires ON call_audio_cache(expires_at);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_voice_audio_cache_lookup ON voice_audio_cache(cache_key) WHERE is_active=true;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_voice_response_templates_lookup ON voice_response_templates(tenant_id, playbook_type, state_name, trigger_intent, language) WHERE is_active=true;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stt_call ON call_stt_events(call_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_voicebot_events_created ON voicebot_events(created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_voicebot_events_call_sid ON voicebot_events(call_sid);`);

  // Additional indexes for production query patterns
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(campaign_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_leads_last_called ON leads(tenant_id, last_called_at);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calls_status_created ON calls(tenant_id, status, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calls_campaign_created ON calls(campaign_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id, created_at ASC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dnc_created ON dnc_list(tenant_id, created_at DESC);`);

  console.log("Migration complete");
}

migrate().then(() => pool.end()).catch(err => {
  console.error(err);
  pool.end();
  process.exit(1);
});
