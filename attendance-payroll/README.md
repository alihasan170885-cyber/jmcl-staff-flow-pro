# Corporate Attendance & Payroll

Attendance, leave and payroll for a company using the **ZKTeco uFace800 Multi-Biometric Time & Attendance and Access Control Terminal** (face, fingerprint, card and password). Node.js, PostgreSQL, installable PWA.

Punches arrive from the device (ADMS push), become attendance records with late / early-out / overtime rules applied, flow into leave and payroll, and raise phone notifications to Admin and HR when something is wrong.

## Run it

```bash
cp .env.example .env        # optional: everything has a working default
docker compose up -d --build
```

Open <http://localhost:3000>. With the default `SEED_DEMO=true` the first start creates 19 employees, three months of punches, leave requests and payroll history. Demo logins (password `Demo@12345`):

| Account | Role | Can |
|---|---|---|
| `admin@company.test` | Admin | everything: devices, settings, finalise payroll |
| `hr@company.test` | HR | employees (Staff only), attendance corrections, leave approvals, payroll preparation, reports |
| `staff@company.test` | Staff | own attendance, leave requests and balance, own finalised payslips |

For a real deployment set `SEED_DEMO=false`. The first admin is then created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (or a generated password printed once in the logs) and must change it at first sign-in.

### Try the pipeline without hardware

```bash
npm run simulate -- --pin 1004 --at 09:35      # a late arrival → "Late arrival" alert to Admin/HR
npm run simulate -- --random 5                 # five punches from random demo staff
npm run simulate -- --watch --interval 8       # keep punching; watch the dashboard ribbon move
npm run simulate -- --pin 9999                 # unregistered PIN alert
npm run simulate -- --sn NEW-DEVICE-42 --handshake   # unknown device → "waiting for approval"
```

The simulator needs only Node 18+ and speaks the real ADMS wire format. Run it from the host (`--url http://localhost:3000`) or `docker compose exec app node scripts/simulate-punch.js …`.

## Connecting the ZKTeco uFace800

1. On the device: **Menu → Comm. → Cloud Server Setting** (labelled *ADMS* on some firmware). Server address = this server's IP, port = `3000` (or `APP_PORT`), HTTPS off. Make sure the device date, time and timezone are correct.
2. The device contacts the server and appears under **Devices** as *Needs approval*. Approve it. Until then its punches are discarded, so a stranger on your network cannot inject attendance.
3. Enrol people on the device (face, fingerprint, card or password) using the **Device PIN** from the Employees page as their User ID. Every punch is recorded however the person verified; the verification type is kept with the raw punch.

**Changing the device address:** *Devices → Edit* lets Admin change the IP address, port or API URL at any time. It is stored in PostgreSQL and takes effect immediately. *Test* checks reachability. Two modes:

- **ADMS push** (default). The device sends to `POST /iclock/cdata?SN=<serial>&table=ATTLOG` (alias `/api/adms/push`). The stored IP is used for display and, if *Only accept pushes from this IP* is on, to reject other sources.
- **HTTP pull**. The server polls the stored API URL every N seconds. It expects JSON, either an array or `{data|records|logs: [...]}`, of `{ "pin": "1004", "timestamp": "2026-10-28 09:02:11" }` (ISO timestamps with a zone are converted; optional `status`, `verify`). Use this for a middleware or gateway in front of the device.

Device clocks send local wall-clock time. It is interpreted in the company timezone (`TZ_DEFAULT`, editable in Settings).

## Rules implemented

