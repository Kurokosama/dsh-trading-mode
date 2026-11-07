# Data Sources

Every upstream this plugin talks to is defined once in `lib/trading/config.js`
(`PROVIDER_CONFIG`) and implemented once in `lib/trading/providers/<id>.js`. Nothing else in
the code base names a provider, so this file is the complete list of what leaves your machine.

Markets: `US` only. A provider is only asked for a market and a capability it declares —
the router filters candidates before any request is made. (The pre-fork multi-market
configuration, including the HK / CN / JP / CRYPTO chains and their providers, was removed
with the US-only scope change; [docs/SCOPE.md](SCOPE.md) keeps the removal log.)

## Implemented providers

| Provider id | Upstream host / page | Features | Notes and known limits |
| --- | --- | --- | --- |
| `yahoo` | `query1.finance.yahoo.com` — `/v8/finance/chart`, `/v7/finance/quote` (cookie + crumb handshake) | quote, candles, profile, search | First link of the US chain. Measured **HTTP 403** from some networks (IP-level block); the health-aware chain falls through when that happens. Also serves the US index tiles through its chart endpoint. |
| `stooq` | `stooq.com/q/l/` (quote CSV), `stooq.com/q/d/l/` (daily CSV) | candles, quote | The historical fallback for the US chain. Measured **403** (access denied) from some networks, so it sits behind Yahoo; as a quote source it is deliberately non-primary because it cannot answer intraday snapshots. |
| `nasdaq` | `api.nasdaq.com/api/screener/stocks` | listings | One request returns roughly seven thousand US rows, so it needs no upstream paging. Quotes and candles stay with the regular chain; the provider declares no quote capability at all. |

In addition to the data providers above, two further upstreams answer feature cards rather
than the chain: **Nasdaq's earnings calendar** feeds the event reminders card and the brief's
earnings warnings (six-hour per-day cache; it rejects non-browser User-Agents, so requests go
out with `HTTP_POLICY.userAgent`), and **SEC EDGAR** (`data.sec.gov` `companyfacts`) feeds the
fundamentals card inside the detail view (six-hour cache; the ticker→CIK lookup caches for
24 h; ETFs and funds carry no XBRL facts and skip the card).

## Default provider chains

Per-market order, quoted from `MARKET_DATA_CONFIG` in `lib/trading/config.js`:

```js
US: { primary: 'yahoo', historicalFallback: 'stooq', chain: ['yahoo', 'stooq'] }
```

`primary` and `historicalFallback` are labels; the order actually walked is `chain`. The
chain is filtered by capability and health at request time, so a provider that cannot serve a
feature is never asked.

Listing (universe) feeds are configured separately in `UNIVERSE_PROVIDERS`:

```js
US: ['nasdaq']
```

## Overriding the chains

Chains are user configuration. Set them on the plugin entry in the profile's patch layer
(the loader entry id is `trading-mode`):

```yaml
- id: trading-mode
  config:
    providers:
      US: ['stooq', 'yahoo']
    networkMode: compatibility
```

Accepted keys: `providers` (market → ordered provider id list), `networkMode`,
`identity.localBucket` (a stable string naming the single-user storage bucket, used only when
the host offers no anonymous user id) and `security.allowUnfencedLoopback` (boolean, default
`false` — the one request-fence opt-out; see `docs/PRIVACY.md`). Provider
ids are validated against the registry: `yahoo`, `stooq`, `nasdaq`.

Validation failures are reported once at startup and the shipped default stays in force — a
bad value never breaks the plugin. Messages are explicit about what was expected, for example:

```
providers must be an object that maps a market to an ordered provider list (got array)
providers.XX: unknown market (accepted: US)
providers.US: expected an array of provider ids (accepted: yahoo, stooq, nasdaq)
providers.US: the chain must list at least one provider (accepted: …)
providers.US: unknown provider "futu" (accepted: …)
providers.US: provider stooq is listed twice
networkMode must be one of auto, standard, compatibility (got "fast")
security.allowUnfencedLoopback must be true or false (got "yes please")
```

and the host log line is `trading-mode: invalid configuration — <problem> (the shipped
default stays in force)`.

## Transport mode — `networkMode`

