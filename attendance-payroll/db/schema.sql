-- Corporate Attendance & Payroll — PostgreSQL schema (idempotent; applied on every start)

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id                      serial PRIMARY KEY,
  name                    text NOT NULL UNIQUE,
  start_time              time NOT NULL,
  end_time                time NOT NULL,
  break_minutes           int  NOT NULL DEFAULT 60 CHECK (break_minutes >= 0),
  grace_minutes           int  NOT NULL DEFAULT 10 CHECK (grace_minutes >= 0),
  early_out_grace_minutes int  NOT NULL DEFAULT 10 CHECK (early_out_grace_minutes >= 0),
  overtime_after_minutes  int  NOT NULL DEFAULT 30 CHECK (overtime_after_minutes >= 0),
  weekly_off              int[] NOT NULL DEFAULT '{5}',      -- 0=Sun … 6=Sat
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)                              -- overnight shifts are not supported in this version
);

CREATE TABLE IF NOT EXISTS users (
  id                   serial PRIMARY KEY,
  employee_code        text NOT NULL UNIQUE,
  device_pin           text NOT NULL UNIQUE,                 -- the PIN / user-id enrolled on the ZKTeco device
  name                 text NOT NULL,
  email                text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','hr','staff')),
  department           text NOT NULL DEFAULT 'General',
  designation          text NOT NULL DEFAULT '',
  shift_id             int  REFERENCES shifts(id),
  base_salary          numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  allowances           numeric(12,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  join_date            date NOT NULL DEFAULT CURRENT_DATE,
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS devices (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  serial_number    text NOT NULL UNIQUE,
  model            text NOT NULL DEFAULT 'ZKTeco uFace800',
  location         text NOT NULL DEFAULT '',
  protocol         text NOT NULL DEFAULT 'adms' CHECK (protocol IN ('adms','http-pull')),
  ip_address       text,
  port             int  CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  api_url          text,
  enforce_ip       boolean NOT NULL DEFAULT false,           -- accept ADMS pushes only from ip_address
  poll_interval_sec int NOT NULL DEFAULT 60 CHECK (poll_interval_sec >= 10),
  approved         boolean NOT NULL DEFAULT false,           -- unknown serials self-register as unapproved
  active           boolean NOT NULL DEFAULT true,
  online           boolean NOT NULL DEFAULT false,
  last_seen        timestamptz,
  last_ip          text,
  attlog_stamp     text,
  last_poll_at     timestamptz,
  last_poll_error  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS punch_logs (
  id          bigserial PRIMARY KEY,
  device_id   int REFERENCES devices(id) ON DELETE SET NULL,
  device_sn   text NOT NULL,
  pin         text NOT NULL,
  user_id     int REFERENCES users(id) ON DELETE SET NULL,
  punched_at  timestamptz NOT NULL,
  state       int,
  verify      int,
  workcode    text,
  source      text NOT NULL DEFAULT 'device' CHECK (source IN ('device','manual','simulator','poll')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_sn, pin, punched_at)
);
CREATE INDEX IF NOT EXISTS punch_logs_user_time_idx ON punch_logs (user_id, punched_at);
CREATE INDEX IF NOT EXISTS punch_logs_time_idx ON punch_logs (punched_at DESC);

CREATE TABLE IF NOT EXISTS holidays (
  date  date PRIMARY KEY,
  name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 bigserial PRIMARY KEY,
  user_id            int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date          date NOT NULL,
  shift_id           int  REFERENCES shifts(id),
  check_in           timestamptz,
  check_out          timestamptz,
  punch_count        int  NOT NULL DEFAULT 0,
  worked_minutes     int  NOT NULL DEFAULT 0,
  late_minutes       int  NOT NULL DEFAULT 0,
  early_out_minutes  int  NOT NULL DEFAULT 0,
  overtime_minutes   int  NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('present','late','half_day','absent','leave','unpaid_leave','weekend','holiday')),
  missing_checkout   boolean NOT NULL DEFAULT false,
  off_day_work       boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (work_date, status);

CREATE TABLE IF NOT EXISTS leave_types (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  annual_quota numeric(5,1) CHECK (annual_quota IS NULL OR annual_quota >= 0),  -- NULL = no balance tracking (e.g. unpaid)
  paid         boolean NOT NULL DEFAULT true,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS leave_balances (
  user_id        int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id  int NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year           int NOT NULL,
  allocated      numeric(5,1) NOT NULL DEFAULT 0,
  used           numeric(5,1) NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id             bigserial PRIMARY KEY,
  user_id        int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id  int NOT NULL REFERENCES leave_types(id),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  half_day       boolean NOT NULL DEFAULT false,
  days           numeric(5,1) NOT NULL CHECK (days > 0),
  reason         text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by    int REFERENCES users(id),
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS leave_requests_user_idx ON leave_requests (user_id, start_date);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx ON leave_requests (status);

CREATE TABLE IF NOT EXISTS adjustments (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind        text NOT NULL CHECK (kind IN ('bonus','deduction')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  note        text NOT NULL DEFAULT '',
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adjustments_month_idx ON adjustments (month, user_id);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id            serial PRIMARY KEY,
  month         text NOT NULL UNIQUE CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  partial       boolean NOT NULL DEFAULT false,
  generated_by  int REFERENCES users(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  finalized_by  int REFERENCES users(id),
  finalized_at  timestamptz
);

CREATE TABLE IF NOT EXISTS payslips (
  id               bigserial PRIMARY KEY,
  run_id           int NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id          int NOT NULL REFERENCES users(id),
  base_pay         numeric(12,2) NOT NULL DEFAULT 0,
  allowances       numeric(12,2) NOT NULL DEFAULT 0,
  overtime_pay     numeric(12,2) NOT NULL DEFAULT 0,
  bonus            numeric(12,2) NOT NULL DEFAULT 0,
  gross            numeric(12,2) NOT NULL DEFAULT 0,
  absence_deduction numeric(12,2) NOT NULL DEFAULT 0,
  late_deduction   numeric(12,2) NOT NULL DEFAULT 0,
  pf_deduction     numeric(12,2) NOT NULL DEFAULT 0,
  tax_deduction    numeric(12,2) NOT NULL DEFAULT 0,
  other_deduction  numeric(12,2) NOT NULL DEFAULT 0,
  total_deductions numeric(12,2) NOT NULL DEFAULT 0,
  net_pay          numeric(12,2) NOT NULL DEFAULT 0,
  breakdown        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (run_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '/',
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

-- Device model: the terminal in use is the ZKTeco uFace800 (multi-biometric: face, fingerprint, card, password).
ALTER TABLE devices ALTER COLUMN model SET DEFAULT 'ZKTeco uFace800';
UPDATE devices SET model = 'ZKTeco uFace800' WHERE model = 'ZKTeco MB20-VL';