- **Late**: check-in after shift start + grace. Late minutes are counted from the shift start.
- **Early out**: check-out before shift end − early-out grace.
- **Overtime**: time after shift end once the threshold is passed, capped per day. All worked time on a weekly off or holiday counts as overtime at its own multiplier.
- **Day status**: present, late, half day (worked below threshold), absent (decided only after the shift ends), leave, weekly off, holiday. A single punch means "missing check-out". Taps within a few minutes of each other count once.
- **Leave**: working days exclude the employee's weekly off and company holidays. Balances are checked at request time (including pending requests) and again, under a row lock, at approval. Cancelling approved leave restores the balance. Nobody can review their own request. Unpaid leave has no balance and is deducted in payroll.
- **Payroll** (per month, from attendance): daily rate = base ÷ scheduled working days. Absence, unpaid leave and half days deduct from the daily rate. Every N late arrivals cost one day. Overtime pays at the hourly rate × multiplier. A perfect-attendance bonus applies when there is no absence, lateness or half day. Provident fund and income tax are percentages. Manual bonuses and deductions are added per month. Mid-month joiners are prorated. A run is a draft until an **Admin** finalises it; finalised months are locked, and only then can staff see payslips. All rules are editable in Settings.
- **Notifications** (in-app and Web Push to Admin/HR): late arrival, not checked in N minutes after shift start, early departure, missing check-out, absences, unregistered PIN, new device waiting, device offline, new leave request. Each alert has a dedupe key, so repeated scans never spam.

## Phone notifications and installing the PWA

Browsers only allow service workers, install and push on **HTTPS** (or `localhost`). For phones:

```bash
# .env:  DOMAIN=attendance.yourcompany.com   TRUST_PROXY=1
docker compose --profile https up -d
```

Caddy obtains certificates automatically. Keep port 3000 reachable on your LAN for the device (it speaks plain HTTP), then on a phone open the HTTPS address, sign in as Admin/HR, press the bell and **Turn on**. On iPhone, add the app to the Home Screen first (iOS 16.4+). VAPID keys are generated on first boot and stored in the database.

## Structure

```
docker-compose.yml  Dockerfile  Caddyfile  .env.example
db/schema.sql                 idempotent schema, applied at every start
src/
  server.js app.js config.js db.js bootstrap.js seed.js
  logic/        pure, unit-tested rules: attendanceRules, payrollCalc, adms
  services/     attendance (recompute + ingest), leave, payroll, reports (PDF/Excel), exceptions, notifications (push),
                dashboard, devicePoller, deviceProbe, scheduler, settings
  routes/       auth users org attendance leave payroll reports dashboard notifications devices settings adms meta
  middleware/   auth (JWT cookie, RBAC, CSRF header) error
public/         PWA: index.html manifest sw.js css/ js/ (main, api, ui, push, pages/*) icons/
scripts/simulate-punch.js     fake ZKTeco device
tests/unit.test.js  tests/smoke.test.js
```

## Security notes

- Passwords: bcrypt. Sessions: signed JWT in an `httpOnly`, `SameSite=Strict` cookie (`Secure` automatically behind HTTPS), plus a required `X-Requested-With` header on writes. Login is rate limited. Roles are re-read from the database on every request, so deactivation takes effect immediately.
- Staff can only read their own attendance, leave and finalised payslips; other people's payslips return 404.
- HR cannot create or edit Admin/HR accounts, change roles, manage devices or finalise payroll.
- Device endpoints cannot carry credentials. They rely on the registered serial number, admin approval, and optional source-IP enforcement. Keep port 3000 on a trusted network (or firewall it to the device's IP).
- JWT and VAPID secrets are generated per installation unless you set `JWT_SECRET`. The database is not published outside Docker.
- Change `POSTGRES_PASSWORD` and set `SEED_DEMO=false` before real use.

## Testing

```bash
npm test               # 17 dependency-free unit tests: attendance rules, payroll maths, ADMS parsing, date helpers
docker compose up -d --build && npm run test:smoke   # end-to-end against the running stack (needs demo data)
```

## Known limitations

- Overnight shifts (ending after midnight) are not supported; shifts must start and end on the same day.
- Half-day leave deducts correctly in payroll but shows as a full "On leave" day in attendance.
- Payroll covers one currency, flat PF and tax percentages (no tax slabs), and no terminated-employee final settlement; deactivated employees are excluded from later runs.
- PDF reports use a built-in Latin font. For Bengali or other scripts, mount a TTF (for example Noto Sans Bengali) and set `PDF_FONT` (and optionally `PDF_FONT_BOLD`).
- The ADMS handshake follows the common ZKTeco push protocol, but firmware differs. Check your uFace800's menu labels and firmware version and watch `docker compose logs app` the first time it connects.