`auto` (default), `standard` or `compatibility`:

- **`standard`** — plain `node:http(s)` with the runtime's own DNS behaviour and no
  address-family pinning. This is what a generic network wants.
- **`compatibility`** — remembers the address family that last answered a host and pins one
  family per retry attempt, flipping between IPv4 and IPv6. It exists for networks where one
  family *accepts* the TCP connection and then resets it (happy-eyeballs cannot see that,
  because no connect error is reported).
- **`auto`** — starts on `standard` and escalates **only the hosts that actually fail** at the
  transport level to the compatibility policy, so nobody has to know which network they are
  on.

`standard` forbids the fallback entirely (useful to prove a network problem is not caused by
the workaround); `compatibility` forces it on. The current mode and per-host state are
reported by the status endpoint.

## Rate limiting, timeouts, retries, cache

From `HTTP_POLICY` in `lib/trading/config.js`:

| Setting | Value | Meaning |
| --- | --- | --- |
| `timeoutMs` | `12000` | Per-attempt timeout; a timeout becomes `UPSTREAM_TIMEOUT`. |
| `retries` | `2` | Retry attempts per request, with exponential back-off (`retryBaseDelayMs` 350 ms, capped at `retryMaxDelayMs` 2000 ms). |
| `rateLimitPerMinute` | `120` | Token bucket **per provider** (each provider instance gets its own `RateLimiter`). |
| `failureThreshold` | `3` | Consecutive failures before a provider capability is marked unhealthy. |
| `healthCooldownMs` | `60000` | How long an unhealthy capability is skipped before it is probed again (a half-open probe is still attempted when everything is cooling down). |

Cache TTLs (`CACHE_TTL`) are session-aware — shorter while a market is open, longer when it is
closed: quotes 20 s open / 10 min closed, candles 60 s / 30 min, technicals 60 s / 30 min,
search 10 min / 60 min, profiles 24 h in both. An expired entry may still be served as a
fallback when every provider fails, up to `maxStaleAge` (quotes 72 h, candles 7 d,
technicals 24 h, profiles 30 d), and it is then labelled `stale: true` with a reason. The
cache is keyed per symbol and shared process-wide, never per user.

## Per-capability health

Health is keyed by **`healthScope(provider, feature)`** — `yahoo::candles`,
`yahoo::search`, and so on — not by provider id alone. That matters because upstreams fail
by endpoint: a provider whose candle endpoint is being reset can keep answering search and
quote. The status endpoint rolls the scoped entries back up to one row per provider and keeps
the per-capability detail in `scopes`.

## Data terms and attribution

**The auditable per-provider table lives in [`DATA_COMPLIANCE.md`](DATA_COMPLIANCE.md)**:
one row per provider id in `PROVIDER_CONFIG` order, with the hosts actually requested, the
capabilities it serves, the `delaySeconds` the plugin records, the attribution the
UI offers (or does not offer), and the compliance status. As of **2026-10-10** every provider's
terms are marked **not verified** — no terms text was fetched while writing these documents —
and all three stay **enabled by default** because each is a public unauthenticated endpoint; an
operator with no right to a feed can drop it with the `providers` config override instead of
patching code. The browser-side **TradingView embed** is a third-party *embed*, not a provider,
and is treated separately in that document.

- These are **public web endpoints** used for personal research inside your own DSH
  installation. The plugin sends ordinary unauthenticated requests to documented public
  endpoints; it does not bypass authentication, scrape logged-in pages, or use undocumented
  private APIs.
- **Quotes may be delayed**, and many of these feeds are not licensed real-time data. The UI
  always shows a data timestamp and a freshness note and never labels anything as live.
- **Terms belong to the upstream operators.** Each host listed above is owned and governed by
  its operator, and their terms of use apply to your use of that data.
- **No redistribution is intended.** The plugin does not republish, resell or bulk-export
  upstream data; it renders values for the person running the panel.
- **Availability is not guaranteed.** Upstreams block, rate-limit, reset connections and
  change their responses without notice; the plugin degrades to a typed error or to labelled
  stale data rather than inventing a value.
- Index levels are points, not tradable prices — see the README's limitations section for
  the full list.
