# Publishing & distribution runbook (Phase 1)

The code artifacts are ready. The steps below are the outward-facing actions that
need accounts/credentials. Do them in order. **Decide the namespace first** — it
threads through npm, `server.json`, and the registry.

> **Steps 2 and 3 are now automated.** `.github/workflows/publish.yml` runs
> `npm publish` and `mcp-publisher publish` when a version bump lands on `main`,
> so **merging the version-bump PR is the release**, and approving that PR is
> approving the release. The manual commands below are kept as the reference for
> what the workflow does and as the fallback if it is disabled.
>
> **One-time setup before it can run** (none of it is automatable — all three are
> account or DNS actions):
>
> 1. **npm Trusted Publisher** — on npmjs.com, open `@shumi-ai/mcp` → Settings →
>    Trusted Publishers, and add: owner `shumi-ai`, repository `shumi-mcp`,
>    workflow `publish.yml`. **There is no `NPM_TOKEN`.** The runner exchanges its
>    OIDC token for short-lived publish rights, so nothing long-lived exists to
>    leak, rotate, or expire — and npm is actively restricting the 2FA-bypass
>    tokens this replaces. Two consequences worth knowing: the workflow *filename*
>    is part of the trust relationship, so renaming `publish.yml` breaks
>    publishing until the entry is updated; and setting `NODE_AUTH_TOKEN` would
>    silently disable OIDC, because npm prefers a token when one is present.
> 2. Repo secret `MCP_DNS_PRIVATE_KEY` — the Ed25519 private key (64-char hex)
>    whose public half is published as an **apex** TXT record on `shumi.ai`:
>    `shumi.ai. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"`. It must be on the
>    apex, not a `_mcp-auth` style selector, and any stale record must be removed
>    or verification fails. Generation commands are in step 3.
> 3. Repo variable `PUBLISH_ENABLED=true` — the off switch. It defaults to off,
>    so merging the workflow alone publishes nothing.
>
> These belong in **GitHub** → Settings → Secrets and variables → Actions. They
> are read by a GitHub Action; putting them in a hosting provider's environment
> does nothing, because the workflow cannot see it.
>
> Optionally add required reviewers to the `publish` environment for a second
> gate that fires after the merge.
>
> **Releasing:** bump the version in `package.json`, `server.json` (`.version`)
> and `server.json` (`.packages[0].version`) together — the workflow fails loudly
> if the three disagree — then open a PR and merge it.
>
> **This is not reversible.** npm allows unpublish for 72 hours, after which the
> name and version are permanent. The registry entry propagates to Smithery,
> Glama and MCPfinder within about 24 hours.

## 0. Namespace + repo owner (decided)

- Registry name: **`ai.shumi/mcp`**, verified by a **DNS TXT record on `shumi.ai`**.
- Repo: **`github.com/shumi-ai/shumi-mcp`** (DNS verification decouples the name
  from the GitHub owner, so the repo can live under the current account).
- `package.json` (`mcpName`) and `server.json` (`name`) are already set to
  `ai.shumi/mcp`; both repository URLs point at `shumi-ai/shumi-mcp`.

## 1. GitHub repo

```bash
cd ~/Projects/shumi-mcp
git add -A && git commit -m "feat: Shumi MCP server (Phase 0 + Phase 1 artifacts)"
gh repo create shumi-ai/shumi-mcp --public --source=. --remote=origin --push
```

## 2. npm publish (`@shumi-ai/mcp`)

Requires being a member of the `@shumi-ai` npm org with publish rights.

```bash
npm login
npm publish        # publishConfig.access=public is already set
# verify
npx -y @shumi-ai/mcp   # should start the stdio server (needs SHUMI_TOKEN to call tools)
```

## 3. Official MCP Registry

```bash
# install the publisher CLI (Go) — see modelcontextprotocol/registry releases
mcp-publisher login dns --domain shumi.ai   # prints a TXT record to add to shumi.ai DNS
mcp-publisher publish                        # reads ./server.json (name: ai.shumi/mcp)
```

Generate the keypair the DNS record proves (Ed25519 — note that macOS ships
LibreSSL, which cannot do Ed25519 in `genpkey`; use `brew install openssl@3` and
call that binary explicitly, or use the ECDSA P-384 variant in the registry docs):

```bash
openssl genpkey -algorithm Ed25519 -out key.pem

# public half → the apex TXT record on shumi.ai
echo "shumi.ai. IN TXT \"v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)\""

# private half → repo secret MCP_DNS_PRIVATE_KEY (64-char hex)
openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
```

The non-interactive form the workflow uses:

```bash
mcp-publisher login dns --domain=shumi.ai --private-key="$MCP_DNS_PRIVATE_KEY"
```

Note this is DNS auth rather than `login github-oidc`: OIDC only grants the
`io.github.*` namespace, and this server is named `ai.shumi/mcp`.
Smithery, Glama, and MCPfinder auto-aggregate from the registry within ~24h.

## 4. Render (hosted Streamable HTTP)

Either: New → Blueprint → point at this repo (`render.yaml`), then set the
`sync:false` env vars (`SHUMI_MCP_PUBLIC_URL`, `SHUMI_MCP_ALLOWED_ORIGINS`).
Or deploy via the Render API/MCP once the repo is connected.
Verify: `GET https://<service>.onrender.com/health` → `{ "ok": true }`.

## 5. Smithery (verified hosted listing — the #1 ranking lever)

`smithery.yaml` + `Dockerfile` are in place (container runtime, HTTP). Connect the
GitHub repo on smithery.ai and deploy; users supply their `shumiToken` via the
config schema (the server maps it to the upstream key). Alternatively, list the
Render URL as a remote server.

## 6. Other registries

- mcp.so — submit/comment on the tracking issue.
- PulseMCP — submit via the site form.
- Glama — claim the auto-crawled listing.
- `punkpeye/awesome-mcp-servers` — PR under the Finance/Crypto section.

Listing copy lives in `llms.txt` and `README.md`; keep it in the product voice
(no payment-processor names, no forbidden words, no "signals service" framing).
