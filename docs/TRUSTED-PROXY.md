# TRUSTED_PROXY — production topology & verification

Audit finding: **B2** (guest rate limiting depends on a client IP that
must not be attacker-controlled).

Status: **code hardened and covered by tests. No production environment
variable has been changed yet** — this document is the configuration
that still has to be applied during a deploy window.

Regression tests: `__tests__/security/trusted-proxy-ip.test.ts`
(14 cases). Implementation: `lib/rate-limit.ts` → `getClientIp()`.

---

## 1. Why this matters

Every guest-facing limit (checkout, COD, spin, voucher, recovery, order
lookup) is keyed on a client IP, because a guest has no session to key
on. `x-forwarded-for` / `x-real-ip` are **client-controlled headers**: if
the app trusts them without a proxy in front, one attacker can send a
different fake value per request and get a fresh bucket every time,
turning every guest cap off.

`getClientIp()` therefore has three states:

| Deployment | `TRUSTED_PROXY` | Result |
|---|---|---|
| Directly exposed (no proxy) | unset | Headers ignored → `"untrusted"`. All guests share one bucket. **Safe**, but global. |
| Behind our proxy | `1` | Client IP taken from the forwarding chain (see §3). Real per-client buckets. |
| Proxy misconfigured | `1` | Headers are still not blindly trusted: a non-IP value fails closed to `"untrusted"`. |

Even in the `"untrusted"` state abuse control does not disappear: each
guest path is evaluated against **both** an IP/device bucket *and* a
keyed-hash contact bucket (`guestIpKey` + `guestDeviceKey` /
`guestIdentityKey`), so a buyer rotating addresses is still capped by
their hashed email/phone. What degrades is the per-client ceiling, which
one noisy client can consume for everyone until `TRUSTED_PROXY` is set.

---

## 2. Production topology

- Next.js is served on **127.0.0.1:3002** (`npm start` → `next start -p 3002`)
  or `server.js` on `$PORT`; it is not reachable from the public
  internet — the reverse proxy terminates TLS and forwards.
- Trust boundary: **exactly the reverse proxy** in front of the app.
  If a CDN (Cloudflare/Fastly/…) sits in front of *that* proxy, it is a
  second trusted hop — see `TRUSTED_PROXY_HOPS` below.

### 2.1 Required proxy configuration (nginx example)

```nginx
location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;

    # OVERWRITE both headers from the socket address. Overwriting is
    # preferred: whatever the client sent in these headers is discarded
    # before it reaches the app.
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
}
```

`$proxy_add_x_forwarded_for` (append) is also acceptable — the app reads
the **rightmost** hop (§3) — but overwriting removes the ambiguity
entirely and is what you should deploy.

Apache equivalent:

```apache
ProxyPreserveHost On
RequestHeader set X-Real-IP       "expr=%{REMOTE_ADDR}"
RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"
ProxyPass        / http://127.0.0.1:3002/
ProxyPassReverse / http://127.0.0.1:3002/
```

### 2.2 Firewall

Port 3002 must **not** be reachable from the internet (`ss -ltnp`
shows it on `127.0.0.1` or it is blocked at the firewall). If a client
can reach the app directly, they can forge the forwarding headers and
the trust boundary is void — no application setting can compensate.

---

## 3. Environment variables

```dotenv
# Enables trust of the proxy forwarding headers.
TRUSTED_PROXY=1

# Number of OUR trusted proxies in front of the app, counted from the
# RIGHT of x-forwarded-for. Default 1 (single nginx/Apache).
# CDN -> proxy -> app => 2
TRUSTED_PROXY_HOPS=1
```

Rule: the client address is the entry **`TRUSTED_PROXY_HOPS` from the
right**, because `x-forwarded-for` is append-only and only the entries
written by our own proxies are trustworthy.

```
client → nginx → app
  normal request              XFF: "203.0.113.9"            → 203.0.113.9
  client injects a header     XFF: "1.2.3.4, 203.0.113.9"   → 203.0.113.9
                                                    ^ the fake value is ignored

client → CDN → nginx → app    (TRUSTED_PROXY_HOPS=2)
                              XFF: "203.0.113.9, 198.51.100.7" → 203.0.113.9
```

Safety rules encoded in the code:

- A value that is not an IP literal (hostname, `ip:port`, arbitrary
  string) is **never** used as a bucket key — a crafted value could
  otherwise collide with another bucket. It fails closed to
  `"untrusted"`.
- `TRUSTED_PROXY_HOPS` deeper than the actual chain fails closed to
  `"untrusted"` rather than falling back to the leftmost (forgettable)
  entry.
- Malformed/non-numeric `TRUSTED_PROXY_HOPS` is treated as `1`.
- `TRUSTED_PROXY` **unset** ignores the headers entirely (the pre-fix
  behaviour, kept as the safe default).

---

## 4. Verification procedure

Do this on staging (or immediately after the production switch), before
declaring B2 closed. `POST /api/orders/recover` is a good probe: it is
cheap, requires no valid order, and is limited to **5 requests / 15 min
per IP bucket**.

1. **Spoofing must not mint buckets.** With `TRUSTED_PROXY` unset *and*
   with it set, send 6 requests from one machine, each with a different
   fake forwarding header:

   ```bash
   for i in 1 2 3 4 5 6; do
     curl -s -o /dev/null -w "%{http_code}\n" \
       -H 'content-type: application/json' \
       -H "x-forwarded-for: 10.9.9.$i" \
       -X POST https://<host>/api/orders/recover \
       -d '{"orderNumber":"PAY-NOPE-1","email":"a@b.com"}'
   done
   ```

   Expected: `404 404 404 404 404 429` — the 6th is refused. If every
   request returns `404`, spoofing is creating fresh buckets and the
   proxy is not writing `x-forwarded-for` (see §2.1).

2. **Real clients get their own buckets.** Repeat step 1 from a second
   network (phone hotspot) while the first machine is already
   rate-limited. Expected: the second network still gets `404`s, i.e.
   per-client keys work rather than one global bucket.

3. **Header hygiene.** From a machine that can reach the app *only*
   through the proxy, confirm the app never receives a
   client-supplied value:

   ```bash
   curl -s -D - -o /dev/null https://<host>/ -H 'x-forwarded-for: 1.2.3.4'
   ```

   then check the app's view (temporary log line in `getClientIp()` or
   `ss`/proxy logs): the IP must be the caller's real address, never
   `1.2.3.4`.

4. **Rollback is trivial**: unset `TRUSTED_PROXY` and restart. Guest
   limits fall back to the shared-bucket mode (safe, coarser) and no
   other behaviour changes.

---

## 5. Not in this change

- No production env var, proxy config or firewall rule was modified.
- The in-memory limiter is still per-process
  (`lib/rate-limit.ts` header comment). With more than one app instance,
  configure Redis-backed limiting so buckets are shared.
